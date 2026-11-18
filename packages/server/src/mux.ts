import {
	CLOSE_GOING_AWAY,
	REASON_SHUTTING_DOWN,
	Wire,
	resolveWireOptions,
	type FrameSink,
	type ResolvedWireOptions,
	type WireOptions,
} from "./wire.ts";
import type { SessionStream } from "./stream.ts";

/**
 * 从一只写帧的手造出一条连接的业务侧。
 *
 * mux 拿的是这个函数而不是 hub / projection / 审批里的任何一个类型：会话语义由工厂背后那一层
 * 拥有，mux 不需要 import 它，也就不可能再长出第二次。
 */
export type SessionStreamFactory = (wire: Wire) => SessionStream;

/** mux 的选项就是 wire 的选项，逐字透传：定时器与预算的含义归 wire。 */
export type MuxOptions = WireOptions;

/**
 * 一个客户端连接：一只替它写帧的 {@link Wire}，以及一条替它翻译会话的 {@link SessionStream}。
 *
 * 连接的生命周期是连接本身，不是任何一次运行。它活得比它上面的每个订阅、它们观看的每个会话的每一轮都久，只在 peer 离开或本服务器判定它已离开时结束。
 */
export class MuxConnection {
	readonly wire: Wire;
	readonly stream: SessionStream;

	constructor(wire: Wire, stream: SessionStream) {
		this.wire = wire;
		this.stream = stream;
	}

	/** 这条连接还收不收写。`muxUpgrade` 在交回所有权之前问它一次。 */
	get isClosed(): boolean {
		return this.wire.isClosed;
	}
}

/**
 * 所有连接，以及评判它们的两个定时器。
 *
 * 整个进程各一个定时器，而不是每条连接一个：一百个空闲窗口不应该是一百个 interval，而按连接计的定时器会让"这个服务器多久 ping 一次"变成一个有一百个答案的问题。连接集合只用于存活探测与关停——它不再参与任何分发。
 */
export class MuxServer {
	private readonly connections = new Set<MuxConnection>();
	private readonly pingTimer: NodeJS.Timeout;
	private readonly heartbeatTimer: NodeJS.Timeout;
	private shuttingDown = false;

	private readonly factory: SessionStreamFactory;
	private readonly options: ResolvedWireOptions;

	constructor(factory: SessionStreamFactory, options: ResolvedWireOptions) {
		this.factory = factory;
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
	 * overview baseline 在任何订阅能被 open 之前发出：它是让侧栏正确、却一次 `GET` 都不需要的那一帧，而一条还得被问"有什么"的连接，正是这个 transport 要替代的东西。所以 `stream.start()` 必须 await：在 `accept` 返回之前到达的上行帧，是由 `muxUpgrade` 的 waiting 缓冲区扣住、在 overview 之后才 replay 的。
	 *
	 * 返回连接，让拥有 socket 的调用者能把上行帧交给它。
	 */
	async accept(sink: FrameSink): Promise<MuxConnection> {
		if (this.shuttingDown) {
			sink.close(CLOSE_GOING_AWAY, REASON_SHUTTING_DOWN);
			throw new Error("The server is shutting down");
		}

		const wire = new Wire(sink, this.options);
		const connection = new MuxConnection(wire, this.factory(wire));
		this.connections.add(connection);

		// wire 自己关掉一条连接（停滞期限、ping 容忍度耗尽）时，订阅必须当场摘掉：不等下一次
		// `pingAll` / `heartbeatAll` 撞见 `isClosed`，否则那条流还在为一个不再有读者的连接翻译帧。
		// 自关与外部 `close()` 因此走同一条收尾路径；`forget` 幂等。
		wire.onClose(() => this.forget(connection));

		await connection.stream.start();

		sink.ping();
		return connection;
	}

	/** 一个上行帧，交给本服务器拥有的连接。 */
	handle(connection: MuxConnection, text: string): void {
		if (!this.connections.has(connection)) return;
		connection.stream.handle(text);
	}

	/** 一条连接上有 Pong 到达：peer 活着。 */
	notePong(connection: MuxConnection): void {
		// 与 `handle` 一样设防，理由相同：Pong 可能在连接已被忘记之后到达，给一个无人持有的连接复活计数器，会让它在任何还持有引用的东西眼里看起来仍然活着。
		if (!this.connections.has(connection)) return;
		connection.wire.notePong();
	}

	/** 忘记一条已结束的连接：先出集合，再让它放下所有订阅。 */
	forget(connection: MuxConnection): void {
		if (!this.connections.delete(connection)) return;
		connection.stream.dispose();
	}

	/** 有多少连接开着。测试读它；生产中没有任何东西用。 */
	get size(): number {
		return this.connections.size;
	}

	/** 协议层存活问题的一轮。 */
	private pingAll(): void {
		for (const connection of [...this.connections]) connection.wire.tick();
	}

	/**
	 * 应用层心跳的一轮。
	 *
	 * 它兼任写入尝试的下限，这正是它走普通发送路径而不是绕过队列的原因：当没有别的东西在写时，它是唯一仍会被做出的尝试，一条恢复的连接靠它把 backlog 冲出去。
	 */
	private heartbeatAll(): void {
		for (const connection of [...this.connections]) connection.wire.heartbeat();
	}

	/** 结束每条连接，让关闭进程不被一个从不离开的窗口吊着。 */
	close(): void {
		this.shuttingDown = true;
		clearInterval(this.pingTimer);
		clearInterval(this.heartbeatTimer);
		for (const connection of [...this.connections]) connection.stream.dispose();
		this.connections.clear();
	}
}

/** 构建一个带默认值的服务器，或带上测试驱动它们加速所需的任何选项。 */
export function createMuxServer(factory: SessionStreamFactory, options: MuxOptions = {}): MuxServer {
	return new MuxServer(factory, resolveWireOptions(options));
}
