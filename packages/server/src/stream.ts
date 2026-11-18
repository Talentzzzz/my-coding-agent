import type {
	ClientFrame,
	PendingApproval,
	ServerFrame,
	ServerMessage,
	SessionRow,
	SessionSnapshot,
} from "@my-agent/core/protocol";
import { UnknownSessionError } from "@my-agent/core";
import type { ApprovalAnswers } from "./approvals.ts";
import { parseClientFrame } from "./http/client-frame.ts";
import type { SessionHub, SubscriptionSink } from "./hub.ts";
import type { SessionProjection } from "./projection.ts";
import type { Wire } from "./wire.ts";

/**
 * 一条连接上的会话语义：订阅哪些会话、baseline 何时发、事件与快照翻译成哪些帧、审批横幅的
 * 读者计数、隐藏目录过滤、失败的措辞。
 *
 * 它懂会话，不认识 socket：所有帧经 {@link Wire.send} 写出，队列、背压、`1013`、字节数与存活
 * 探测都在 wire 那一层。每连接一个，自持一张订阅表——这既是"我在订什么"，也是断线时唯一的
 * 反向索引，所以断线是"把这个对象扔掉"，不是遍历若干张边表。
 *
 * 知道：会话、事件语义、baseline 时机、审批读者计数、隐藏目录过滤、帧措辞。
 * 不知道：socket、背压、`1013`、字节数。
 *
 * 帧序不变量的另一半住在这里：本层保证 baseline 帧先于它自己 backlog 里的任何帧写出。与 hub
 * 的「注册与快照原子」之间的缝是本层 `subscribe` 的返回拍：hub 保证订阅元素在同一个同步块里
 * 挂上并同步交付活半 baseline；本层保证 `subscribe` 返回前 baseline 已同步回调、同步 `send`，
 * 而不是先攒着等一拍，所以任何 emit 只能落在下一个事件循环拍，那时 baseline 早已排在前面。
 * 冷半的读盘在 hub 内异步，跨过的那段由本订阅的 backlog 扣住。两半之间的缝是：hub 只交结果
 * （快照或原始 error），帧序与失败措辞由这里决定。
 */

/**
 * 本连接正在观看的一个会话。
 *
 * 订阅是一个*连接 × 会话*对，这就是它住在这里而不是会话上的原因：同一会话的两个窗口各持有一个，各自从自己的起点上报审批差异，两者都不是关于会话的事实。
 *
 * 它不占 hold。观看一个会话不让它保持运行——hold 表示有人在运行或修改它——所以这里的任何东西都不是 hub 判断会话能否关闭的输入。这个分离是承重的：如果订阅占一个 hold，一个开着窗口盯着空闲会话的浏览器就会让一个无人使用的 `Agent` 永远驻留。
 */
interface Subscription {
	/**
	 * 本订阅已经告诉浏览器的审批，按 `toolCallId`。
	 *
	 * 以"一个 `toolCallId` 在一个会话内唯一"为前提键控——与 `Agent.pendingApprovals` 相同的前提，由 provider 的 `tool_use` id 语义背书。两个会话碰巧共用一个 id 是另一回事，不是缺陷：answers 表先按会话键控，一个会话的答案永远不会到达另一个会话的窗口。
	 */
	pending: Map<string, PendingApproval>;
	/**
	 * baseline 发出之前产生的帧，baseline 发出后为 `null`。
	 *
	 * 数组表示"还欠一个 baseline"；`null` 表示已经发出。这个区分正是它不做长度判断的原因——两种状态下数组都合法地可以为空，而 baseline 之后空 backlog 是常态而非特例。
	 */
	backlog: ServerFrame[] | null;
	/**
	 * 所有要撤销的东西，按设置的顺序。
	 *
	 * 用列表而不是单个可重赋值的函数，原因在于这些事发生的顺序：`subscribe` 注册的同一拍就*同步*回调，所以订阅元素在这个订阅还没创建完之前就已挂上。一个每步包裹前一步的函数会被下一次赋值覆盖掉工作——而丢掉的恰好是订阅元素那半，正是让一个已结束的连接保持存活、还在为客户端已取消的订阅写帧的那半。
	 */
	teardown: (() => void)[];
}

/** 逻辑流上承载的东西：`ServerMessage` 一直承载的那些 payload。 */
type ServerMessageItem = ServerMessage;

/**
 * 一条连接上会话流的驱动面。
 *
 * `start` 与 `dispose` 是一条连接的开场与收场；`handle` 是它唯一的入口——一个上行帧。
 */
export interface SessionStream {
	/** 应用心跳 → overview（过滤隐藏目录）→ 注册全局订阅。顺序即现状。 */
	start(): Promise<void>;
	/** 一个上行帧：`open` / `cancel`。 */
	handle(text: string): void;
	/** 退掉所有会话订阅、摘全局订阅、让 wire 关闭。 */
	dispose(): void;
}

export function createSessionStream(
	wire: Wire,
	deps: { hub: SessionHub; projection: SessionProjection; answers: ApprovalAnswers },
): SessionStream {
	const { hub, projection, answers } = deps;

	/** 本连接正在观看的会话，按会话 id。每个会话一条流，绝无两条。 */
	const subscriptions = new Map<string, Subscription>();
	let disposed = false;
	/** 摘下全局列表订阅的那一步；`start` 成功之前为 `undefined`。 */
	let stopGlobal: (() => void) | undefined;

	/** 发送一帧；帧由 wire 写出，队列与停滞策略都在那里。 */
	const send = (frame: ServerFrame): void => {
		wire.send(frame);
	};

	/**
	 * 这条连接的窗口是否被允许看到一行。
	 *
	 * 规则是 hub 的（{@link SessionHub.listsDirectory}），过滤在这里施加，施加在一行到达窗口的两个点上：连接打开时的 overview，以及其后每一个变了的行。只过滤 overview，会让一个用户放到一边的目录在其某个会话一变的瞬间自己回来——自己回来的组比从未离开的更糟。
	 */
	const listed = (sessionRow: SessionRow): boolean => hub.listsDirectory(sessionRow.workDirAbsPath);

	/** 本连接的开场 overview：本进程列出的每一行，各一次。 */
	const overview = async (): Promise<SessionRow[]> => {
		const rows = await projection.rows();
		return rows.filter((sessionRow) => listed(sessionRow));
	};

	/** 本连接的开场 overview，或列表变动后的一份新的：它可能看到的那些行。 */
	const sendSessions = (rows: readonly SessionRow[]): void => {
		send({ streamId: null, item: { type: "sessions", sessions: [...rows] } });
	};

	/** 一行变了。整行发出，因为行很小、而整行替换是幂等的。 */
	const sendRow = (sessionRow: SessionRow): void => {
		send({ streamId: null, item: { type: "session_row", session: sessionRow } });
	};

	/** 一行消失了。id 就是全部 payload：丢弃它是客户端唯一能做的事。 */
	const sendGone = (sessionId: string): void => {
		send({ streamId: null, item: { type: "session_gone", sessionId } });
	};

	/**
	 * 给这条连接发一份新的 overview。
	 *
	 * 一行承载不了的那件事：目录进出列表是列表本身的变更，组没有对应的 `session_row`。重发 overview，就是让那条本来就说"这是机器的列表"的帧顺带说"……它动了"——与连接打开时收到的是同一帧，客户端不必为侧栏学第二种消息形状。
	 */
	const resync = async (): Promise<void> => {
		const rows = await overview();
		if (disposed) return;
		sendSessions(rows);
	};

	/**
	 * 把一帧放到本订阅的流上，baseline 还没发出时先扣住。
	 *
	 * backlog 是对设计里唯一可能出现的缝隙的回答：*冷*会话的会话记录必须从磁盘读，那是异步的，读取期间可能有东西被发布。扣到 baseline 发出、再按序冲刷，让保证与同步场景完全一致——客户端先看到状态，然后看到其后的每个变更，按发生顺序。
	 */
	const push = (sessionId: string, subscription: Subscription, item: ServerMessageItem): void => {
		const frame: ServerFrame = { streamId: sessionId, item };
		if (subscription.backlog === null) {
			send(frame);
			return;
		}
		subscription.backlog.push(frame);
	};

	/**
	 * 先发出 baseline，然后是堆积在它后面的一切。
	 *
	 * 每个 baseline 调一次：首次交付与重发都经 {@link baselineSink} 把 hub 交回的结果送进这里——
	 * 这一层不再知道它读的是袋还是盘。永远按产生顺序冲刷，客户端不可能看到会话记录往回跳。
	 */
	const writeBaseline = (sessionId: string, subscription: Subscription, snapshot: SessionSnapshot): void => {
		if (subscription.backlog === null) return;
		// baseline *替换*本订阅此前展示的东西，所以"一个读者正在屏幕上展示这个审批"的计数按差值移动——与 `pushApprovalChanges` 移动它们的方式相同。把集合再加一遍会把同一个读者数两次；先丢再加会扔掉一个已经为仍然悬着的问题记录下的答案。
		const current = new Map(snapshot.pendingApprovals.map((approval) => [approval.toolCallId, approval]));
		for (const toolCallId of subscription.pending.keys()) {
			if (!current.has(toolCallId)) answers.hide(sessionId, toolCallId);
		}
		for (const toolCallId of current.keys()) {
			if (!subscription.pending.has(toolCallId)) answers.show(sessionId, toolCallId);
		}
		subscription.pending = current;

		send({ streamId: sessionId, item: { type: "baseline", session: snapshot } });

		const backlog = subscription.backlog;
		subscription.backlog = null;
		for (const frame of backlog) send(frame);
	};

	/**
	 * 重发整个状态：这是对分支移动、以及对本连接已持有的观看上第二个 `open` 的应答。
	 *
	 * 重发不能重新订阅——那会多注册一个订阅元素——所以走 hub 的 `snapshotFor`：活冷分岔在那里完成，活半同步交回袋里的在飞状态（运行中途的第二个 `open` 因此带走正在写出的 `partial`，而不是盘上上一次落定的状态），冷半读盘后异步交回。
	 *
	 * 这里剩下的是帧序的本域。布防 backlog 让读盘期间到达的帧排在 baseline 之后：活半在同一同步块里布防又冲刷，等于没扣；冷半扣到读盘返回。已经欠着一份时不再要——那份 baseline 还在路上，再要一份只会让客户端多收一次同一状态，冷半还会多读一次盘；活半的同步交付同样受这条去重覆盖。
	 *
	 * 行为说明：重发经 {@link writeBaseline}，所以「正在展示哪些审批」的读者计数按新 baseline 的
	 * 集合移动，而不是再数一遍——与 {@link pushApprovalChanges} 的差值移动同一条规则。
	 */
	const pushBaseline = (sessionId: string, subscription: Subscription): void => {
		if (subscription.backlog !== null) return;
		subscription.backlog = [];
		hub.snapshotFor(sessionId, baselineSink(sessionId, subscription));
	};

	/**
	 * 一份 baseline 的着陆点：守卫，然后写出或报告失败。
	 *
	 * 首次交付与重发共用这一份，因为它们服从同一条规则：这份 baseline 还有人要吗。冷读盘在途
	 * 时可能落进 cancel、第二个 open 或断线，往一条已经结束、或已经换了订阅的流上写帧是更糟
	 * 的谎。守卫只写这一处；失败措辞仍归 {@link failBaseline}。
	 */
	const baselineSink = (sessionId: string, subscription: Subscription): SubscriptionSink => {
		const wanted = (): boolean => !disposed && subscriptions.get(sessionId) === subscription;
		return {
			onBaseline: (snapshot) => {
				if (!wanted()) return;
				writeBaseline(sessionId, subscription, snapshot);
			},
			onError: (error) => {
				if (!wanted()) return;
				failBaseline(sessionId, error);
			},
		};
	};

	/**
	 * `entry_appended` 所指的 entry，附上会话记录用于排序的时间戳。
	 *
	 * 时间戳随事件而来而不是在这里回读：这里对每条追加的消息只跑一次，而回读会话记录要解析整份日志只为一个数字（ADR-0013）。
	 */
	const pushEntry = (sessionId: string, subscription: Subscription, entryId: string, at: number | undefined): void => {
		push(sessionId, subscription, {
			type: "entry",
			entryId,
			...(typeof at === "number" ? { messageTimestamp: at } : {}),
		});
	};

	const pushStatus = (sessionId: string, subscription: Subscription, snapshot: SessionSnapshot): void => {
		push(sessionId, subscription, {
			type: "status",
			usage: snapshot.usage,
			running: snapshot.running,
			queued: snapshot.queued,
			isRetrying: snapshot.isRetrying,
			retryAttempt: snapshot.retryAttempt,
		});
	};

	/**
	 * 上报本订阅待审批集合的差量。
	 *
	 * 按订阅而不是按会话：每个窗口从自己的起点了解一个审批。消失的一个是已定案的——除非有东西为它记录过答案，否则视为*拒绝*——因为 abort 和关闭会话都会拒绝，这是诚实的默认值。
	 */
	const pushApprovalChanges = (sessionId: string, subscription: Subscription, snapshot: SessionSnapshot): void => {
		const current = new Map(snapshot.pendingApprovals.map((approval) => [approval.toolCallId, approval]));

		for (const [toolCallId, approval] of current) {
			if (subscription.pending.has(toolCallId)) continue;
			push(sessionId, subscription, { type: "approval_request", request: approval });
			answers.show(sessionId, approval.toolCallId);
		}
		for (const toolCallId of subscription.pending.keys()) {
			if (current.has(toolCallId)) continue;
			push(sessionId, subscription, {
				type: "approval_settled",
				toolCallId,
				approved: answers.wasApproved(sessionId, toolCallId),
			});
			answers.hide(sessionId, toolCallId);
		}

		subscription.pending.clear();
		for (const [toolCallId, approval] of current) subscription.pending.set(toolCallId, approval);
	};

	/**
	 * 一次 baseline 交付失败的应答：先带归因的 error，再是让尝试不至于继续看起来像一条安静流的 end。
	 *
	 * 归因措辞留在这一层——hub 只交原始 error，它不知道帧上的话怎么说。这里最常见的情形是 id 什么都不指，它自己那句话比一个读取失败更清楚。
	 *
	 * 「这份 baseline 还有人要吗」的守卫不在这里，它与成功那条共用 {@link baselineSink} 给出的同一处判断。
	 */
	const failBaseline = (sessionId: string, error: unknown): void => {
		const message = error instanceof UnknownSessionError ? `未知的会话：${sessionId}` : `读不出这个会话的记录：${describe(error)}`;
		failStream(sessionId, message);
	};

	/**
	 * 告诉客户端它的 `open` 没有成功，并结束这次尝试。
	 *
	 * 先 error 后 end：error 带归因，end 让尝试不至于继续看起来像一条只是安静的流。第一次 `open` 时客户端知道自己的请求失败了，因为那条流从未承载过 baseline。第二次——重发的 baseline 的读取发现会话已不在——流承载过一份，end 此时才是诚实的应答而不是误读：记录真的没了，没有什么可重开。
	 */
	const failStream = (sessionId: string, message: string): void => {
		send({ streamId: sessionId, error: { message } });
		endStream(sessionId);
	};

	/**
	 * 撤销一个订阅：它注册的每一步，后进先出。
	 *
	 * 逆序是因为这些步骤是一个栈——订阅是在观看注册之后挂上的，所以它也是更晚放下的东西。
	 */
	const teardown = (subscription: Subscription): void => {
		for (let index = subscription.teardown.length - 1; index >= 0; index -= 1) {
			subscription.teardown[index]?.();
		}
		subscription.teardown = [];
	};

	/**
	 * 结束一条逻辑流并忘记它。
	 *
	 * entry 在帧*之前*移除，因为 `end` 之后本连接对那个会话必须再无话可说——这就是这帧的全部含义，在它之后还看到任何东西的客户端将无法分辨那属于哪条流。
	 *
	 * 每个调用者结束的都是一条无话可说的流。第二个 `open` 曾经是唯一的例外，现在不是了：重复 `open` 的应答是在已有流上发一份 baseline（ADR-0009 决定 1），所以没有任何路径会为一个底层健康的订阅报告失败。
	 */
	const endStream = (sessionId: string): void => {
		const subscription = subscriptions.get(sessionId);
		if (subscription !== undefined) teardown(subscription);
		send({ streamId: sessionId, end: true });
	};

	/**
	 * 开始观看一个会话，或把本连接已持有的观看刷新到最新。
	 *
	 * `open` 的意思是"这个会话现在的状态，然后之后的一切"，且是幂等的（ADR-0009 决定 1）。本连接*已经在看*的会话因此不算错：应答是在已有的流上再发一份 baseline，底下的订阅原样保留——同样的订阅元素、同样的审批、同一条流。这才让"窗格在别处仍持有会话时消失、又回来了"能工作：引用计数意味着没有发过 `cancel`，回来这一程唯一能应答它的就是重发的 baseline。
	 *
	 * 不存在的会话仍然是客户端的错，但应答写在它相关的流上——一个带归因的 `error` 帧，然后一个 `end`，让失败的尝试不至于继续看起来像一条只是安静的流——而连接本身无论哪种情况都不受影响。
	 */
	const open = (sessionId: string): void => {
		const watching = subscriptions.get(sessionId);
		if (watching !== undefined) {
			pushBaseline(sessionId, watching);
			return;
		}

		const subscription: Subscription = { pending: new Map(), backlog: [], teardown: [] };
		subscriptions.set(sessionId, subscription);

		// 观看不占 hold，这一点始终是全部关键：计数属于改变或运行会话的调用者，而看着它的窗口两者都不是。注册的同一拍订阅元素就已在表里——分发按 id 进行，对冷会话同样成立——所以该会话开始运行的那一刻，事件自然流入，无需任何重绑。

		// no-gap 的两半在这里合缝。hub 保证「注册与快照原子」（机制与论证见 hub.ts 的 `subscribe`）；
		// 本层保证「baseline 帧先于本订阅 backlog 里的任何帧写出」——`subscribe` 返回前 `baseline` 已
		// 同步回调，回调里同步 `send`，而不是先攒着等一拍。两半之间的缝是：hub 只交结果（快照或
		// 原始 error），帧序与失败措辞由这里决定；冷半的读盘在 hub 内异步，跨过的那段由 backlog 扣住。
		const stopWatching = hub.subscribe(sessionId, {
			baseline: (snapshot) => writeBaseline(sessionId, subscription, snapshot),
			baselineFailed: (error) => failBaseline(sessionId, error),
			event: (event) => {
				push(sessionId, subscription, { type: "event", event });
				// 叶子移动改变整条会话记录，所以为它发出的是会话的当前状态而不是差异：事件说树动了，这帧说动到了哪里。
				if (event.type === "branch_changed") pushBaseline(sessionId, subscription);
				if (event.type === "entry_appended") pushEntry(sessionId, subscription, event.entryId, event.at);
			},
			state: (snapshot) => {
				pushStatus(sessionId, subscription, snapshot);
				// 待审批和其他变更一样以 change 发布，所以窗口就是在这里学会显示横幅的。baseline 只负责播种已经在等的那些。
				pushApprovalChanges(sessionId, subscription, snapshot);
			},
			// 只在会话被删除（或进程收摊）时到达；观看中的流以 end 作别。
			gone: () => endStream(sessionId),
			// 一次运行在会话自己的流上说的那句失败（`publishFailure`）：只发给观看中的流，没有读者就没有帧。
			failure: (message) => {
				// 不需要再查 `subscriptions`：hub 只把 `failure` 交给这个会话的订阅者，而本回调正是
				// 订阅元素自己被调用的那一拍——元素在表里才会被调到，退订与 `subscriptions.delete` 同时发生。
				send({ streamId: sessionId, item: { type: "error", message } });
			},
		});

		// 刻意在 `subscribe` 调用之后注册，且追加而不是赋值：`subscribe` 返回前的同步回调可能已经写过帧，这一步不能把它挤掉。见 `Subscription.teardown`。
		subscription.teardown.push(() => {
			stopWatching();
			// 这个订阅还在展示的任何东西，这里都不会再有人上报了：一个只等已消失读者的应答，是一个没有理由留着的应答。
			for (const toolCallId of subscription.pending.keys()) answers.hide(sessionId, toolCallId);
			subscription.pending.clear();
			subscription.backlog = null;
			subscriptions.delete(sessionId);
		});
	};

	/**
	 * 停止观看一个会话。
	 *
	 * 丢弃订阅的唯一含义是"这条连接上不再有这个会话的帧"——不是"停止运行"，不是"关闭会话"，不是"释放任何东西"。hold 通道已随簿记迁入 SessionManager 而退场（ADR-0023），会话的改变归 Manager 的文件闸，订阅与它毫无换算；从这个窗口发起的运行照常跑完，窗口才能在会话仍在应答时离开——而删除也不再因有人在看而止步：否决式删除先停运行、闸内删文件。
	 *
	 * 没有应答：客户端的意图在发出 `cancel` 时就完整了，回复会是一帧写在它刚刚声明不想要的流上。
	 */
	const cancel = (sessionId: string): void => {
		const subscription = subscriptions.get(sessionId);
		if (subscription !== undefined) teardown(subscription);
	};

	return {
		async start(): Promise<void> {
			if (disposed) return;
			// 先发一个心跳，刻意为之：它是客户端看门狗在等的那一帧，所以发出过它的连接已经是客户端可以当作活着的连接。overview 随后跟上，socket 的写出顺序就是到达顺序。
			wire.heartbeat();
			sendSessions(await overview());
			if (disposed) return;
			// overview 是一条从不被 open、从不被 cancel 的连接层流，所以它由唯一知道一行变了的地方供数，而不是由某张订阅表。
			stopGlobal = hub.subscribeGlobal({
				rows: (sessionRow) => {
					if (!listed(sessionRow)) return;
					sendRow(sessionRow);
				},
				gone: (sessionId) => sendGone(sessionId),
				resync: () => {
					void resync();
				},
			});
		},

		/**
		 * 处理一个上行帧。
		 *
		 * `open` 是有趣的一个：订阅与活半 baseline 在 hub 的同一个同步块里完成——entry 被创建、订阅元素被挂上、快照被交回、baseline 被写出，中间没有 `await`。这才让"baseline 与增量之间没有缝隙"由构造成立而非靠论证成立——不存在这样一个时刻：读取会话状态与开始监听之间恰好插进一个变更。
		 */
		handle(text: string): void {
			if (disposed) return;
			const frame: ClientFrame | undefined = parseClientFrame(text);
			if (frame === undefined) {
				// 丢弃而不是致命错误，记日志而不是沉默。见 `parseClientFrame`：一帧读不懂的东西不能让一个窗口赔上整条连接。
				wire.log(`mux: 丢弃一帧看不懂的上行帧（${text.length} 字节）`);
				return;
			}
			if (frame.type === "open") open(frame.sessionId);
			else cancel(frame.sessionId);
		},

		/**
		 * 放弃所有订阅并停止。
		 *
		 * 订阅先行，让它们在任何东西试图关闭它们正在观看的会话之前从 hub 退订。被丢弃的连接是一个永远不会被应答的客户端，它持有的每个订阅都在这里放弃：与 `cancel`、刷新、断线同一种等价处理。幂等：mux 的外部 `close()` 与 wire 自关走同一条收尾路径。
		 */
		dispose(): void {
			if (disposed) return;
			disposed = true;
			stopGlobal?.();
			stopGlobal = undefined;
			for (const subscription of [...subscriptions.values()]) teardown(subscription);
			subscriptions.clear();
			wire.close();
		},
	};
}

/**
 * 出了什么问题，用客户端能展示的话说。
 *
 * 只有 `Error` 一种情况值得关心：读取失败带着它自己的消息，那本来就是一句能对客户端说出口的话。其余都是 bug，按 bug 命名而不是插值——帧不是把堆栈递给浏览器的地方。
 */
function describe(error: unknown): string {
	return error instanceof Error ? error.message : "未知的错误";
}
