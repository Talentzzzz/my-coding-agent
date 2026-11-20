import type { PendingApproval, ServerFrame, SessionRow, SessionRowPatch, SessionSnapshot } from "@my-agent/core/protocol";
import * as frame from "./frames.ts";
import type { SessionHub, SubscriptionSink } from "./hub.ts";
import {
	CLOSE_GOING_AWAY,
	REASON_SHUTTING_DOWN,
	Wire,
	resolveWireOptions,
	type FrameSink,
	type ResolvedWireOptions,
	type WireOptions,
} from "./wire.ts";

/**
 * mux 作为连接级 controller 注入的服务。
 *
 * 与 REST 侧同形：`Router` 把请求交给 controller，controller 调 hub；这里 `MuxServer` 把一条
 * socket 交给 `MuxConnection`，它调的是同一件东西（ADR-0025）。依赖方向因此是 `mux → hub`，
 * 没有回边。
 */
export interface MuxDeps {
	readonly sessionHub: SessionHub;
}

/** mux 的选项就是 wire 的选项，逐字透传：定时器与预算的含义归 wire。 */
export type MuxOptions = WireOptions;

/**
 * 本连接对一个会话的观看。
 *
 * 订阅是一个*连接 × 会话*对，这就是它住在这里的原因：同一会话的两个窗口各持有一个，各自从自己
 * 的起点上报审批差异，两者都不是关于会话的事实。
 *
 * 它不占任何持有：观看一个会话不让它保持运行，所以这里的任何东西都不是"会话能否关闭"的输入。
 * 这个分离是承重的——如果观看占一个持有，一个开着窗口盯着空闲会话的浏览器就会让一个无人使用的
 * `Agent` 永远驻留。
 */
interface Watcher {
	/**
	 * 本观看已经告诉浏览器的审批，按 `toolCallId`。
	 *
	 * 以"一个 `toolCallId` 在一个会话内唯一"为前提键控——与 `Agent.pendingApprovals` 相同的前提，
	 * 由 provider 的 `tool_use` id 语义背书。两个会话碰巧共用一个 id 是另一回事，不是缺陷：差量
	 * 键控到本观看自己的流上，一个会话的审批帧永远不会到达另一个会话的窗口。
	 */
	pending: Map<string, PendingApproval>;
	/**
	 * baseline 发出之前产生的帧，baseline 发出后为 `null`。
	 *
	 * 数组表示"还欠一份 baseline"；`null` 表示已经发出。这个区分正是它不做长度判断的原因——两种
	 * 状态下数组都合法地可以为空，而 baseline 之后空 backlog 是常态而非特例。
	 */
	backlog: ServerFrame[] | null;
	/**
	 * 所有要撤销的东西，按设置的顺序。
	 *
	 * 用列表而不是单个可重赋值的函数，原因在于这些事发生的顺序：`hub.subscribe` 在返回的同一拍
	 * 就*同步*回调，所以订阅元素在这个观看还没创建完之前就已挂上。一个每步包裹前一步的函数会被
	 * 下一次赋值覆盖掉工作——而丢掉的恰好是订阅元素那半，正是让一个已结束的连接保持存活、还在为
	 * 客户端已取消的订阅写帧的那半。
	 */
	undo: (() => void)[];
}

/**
 * 一个客户端连接：这条连接的全部事情。
 *
	 * 它是这个传输层的 controller 实例——`open` / `cancel` 是它仅有的两个动词，此外它把事件与快照
	 * 翻译成帧、决定 baseline 的时机、记着本观看已上报了哪些审批。这些全是*连接 × 会话*的事实，
	 * 本就不该由第二个对象代持：一个连接的状态被拆在一个 `MuxConnection` 与一个由工厂造出来的
	 * `SessionStream` 之间，只会让"这条连接现在在看什么"有两个答案（ADR-0025）。
 *
 * 它懂会话，不认识 socket：所有帧经 {@link Wire.send} 写出，队列、背压、`1013`、字节数与存活
 * 探测都在 wire 那一层。
 *
 * 帧序不变量的另一半住在这里：本层保证 baseline 帧先于它自己 backlog 里的任何帧写出。与 hub
 * 的「注册与快照原子」之间的缝是 `open` 的返回拍：hub 保证订阅元素在同一个同步块里挂上并同步
 * 交付活半 baseline；本层保证 baseline 已同步回调、同步 `send`，而不是先攒着等一拍，所以任何
 * emit 只能落在下一个事件循环拍，那时 baseline 早已排在前面。冷半的读盘在 hub 内异步，跨过的
 * 那段由本观看的 backlog 扣住。两半之间的缝是：hub 只交结果（快照或原始 error），帧序与失败
 * 措辞由这里决定。
 */
export class MuxConnection {
	readonly wire: Wire;

	private readonly deps: MuxDeps;
	/** 本连接正在观看的会话，按会话 id。每个会话一条流，绝无两条。 */
	private readonly watching = new Map<string, Watcher>();
	/**
	 * overview 还在路上时到达的行增量，overview 写出后为 `null`。
	 *
	 * 与观看流的 backlog 同一个模式：hub 的行是现算的（ADR-0027），首读要扫盘，扫描期间发布的
	 * 增量扣在这里，overview 之后按序冲刷——先看到整表，再看到其后的每个变更。这是暂存的握手
	 * 队列，不是存储：它的生命周期就是这一条连接的开场。
	 */
	private overviewBacklog: SessionRowPatch[] | null = [];
	private stopped: (() => void) | undefined;
	private disposed = false;

	constructor(wire: Wire, deps: MuxDeps) {
		this.wire = wire;
		this.deps = deps;
	}

	/** 这条连接还收不收写。`muxUpgrade` 在交回所有权之前问它一次。 */
	get isClosed(): boolean {
		return this.wire.isClosed;
	}

	/**
	 * 开场：应用心跳 → overview（过滤隐藏目录）→ 注册全局列表订阅。
	 *
	 * 顺序即现状，且必须 await：overview 是让侧栏正确、却一次 `GET` 都不需要的那一帧，而一条还
	 * 得被问"有什么"的连接，正是这个 transport 要替代的东西。在它返回之前到达的上行帧，由
	 * `muxUpgrade` 的 waiting 缓冲扣住、在 overview 之后才 replay。
	 *
	 * 本方法隔着一次 `await`，所以中间那一拍连接可能已经消失：两个 `disposed` 检查不是防御性
	 * 编程，而是这条 await 的直接后果。
	 */
	async begin(): Promise<void> {
		if (this.disposed) return;
		// 先发一个心跳，刻意为之：它是客户端看门狗在等的那一帧，所以发出过它的连接已经是客户端
		// 可以当作活着的连接。overview 随后跟上，socket 的写出顺序就是到达顺序。
		this.wire.heartbeat();
		// 订阅先于读取：注册与首读之间的增量扣进 backlog，overview 写出后按序冲刷。hub 只交结果，
		// 帧序归这里——与观看流上的 baseline 半相同。
		this.stopped = this.deps.sessionHub.subscribeGlobal({
			rows: (sessionRow) => {
				if (!this.listed(sessionRow)) return;
				if (this.overviewBacklog !== null) {
					this.overviewBacklog.push(sessionRow);
					return;
				}
				this.wire.send(frame.row(sessionRow));
			},
			gone: (sessionId) => this.wire.send(frame.gone(sessionId)),
			resync: () => {
				void this.resync();
			},
		});
		this.sendSessions(await this.overview());
		if (this.disposed) return;
		const queued = this.overviewBacklog ?? [];
		this.overviewBacklog = null;
		for (const sessionRow of queued) this.wire.send(frame.row(sessionRow));
	}

	/**
	 * 一个上行帧：`open` / `cancel`。
	 *
	 * 读不懂的帧丢弃并记日志，而不是关掉连接：两个动作没有一个能被滥用成什么，而手写 smoke 里
	 * 一个拼错的动作让窗口再也打不开，代价高于一行日志（见 `parseClientFrame`）。
	 */
	handle(text: string): void {
		if (this.disposed) return;
		const incoming = frame.parseClientFrame(text);
		if (incoming === undefined) {
			this.wire.log(`mux: 丢弃一帧看不懂的上行帧（${text.length} 字节）`);
			return;
		}
		if (incoming.type === "open") this.open(incoming.sessionId);
		else this.cancel(incoming.sessionId);
	}

	/**
	 * 放弃所有观看并停止。
	 *
	 * 观看先行，让它们在任何东西试图关闭它们正在观看的会话之前从 hub 退订。被丢弃的连接是一个
	 * 永远不会被应答的客户端，它持有的每个观看都在这里放弃：与 `cancel`、刷新、断线同一种等价
	 * 处理。幂等：mux 的外部 `close()` 与 wire 自关走同一条收尾路径。
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopped?.();
		this.stopped = undefined;
		for (const watcher of [...this.watching.values()]) this.unwatch(watcher);
		this.watching.clear();
		this.wire.close();
	}

	/**
	 * 这条连接的窗口是否被允许看到一行。
	 *
	 * 规则是 hub 的（`SessionHub.listsDirectory`），过滤在这里施加，施加在一行到达窗口的两个点
	 * 上：连接打开时的 overview，以及其后每一个变了的行。只过滤 overview，会让一个用户放到一边
	 * 的目录在其某个会话一变的瞬间自己回来——自己回来的组比从未离开的更糟。
	 *
	 * 增量没有 `workDirAbsPath` 可问——hub 不为行养存储，事件自带什么就带什么（ADR-0027）。放行
	 * 是安全的：增量只能改动客户端已有的行，而隐藏目录的行从不在客户端的表里——overview 过滤过
	 * 一次，resync 又会摘走——对未知 id 的增量客户端自己丢弃。完整行（出生、改名）带 workDir，
	 * 照常过滤。
	 */
	private listed(sessionRow: SessionRowPatch): boolean {
		if (sessionRow.workDirAbsPath === undefined) return true;
		return this.deps.sessionHub.listsDirectory(sessionRow.workDirAbsPath);
	}

	/** 本连接的开场 overview：本进程列出的每一行，各一次。 */
	private async overview(): Promise<SessionRow[]> {
		const rows = await this.deps.sessionHub.rows();
		return rows.filter((sessionRow) => this.listed(sessionRow));
	}

	/** 本连接的开场 overview，或列表变动后的一份新的：它可能看到的那些行。 */
	private sendSessions(rows: readonly SessionRow[]): void {
		this.wire.send(frame.sessions(rows));
	}

	/**
	 * 给这条连接发一份新的 overview。
	 *
	 * 一行承载不了的那件事：目录进出列表是列表本身的变更，组没有对应的 `session_row`。重发
	 * overview，就是让那条本来就说"这是机器的列表"的帧顺带说"……它动了"——与连接打开时收到的
	 * 是同一帧，客户端不必为侧栏学第二种消息形状。
	 */
	private async resync(): Promise<void> {
		const rows = await this.overview();
		if (this.disposed) return;
		this.sendSessions(rows);
	}

	/**
	 * 把一帧放到本观看的流上，baseline 还没发出时先扣住。
	 *
	 * backlog 是对设计里唯一可能出现的缝隙的回答：*冷*会话的会话记录必须从磁盘读，那是异步的，
	 * 读取期间可能有东西被发布。扣到 baseline 发出、再按序冲刷，让保证与同步场景完全一致——客户
	 * 端先看到状态，然后看到其后的每个变更，按发生顺序。
	 */
	private push(watcher: Watcher, outgoing: ServerFrame): void {
		if (watcher.backlog === null) {
			this.wire.send(outgoing);
			return;
		}
		watcher.backlog.push(outgoing);
	}

	/**
	 * 先发出 baseline，然后是堆积在它后面的一切。
	 *
	 * 每个 baseline 调一次：首次交付与重发都经 {@link baselineSink} 把 hub 交回的结果送进这里。
	 * 永远按产生顺序冲刷，客户端不可能看到会话记录往回跳。
	 */
	private writeBaseline(sessionId: string, watcher: Watcher, snapshot: SessionSnapshot): void {
		if (watcher.backlog === null) return;
		// baseline *替换*本观看此前展示的东西，所以"已上报了哪些审批"整表换新——不是差量：
		// 换成差量会把 baseline 之后到达的变更帧重复算一遍。
		watcher.pending = frame.pendingOf(snapshot);

		this.wire.send(frame.baseline(sessionId, snapshot));

		const backlog = watcher.backlog;
		watcher.backlog = null;
		for (const queued of backlog) this.wire.send(queued);
	}

	/**
	 * 重发整个状态：这是对分支移动、以及对本连接已持有的观看上第二个 `open` 的应答。
	 *
	 * 重发不能重新订阅——那会多注册一个订阅元素——所以走 hub 的 `snapshotFor`：活冷分岔在那里
	 * 完成，活半同步交回袋里的在飞状态（运行中途的第二个 `open` 因此带走正在写出的 `partial`，
	 * 而不是盘上上一次落定的状态），冷半读盘后异步交回。
	 *
	 * 这里剩下的是帧序的本域。布防 backlog 让读盘期间到达的帧排在 baseline 之后：活半在同一同步
	 * 块里布防又冲刷，等于没扣；冷半扣到读盘返回。已经欠着一份时不再要——那份 baseline 还在路上，
	 * 再要一份只会让客户端多收一次同一状态，冷半还会多读一次盘；活半的同步交付同样受这条去重覆盖。
	 */
	private pushBaseline(sessionId: string, watcher: Watcher): void {
		if (watcher.backlog !== null) return;
		watcher.backlog = [];
		this.deps.sessionHub.snapshotFor(sessionId, this.baselineSink(sessionId, watcher));
	}

	/**
	 * 一份 baseline 的着陆点：守卫，然后写出或报告失败。
	 *
	 * 首次交付与重发共用这一份，因为它们服从同一条规则：这份 baseline 还有人要吗。冷读盘在途时
	 * 可能落进 cancel、第二个 open 或断线，往一条已经结束、或已经换了观看的流上写帧是更糟的谎。
	 */
	private baselineSink(sessionId: string, watcher: Watcher): SubscriptionSink {
		const wanted = (): boolean => !this.disposed && this.watching.get(sessionId) === watcher;
		return {
			onBaseline: (snapshot) => {
				if (!wanted()) return;
				this.writeBaseline(sessionId, watcher, snapshot);
			},
			onError: (error) => {
				if (!wanted()) return;
				this.failBaseline(sessionId, error);
			},
		};
	}

	/**
	 * 上报本观看待审批集合的差量。
	 *
	 * 按观看而不是按会话：每个窗口从自己的起点了解一个审批。消失的一个只上报为"定案了"——它是
	 * 被批准还是被拒绝，由那次关闭自己的执行事件说（grant 是恢复运行重发调用的执行，deny 是合成
	 * 结果的结束事件），差量帧不替结果代言。
	 */
	private pushApprovalChanges(sessionId: string, watcher: Watcher, snapshot: SessionSnapshot): void {
		const current = frame.pendingOf(snapshot);
		const diff = frame.approvalDiff(watcher.pending, current);

		for (const approval of diff.appearing) {
			this.push(watcher, frame.approvalRequest(sessionId, approval));
		}
		for (const toolCallId of diff.disappearing) {
			this.push(watcher, frame.approvalSettled(sessionId, toolCallId));
		}

		watcher.pending = current;
	}

	/**
	 * 一份 baseline 交付失败的应答：先带归因的 error，再是让尝试不至于继续看起来像一条安静流的 end。
	 *
	 * 「这份 baseline 还有人要吗」的守卫不在这里，它与成功那条共用 {@link baselineSink} 给出的同一处判断。
	 */
	private failBaseline(sessionId: string, error: unknown): void {
		this.failStream(sessionId, frame.baselineFailureText(sessionId, error));
	}

	/**
	 * 告诉客户端它的 `open` 没有成功，并结束这次尝试。
	 *
	 * 先 error 后 end：error 带归因，end 让尝试不至于继续看起来像一条只是安静的流。第一次 `open`
	 * 时客户端知道自己的请求失败了，因为那条流从未承载过 baseline。第二次——重发的 baseline 的读取
	 * 发现会话已不在——流承载过一份，end 此时才是诚实的应答而不是误读：记录真的没了，没有什么可重开。
	 */
	private failStream(sessionId: string, text: string): void {
		this.wire.send(frame.refusal(sessionId, text));
		this.endStream(sessionId);
	}

	/**
	 * 撤销一个观看：它注册的每一步，后进先出。
	 *
	 * 逆序是因为这些步骤是一个栈——观看是在注册之后挂上的，所以它也是更晚放下的东西。
	 */
	private unwatch(watcher: Watcher): void {
		for (let index = watcher.undo.length - 1; index >= 0; index -= 1) {
			watcher.undo[index]?.();
		}
		watcher.undo = [];
	}

	/**
	 * 结束一条逻辑流并忘记它。
	 *
	 * 观看在帧*之前*移除，因为 `end` 之后本连接对那个会话必须再无话可说——这就是这帧的全部含义，
	 * 在它之后还看到任何东西的客户端将无法分辨那属于哪条流。
	 */
	private endStream(sessionId: string): void {
		const watcher = this.watching.get(sessionId);
		if (watcher !== undefined) this.unwatch(watcher);
		this.wire.send(frame.end(sessionId));
	}

	/**
	 * 开始观看一个会话，或把本连接已持有的观看刷新到最新。
	 *
	 * `open` 的意思是"这个会话现在的状态，然后之后的一切"，且是幂等的（ADR-0009 决定 1）。本连接
	 * *已经在看*的会话因此不算错：应答是在已有的流上再发一份 baseline，底下的观看原样保留——同
	 * 样的订阅元素、同样的审批、同一条流。这才让"窗格在别处仍持有会话时消失、又回来了"能工作：
	 * 引用计数意味着没有发过 `cancel`，回来这一程唯一能应答它的就是重发的 baseline。
	 *
	 * 不存在的会话仍然是客户端的错，但应答写在它相关的流上——一个带归因的 `error` 帧，然后一个
	 * `end`，让失败的尝试不至于继续看起来像一条只是安静的流——而连接本身无论哪种情况都不受影响。
	 */
	private open(sessionId: string): void {
		const watching = this.watching.get(sessionId);
		if (watching !== undefined) {
			this.pushBaseline(sessionId, watching);
			return;
		}

		const watcher: Watcher = { pending: new Map(), backlog: [], undo: [] };
		this.watching.set(sessionId, watcher);

		// 观看不占任何持有，这一点始终是全部关键：计数属于改变或运行会话的调用者，而看着它的窗口
		// 两者都不是。注册的同一拍订阅元素就已在表里——分发按 id 进行，对冷会话同样成立——所以该
		// 会话开始运行的那一刻，事件自然流入，无需任何重绑。

		// no-gap 的两半在这里合缝。hub 保证「注册与快照原子」（机制与论证见 hub.ts 的 `subscribe`）；
		// 本层保证「baseline 帧先于本观看 backlog 里的任何帧写出」——`subscribe` 返回前 `baseline`
		// 已同步回调，回调里同步 `send`，而不是先攒着等一拍。冷半的读盘在 hub 内异步，跨过的那段
		// 由 backlog 扣住。
		const stopWatching = this.deps.sessionHub.subscribe(sessionId, {
			baseline: (snapshot) => this.writeBaseline(sessionId, watcher, snapshot),
			baselineFailed: (error) => this.failBaseline(sessionId, error),
			event: (change) => {
				this.push(watcher, frame.event(sessionId, change));
				// 叶子移动改变整条会话记录，所以为它发出的是会话的当前状态而不是差异：事件说树动了，
				// 这帧说动到了哪里。
				if (change.type === "branch_changed") this.pushBaseline(sessionId, watcher);
				if (change.type === "entry_appended") this.push(watcher, frame.entry(sessionId, change.entryId, change.at));
			},
			state: (snapshot) => {
				this.push(watcher, frame.status(sessionId, snapshot));
				// 待审批和其他变更一样以 change 发布，所以窗口就是在这里学会显示横幅的。baseline 只
				// 负责播种已经在等的那些。
				this.pushApprovalChanges(sessionId, watcher, snapshot);
			},
			// 只在会话被删除（或进程收摊）时到达；观看中的流以 end 作别。
			gone: () => this.endStream(sessionId),
			// 一次运行在会话自己的流上说的那句失败（`hub.publishFailure`）：只发给观看中的流，没有
			// 读者就没有帧。
			failure: (text) => {
				// 不需要再查 `watching`：hub 只把 `failure` 交给这个会话的订阅者，而本回调正是订阅
				// 元素自己被调用的那一拍——元素在表里才会被调到，退订与 `watching.delete` 同时发生。
				this.wire.send(frame.failure(sessionId, text));
			},
		});

		// 刻意在 `subscribe` 调用之后注册，且追加而不是赋值：`subscribe` 返回前的同步回调可能已经
		// 写过帧，这一步不能把它挤掉。见 `Watcher.undo`。
		watcher.undo.push(() => {
			stopWatching();
			watcher.pending.clear();
			watcher.backlog = null;
			this.watching.delete(sessionId);
		});
	}

	/**
	 * 停止观看一个会话。
	 *
	 * 丢弃观看的唯一含义是"这条连接上不再有这个会话的帧"——不是"停止运行"，不是"关闭会话"，不是
	 * "释放任何东西"。持有通道已随簿记迁入 SessionManager 而退场（ADR-0023），会话的改变归
	 * Manager 的文件闸，观看与它毫无换算；从这个窗口发起的运行照常跑完，窗口才能在会话仍在应答
	 * 时离开——而删除也不再因有人在看而止步：否决式删除先停运行、闸内删文件。
	 *
	 * 没有应答：客户端的意图在发出 `cancel` 时就完整了，回复会是一帧写在它刚刚声明不想要的流上。
	 */
	private cancel(sessionId: string): void {
		const watcher = this.watching.get(sessionId);
		if (watcher !== undefined) this.unwatch(watcher);
	}
}

/**
 * 所有连接，以及评判它们的两个定时器。
 *
 * 整个进程各一个定时器，而不是每条连接一个：一百个空闲窗口不应该是一百个 interval，而按连接计
 * 的定时器会让"这个服务器多久 ping 一次"变成一个有一百个答案的问题。连接集合只用于存活探测与
 * 关停——它不再参与任何分发。
 *
 * 它是 controller 的服务端那一半：`accept` 造出每条连接的 controller 并让它开场，`handle` 把
 * 一个上行帧交给它。两只服务在这里注入，连接因此不必去够任何全局。
 */
export class MuxServer {
	private readonly connections = new Set<MuxConnection>();
	private readonly pingTimer: NodeJS.Timeout;
	private readonly heartbeatTimer: NodeJS.Timeout;
	private shuttingDown = false;

	private readonly deps: MuxDeps;
	private readonly options: ResolvedWireOptions;

	constructor(deps: MuxDeps, options: ResolvedWireOptions) {
		this.deps = deps;
		this.options = options;
		this.pingTimer = setInterval(() => this.pingAll(), options.pingIntervalMs);
		// 永远不是进程保持存活的理由：一个没有窗口开着的服务器仍然必须退出。
		this.pingTimer.unref();

		this.heartbeatTimer = setInterval(() => this.heartbeatAll(), options.heartbeatIntervalMs);
		this.heartbeatTimer.unref();
	}

	/**
	 * 收下一条刚升级的连接，开始为它服务。
	 *
	 * overview baseline 在任何订阅能被 open 之前发出，所以 `begin()` 必须 await：在 `accept` 返回
	 * 之前到达的上行帧，是由 `muxUpgrade` 的 waiting 缓冲区扣住、在 overview 之后才 replay 的。
	 *
	 * 返回连接，让拥有 socket 的调用者能把上行帧交给它。
	 */
	async accept(frameSink: FrameSink): Promise<MuxConnection> {
		if (this.shuttingDown) {
			frameSink.close(CLOSE_GOING_AWAY, REASON_SHUTTING_DOWN);
			throw new Error("The server is shutting down");
		}

		const wire = new Wire(frameSink, this.options);
		const muxConnection = new MuxConnection(wire, this.deps);
		this.connections.add(muxConnection);

		// wire 自己关掉一条连接（停滞期限、ping 容忍度耗尽）时，观看必须当场摘掉：不等下一次
		// `pingAll` / `heartbeatAll` 撞见 `isClosed`，否则那条流还在为一个不再有读者的连接翻译帧。
		// 自关与外部 `close()` 因此走同一条收尾路径；`forget` 幂等。
		wire.onClose(() => this.forget(muxConnection));

		await muxConnection.begin();

		frameSink.ping();
		return muxConnection;
	}

	/** 一个上行帧，交给本服务器拥有的连接。 */
	handle(muxConnection: MuxConnection, text: string): void {
		if (!this.connections.has(muxConnection)) return;
		muxConnection.handle(text);
	}

	/** 一条连接上有 Pong 到达：peer 活着。 */
	notePong(muxConnection: MuxConnection): void {
		// 与 `handle` 一样设防，理由相同：Pong 可能在连接已被忘记之后到达，给一个无人持有的连接
		// 复活计数器，会让它在任何还持有引用的东西眼里看起来仍然活着。
		if (!this.connections.has(muxConnection)) return;
		muxConnection.wire.notePong();
	}

	/** 忘记一条已结束的连接：先出集合，再让它放下所有观看。 */
	forget(muxConnection: MuxConnection): void {
		if (!this.connections.delete(muxConnection)) return;
		muxConnection.dispose();
	}

	/** 有多少连接开着。测试读它；生产中没有任何东西用。 */
	get size(): number {
		return this.connections.size;
	}

	/** 协议层存活问题的一轮。 */
	private pingAll(): void {
		for (const muxConnection of [...this.connections]) muxConnection.wire.tick();
	}

	/**
	 * 应用层心跳的一轮。
	 *
	 * 它兼任写入尝试的下限，这正是它走普通发送路径而不是绕过队列的原因：当没有别的东西在写时，
	 * 它是唯一仍会被做出的尝试，一条恢复的连接靠它把 backlog 冲出去。
	 */
	private heartbeatAll(): void {
		for (const muxConnection of [...this.connections]) muxConnection.wire.heartbeat();
	}

	/** 结束每条连接，让关闭进程不被一个从不离开的窗口吊着。 */
	close(): void {
		this.shuttingDown = true;
		clearInterval(this.pingTimer);
		clearInterval(this.heartbeatTimer);
		for (const muxConnection of [...this.connections]) muxConnection.dispose();
		this.connections.clear();
	}
}

/** 构建一个带默认值的服务器，或带上测试驱动它们加速所需的任何选项。 */
export function createMuxServer(deps: MuxDeps, options: MuxOptions = {}): MuxServer {
	return new MuxServer(deps, resolveWireOptions(options));
}
