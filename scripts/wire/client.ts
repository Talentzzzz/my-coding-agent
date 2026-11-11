// 冒烟用的 wire 客户端：一条连到 `/mux` 的真 WebSocket，加上一张按 `streamId` 分道的帧表。
//
// 它与浏览器那份解析器（`packages/web/src/client.ts`）故意相反：浏览器只校验信封、其余容错，
// 因为它要活；这里的读者是断言工具——服务端发了一个坏帧时，把它读成"这帧我认识但不处理"
// 恰好会把冒烟要找的 bug 吞掉，所以遇到畸形信封宁可当场炸。这也是它不 import 浏览器那份
// 解析器的理由：容错器不是冒烟要的那份东西。
//
// 不引入 `ws` 依赖：Node ≥22.19 自带全局 `WebSocket`（undici）。22 与 24 在失败语义上分叉
// （22.19 握手失败只 fire `error`、`close` 永不到来），所以 `connect()` 的失败判据同时挂在
// `error`、`close` 与一个自己的超时上，不赌任何一个事件一定到来。
//
// 两条形状规矩（旧图票 15 §1(a)）：
// 1. `send()` 收任意对象——上行容错本身是被测对象，故意发畸形帧也要能发；
// 2. `streamId: null` 的帧只进 `connection()`，永不进 `items()` / `waitFor()` / `open()` 的
//    "第一帧"判据——常驻通道上一帧心跳就能让"第一帧是基线"随机失败。
import type {
	ServerFrame,
	ServerMessage,
	SessionSnapshot,
} from "@my-agent/core/protocol";

/** 连接级载荷（`streamId: null`）的信封，去掉外层的座位字段。 */
export type ConnectionEnvelope = { item?: { type: string; [key: string]: unknown }; error?: { message: string } };

export interface WireClient {
	/**
	 * 发一个上行帧。
	 *
	 * 故意发畸形帧也要能发：上行容错规则本身是被测对象（票 05 决定 2），所以参数不是
	 * `ClientFrame` 而是任意对象。
	 */
	send(frame: object): void;
	/** 发一段原始文本上行——"不是 JSON 的上行"这条容错只有走这里才测得到。 */
	sendRaw(text: string): void;
	/** 订阅一个会话，并断言这条逻辑流的第一帧是基线；返回那份快照。 */
	open(sessionId: string): Promise<SessionSnapshot>;
	/** 取消订阅一个会话。 */
	cancel(sessionId: string): void;
	/** 这条逻辑流上收到的 item（按到达顺序）。连接级帧一帧都不在这里。 */
	items(sessionId: string): readonly ServerMessage[];
	/** 连接级载荷（heartbeat / sessions / session_row），一栏都不属于它们。 */
	connection(): readonly ConnectionEnvelope[];
	/** 等到这条流上第一个满足 `match` 的帧；超时回 undefined——"什么没到"要用它断言。 */
	waitFor(sessionId: string, match: (message: ServerMessage) => boolean, ms?: number): Promise<ServerMessage | undefined>;
	/** 等到连接级上第一个满足 `match` 的信封；超时回 undefined。 */
	waitForConnection(match: (envelope: ConnectionEnvelope) => boolean, ms?: number): Promise<ConnectionEnvelope | undefined>;
	/** 这条流的终帧与错帧：`{ ended, errors, ends }`。`ended` 是"曾经终过"，`ends` 是次数——
	 * 一条流可以被取消再重开，跨订阅的断言要用次数比，不能用布尔。 */
	endOf(sessionId: string): { ended: boolean; errors: readonly string[]; ends: number };
	/** 原始信封，供断言信封本身（含 `streamId` 与帧的种类）。 */
	readonly frames: readonly ServerFrame[];
	/** 连接被关闭时的 code / reason。取值本身不断言（票 15 决定 10）。 */
	closed(): Promise<{ code: number; reason: string }>;
	/** 这条连接是否已经关上。 */
	readonly isClosed: boolean;
	close(): Promise<void>;
}

/** 握手判据自己的兜底：22.19 上握手失败可能只有 `error`、连 `close` 都不来。 */
const HANDSHAKE_TIMEOUT_MS = 5_000;

/** 轮询的步长。断言要的是"到了没有"，不是精确时刻，所以这个数字只影响延迟不影响正确性。 */
const POLL_MS = 10;

/** 一个信封的形状错误：读侧响亮失败的全部依据。 */
function assertEnvelope(frame: unknown): ServerFrame {
	if (typeof frame !== "object" || frame === null) {
		throw new Error(`wire: 信封不是对象：${JSON.stringify(frame)}`);
	}
	const record = frame as { streamId?: unknown; item?: unknown; end?: unknown; error?: unknown };
	if (typeof record.streamId !== "string" && record.streamId !== null) {
		throw new Error(`wire: 信封的 streamId 既不是字符串也不是 null：${JSON.stringify(frame)}`);
	}
	const keys = ["item", "end", "error"].filter((key) => key in record);
	if (keys.length !== 1) {
		throw new Error(`wire: 信封必须恰有 item / end / error 之一，实际是 ${keys.join(",") || "没有"}：${JSON.stringify(frame)}`);
	}
	return frame as ServerFrame;
}

/** 连上 `/mux`，握手判据同时挂在 `open`、`error`、`close` 与自己的超时上。 */
export function connect(url: string): Promise<WireClient> {
	return new Promise<WireClient>((resolve, reject) => {
		const socket = new WebSocket(url);
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`wire: 握手在 ${HANDSHAKE_TIMEOUT_MS} ms 内没有完成（22.19 的握手失败可能只报 error 不报 close）`));
		}, HANDSHAKE_TIMEOUT_MS);

		const fail = (why: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`wire: ${why}`));
		};

		socket.addEventListener("error", () => fail("连接出错"));
		socket.addEventListener("close", (event) => fail(`连接在握手前关上（code=${event.code}）`));
		socket.addEventListener("open", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(wireOver(socket));
		});
	});
}

/** 把一个已握手的 socket 包成 WireClient。 */
function wireOver(socket: WebSocket): WireClient {
	/** 全部原始信封，按到达顺序。 */
	const frames: ServerFrame[] = [];
	/** 按流分道的 item。连接级帧（`streamId: null`）一帧都不进这里。 */
	const streams = new Map<string, ServerMessage[]>();
	/** 收到过终帧与错帧的流。终帧计次数：一条流可以终了再重开。 */
	const ended = new Map<string, number>();
	const streamErrors = new Map<string, string[]>();
	/** 连接级载荷（heartbeat / sessions / session_row），按到达顺序。 */
	const connectionItems: ConnectionEnvelope[] = [];
	/** 关闭的 code 与 reason；null 表示还没关。 */
	let closeInfo: { code: number; reason: string } | null = null;
	const closeWaiters: Array<(info: { code: number; reason: string }) => void> = [];

	socket.addEventListener("message", (event) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(String(event.data));
		} catch {
			throw new Error(`wire: 收到一段不是 JSON 的下行：${String(event.data).slice(0, 200)}`);
		}
		const frame = assertEnvelope(parsed);
		frames.push(frame);

		if (frame.streamId === null) {
			// 连接级座位：heartbeat / sessions / session_row，外加"先定义不实现"的信封级 error。
			connectionItems.push(frame as ConnectionEnvelope);
			return;
		}
		if ("end" in frame) {
			ended.set(frame.streamId, (ended.get(frame.streamId) ?? 0) + 1);
			return;
		}
		if ("error" in frame) {
			const list = streamErrors.get(frame.streamId) ?? [];
			list.push(frame.error.message);
			streamErrors.set(frame.streamId, list);
			return;
		}
		const list = streams.get(frame.streamId) ?? [];
		list.push(frame.item);
		streams.set(frame.streamId, list);
	});

	socket.addEventListener("close", (event) => {
		closeInfo = { code: event.code, reason: event.reason ?? "" };
		for (const waiter of closeWaiters.splice(0)) waiter(closeInfo);
	});

	const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

	async function waitFor(
		sessionId: string,
		match: (message: ServerMessage) => boolean,
		ms = 5_000,
	): Promise<ServerMessage | undefined> {
		const deadline = Date.now() + ms;
		for (;;) {
			const found = (streams.get(sessionId) ?? []).find(match);
			if (found !== undefined) return found;
			if (Date.now() > deadline) return undefined;
			await sleep(POLL_MS);
		}
	}

	return {
		send(frame: object): void {
			socket.send(JSON.stringify(frame));
		},
		sendRaw(text: string): void {
			socket.send(text);
		},
		async open(sessionId: string): Promise<SessionSnapshot> {
			// "第一帧是基线"判据从这次 open 之后开始数：一条流可以被取消再重开，此前收到的帧
			// 还在表里，拿它们当这次 open 的回话会把旧基线当成新回答。
			const seen = (streams.get(sessionId) ?? []).length;
			const errorsBefore = (streamErrors.get(sessionId) ?? []).length;
			const endsBefore = ended.get(sessionId) ?? 0;
			this.send({ type: "open", sessionId });
			const deadline = Date.now() + 5_000;
			for (;;) {
				const fresh = (streams.get(sessionId) ?? []).slice(seen);
				if (fresh.length > 0) {
					const first = fresh[0]!;
					if (first.type !== "baseline") {
						throw new Error(`wire: open ${sessionId} 的第一帧是 ${first.type}，不是 baseline`);
					}
					return (first as { session: SessionSnapshot }).session;
				}
				const errors = streamErrors.get(sessionId) ?? [];
				if (errors.length > errorsBefore) {
					throw new Error(`wire: open ${sessionId} 被拒绝：${errors[errorsBefore]}`);
				}
				if ((ended.get(sessionId) ?? 0) > endsBefore) {
					throw new Error(`wire: open ${sessionId} 以 end 收场，没有基线`);
				}
				if (Date.now() > deadline) {
					throw new Error(`wire: open ${sessionId} 之后没有等到基线`);
				}
				await sleep(POLL_MS);
			}
		},
		cancel(sessionId: string): void {
			this.send({ type: "cancel", sessionId });
		},
		items(sessionId: string): readonly ServerMessage[] {
			return streams.get(sessionId) ?? [];
		},
		connection(): readonly ConnectionEnvelope[] {
			return connectionItems;
		},
		waitFor,
		async waitForConnection(match, ms = 5_000): Promise<ConnectionEnvelope | undefined> {
			const deadline = Date.now() + ms;
			for (;;) {
				const found = connectionItems.find(match);
				if (found !== undefined) return found;
				if (Date.now() > deadline) return undefined;
				await sleep(POLL_MS);
			}
		},
		endOf(sessionId: string): { ended: boolean; errors: readonly string[]; ends: number } {
			return { ended: (ended.get(sessionId) ?? 0) > 0, errors: streamErrors.get(sessionId) ?? [], ends: ended.get(sessionId) ?? 0 };
		},
		frames,
		closed(): Promise<{ code: number; reason: string }> {
			if (closeInfo !== null) return Promise.resolve(closeInfo);
			return new Promise((resolve) => closeWaiters.push(resolve));
		},
		get isClosed(): boolean {
			return closeInfo !== null || socket.readyState === socket.CLOSED;
		},
		close(): Promise<void> {
			if (socket.readyState === socket.OPEN) socket.close();
			return this.closed().then(() => undefined);
		},
	};
}

/** 冒烟里最常用的一段轮询：等到谓词成立或超时。装置自己不用，留给各 rig。 */
export function until(ready: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	const sleep = (step: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, step));
	return (async () => {
		while (Date.now() < deadline) {
			// 必须真正 await，而不只是判真值：async 谓词返回的 Promise 在第一次轮询时就会被当成
			// "ready"，整个等待就退化为一次空转。
			if (await ready()) return true;
			await sleep(POLL_MS);
		}
		return ready();
	})();
}
