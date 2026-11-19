import type { ServerFrame } from "@my-agent/core/protocol";

/**
 * 一条连接上"把帧写到 socket"的全部机制：有界队列、背压、停滞期限、ping、应用心跳、关闭。
 *
 * 这一层知道帧、字节数、队列、socket 还收不收写；不知道会话、事件、baseline、审批、目录，也不知道
 * 连接上除了帧之外发生过什么。它对上层唯一的接口是 `send`，对 socket 唯一的接口是 {@link FrameSink}。
 *
 * 帧序不变量的第一半住在这里：一条连接上的所有帧——流上的、行、心跳、end——只经同一个队列写出，
 * 所以「先 baseline 后增量」由队列顺序保证，不靠约定。另一半（什么时候把哪一帧交给 `send`）在
 * 知道会话的那一层。
 */

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
export const CLOSE_GOING_AWAY = 1001;

/**
 * 与那些 code 配套的 reason，集中在一处，因为它们是同一类字符串。
 *
 * 刻意用英文：Close reason 的读者是决定下一步怎么做的客户端，而且它与客户端自己发送的 `4000 "reconnect requested"` 之类的 code 并排出现。本文件里的中文是给读代码的人看的——本层唯一会打的那行日志——而那行日志刻意不是 wire 上的那条。
 */
const REASON_STOPPED_READING = "subscription client stopped reading";
export const REASON_SHUTTING_DOWN = "server is shutting down";

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
export interface WireOptions {
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
export type ResolvedWireOptions = Required<WireOptions>;

/** 把选项补成完整形态。默认值只在这里写一次，服务器与连接因此不可能各说各话。 */
export function resolveWireOptions(options: WireOptions = {}): ResolvedWireOptions {
	return {
		pingIntervalMs: options.pingIntervalMs ?? PING_INTERVAL_MS,
		maxMissedPongs: options.maxMissedPongs ?? MAX_MISSED_PONGS,
		heartbeatIntervalMs: options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
		stallBudgetBytes: options.stallBudgetBytes ?? STALL_BUDGET_BYTES,
		stallDeadlineMs: options.stallDeadlineMs ?? STALL_DEADLINE_MS,
		log: options.log ?? ((line) => console.warn(line)),
	};
}

/**
 * 一条连接的有界写队列，以及判定 peer 是否仍在应答的计数器。
 *
 * 它只管一帧一帧地送到 socket，以及送不到时该怎么办；连接上承载的是什么，它不知道也不问。
 */
export class Wire {
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
	/** 本层关闭时通知的那一步，没有登记时为 `undefined`。 */
	private closeListener: (() => void) | undefined;

	private readonly frameSink: FrameSink;
	private readonly options: ResolvedWireOptions;

	constructor(frameSink: FrameSink, options: ResolvedWireOptions) {
		this.frameSink = frameSink;
		this.options = options;
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
		if (this.frameSink.send(frame)) return;

		// `false` 意味着这帧已被收进 socket 自己的缓冲、排队在*那里*，所以绝不能重写，否则会送达两次。从这一刻起连接算作停滞，这帧之后的一切都要等。
		this.markStalled();
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
			this.frameSink.terminate();
			this.close();
			return;
		}
		this.missedPongs += 1;
		this.frameSink.ping();
	}

	/** 一个 Pong 到达：peer 活着，计数清零重来。 */
	notePong(): void {
		this.missedPongs = 0;
	}

	/** 本层日志的去处。帧层的诊断行与停滞日志共用一个出口，一条连接的日志因此只有一处可被接管。 */
	log(line: string): void {
		this.options.log(line);
	}

	/**
	 * 登记"本层关闭时"要做的那一步。
	 *
	 * 一个就够：mux 用它把连接从集合里忘记并放下它的订阅，于是自关（停滞期限、ping 容忍度耗尽）
	 * 与外部 `close()` 走同一条收尾路径，而不是等下一次存活探测撞见 `isClosed`。
	 */
	onClose(listener: () => void): void {
		this.closeListener = listener;
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
	 * 停止本层：丢弃队列、清掉停滞簿记与定时器。
	 *
	 * 关闭后接受检视的连接报告一个已了结的状态，而不是一副还在等一个永远不会排空的 socket 的样子。
	 */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.queue.length = 0;
		this.queuedBytes = 0;
		this.stalled = false;
		this.stalledSince = 0;
		this.clearStallTimer();
		// 通知放在状态落定之后：收尾的那一步看到的是已经关好的连接，不会再回到这里。
		this.closeListener?.();
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
			if (!this.frameSink.send(frame)) return;
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
		this.frameSink.close(CLOSE_TRY_AGAIN_LATER, REASON_STOPPED_READING);
		this.close();
	}

	private clearStallTimer(): void {
		if (this.stallTimer === null) return;
		clearTimeout(this.stallTimer);
		this.stallTimer = null;
	}
}

/** 一帧的 JSON 大小，字节预算就是以它计价的。 */
function sizeOf(frame: ServerFrame): number {
	return Buffer.byteLength(JSON.stringify(frame));
}
