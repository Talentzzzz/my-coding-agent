import type {
	ClientFrame,
	PendingApproval,
	ServerFrame,
	ServerMessage,
	SessionRow,
	SessionSnapshot,
} from "@my-agent/core/protocol";
import { UnknownSessionError } from "@my-agent/core";
import { parseClientFrame } from "./http/client-frame.ts";
import type { SessionFeeds, SessionHub, SubscriptionSink } from "./hub.ts";
import type { SessionProjection } from "./projection.ts";

/**
 * 服务器判定客户端已停止应答前等待的时长。
 *
 * RFC 6455 没有给 Pong 设自己的期限——服务器想 ping 多勤都行——所以间隔和容忍度是这一层自己的选择。两秒一次、容忍两次未应答，也就是说*第三次*未应答的 ping 才会终结一条连接：大约六秒。
 *
 * 容忍两次而不是一次并非保守。RFC 6455 §5.5.3 明确允许 peer 只应答它收到的*最后*一个 ping，所以批量回复的客户端是守规矩的，容忍度为 1 会让健康的连接纯粹因为时序而死。
 *
 * 误杀的代价是一次重连加一份新 baseline，而不是一个错误的答案。
 */
const PING_INTERVAL_MS = 2_000;

/** 多少个 ping 未被应答后连接被丢弃。 */
const MAX_MISSED_PONGS = 2;

/**
 * 每条连接每隔多久被告知一次"通道还活着"，用一帧完成。
 *
 * 与上面的 ping 分开，因为它们的读者不同，也没有别的理由必须一致。Pong 只有这里可见——浏览器永远看不到一个——所以它不可能是客户端读超时所监视的东西。这个帧才是客户端监视的对象，它存在的原因是浏览器的 WebSocket API 不提供任何等价的信号。
 *
 * 五秒，且刻意不是 ping 间隔的倍数：两个定时器回答的是不同的问题，让其中一个成为另一个的函数，会诱使后来的读者把 Pong 当成客户端安好的证明——恰恰是让 SSE 心跳失去价值的那个假设。
 */
const HEARTBEAT_INTERVAL_MS = 5_000;

/** 停止接受写入的连接背后允许积压多少字节。 */
const STALL_BUDGET_BYTES = 4 * 1024 * 1024;

/**
 * 一条停滞的连接在关闭前允许停滞多久。
 *
 * 与 {@link STALL_BUDGET_BYTES} 同一预算的另一半，也是真正会触发的那一半。停止读取的 peer 会在几个 frame 内填满它的 socket 缓冲，所以字节上限只有"读得慢"的 peer 才会触到；完全停滞的 peer 的实测行为是队列在几十 KB 处走平、然后期限到期。
 *
 * 它必须小于客户端的读超时（十五秒），这个先后顺序就是全部要点：一条停止移动的通道应该以*服务器*的 close 收场，让客户端立刻在一条它已经知道坏掉的通道上重连，而不是靠等自己的看门狗发现问题。
 */
const STALL_DEADLINE_MS = 10_000;

/** RFC 6455 §7.4.1："稍后再试"。停滞连接以此关闭。 */
const CLOSE_TRY_AGAIN_LATER = 1013;

/** RFC 6455 §7.4.1：离开。正在关闭的服务器以此关闭。 */
const CLOSE_GOING_AWAY = 1001;

/**
 * 与那些 code 配套的 reason，集中在一处，因为它们是同一类字符串。
 *
 * 刻意用英文：Close reason 的读者是决定下一步怎么做的客户端，而且它与客户端自己发送的 `4000 "reconnect requested"` 之类的 code 并排出现。本文件里的中文是给读代码的人看的——本层唯一会打的那行日志——而那行日志刻意不是 wire 上的那条。
 */
const REASON_STOPPED_READING = "subscription client stopped reading";
const REASON_SHUTTING_DOWN = "server is shutting down";

/**
 * 本层写入的对象，让队列可以在没有 socket 的情况下测试。
 *
 * 四个成员，恰好是策略需要的四个：socket 还收不收、如何问它一个协议层的问题、如何礼貌地关闭、以及停止应答时如何丢弃。再多一点就是这条缝伪装不了的 socket 了——这正是这条缝存在的意义。
 */
export interface FrameSink {
	/**
	 * 写一帧。
	 *
	 * 返回 socket 自己的 `write()` 返回的值。`false` 意味着这条连接不再能被直接写入，它是整个停滞策略赖以成立的唯一信号。
	 */
	send(frame: ServerFrame): boolean;
	/** 向 peer 问一个它必须应答的协议层问题。 */
	ping(): void;
	/** 礼貌地关闭，带上 peer 将看到的 code 和 reason。 */
	close(code: number, reason: string): void;
	/** 不等 peer，直接丢弃连接。 */
	terminate(): void;
	/** 这个 sink 是否已结束，无论由谁结束。 */
	readonly isClosed: boolean;
}

/**
 * 本层的定时器和预算如何度量。
 *
 * 之所以是选项，只是为了让 smoke 用毫秒驱动它们；生产中没有任何东西设置它。与 `HubOptions.approvalGraceMs` 理由相同：测试够不到的定时器就是测试检查不了的定时器，而用 sleep 去够会让测试套件又慢又飘。
 */
export interface MuxOptions {
	/** 见 {@link PING_INTERVAL_MS}。 */
	pingIntervalMs?: number;
	/** 见 {@link MAX_MISSED_PONGS}。 */
	maxMissedPongs?: number;
	/** 见 {@link HEARTBEAT_INTERVAL_MS}。 */
	heartbeatIntervalMs?: number;
	/** 见 {@link STALL_BUDGET_BYTES}。 */
	stallBudgetBytes?: number;
	/** 见 {@link STALL_DEADLINE_MS}。 */
	stallDeadlineMs?: number;
	/** 关于停滞连接的那一行日志的去处。默认是 console。 */
	log?: (line: string) => void;
}

/** 所有选项解析完毕后的形态，连接和服务器实际接收的就是它。 */
export type ResolvedMuxOptions = Required<MuxOptions>;

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
	 * 用列表而不是单个可重赋值的函数，原因在于这些事发生的顺序：`subscribe` 注册的同一拍就*同步*回调，所以 feed 在这个订阅还没创建完之前就已挂上。一个每步包裹前一步的函数会被下一次赋值覆盖掉工作——而丢掉的恰好是 feed 监听器那半，正是让一个已结束的连接保持存活、还在为客户端已取消的订阅写帧的那半。
	 */
	teardown: (() => void)[];
}

/**
 * 一个客户端连接：一张订阅表、一个有界写队列，以及判定 peer 是否仍在应答的计数器。
 *
 * 连接的生命周期是连接本身，不是任何一次运行。它活得比它上面的每个订阅、它们观看的每个会话的每一轮都久，只在 peer 离开或本服务器判定它已离开时结束——这才让一个窗口同时看多个会话，而不是在会话之间反复重连。
 */
export class MuxConnection {
	/** 本连接正在观看的会话，按会话 id。每个会话一条流，绝无两条。 */
	private readonly subscriptions = new Map<string, Subscription>();
	/**
	 * 未能写入的帧，最旧的在前。
	 *
	 * 这个队列存在是因为无处反压。事件由 agent loop 产生、在这一层推入；把 `send` 变成 awaitable 会把那个等待传染进一个不许改动的 vendored loop，于是一个暂停的浏览器会拖住模型而不是窗口。缓冲让 loop 继续跑，把代价放在连接上——唯一付得起的一方。
	 */
	private readonly queue: ServerFrame[] = [];
	/** 队列当前占用的字节数，让预算是一个比较而不是一次求和。 */
	private queuedBytes = 0;
	/** socket 是否已停止接受写入，之后的一切必须排队等轮次。 */
	private stalled = false;
	/** socket 停止接受的时刻，期限从这里起算。 */
	private stalledSince = 0;
	/** 期限定时器，没有在等的时候为 null。 */
	private stallTimer: NodeJS.Timeout | null = null;
	/** 上一次 Pong 到达以来发出的 ping 数。 */
	private missedPongs = 0;
	private closed = false;

	private readonly sink: FrameSink;
	private readonly hub: SessionHub;
	private readonly options: ResolvedMuxOptions;
	private readonly answers: ApprovalAnswers;

	constructor(
		sink: FrameSink,
		hub: SessionHub,
		options: ResolvedMuxOptions,
		answers: ApprovalAnswers,
	) {
		this.sink = sink;
		this.hub = hub;
		this.options = options;
		this.answers = answers;
	}

	/**
	 * 发送一帧，连接停止接受写入时入队。
	 *
	 * 同步且 `void`，这是服务器其余部分所依赖的接口，而不是一个简化。一次运行的帧产自 agent loop 内部，它没有任何 await 的手段；把这变成 promise 意味着每个调用点都得变 async，loop 还得了解某个窗口的 backpressure。
	 *
	 * 正常路径就是一次 `write()` 加一个返回：没有拷贝、没有 promise、没有定时器。
	 */
	send(frame: ServerFrame): void {
		if (this.closed) return;

		// 停滞的连接在新帧加入前先泵一次，让队列保持有序，也让中途恢复的连接不必排在一个本可以立刻吃下的突发后面。
		if (this.stalled) this.pump();
		if (this.stalled) {
			this.enqueue(frame);
			return;
		}
		if (this.sink.send(frame)) return;

		// `false` 意味着这帧已被收进 socket 自己的缓冲、排队在*那里*，所以绝不能重写，否则会送达两次。从这一刻起连接算作停滞，这帧之后的一切都要等。
		this.markStalled();
	}

	/**
	 * 处理一个上行帧。
	 *
	 * `open` 是有趣的一个：订阅与活半 baseline 在 hub 的同一个同步块里完成——entry 被创建、feed 被挂上、快照被交回、baseline 被写出，中间没有 `await`。冷半的读盘也在 hub 内完成，只是异步，跨过的那段时间由本订阅的 backlog 扣住。这才让"baseline 与增量之间没有缝隙"由构造成立而非靠论证成立——不存在这样一个时刻：读取会话状态与开始监听之间恰好插进一个变更。
	 */
	handle(text: string): void {
		if (this.closed) return;
		const frame: ClientFrame | undefined = parseClientFrame(text);
		if (frame === undefined) {
			// 丢弃而不是致命错误，记日志而不是沉默。见 `parseClientFrame`：一帧读不懂的东西不能让一个窗口赔上整条连接。
			this.options.log(`mux: 丢弃一帧看不懂的上行帧（${text.length} 字节）`);
			return;
		}
		if (frame.type === "open") this.open(frame.sessionId);
		else this.cancel(frame.sessionId);
	}

	/**
	 * 开始观看一个会话，或把本连接已持有的观看刷新到最新。
	 *
	 * `open` 的意思是"这个会话现在的状态，然后之后的一切"，且是幂等的（ADR-0009 决定 1）。本连接*已经在看*的会话因此不算错：应答是在已有的流上再发一份 baseline，底下的订阅原样保留——同样的 feed、同样的审批、同一条流。这才让"窗格在别处仍持有会话时消失、又回来了"能工作：引用计数意味着没有发过 `cancel`，回来这一程唯一能应答它的就是重发的 baseline。
	 *
	 * 不存在的会话仍然是客户端的错，但应答写在它相关的流上——一个带归因的 `error` 帧，然后一个 `end`，让失败的尝试不至于继续看起来像一条只是安静的流——而连接本身无论哪种情况都不受影响。
	 */
	private open(sessionId: string): void {
		const watching = this.subscriptions.get(sessionId);
		if (watching !== undefined) {
			this.pushBaseline(sessionId, watching);
			return;
		}

		const subscription: Subscription = { pending: new Map(), backlog: [], teardown: [] };
		this.subscriptions.set(sessionId, subscription);

		// 观看不占 hold，这一点始终是全部关键：计数属于改变或运行会话的调用者，而看着它的窗口两者都不是。注册的同一拍就交出 feed——分发按 id 进行，对冷会话同样成立——所以该会话开始运行的那一刻，事件自然流入，无需任何重绑。
		let live = false;

		// no-gap 的两半在这里合缝。hub 保证「注册与快照原子」：`subscribe` 在返回前的同一个同步块里
		// 注册 watcher、判定活冷、交付活半的 baseline（机制与论证见 hub.ts 的 `subscribe`）；mux
		// 保证「baseline 帧先于本订阅 backlog 里的任何帧写出」——`subscribe` 返回前 `onBaseline` 已
		// 同步回调，回调里同步 `send`，而不是先攒着等一拍，所以任何 emit 只能落在下一个事件循环
		// 拍，那时 baseline 早已排在前面。两半之间的缝是：hub 只交结果（快照或原始 error），帧序
		// 与失败措辞由这里决定；冷半的读盘在 hub 内异步，跨过的那段由 backlog 扣住。
		const stopWatching = this.hub.subscribe(
			sessionId,
			(feeds) => {
				if (feeds === undefined) {
					// undefined 只在会话被删除（或进程收摊）时到达；观看中的流以 end 作别。
					if (live) this.endStream(sessionId);
					return;
				}
				live = true;
				this.bind(sessionId, subscription, feeds);
			},
			this.baselineSink(sessionId, subscription),
		);

		// 刻意在 `subscribe` 调用之后注册，且追加而不是赋值：`bind` 可能已经追加了 feed 的退订器，这一步不能挤掉它们。见 `Subscription.teardown`。
		subscription.teardown.push(() => {
			stopWatching();
			// 这个订阅还在展示的任何东西，这里都不会再有人上报了：一个只等已消失读者的应答，是一个没有理由留着的应答。
			for (const toolCallId of subscription.pending.keys()) this.answers.hide(sessionId, toolCallId);
			subscription.pending.clear();
			subscription.backlog = null;
			this.subscriptions.delete(sessionId);
		});
	}

	/**
	 * 撤销一个订阅：它注册的每一步，后进先出。
	 *
	 * 逆序是因为这些步骤是一个栈——feed 是在观看注册之后挂上的，所以它们也是更晚放下的东西。
	 */
	private teardown(subscription: Subscription): void {
		for (let index = subscription.teardown.length - 1; index >= 0; index -= 1) {
			subscription.teardown[index]?.();
		}
		subscription.teardown = [];
	}

	/**
	 * 停止观看一个会话。
	 *
	 * 丢弃订阅的唯一含义是"这条连接上不再有这个会话的帧"——不是"停止运行"，不是"关闭会话"，不是"释放任何东西"。hold 通道已随簿记迁入 SessionManager 而退场（ADR-0023），会话的改变归 Manager 的文件闸，订阅与它毫无换算；从这个窗口发起的运行照常跑完，窗口才能在会话仍在应答时离开——而删除也不再因有人在看而止步：否决式删除先停运行、闸内删文件。
	 *
	 * 没有应答：客户端的意图在发出 `cancel` 时就完整了，回复会是一帧写在它刚刚声明不想要的流上。
	 */
	private cancel(sessionId: string): void {
		const subscription = this.subscriptions.get(sessionId);
		if (subscription !== undefined) this.teardown(subscription);
	}

	/**
	 * 把订阅绑到一个会话的 feed 上。
	 *
	 * `subscribe` 注册的同一拍同步回调，于是 attach 与活半的 baseline 落在同一段没有 `await` 的同步代码块里。no-gap 保证就是围绕这个场景构建的；冷半的读盘在 hub 内异步，{@link push} 的 backlog 是为它买单的东西。
	 */
	private bind(sessionId: string, subscription: Subscription, feeds: SessionFeeds): void {
		const onEvent = feeds.onEvent((event) => {
			this.push(sessionId, subscription, { type: "event", event });
			// 叶子移动改变整条会话记录，所以为它发出的是会话的当前状态而不是差异：事件说树动了，这帧说动到了哪里。
			if (event.type === "branch_changed") this.pushBaseline(sessionId, subscription);
			if (event.type === "entry_appended") this.pushEntry(sessionId, subscription, event.entryId, event.at);
		});

		const onChange = feeds.onChange((snapshot) => {
			this.pushStatus(sessionId, subscription, snapshot);
			// 待审批和其他变更一样以 change 发布，所以窗口就是在这里学会显示横幅的。baseline 只负责播种已经在等的那些。
			this.pushApprovalChanges(sessionId, subscription, snapshot);
		});

		// 永远追加，从不赋值——见 `Subscription.teardown`。
		subscription.teardown.push(() => {
			onEvent();
			onChange();
		});
	}

	/**
	 * 把一帧放到本订阅的流上，baseline 还没发出时先扣住。
	 *
	 * backlog 是对设计里唯一可能出现的缝隙的回答：*冷*会话的会话记录必须从磁盘读，那是异步的，读取期间可能有东西被发布。扣到 baseline 发出、再按序冲刷，让保证与同步场景完全一致——客户端先看到状态，然后看到其后的每个变更，按发生顺序。
	 */
	private push(sessionId: string, subscription: Subscription, item: ServerMessageItem): void {
		const frame: ServerFrame = { streamId: sessionId, item };
		if (subscription.backlog === null) {
			this.send(frame);
			return;
		}
		subscription.backlog.push(frame);
	}

	/**
	 * 先发出 baseline，然后是堆积在它后面的一切。
	 *
	 * 每个 baseline 调一次：首次交付与重发都经 {@link baselineSink} 把 hub 交回的结果送进这里——
	 * 这一层不再知道它读的是袋还是盘。永远按产生顺序冲刷，客户端不可能看到会话记录往回跳。
	 */
	private writeBaseline(sessionId: string, subscription: Subscription, snapshot: SessionSnapshot): void {
		if (subscription.backlog === null) return;
		// baseline *替换*本订阅此前展示的东西，所以"一个读者正在屏幕上展示这个审批"的计数按差值移动——与 `pushApprovalChanges` 移动它们的方式相同。把集合再加一遍会把同一个读者数两次；先丢再加会扔掉一个已经为仍然悬着的问题记录下的答案。
		const current = new Map(snapshot.pendingApprovals.map((approval) => [approval.toolCallId, approval]));
		for (const toolCallId of subscription.pending.keys()) {
			if (!current.has(toolCallId)) this.answers.hide(sessionId, toolCallId);
		}
		for (const toolCallId of current.keys()) {
			if (!subscription.pending.has(toolCallId)) this.answers.show(sessionId, toolCallId);
		}
		subscription.pending = current;

		this.send({ streamId: sessionId, item: { type: "baseline", session: snapshot } });

		const backlog = subscription.backlog;
		subscription.backlog = null;
		for (const frame of backlog) this.send(frame);
	}

	/**
	 * 重发整个状态：这是对分支移动、以及对本连接已持有的观看上第二个 `open` 的应答。
	 *
	 * 重发不能重新订阅——那会多挂一条 feed——所以走 hub 的 `rebaseline`：活冷分岔在那里完成，活半同步交回袋里的在飞状态（运行中途的第二个 `open` 因此带走正在写出的 `partial`，而不是盘上上一次落定的状态），冷半读盘后异步交回。
	 *
	 * 这里剩下的是帧序的本域。布防 backlog 让读盘期间到达的帧排在 baseline 之后：活半在同一同步块里布防又冲刷，等于没扣；冷半扣到读盘返回。已经欠着一份时不再要——那份 baseline 还在路上，再要一份只会让客户端多收一次同一状态，冷半还会多读一次盘；活半的同步交付同样受这条去重覆盖。
	 *
	 * 行为说明：重发经 {@link writeBaseline}，所以「正在展示哪些审批」的读者计数按新 baseline 的
	 * 集合移动，而不是再数一遍——与 {@link pushApprovalChanges} 的差值移动同一条规则。
	 */
	private pushBaseline(sessionId: string, subscription: Subscription): void {
		if (subscription.backlog !== null) return;
		subscription.backlog = [];
		this.hub.rebaseline(sessionId, this.baselineSink(sessionId, subscription));
	}

	/**
	 * 一份 baseline 的着陆点：守卫，然后写出或报告失败。
	 *
	 * 首次交付与重发共用这一份，因为它们服从同一条规则：这份 baseline 还有人要吗。冷读盘在途
	 * 时可能落进 cancel、第二个 open 或断线，往一条已经结束、或已经换了订阅的流上写帧是更糟
	 * 的谎。守卫只写这一处；失败措辞仍归 {@link failBaseline}。
	 */
	private baselineSink(sessionId: string, subscription: Subscription): SubscriptionSink {
		const wanted = (): boolean => !this.closed && this.subscriptions.get(sessionId) === subscription;
		return {
			onBaseline: (snapshot) => {
				if (!wanted()) return;
				this.writeBaseline(sessionId, subscription, snapshot);
			},
			onError: (error) => {
				if (!wanted()) return;
				this.failBaseline(sessionId, error);
			},
		};
	}

	/**
	 * `entry_appended` 所指的 entry，附上会话记录用于排序的时间戳。
	 *
	 * 时间戳随事件而来而不是在这里回读：这里对每条追加的消息只跑一次，而回读会话记录要解析整份日志只为一个数字（ADR-0013）。
	 */
	private pushEntry(sessionId: string, subscription: Subscription, entryId: string, at: number | undefined): void {
		this.push(sessionId, subscription, {
			type: "entry",
			entryId,
			...(typeof at === "number" ? { messageTimestamp: at } : {}),
		});
	}

	private pushStatus(sessionId: string, subscription: Subscription, snapshot: SessionSnapshot): void {
		this.push(sessionId, subscription, {
			type: "status",
			usage: snapshot.usage,
			running: snapshot.running,
			queued: snapshot.queued,
			isRetrying: snapshot.isRetrying,
			retryAttempt: snapshot.retryAttempt,
		});
	}

	/**
	 * 上报本订阅待审批集合的差量。
	 *
	 * 按订阅而不是按会话：每个窗口从自己的起点了解一个审批。消失的一个是已定案的——除非有东西为它记录过答案，否则视为*拒绝*——因为 abort 和关闭会话都会拒绝，这是诚实的默认值。
	 */
	private pushApprovalChanges(sessionId: string, subscription: Subscription, snapshot: SessionSnapshot): void {
		const current = new Map(snapshot.pendingApprovals.map((approval) => [approval.toolCallId, approval]));

		for (const [toolCallId, approval] of current) {
			if (subscription.pending.has(toolCallId)) continue;
			this.push(sessionId, subscription, { type: "approval_request", request: approval });
			this.answers.show(sessionId, approval.toolCallId);
		}
		for (const toolCallId of subscription.pending.keys()) {
			if (current.has(toolCallId)) continue;
			this.push(sessionId, subscription, {
				type: "approval_settled",
				toolCallId,
				approved: this.answers.wasApproved(sessionId, toolCallId),
			});
			this.answers.hide(sessionId, toolCallId);
		}

		subscription.pending.clear();
		for (const [toolCallId, approval] of current) subscription.pending.set(toolCallId, approval);
	}

	/**
	 * 一次 baseline 交付失败的应答：先带归因的 error，再是让尝试不至于继续看起来像一条安静流的 end。
	 *
	 * 归因措辞留在这一层——hub 只交原始 error，它不知道帧上的话怎么说。这里最常见的情形是 id 什么都不指，它自己那句话比一个读取失败更清楚。
	 *
	 * 「这份 baseline 还有人要吗」的守卫不在这里，它与成功那条共用 {@link baselineSink} 给出的同一处判断。
	 */
	private failBaseline(sessionId: string, error: unknown): void {
		const message = error instanceof UnknownSessionError ? `未知的会话：${sessionId}` : `读不出这个会话的记录：${describe(error)}`;
		this.failStream(sessionId, message);
	}

	/**
	 * 告诉客户端它的 `open` 没有成功，并结束这次尝试。
	 *
	 * 先 error 后 end：error 带归因，end 让尝试不至于继续看起来像一条只是安静的流。第一次 `open` 时客户端知道自己的请求失败了，因为那条流从未承载过 baseline。第二次——重发的 baseline 的读取发现会话已不在——流承载过一份，end 此时才是诚实的应答而不是误读：记录真的没了，没有什么可重开。
	 */
	private failStream(sessionId: string, message: string): void {
		this.send({ streamId: sessionId, error: { message } });
		this.endStream(sessionId);
	}

	/**
	 * 结束一条逻辑流并忘记它。
	 *
	 * entry 在帧*之前*移除，因为 `end` 之后本连接对那个会话必须再无话可说——这就是这帧的全部含义，在它之后还看到任何东西的客户端将无法分辨那属于哪条流。
	 *
	 * 每个调用者结束的都是一条无话可说的流。第二个 `open` 曾经是唯一的例外，现在不是了：重复 `open` 的应答是在已有流上发一份 baseline（ADR-0009 决定 1），所以没有任何路径会为一个底层健康的订阅报告失败。
	 */
	private endStream(sessionId: string): void {
		const subscription = this.subscriptions.get(sessionId);
		if (subscription !== undefined) this.teardown(subscription);
		this.send({ streamId: sessionId, end: true });
	}

	/** 对本连接上每个正在观看某会话的流说同一句话。 */
	announce(sessionId: string, message: string): void {
		if (!this.subscriptions.has(sessionId)) return;
		this.send({ streamId: sessionId, item: { type: "error", message } });
	}

	/** 本连接的开场 overview，或列表变动后的一份新的：它可能看到的那些行。 */
	sendSessions(rows: readonly SessionRow[]): void {
		this.send({ streamId: null, item: { type: "sessions", sessions: [...rows] } });
	}

	/** 一行变了。整行发出，因为行很小、而整行替换是幂等的。 */
	sendRow(sessionRow: SessionRow): void {
		this.send({ streamId: null, item: { type: "session_row", session: sessionRow } });
	}

	/** 一行消失了。id 就是全部 payload：丢弃它是客户端唯一能做的事。 */
	sendGone(sessionId: string): void {
		this.send({ streamId: null, item: { type: "session_gone", sessionId } });
	}

	/** 应用层的存活帧。按构造就是连接层的：没有 stream id。 */
	heartbeat(): void {
		this.send({ streamId: null, item: { type: "heartbeat", everyMs: this.options.heartbeatIntervalMs } });
	}

	/**
	 * 协议层存活问题的一轮。
	 *
	 * 先计一次未应答，只有计数仍在可容忍范围内才真的 ping，所以超出容忍度的连接在退场的路上不会再被 ping。丢弃用 `terminate` 而不是 `close`：停止应答 Pong 的 peer 也不会读 Close 帧，等它等于等一个已经不在的东西。
	 */
	tick(): void {
		if (this.closed) return;
		if (this.missedPongs >= this.options.maxMissedPongs) {
			this.options.log("mux: 客户端连续未回应 Ping，关闭连接");
			this.sink.terminate();
			this.close();
			return;
		}
		this.missedPongs += 1;
		this.sink.ping();
	}

	/** 一个 Pong 到达：peer 活着，计数清零重来。 */
	notePong(): void {
		this.missedPongs = 0;
	}

	/** 有多少个 ping 未被应答。 */
	get missed(): number {
		return this.missedPongs;
	}

	/** 停止接受写入的连接背后积压了多少字节。 */
	get queuedByteLength(): number {
		return this.queuedBytes;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/**
	 * 放弃所有订阅并停止。
	 *
	 * 订阅先行，让它们的 feed 在任何东西试图关闭它们正在观看的会话之前释放。被丢弃的连接是一个
	 * 永远不会被应答的客户端，它持有的每个订阅都在这里放弃：与 `cancel`、刷新、断线同一种等价处理。
	 */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const subscription of [...this.subscriptions.values()]) this.teardown(subscription);
		this.subscriptions.clear();
		this.queue.length = 0;
		this.queuedBytes = 0;
		// 停滞的簿记一并清掉，让关闭后接受检视的连接报告一个已了结的状态，而不是一副还在等一个永远不会排空的 socket 的样子。
		this.stalled = false;
		this.stalledSince = 0;
		this.clearStallTimer();
	}

	/**
	 * 记住 socket 停止了接受写入。
	 *
	 * 时钟从这里起算，而不是队列第一次有东西的时刻，因为那是同一瞬间——得到 `false` 的那帧已经在 socket 缓冲里，下一个才是本层持有的第一帧，两种读法最多差一帧。
	 */
	private markStalled(): void {
		if (this.stalled) return;
		this.stalled = true;
		this.stalledSince = Date.now();
		this.stallTimer = setTimeout(() => this.onStallDeadline(), this.options.stallDeadlineMs);
		// 等一个可能永不回来的 peer 的定时器，不能成为进程保持存活的理由。
		this.stallTimer.unref();
	}

	/** 扣住一帧，并强制执行预算的两半。 */
	private enqueue(frame: ServerFrame): void {
		this.queue.push(frame);
		this.queuedBytes += sizeOf(frame);
		if (this.queuedBytes > this.options.stallBudgetBytes) this.onStallDeadline();
	}

	/**
	 * 按序写出队列里的东西，直到 socket 再次拒绝。
	 *
	 * 触发条件是"这次尝试成功了"，而不是 `'drain'` 事件。这里没有任何东西监听它，停滞中途连接结束时也就没有监听器可泄漏，也不用第二个定时器与第一个保持步调：下一次尝试就是这条连接要写的下一帧。
	 */
	private pump(): void {
		// 这次尝试是否真的写出了一帧。它是唯一被允许解除停滞的东西，这个区分很重要：对*空*队列的泵什么都没写，把它当作成功会在停滞开始后的第一帧上就清掉停滞状态、取消期限——留下一条永不恢复、也永不放弃的连接。
		let wrote = false;
		while (this.queue.length > 0 && !this.closed) {
			const frame = this.queue[0] as ServerFrame;
			if (!this.sink.send(frame)) return;
			this.queuedBytes -= sizeOf(frame);
			this.queue.shift();
			wrote = true;
		}
		if (!wrote || this.closed) return;
		this.stalled = false;
		this.clearStallTimer();
	}

	/**
	 * peer 不读取了，或读得不够快。关闭整条连接。
	 *
	 * 是*整条*连接，这不是简化：一条连接就是一个 socket、一个写缓冲，不存在"从停滞的 peer 手里救出一条流"这回事。客户端靠重连重订阅恢复，那条路已经存在、什么都不缺——而只结束一条流，需要在一个定义上就不携带理由的帧上表达"你掉队了"。
	 */
	private onStallDeadline(): void {
		if (this.closed) return;
		const waited = Date.now() - this.stalledSince;
		const backlog = Math.round(this.queuedBytes / 1024);
		this.options.log(`mux: 停滞 ${waited} ms，积压 ${backlog} KB，关闭连接（1013）：订阅端停止读取`);
		this.sink.close(CLOSE_TRY_AGAIN_LATER, REASON_STOPPED_READING);
		this.close();
	}

	private clearStallTimer(): void {
		if (this.stallTimer === null) return;
		clearTimeout(this.stallTimer);
		this.stallTimer = null;
	}
}

/**
 * 逻辑流上承载的东西：`ServerMessage` 一直承载的那些 payload。
 *
 * 显式写出而不是从 `ServerFrame` 里提取，因为那个类型是与一个 union 的 intersection，`Extract` 看不穿它——需要的属性只有在 union 被分发之后才可达，而 intersection 上的条件类型做不到。在这里命名而不是导入，也让答案只有一个家：这是订阅会写的唯一一组 payload，连接层的 payload 按构造进不来。
 */
type ServerMessageItem = ServerMessage;

/** 一帧的 JSON 大小，字节预算就是以它计价的。 */
function sizeOf(frame: ServerFrame): number {
	return Buffer.byteLength(JSON.stringify(frame));
}

/**
 * 出了什么问题，用客户端能展示的话说。
 *
 * 只有 `Error` 一种情况值得关心：读取失败带着它自己的消息，那本来就是一句能对客户端说出口的话。其余都是 bug，按 bug 命名而不是插值——帧不是把堆栈递给浏览器的地方。
 */
function describe(error: unknown): string {
	return error instanceof Error ? error.message : "未知的错误";
}

/** 一个正被展示的审批：要上报的答案，以及有多少读者在展示它。 */
interface ShownApproval {
	/** 它被如何应答；无人另有表示时视为拒绝。 */
	approved: boolean;
	/** 此刻正在展示它的订阅数。 */
	showing: number;
}

/**
 * 屏幕上的审批如何被应答，以及谁在展示。
 *
 * 每个有订阅在屏幕上展示的审批一个 entry，因为那就是一个事实：上报答案的帧是那个订阅自己的差量，所以展示审批的订阅是它的答案唯一会有的读者，答案值得持有的时间恰好等于计数大于零的时间。
 *
 * entry 按会话一张表，这个键控是本层自己拍板的决定而不是继承来的。两个会话碰巧共用的 `toolCallId` 是两个审批——若干 Anthropic 兼容端点对 tool call 用同样的编号方式——一个被批准绝不能到达另一个的窗口。
 */
export interface ApprovalAnswers {
	/** 记下一个答案，给将要上报它的那些订阅——且仅在其中有订阅能上报时。 */
	remember(sessionId: string, toolCallId: string, approved: boolean): void;
	/** 这个审批被如何应答。没有记录时，拒绝就是答案。 */
	wasApproved(sessionId: string, toolCallId: string): boolean;
	/** 又一个订阅开始展示这个审批。 */
	show(sessionId: string, toolCallId: string): void;
	/** 一个订阅不再展示；最后一个读者离开时随之丢弃。 */
	hide(sessionId: string, toolCallId: string): void;
}

function createApprovalAnswers(): ApprovalAnswers {
	/** 按会话，其订阅正在屏幕上展示的审批。 */
	const shown = new Map<string, Map<string, ShownApproval>>();

	return {
		remember(sessionId, toolCallId, approved) {
			const approval = shown.get(sessionId)?.get(toolCallId);
			// 无可记录：没有订阅在展示它，永远不会有什么帧去上报它。硬存一个只会让没有答案的问题活得比被告知的进程还久。
			if (approval === undefined) return;
			approval.approved = approved;
		},
		wasApproved(sessionId, toolCallId) {
			return shown.get(sessionId)?.get(toolCallId)?.approved ?? false;
		},
		show(sessionId, toolCallId) {
			const perSession = shown.get(sessionId) ?? new Map<string, ShownApproval>();
			if (!shown.has(sessionId)) shown.set(sessionId, perSession);
			const approval = perSession.get(toolCallId);
			if (approval === undefined) perSession.set(toolCallId, { approved: false, showing: 1 });
			else approval.showing += 1;
		},
		hide(sessionId, toolCallId) {
			const perSession = shown.get(sessionId);
			const approval = perSession?.get(toolCallId);
			if (perSession === undefined || approval === undefined) return;
			approval.showing -= 1;
			if (approval.showing <= 0) perSession.delete(toolCallId);
			// 与按会话的 entry 同样的卫生：空表没有理由活得比最后一个本会从中上报的读者更久。
			if (perSession.size === 0) shown.delete(sessionId);
		},
	};
}

/**
 * 所有连接，以及评判它们的两个定时器。
 *
 * 整个进程各一个定时器，而不是每条连接一个：一百个空闲窗口不应该是一百个 interval，而按连接计的定时器会让"这个服务器多久 ping 一次"变成一个有一百个答案的问题。
 */
export class MuxServer {
	private readonly connections = new Set<MuxConnection>();
	private readonly pingTimer: NodeJS.Timeout;
	private readonly heartbeatTimer: NodeJS.Timeout;
	/**
	 * 审批的答案，所有连接共享。
	 *
	 * 整个进程一张表而不是每连接一张，原因是一个没有作答的窗口：上报审批答案的帧是*作答*那个订阅自己的差量，所以观看同一审批的第二个窗口必须被告知它被如何应答。若每个连接各存一张表，第二个窗口会查不到记录而报一个拒绝——这正是这个键控要防的跨会话 bug 在上一层复现。
	 */
	private readonly answers: ApprovalAnswers = createApprovalAnswers();
	private shuttingDown = false;
	/** 放开 projection 的行监听器，让本服务器不再能被它触达。 */
	private readonly stopRows: () => void;
	private readonly stopGone: () => void;

	private readonly hub: SessionHub;
	private readonly projection: SessionProjection;
	private readonly options: ResolvedMuxOptions;

	constructor(hub: SessionHub, projection: SessionProjection, options: ResolvedMuxOptions) {
		this.hub = hub;
		this.projection = projection;
		this.options = options;
		this.pingTimer = setInterval(() => this.pingAll(), options.pingIntervalMs);
		// 永远不是进程保持存活的理由：一个没有窗口开着的服务器仍然必须退出。
		this.pingTimer.unref();

		this.heartbeatTimer = setInterval(() => this.heartbeatAll(), options.heartbeatIntervalMs);
		this.heartbeatTimer.unref();

		// overview 是一条从不被 open、从不被 cancel 的连接层流，所以它由唯一知道一行变了的地方供数，而不是由某张订阅表。
		//
		// 退订器被保留而不是丢弃：projection 比任何一个 mux 服务器活得久，遗落的监听器会在 `close()` 之后把整个对象图——连同它持有的每条连接——都吊着不放。真实进程里 projection 先关闭、本来就会清掉监听器，这正是这个 bug 在那里不会现形的原因。
		this.stopRows = projection.onRow((sessionRow) => {
			if (!this.listed(sessionRow)) return;
			for (const connection of this.connections) connection.sendRow(sessionRow);
		});
		// 移除与行占同一个连接层的席位，理由相同：它说的是机器的列表，不是任何一条流。像 `stopRows` 一样保留——projection 比本服务器活得久，遗落的监听器会吊住整个对象图。
		this.stopGone = projection.onGone((sessionId) => {
			for (const connection of this.connections) connection.sendGone(sessionId);
		});
	}

	/**
	 * 收下一条刚升级的连接，开始为它服务。
	 *
	 * overview baseline 在任何订阅能被 open 之前发出：它是让侧栏正确、却一次 `GET` 都不需要的那一帧，而一条还得被问"有什么"的连接，正是这个 transport 要替代的东西。
	 *
	 * 返回连接，让拥有 socket 的调用者能把上行帧交给它。
	 */
	async accept(sink: FrameSink): Promise<MuxConnection> {
		if (this.shuttingDown) {
			sink.close(CLOSE_GOING_AWAY, REASON_SHUTTING_DOWN);
			throw new Error("The server is shutting down");
		}

		const connection = new MuxConnection(sink, this.hub, this.options, this.answers);
		this.connections.add(connection);

		// 先发一个心跳，刻意为之：它是客户端看门狗在等的那一帧，所以发出过它的连接已经是客户端可以当作活着的连接。overview 随后跟上，socket 的写出顺序就是到达顺序。
		connection.heartbeat();
		connection.sendSessions(await this.overview());

		sink.ping();
		return connection;
	}

	/** 一个上行帧，交给本服务器拥有的连接。 */
	handle(connection: MuxConnection, text: string): void {
		if (!this.connections.has(connection)) return;
		connection.handle(text);
	}

	/** 一条连接上有 Pong 到达：peer 活着。 */
	notePong(connection: MuxConnection): void {
		// 与 `handle` 一样设防，理由相同：Pong 可能在连接已被忘记之后到达，给一个无人持有的连接复活计数器，会让它在任何还持有引用的东西眼里看起来仍然活着。
		if (!this.connections.has(connection)) return;
		connection.notePong();
	}

	/** 忘记一条已结束的连接。 */
	forget(connection: MuxConnection): void {
		this.connections.delete(connection);
		connection.close();
	}

	/** 有多少连接开着。测试读它；生产中没有任何东西用。 */
	get size(): number {
		return this.connections.size;
	}

	/** 对观看某个会话的每条连接说同一句话。 */
	announce(sessionId: string, message: string): void {
		for (const connection of this.connections) connection.announce(sessionId, message);
	}

	/** 记下一个审批答案，给正在展示它的每条连接。 */
	rememberApproval(sessionId: string, toolCallId: string, approved: boolean): void {
		this.answers.remember(sessionId, toolCallId, approved);
	}

	/**
	 * 这条连接的窗口是否被允许看到一行。
	 *
	 * 规则是 hub 的（{@link SessionHub.listsDirectory}），过滤在这里施加，施加在一行到达窗口的两个点上：连接打开时的 overview，以及其后每一个变了的行。只过滤 overview，会让一个用户放到一边的目录在其某个会话一变的瞬间自己回来——自己回来的组比从未离开的更糟。
	 */
	private listed(sessionRow: SessionRow): boolean {
		return this.hub.listsDirectory(sessionRow.workDirAbsPath);
	}

	/** 本连接的开场 overview：本进程列出的每一行，各一次。 */
	private overview(): Promise<SessionRow[]> {
		return this.projection.rows().then((rows) => rows.filter((sessionRow) => this.listed(sessionRow)));
	}

	/**
	 * 给每条连接发一份新的 overview。
	 *
	 * 一行承载不了的那件事：目录进出列表是列表本身的变更，组没有对应的 `session_row`。重发 overview，就是让那条本来就说"这是机器的列表"的帧顺带说"……它动了"——与连接打开时收到的是同一帧，客户端不必为侧栏学第二种消息形状。
	 */
	async broadcastSessions(): Promise<void> {
		const rows = await this.overview();
		for (const connection of this.connections) connection.sendSessions(rows);
	}

	/** 协议层存活问题的一轮，以及它了结的那些连接的清扫。 */
	private pingAll(): void {
		for (const connection of [...this.connections]) {
			connection.tick();
			if (connection.isClosed) this.forget(connection);
		}
	}

	/**
	 * 应用层心跳的一轮。
	 *
	 * 它兼任写入尝试的下限，这正是它走普通发送路径而不是绕过队列的原因：当没有别的东西在写时，它是唯一仍会被做出的尝试，一条恢复的连接靠它把 backlog 冲出去。
	 */
	private heartbeatAll(): void {
		for (const connection of [...this.connections]) {
			connection.heartbeat();
			if (connection.isClosed) this.forget(connection);
		}
	}

	/** 结束每条连接，让关闭进程不被一个从不离开的窗口吊着。 */
	close(): void {
		this.shuttingDown = true;
		this.stopRows();
		this.stopGone();
		clearInterval(this.pingTimer);
		clearInterval(this.heartbeatTimer);
		for (const connection of [...this.connections]) connection.close();
		this.connections.clear();
	}
}

/** 构建一个带默认值的服务器，或带上测试驱动它们加速所需的任何选项。 */
export function createMuxServer(
	hub: SessionHub,
	projection: SessionProjection,
	options: MuxOptions = {},
): MuxServer {
	return new MuxServer(hub, projection, {
		pingIntervalMs: options.pingIntervalMs ?? PING_INTERVAL_MS,
		maxMissedPongs: options.maxMissedPongs ?? MAX_MISSED_PONGS,
		heartbeatIntervalMs: options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
		stallBudgetBytes: options.stallBudgetBytes ?? STALL_BUDGET_BYTES,
		stallDeadlineMs: options.stallDeadlineMs ?? STALL_DEADLINE_MS,
		log: options.log ?? ((line) => console.warn(line)),
	});
}
