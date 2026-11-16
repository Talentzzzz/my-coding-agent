import type { ConnectionFrame, ConnectionItem, ServerMessage, SessionSnapshot, StreamFrame } from "@my-agent/core/protocol";

/**
 * 窗口对物理通道的认知。
 *
 * 三个状态，因为"能否连上服务端"有两个独立变化的答案：这个 socket 是否已打开**且被证明**可用，
 * 以及 REST 平面是否在应答。只有前者住在这里。
 *
 * - `connecting` —— 一次尝试正在进行，或尚未尝试过。
 * - `live` —— socket 已打开**且**本连接的第一个帧已到达。不是"已打开"：打开后陷入沉默的 socket
 *   正是客户端 otherwise 无法察觉的情形，把它叫 live 会让专门盯着这种情形的看门狗失效。
 * - `down` —— 上次尝试已结束、退避在休眠，或浏览器离线。
 */
export type ChannelState = "connecting" | "live" | "down";

/**
 * 这个窗口为什么在看一个会话。
 *
 * 引用计数在客户端按来源计数，因为服务的表只回答"这个连接订阅了什么"，刻意不回答"为什么" ——
 * 在那边计数会是没有人读的状态。存在两种来源，因为它们在真正不同的事件上释放：窗格的寿命与窗口
 * 看着会话的时长一致，send 的寿命与它开启的那次运行完全一致。
 */
export type SubscriptionSource = "pane" | "send";

/** 一条逻辑流在本连接上正在做什么。 */
export type SubscriptionStatus =
	/** `open` 已发出且服务端尚未结束它。 */
	| "subscribed"
	/**
	 * 服务端发送了 `end`，这条流已结束。
	 *
	 * 唯一一个在重连后不被重新打开而保留的状态：服务端已判定这条逻辑流结束，每次断线后再问一次，
	 * 对一个确实已消失的会话只会买回第二句"没有这个会话"。它在最后一个引用消失时清除，因此把
	 * 窗格指去别处再指回来会正常重新订阅 —— 收到新的 `retain` 时也会清除，于是一个窗格仍指着的
	 * 会话上新的一次 send 会复活这条流，而不是被记进一条死条目。
	 */
	| "ended";

/** socket 能引发的三个事件，按本层需要的形式。 */
export interface MuxSocketHandlers {
	onOpen(): void;
	onMessage(text: string): void;
	onClose(): void;
	onError(): void;
}

/** 本层的写入目标。浏览器的 socket，或冒烟测试里的假 socket。 */
export interface MuxSocket {
	send(text: string): void;
	close(code: number, reason: string): void;
}

/** 构造一个 socket。注入是为了让冒烟测试在没有服务端的情况下驱动状态机。 */
export type MuxSocketFactory = (handlers: MuxSocketHandlers) => MuxSocket;

/**
 * 本层的定时器。
 *
 * 与 socket 同样的接缝理由：看门狗和退避没法靠 sleep 来检验，等真实秒数的测试套件既慢又 flaky。
 * 生产环境用全局对象，之后再不想它。
 */
export interface MuxTimers {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

/** 通道响应的两个网络事件。浏览器里是 `window`，冒烟测试里没有。 */
export interface NetworkEvents {
	addEventListener(type: "online" | "offline", listener: () => void): void;
	removeEventListener(type: "online" | "offline", listener: () => void): void;
}

export interface MuxOptions {
	/** 通道的位置。 */
	url: string;
	socket: MuxSocketFactory;
	/** 默认为全局对象。 */
	timers?: MuxTimers;
	/** 默认为 `Math.random`。只有退避的抖动读它。 */
	random?: () => number;
	/** 浏览器的 `window`，冒烟测试里没有。没有它就没有 online/offline 处理。 */
	network?: NetworkEvents;
	/** 见 {@link READY_TIMEOUT_MS}。 */
	readyTimeoutMs?: number;
	/** 任何心跳上报间隔之前的容忍度。见 {@link WATCHDOG_MULTIPLIER}。 */
	watchdogTimeoutMs?: number;
	/** 一次导航等待其基线的时长。见 {@link OPEN_TIMEOUT_MS}。 */
	openTimeoutMs?: number;
	/** 每次断线那一行日志的去向。默认为 console。 */
	log?: (line: string) => void;
}

export interface MuxHandlers {
	/** 通道变了。窗口唯一的窗口级状态机经由这里上报。 */
	onChannel(channelState: ChannelState): void;
	/** 不属于任何会话的载荷：行表、一行变更，或心跳。 */
	onConnectionItem(item: ConnectionItem): void;
	/**
	 * 某条会话流的一个帧。
	 *
	 * `baseline` 是那个一职两用的成员：它同时也是一次进行中导航的答案，所以向 `retain` 传了
	 * `series` 的窗口会被通知两次 —— 一次经 promise，一次经这个 handler。两者是同一个快照，
	 * 谁也不以谁为条件。
	 */
	onStreamMessage(sessionId: string, message: ServerMessage): void;
	/** 服务端结束了这条流。重连不会重开它；新的 retain 会复活它。 */
	onStreamEnd(sessionId: string): void;
	/**
	 * 一条流没有结束就失败了 —— 服务端拒绝的 `open`，或 `announce` 过的故障。
	 *
	 * 同时也是一次进行中导航的答案，所以等待基线的窗口可能听到同一个失败两次：一次在这里，一次
	 * 作为 `retain` 返回的 promise 的拒绝。
	 */
	onStreamError(sessionId: string, message: string): void;
}

/**
 * 第一次延迟的上限：`500ms`，每次尝试翻倍，直至 {@link BACKOFF_CAP_MS}。
 *
 * 第一次*真正*的等待是它的一半 —— 见 {@link backoffDelay} —— 所以把"500"读成等待时长差了一倍。
 */
const BACKOFF_FIRST_MS = 500;

/** 每个延迟饱和的上限。没有尝试次数上限：常驻通道永不放弃。 */
const BACKOFF_CAP_MS = 10_000;

/**
 * 一次尝试变成 `live` 之前允许花费的时间。
 *
 * "已连接"不是标准 —— 证明才是。打开后从不送帧的 socket 是一个无法与黑洞区分的连接，所以这个
 * 限时把没能证明自己的尝试放弃掉，把新一轮交给退避。
 *
 * 与看门狗同值，但刻意不是同一个定时器：它们度量两个不同的问题（"这次尝试证明了没有"和"一条
 * 已证明的连接是不是安静了"），合并它们会让 socket 的第一次心跳失去归属。
 */
const READY_TIMEOUT_MS = 15_000;

/**
 * 心跳说明它的间隔之前，沉默的预算。
 *
 * 是回退值而非真正的规则：心跳一旦到达就会报出自己的间隔，容忍度从那个值推导，所以它只管辖
 * 通道证明自己到第一次心跳落地之间的那段。它是选项，是为了让冒烟测试把整个看门狗压到毫秒级；
 * 生产环境不动它。
 */
const WATCHDOG_TIMEOUT_MS = 15_000;

/** 以心跳间隔计的容忍度，超过即判定 live 连接已死。 */
const WATCHDOG_MULTIPLIER = 3;

/**
 * 一次导航可以为它的基线等待多久。
 *
 * 限制的是*窗口*，不是服务端：`open` 已被接受、基线已被承诺，这是窗口停止假装它还在路上的
 * 时刻。它真正的尺寸依据是写队列后面的等待（基线是一整份会话记录，会排在繁忙会话正在流式
 * 输出的内容之后），而不是构建基线的成本 —— 那个成本实测对 3000 条消息 / 1.9 MiB 的快照只有几
 * 毫秒，所以三秒大约是它的三个数量级的余量，真正的支配项是"一个人会盯着一块还没变化的窗格多久"。
 * 把它收紧到实测成本附近，就会把一条只是繁忙的连接报告成坏连接，这正是这个数字要避免的失败。
 */
const OPEN_TIMEOUT_MS = 3_000;

/** 客户端判定连接已死时用来关闭的 code。客户端自选的 code。 */
const CLOSE_RECONNECT_REQUESTED = 4000;

/** 本连接正在看的一个会话。 */
interface Subscription {
	/** 它仍被需要的原因。空集合表示条目正在被丢弃。 */
	sources: Set<SubscriptionSource>;
	status: SubscriptionStatus;
}

/**
 * 某会话下一条基线将要应答的那些导航。
 *
 * "窗口要求查看这个会话" —— 调用者 await 的那个 promise —— 是本地完成，刻意不是协议完成：
 * wire 上没有为它新增帧类型（ADR-0009）。应答 `open` 的基线与流为自己锚定的帧是同一个，所以
 * 每个会话一条记录就是全部的记账；除了会话 id 之外没有别的要匹配。
 *
 * 多个请求可以同时等在它上面。点同一行两次是两个请求一条流，答案无论如何是同一个快照 —— 所以
 * 它们一起等，而不是第二个取消第一个。哪一个*绘制*是调用者对着自己的 series 做的决定；这里不会
 * 只因一个请求更旧就拒绝它。
 */
interface PendingOpen {
	/** 等在这条流上的每个导航，最早的请求在前。 */
	waiters: {
		/**
		 * 调用者给这次导航的编号。仅用于在超时写的日志行里指名它：本层从不拿它和任何东西比较，
		 * 因为哪次点击最新是窗口自己的计数器的事。
		 */
		series: number;
		resolve(session: SessionSnapshot): void;
		reject(error: Error): void;
	}[];
	/**
	 * 它们共享的期限，因为这段等待属于流而不属于某一次点击。记录落定时清除。
	 */
	timer: unknown;
}

/** 所有选项解析完毕后的形态，正是状态机实际读取的东西。 */
interface ResolvedMuxOptions {
	url: string;
	socket: MuxSocketFactory;
	readyTimeoutMs: number;
	watchdogTimeoutMs: number;
	openTimeoutMs: number;
	log: (line: string) => void;
}

/**
 * 一条通往服务端的常驻通道，以及窗口需要知道的关于它健康的一切。
 *
 * 三件过去住在别处的东西在这里同住，理由只有一个：每一件都是一个不能有第二个主人的时钟或计数器。
 *
 * **退避时间线。** 浏览器会自己重连 `EventSource`，却完全不重连 `WebSocket`，所以这是唯一决定
 * 何时重试的东西。上限从 500ms 翻倍到 10s，实际等待是它的 50–100%，这让同时失去同一服务器的几个
 * 窗口错开返回，而不是步调一致地一起回来。没有尝试次数上限，因为放弃的通道与服务器永久消失的
 * 通道无法区分。
 *
 * **两个永不重叠的期限。** 一次尝试被 {@link READY_TIMEOUT_MS} 限制，直到它证明自己；一旦证明，
 * 那个期限就消失，由 {@link WATCHDOG_TIMEOUT_MS} 度量沉默。它们同值，因为是同一个问题在两个
 * 阶段的提问。（第三个 {@link OPEN_TIMEOUT_MS} 与两者无关，并行运行：它限制的是一次导航，不是
 * 连接。）
 *
 * **看门狗。** 空闲但健康不产生任何帧 —— 逻辑流只在它看的会话有话要说时才开口 —— 所以沉默本身
 * 证明不了什么。让它成为判决的是服务端的连接级心跳：任何帧都会重置计时器，容忍度是服务端最后
 * 上报间隔的三倍，所以这两个数字写在一处。
 *
 * 订阅表是这里的第四件东西，且刻意是*唯一*在失败尝试后存活的状态。它的条目是意图，不是到达
 * 记录，所以重连会重开每一条并拿到新基线 —— 这是这个传输仅有的恢复手段，也是它 anywhere 都没有
 * 游标或补洞的原因。
 *
 * 第五件是进行中导航的小账本：窗口在等待被展示一个会话时 await 的那些 promise。它们由应答它们的
 * 帧结算，否则由本地超时结算，绝不会由自己的帧类型结算 —— "打开会话"是本地完成，给它协议形态
 * 会让 wire 携带一个它用不上的确认。与订阅表不同，它按规则不在失败尝试后存活：重连的重放常常
 * 产生结算它的基线，而没有产生时，超时就是收尾者。
 *
 * 这里任何东西都不碰 DOM。socket、定时器、网络事件和抖动都是注入的，这让冒烟测试能在毫秒级驱动
 * 一台十五秒的状态机，并断言浏览器需要代理才能复现的东西。
 */
export class MuxClient {
	private readonly handlers: MuxHandlers;
	private readonly options: ResolvedMuxOptions;
	private readonly timers: MuxTimers;
	private readonly random: () => number;
	private readonly log: (line: string) => void;

	/**
	 * 本尝试的 socket。
	 *
	 * 未连接时为 `undefined`。替换它就是重连的全部：新的 socket 是物理替换，它上面的每条逻辑流
	 * 都按引用重开，而不是靠这个类对旧尝试记住的任何东西。
	 */
	private socket?: MuxSocket;
	/**
	 * 哪次尝试在说话。
	 *
	 * socket 对客户端自己关闭的连接，和对掉线的一样都会引发 `close` 和 `error`，所以下面的 handler
	 * 无法自行区分两者。这个计数器就是让它们能区分的东西：一次尝试递增它，来自被取代尝试的每个
	 * handler 发现自己已过期，什么都不做。
	 */
	private generation = 0;
	private channelState: ChannelState = "connecting";
	/** 自上次成功证明以来失败的尝试次数。 */
	private attempt = 0;
	/** 只由 {@link close} 设置，那是窗口离去，不是连接失败。 */
	private stopped = false;
	/** 浏览器说网络没了，不值得做任何尝试。 */
	private offline = false;
	/** 进行中的退避休眠，若有。 */
	private retryTimer: unknown = null;
	/** 当前尝试的就绪期限，只要它还在试图证明自己。 */
	private readyTimer: unknown = null;
	/** live 连接上的沉默预算，每个帧都会重置。 */
	private watchdogTimer: unknown = null;
	/** 服务端最后一次上报的间隔，未上报过时为 `undefined`。 */
	private heartbeatMs: number | undefined;
	/** 本连接正在看的会话。每个会话一条，无论有多少来源。 */
	private readonly subscriptions = new Map<string, Subscription>();
	/**
	 * 仍在等待基线的导航，按会话。
	 *
	 * 刻意放在订阅表之外：一个引用消失不是答案，而一个已无人观看的导航仍然必须停止等待（超时是
	 * 说这话的东西）。把两者分开，正是让 release 成为一桩小事的原因。
	 */
	private readonly pendingOpens = new Map<string, PendingOpen>();

	constructor(handlers: MuxHandlers, options: MuxOptions) {
		this.handlers = handlers;
		this.options = {
			url: options.url,
			socket: options.socket,
			readyTimeoutMs: options.readyTimeoutMs ?? READY_TIMEOUT_MS,
			watchdogTimeoutMs: options.watchdogTimeoutMs ?? WATCHDOG_TIMEOUT_MS,
			openTimeoutMs: options.openTimeoutMs ?? OPEN_TIMEOUT_MS,
			log: options.log ?? ((line) => console.warn(line)),
		};
		this.timers = options.timers ?? {
			setTimeout: (fn, ms) => setTimeout(fn, ms),
			clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		};
		this.random = options.random ?? Math.random;
		this.log = this.options.log;
		if (options.network !== undefined) this.watchNetwork(options.network);
	}

	/** 打开通道。第一次尝试立即进行；只有失败才退避。 */
	start(): void {
		if (this.stopped || this.socket !== undefined) return;
		this.attemptConnect();
	}

	/**
	 * 永久停止。
	 *
	 * 与断线不是一回事：这是窗口卸载，之后不会有任何尝试。这个类里其他一切放弃连接的地方都是
	 * *替换*，这正是这个标志是类级的原因 —— 一个按尝试的"放弃"与它无法区分。
	 */
	close(): void {
		this.stopped = true;
		this.clearTimers();
		// 正在关闭的窗口已无人可告知，所以每个仍在等待的导航在这里结算，而不是留给这条连接永远
		// 收不到的基线。拒绝是诚实的答案：它们没有一个被回答过。
		for (const sessionId of [...this.pendingOpens.keys()]) this.settleOpen(sessionId, new Error("通道已关闭。"));
		this.socket?.close(1000, "window is closing");
		this.socket = undefined;
	}

	/**
	 * 声明窗口因一个比一次运行更长久的原因需要这个会话的内容。
	 *
	 * 按来源、按会话幂等，所以调用者可以说"确保有东西在看这个"而不必跟踪是否已经在看。引用计数
	 * 决定何时发出 `cancel`，它保持不变：同一会话的第二个原因仍然只是添加一个来源，绝不是第二条流。
	 *
	 * 每次调用还*要求* —— `open` 是幂等原语（ADR-0009），已打开的流会以新基线作答，于是回到一个
	 * send 仍持有着的会话的窗格，看到的是"它现在长什么样"，而不是过去那种沉默。这是过去跳过那个
	 * 帧的唯一地方；表的其他部分什么都没变。
	 *
	 * 传 `series` 是导航要求被告知何时落下的方式：返回的 promise 以这次 `open` 产生的基线的快照
	 * 结算，在流出错或结束、或安静超过 {@link OPEN_TIMEOUT_MS} 时拒绝。该 promise 是本地完成，
	 * wire 上没有它的任何东西 —— 不带 `series` 的 retain（send 的引用，或通道还在连接时打开的
	 * 窗格）没有要完成的导航，返回空。
	 *
	 * `series` 本身是调用者自己的计数器，本层从不把它当判决读：这条流产生的每个基线都会交给等待
	 * 的人，哪次点击获得绘制由比较窗口自己保存的数字来决定。
	 *
	 * 两个签名是解析了联合后的同一次调用：不带导航的引用没有要完成的（`undefined`），而导航总有
	 * 一个 promise —— 包括答案是一次拒绝的情形，那是拒绝而不是缺失的值。
	 */
	retain(sessionId: string, source: SubscriptionSource): undefined;
	retain(sessionId: string, source: SubscriptionSource, series: number): Promise<SessionSnapshot>;
	retain(sessionId: string, source: SubscriptionSource, series?: number): Promise<SessionSnapshot> | undefined {
		// 已关闭的通道选择应答而不是排队：导航是一个问题，"这个窗口正在离去"就是它得到的答案。
		// 默默返回空会让调用者 await 一个它从未收到过的 promise。
		if (this.stopped) return this.refuse(series, "通道已关闭。");

		const existing = this.subscriptions.get(sessionId);
		if (existing !== undefined) {
			existing.sources.add(source);
			// 新的需求会复活服务端已结束的流，这就是为什么它无条件写而不藏在 `if` 后面：`ended`
			// 标记的存在是为了让*重连*路径 —— {@link replaySubscriptions} —— 不再为一个服务端已
			// 宣告结束的会话重复要求，它不是一个比一次新的意图手势更长寿的判决。没有这一行，一个
			// 窗格从未放手的会话就永远无法再被观看：走出 `ended` 的另一条路是引用计数降到零，而
			// 仍指着会话的窗格恰恰阻止了这一点。
			existing.status = "subscribed";
		} else {
			this.subscriptions.set(sessionId, { sources: new Set([source]), status: "subscribed" });
		}

		// 通道不是 live 时不发送：无处可发，而且 live 迁移本来就会重放每个条目 —— 记录意图刚才
		// 就是全部的工作。无论如何都要求了导航的，会被拒绝而不是等待一条这条连接从未请求过的基线，
		// 因为那种等待只会在超时里结束，而这个超时说的是"没人问过的服务端很慢"。
		if (this.channelState !== "live") return this.refuse(series, "通道未连接，无法打开会话。");

		const opened = series === undefined ? undefined : this.expectBaseline(sessionId, series);
		this.writeOpen(sessionId);
		return opened;
	}

	/**
	 * 放弃观看一个会话的一个原因。
	 *
	 * 最后离开的人发送 `cancel` 并删除条目，这同时也是释放窗口持有的那个会话的副本 —— 没有第二处
	 * 要清理，所以"没人在看它"和"我们没为它持有任何东西"按构造就是同一个事件。
	 */
	release(sessionId: string, source: SubscriptionSource): void {
		const subscription = this.subscriptions.get(sessionId);
		if (subscription === undefined) return;
		// 布尔返回值是旧代码缺的那道防线：从未持有的来源绝不能被释放，否则下面的最后引用逻辑会在
		// 一次调用并未真正改变的集合上触发。
		if (!subscription.sources.delete(source)) return;
		if (subscription.sources.size > 0) return;

		this.subscriptions.delete(sessionId);
		if (this.channelState === "live" && subscription.status !== "ended") {
			this.write({ type: "cancel", sessionId });
		}
	}

	/** 本连接对自己的认知。 */
	get channel(): ChannelState {
		return this.channelState;
	}

	/** 此会话当前在本连接上是否有一条 live 的逻辑流。 */
	isWatching(sessionId: string): boolean {
		return this.subscriptions.get(sessionId)?.status === "subscribed";
	}

	/** 是否还有任何原因需要这个会话。 */
	isRetained(sessionId: string): boolean {
		return (this.subscriptions.get(sessionId)?.sources.size ?? 0) > 0;
	}

	// ------------------------------------------------------------- 尝试

	/**
	 * 一次尝试：从裸 socket 到已证明的通道。
	 *
	 * 除了退避计数器，这里任何东西都不跨尝试记忆，这是刻意的。新的尝试对旧的知道 nothing ——
	 * 不知道它的流，不知道它的帧 —— 因为通道之上的一切都从新基线收敛，而一个会记忆的机制将成为
	 * "窗口在看什么"的第二个事实来源。
	 */
	private attemptConnect(): void {
		if (this.stopped || this.offline) return;
		const generation = ++this.generation;
		this.socket?.close(1000, "replaced by a new attempt");
		this.setChannel("connecting");

		const socket = this.options.socket({
			onOpen: () => {
				// 刻意*不*让通道变 live。打开的 socket 只证明了一次握手，而握手恰恰是黑洞化的连接
				// 也能完成的；第一个帧才是证明，在它落地之前由就绪期限说了算。
				if (generation !== this.generation) return;
			},
			onMessage: (text) => this.onFrame(generation, text),
			onClose: () => this.onLost(generation, "连接已断开"),
			onError: () => {
				// `error` 之后必然跟着 `close`，退避是在那里决定的 —— 在两处都决定会开启两个休眠，
				// 让其中一个醒来时无事可做。
				if (generation !== this.generation) return;
			},
		});
		this.socket = socket;

		this.readyTimer = this.timers.setTimeout(() => {
			this.readyTimer = null;
			if (generation !== this.generation) return;
			// 打开了，或接近打开，但仍然没有帧。放弃这个 socket 而不是继续等：下一次尝试的成本是
			// 一次退避，而一个无法证明自己的 socket，看门狗反正也会在宣布它 live 之后不久把它杀掉。
			this.log("mux: 这次连接没能证明自己活着，放弃并重试");
			this.onLost(generation, "连接就绪超时");
		}, this.options.readyTimeoutMs);
	}

	/** 一次尝试的最后一步，无论它因何结束：报告 down，然后退避。 */
	private onLost(generation: number, why: string): void {
		if (generation !== this.generation) return;
		this.generation += 1;
		this.clearTimers();
		this.socket = undefined;
		if (this.stopped) return;

		this.log(`mux: ${why}（第 ${this.attempt + 1} 次）`);
		this.setChannel("down");
		if (this.offline) return;

		// 订阅表刻意存活。它的条目是*意图*，不是到达记录：掉线之前被观看的会话仍然被观看，下一次
		// `live` 会重开每一条并为它拿到新基线。
		const cap = this.backoffCap(this.attempt + 1);
		this.attempt += 1;
		this.retryTimer = this.timers.setTimeout(() => {
			this.retryTimer = null;
			this.attemptConnect();
		}, this.backoffDelay(cap));
	}

	/**
	 * wire 上的一个帧。
	 *
	 * 这里是唯一决定帧含义的地方，而且它只靠 `streamId` 决定：`null` 指连接，其他任何值指一条
	 * 逻辑流。检查载荷形状的客户端将不得不认识两个 union 的每个成员才能路由一个帧，而新成员会
	 * 成为对路由器的破坏性变更，而不是一次添加。
	 *
	 * 存活检查在帧被识别**之后**而不是之前做，顺序就是要点。字节到达证明 socket 打开着，却不能
	 * 证明对端理解这个协议 —— 所以本客户端读不懂的载荷必须让就绪期限继续运行。反过来，一个损坏
	 * 或陌生的帧就会把一个自打开以来没说过任何可理解内容的通道转正，而那个存在的目的正是捕捉这种
	 * 情形的期限，就会被它所盯着的东西自己取消。
	 */
	private onFrame(generation: number, text: string): void {
		if (generation !== this.generation) return;

		let frame: unknown;
		try {
			frame = JSON.parse(text);
		} catch {
			// 丢弃，不是致命：一个读不懂的帧比为此关闭通道便宜，而且就绪期限仍然有机会触发。
			return;
		}
		if (typeof frame !== "object" || frame === null) return;
		const record = frame as { streamId?: unknown };
		if (record.streamId === null) {
			this.noteAlive();
			this.onConnectionFrame(frame as ConnectionFrame);
			return;
		}
		// 不路由，也不计作活着的证明：没有会话 id 的载荷是本协议没有形状的东西，把它当作健康信号
		// 会让唯一一个毫无意义的帧取消那个正是为此而设的期限。
		if (typeof record.streamId !== "string") return;
		this.noteAlive();
		this.onStreamFrame(record.streamId, frame as StreamFrame);
	}

	private onConnectionFrame(frame: ConnectionFrame): void {
		// 用 `in` 而不是 `!== undefined`，与流分支同样的理由：这是靠哪个键存在来区分的三种形状，
		// 对一个其中两个都缺的键做查找，问的就是错误的问题。
		if ("item" in frame) {
			// 心跳自己的消费者是看门狗，它携带的间隔正是容忍度计算所依据的 —— 所以这个数字在这里
			// 被读取，而不是在这里被猜测。
			if (frame.item.type === "heartbeat") this.heartbeatMs = frame.item.everyMs;
			this.handlers.onConnectionItem(frame.item);
			return;
		}
		// 信封级的失败不属于任何会话，所以没有列可以归档它。空 id 就是本层说"不属于任何一个"的
		// 方式，这让窗口不会把一个连接问题归进碰巧在屏幕上的那个对话里。
		this.handlers.onStreamError("", frame.error.message);
	}

	private onStreamFrame(sessionId: string, frame: StreamFrame): void {
		// `in` 而不是 `!== undefined`：三种形状靠哪个键携带载荷来区分，其中两个根本没有 `item`
		// 键 —— 所以对它发问是类型错误，而不是碰巧没命中的查找。
		if ("item" in frame) {
			// 基线是对最后一次 `open` 所问的答案，所以它在被交给绘制之前先结算一次导航。无论是否
			// 有导航它都会被交下去：同一个帧也是流自己的锚，没有在导航的调用者照样折叠它。
			if (frame.item.type === "baseline") this.settleOpen(sessionId, frame.item.session);
			this.handlers.onStreamMessage(sessionId, frame.item);
			return;
		}
		if ("error" in frame) {
			// 流级失败本身不是终点：无法启动的运行在这里上报，流保持打开。决定这条订阅是否结束的
			// 是服务端是否跟了一个 `end`，在下面处理。
			//
			// 不过进行中的导航是被它*回答*的：被拒绝的流不是一份稍后会到达的基线，窗口应该听到
			// 这一点，而不是等完自己的超时。
			this.settleOpen(sessionId, new Error(frame.error.message));
			this.handlers.onStreamError(sessionId, frame.error.message);
			return;
		}
		if (frame.end === true) this.endStream(sessionId);
	}

	/**
	 * 服务端结束了这条流。
	 *
	 * 条目保留，继续持有所有还需要这个会话的东西，因为"没人再需要它了"不是发生的事：窗格仍在
	 * 看着它。变的是这条逻辑流结束了，所以下一次重连绝不能重开它 —— 服务端已经给出了答案，再问
	 * 一次只会拿回第二份副本。`ended` 标记在最后一个引用消失时清除，所以把窗格指走再指回来会重新
	 * 订阅。
	 */
	private endStream(sessionId: string): void {
		const subscription = this.subscriptions.get(sessionId);
		if (subscription !== undefined) subscription.status = "ended";
		// 被服务端宣告结束的流不会再携带基线，所以等在它上面的导航现在被回答，而不是等到超时。
		// 订阅本身保留：见上。
		this.settleOpen(sessionId, new Error("服务端结束了这条流，没有基线。"));
		this.handlers.onStreamEnd(sessionId);
	}

	// -------------------------------------------------------------- 导航

	/**
	 * 排进某会话下一条基线将要应答的队列。
	 *
	 * 每个会话一条记录，因为一个会话只有一条流 —— 所以第一个请求还在等待时的第二个请求加入它，
	 * 而不是替换它。两者都在对同一条流问同一个问题，应答它的快照应答所有；"某次点击被取代"留给
	 * 调用者自己的 series 说，那是唯一知道点击如何计数的地方。
	 */
	private expectBaseline(sessionId: string, series: number): Promise<SessionSnapshot> {
		const waiting = this.pendingOpens.get(sessionId) ?? this.armWait(sessionId);
		return new Promise<SessionSnapshot>((resolve, reject) => {
			waiting.waiters.push({ series, resolve, reject });
		});
	}

	/**
	 * 启动某会话第一个等待中的导航打开的时钟。
	 *
	 * 期限属于流，不属于点击：等在这条流上的一切共享它，所以已经等了两秒的窗格，不会因为又被要求
	 * 一次而重新获得三秒。
	 */
	private armWait(sessionId: string): PendingOpen {
		const pending: PendingOpen = {
			waiters: [],
			timer: this.timers.setTimeout(() => this.timeoutOpen(sessionId), this.options.openTimeoutMs),
		};
		this.pendingOpens.set(sessionId, pending);
		return pending;
	}

	/**
	 * 等待到期，没有基线。
	 *
	 * 没有别的动作：订阅保留，因为基线可能仍坐在服务端写队列里一个大帧的后面，而 `cancel` 也会排
	 * 在它后面 —— 丢掉引用释放的是流，不是积压。真正的堵塞是服务端自己的 10s 停滞上界，它会以
	 * `1013` 关闭连接并让重放治愈它。
	 */
	private timeoutOpen(sessionId: string): void {
		const waiting = this.pendingOpens.get(sessionId);
		if (waiting === undefined) return;
		const asked = waiting.waiters.map((waiter) => waiter.series).join(", ");
		this.log(`mux: 第 ${asked} 次打开 ${sessionId} 没等到基线（${this.options.openTimeoutMs} ms）`);
		this.settleOpen(sessionId, new Error(`等待会话基线超过 ${this.options.openTimeoutMs} ms。`));
	}

	/**
	 * 结算此会话正在等待的所有导航，若有。
	 *
	 * 每个结算点的唯一出口 —— 基线、失败、结束、超时、正在关闭的窗口 —— 所以"每个 promise 恰好
	 * 被回答一次、计时器随它一起消失"靠构造成立，而不是靠每个调用者自己记得。
	 */
	private settleOpen(sessionId: string, outcome: SessionSnapshot | Error): void {
		const waiting = this.pendingOpens.get(sessionId);
		if (waiting === undefined) return;
		this.pendingOpens.delete(sessionId);
		this.timers.clearTimeout(waiting.timer);
		for (const waiter of waiting.waiters) {
			if (outcome instanceof Error) waiter.reject(outcome);
			else waiter.resolve(outcome);
		}
	}

	/**
	 * 拒绝一次这条连接无法服务的导航。
	 *
	 * 没指名导航的 retain 就此完成 —— 没有要回答的东西 —— 联合类型让这两者在调用点都可见，而不是
	 * 变成一个被忽略的 rejection。
	 */
	private refuse(series: number | undefined, message: string): Promise<SessionSnapshot> | undefined {
		return series === undefined ? undefined : Promise.reject(new Error(message));
	}

	// --------------------------------------------------------------- 存活

	/**
	 * live 连接上有帧到达：沉默预算从头开始。
	 *
	 * 也是已证明的尝试不再是尝试的地方。就绪期限在这里被取消，而不是留给它在一个工作正常的通道上
	 * 过期 —— 那种过期会在一个慢的首帧超过期限的瞬间，关闭一条完美的连接。
	 */
	private noteAlive(): void {
		if (this.readyTimer !== null) {
			this.timers.clearTimeout(this.readyTimer);
			this.readyTimer = null;
		}
		if (this.channelState !== "live") {
			// 刚证明自己的通道把退避从头开始：它对下一次故障有多健康什么都没说，带着旧计数会让
			// 长时间健康之后的第一次重试毫无理由地等十秒。
			this.attempt = 0;
			this.setChannel("live");
			this.replaySubscriptions();
		}

		if (this.watchdogTimer !== null) this.timers.clearTimeout(this.watchdogTimer);
		this.watchdogTimer = this.timers.setTimeout(() => {
			this.watchdogTimer = null;
			const socket = this.socket;
			if (socket === undefined || this.channelState !== "live") return;
			this.log("mux: 太久没有收到任何帧，判定连接已死");
			// 以客户端 code 关闭而不是直接丢弃：这是一个决定，close 帧就是服务端得知订阅表该走的
			// 方式。`onLost` 从这里跟进，与服务端一侧的关闭完全一样。
			socket.close(CLOSE_RECONNECT_REQUESTED, "reconnect requested");
			this.onLost(this.generation, "读超时");
		}, this.watchdogTolerance());
	}

	/**
	 * live 连接可以安静多久。
	 *
	 * 心跳一旦上报了间隔，容忍度就从它推导，两侧因此无法漂移：服务端说它多久说一次话，这一侧允许
	 * 三次迟到才判死。第一次上报之前没有可推导的东西，所以配置值生效 —— 这正是它是选项的原因。
	 */
	private watchdogTolerance(): number {
		return this.heartbeatMs === undefined
			? this.options.watchdogTimeoutMs
			: WATCHDOG_MULTIPLIER * this.heartbeatMs;
	}

	// ---------------------------------------------------------------- 网络

	/**
	 * 浏览器自己对网络说的话。
	 *
	 * `offline` 是挂起而不是失败：没有可连接的东西，在没有路由的机器上烧退避次数，会把真正故障
	 * 需要的计数花掉。
	 *
	 * `online` **不**直接重连 —— 它打断当前的等待，重置计数器，然后再睡一次普通的退避。理由是
	 * "网络回来了"和"服务器回来了"是两个事实，第二个只能由一次尝试确立。睡一次能防止一条抖动的
	 * 链路变成紧密的重连循环，又不让真正的恢复等得更久。
	 */
	private watchNetwork(network: NetworkEvents): void {
		network.addEventListener("offline", () => {
			this.offline = true;
			if (this.retryTimer !== null) {
				this.timers.clearTimeout(this.retryTimer);
				this.retryTimer = null;
			}
			if (this.stopped || this.channelState !== "live") return;
			this.generation += 1;
			this.clearTimers();
			this.socket?.close(1000, "the browser went offline");
			this.socket = undefined;
			this.setChannel("down");
		});

		network.addEventListener("online", () => {
			this.offline = false;
			if (this.stopped || this.channelState === "live") return;
			if (this.retryTimer !== null) {
				this.timers.clearTimeout(this.retryTimer);
				this.retryTimer = null;
			}
			this.attempt = 0;
			const cap = this.backoffCap(1);
			this.retryTimer = this.timers.setTimeout(() => {
				this.retryTimer = null;
				this.attemptConnect();
			}, this.backoffDelay(cap));
		});
	}

	// ---------------------------------------------------------------- 写入

	/**
	 * 重开这条连接仍然有理由持有的每一条逻辑流。
	 *
	 * 在进入 `live` 的迁移时调用，那是唯一能发帧的时刻。每个不是 `ended` 的条目按引用重开：服务端
	 * 把它当作全新的订阅并以新基线作答，所以窗口最终显示的是"它现在长什么样"，而不是"我错过了
	 * 什么" —— 这是这个传输仅有的恢复手段，也是它 anywhere 都没有游标或补洞的原因。
	 *
	 * 掉线时正在进行中的导航在这里不需要任何东西，两半都是刻意的。如果重放到达了它的会话，新基线
	 * 会结算挂起的 promise —— 等的是基线，这就是一个。如果没有（条目是 `ended`，或它的最后一个
	 * 引用在连接断开期间消失了），就没有可重开的东西，等待以所有等待结束的方式结束：超时。注意
	 * 这排除了什么 —— release 不结算导航，因为"窗格移开了目光"不是关于会话的答案，而 send 的
	 * release 若能回答窗格的问题就成了越权。
	 */
	private replaySubscriptions(): void {
		for (const [sessionId, subscription] of this.subscriptions) {
			if (subscription.status === "ended" || subscription.sources.size === 0) continue;
			subscription.status = "subscribed";
			this.writeOpen(sessionId);
		}
	}

	/** 请求这个会话的流。每次 retain 都发，因为答案幂等。 */
	private writeOpen(sessionId: string): void {
		this.write({ type: "open", sessionId });
	}

	/**
	 * 发送一个上行帧，或因为无通道而丢弃它。
	 *
	 * 丢弃而不是排队是刻意的。两个帧都是订阅表已经持有的关于*意图*的陈述 —— 被丢弃的 `open` 会由
	 * 下一次 `live` 从需要它的条目重发，被丢弃的 `cancel` 指的是这条连接已经不再持有（或从未持有）
	 * 的会话。队列将是表的第二份副本，而重连唯一绝不能错的，就是它认为自己正在看什么。
	 */
	private write(frame: { type: "open" | "cancel"; sessionId: string }): void {
		const socket = this.socket;
		if (socket === undefined || this.channelState !== "live") return;
		try {
			socket.send(JSON.stringify(frame));
		} catch (error) {
			// 向浏览器已经遗忘了的 socket 发送会抛异常，而不是软失败。这是丢了一个帧，不是坏了通道：
			// 表仍然持有意图，看门狗或 close 事件会驱动重发它的替换。
			this.log(`mux: 上行帧发不出去：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private setChannel(channelState: ChannelState): void {
		if (this.channelState === channelState) return;
		this.channelState = channelState;
		this.handlers.onChannel(channelState);
	}

	private clearTimers(): void {
		for (const timer of [this.retryTimer, this.readyTimer, this.watchdogTimer]) {
			if (timer !== null) this.timers.clearTimeout(timer);
		}
		this.retryTimer = null;
		this.readyTimer = null;
		this.watchdogTimer = null;
	}

	/** 第 n 次尝试的上限，翻倍到 {@link BACKOFF_CAP_MS} 为止。 */
	private backoffCap(attempt: number): number {
		return Math.min(BACKOFF_CAP_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, attempt - 1));
	}

	/**
	 * 实际等待多久：上限的一半，再加上至多半上限的抖动。
	 *
	 * 抖动不是装饰。几个看着同一服务器的窗口会在同一时刻失去它，固定延迟也会让它们在同一时刻回来
	 * —— 把一次故障变成对刚重启服务器的惊群。
	 */
	private backoffDelay(cap: number): number {
		const half = cap / 2;
		return half + this.random() * half;
	}
}

/** 由此服务端服务的页面的通道位置。同源，一条固定路径。 */
export function muxUrl(location: { protocol: string; host: string }): string {
	const scheme = location.protocol === "https:" ? "wss:" : "ws:";
	return `${scheme}//${location.host}/mux`;
}

/** 建立在浏览器自带 `WebSocket` 之上的 socket 工厂。 */
export function browserSocket(url: string): MuxSocketFactory {
	return (handlers) => {
		const socket = new WebSocket(url);
		socket.addEventListener("open", () => handlers.onOpen());
		socket.addEventListener("message", (event) => handlers.onMessage(String(event.data)));
		socket.addEventListener("close", () => handlers.onClose());
		socket.addEventListener("error", () => handlers.onError());
		return {
			send: (text) => socket.send(text),
			close: (code, reason) => socket.close(code, reason),
		};
	};
}