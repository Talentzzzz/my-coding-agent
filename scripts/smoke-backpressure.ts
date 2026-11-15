// Backpressure smoke test：经由一个注入的假 socket 驱动 mux 写侧，在停滞策略所在之处断言它
// ——`write()` 说不的那一刻起，没有任何东西越过队列；队列绝不越过交给它的预算；一个停滞的
// 连接在截止时间前被关闭，而不是被永远握着；重新开始读取的 peer 按序拿到自己的积压，无洞。
//
// 这是整个测试所站的接缝：连接层收的是 `FrameSink`，不是 socket（ticket 04 的写侧），所以
// "永不读取的 peer"这个情形就是一个 `send` 返回 `false` 的桩——没有真网络、没有 RFC6455
// 客户端、也没有任何关于 pong 的断言（pong 按设计不可见；见 ticket 15 决定 10）。对真正停滞的
// peer 的端到端证据住在
// `.scratch/client-server-refactor/prototype/backpressure-stalled-peer.mjs`。
//
// 有一项策略行为必须先理解，断言才有意义：没有 `drain` 监听器，所以*下一次写尝试就是 drain*。
// 每次 `send` 都先把队列头泵出去，泵在第一次拒绝处停下——这就是为什么一条停滞连接的头帧在
// 每次 send 尝试时重试一次，而它身后的一切留在队列里。桩同时记录它被递交了什么、收下了什么，
// 下面的断言钉住两者的差别。
//
// 这里不触碰任何 session 或模型，无需 provider key。
// 运行：node scripts/smoke-backpressure.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../packages/server/src/hub.ts";
import { MuxConnection, type ApprovalAnswers, type FrameSink, type ResolvedMuxOptions } from "../packages/server/src/mux.ts";
import { until } from "./wire/client.ts";
import type { ServerFrame } from "@my-agent/core";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 由测试逐个行为编排的 sink。
 *
 * `mode` 每次调用都会读，所以测试可以在运行中翻转它：`"accept"` 是健康的 peer，`"stall"` 是
 * 停止读取的 peer。两份记录，因为策略给被拒的帧与被收下的帧不同的命运：`handed` 列出每个被
 * 要求写进 socket 的帧（被拒的帧照样递交——它坐在 socket 自己的缓冲里），`accepted` 只有 peer
 * 真正收下的。队列里的内容才是层替以后保留的东西。
 */
function scriptedSink(): FrameSink & {
	handed: ServerFrame[];
	accepted: ServerFrame[];
	closes: { code: number; reason: string }[];
	terminates: number;
	mode: "accept" | "stall";
} {
	const sink = {
		handed: [] as ServerFrame[],
		accepted: [] as ServerFrame[],
		closes: [] as { code: number; reason: string }[],
		terminates: 0,
		mode: "accept" as "accept" | "stall",
		send(frame: ServerFrame): boolean {
			sink.handed.push(frame);
			if (sink.mode === "stall") return false;
			sink.accepted.push(frame);
			return true;
		},
		ping(): void {},
		close(code: number, reason: string): void {
			sink.closes.push({ code, reason });
		},
		terminate(): void {
			sink.terminates += 1;
		},
		get isClosed(): boolean {
			return sink.closes.length > 0 || sink.terminates > 0;
		},
	};
	return sink;
}

/** 应答表是没有任何 backpressure 路径会读的进程级状态；stub 在这里是诚实的。 */
const answers: ApprovalAnswers = {
	remember(): void {},
	wasApproved: () => false,
	show(): void {},
	hide(): void {},
};

/** 带着调用方指定尺寸载荷的流帧，字节预算因此可以精确瞄准。 */
function payloadFrame(text: string): ServerFrame {
	return {
		streamId: "s",
		item: { type: "status", usage: ZERO_USAGE, running: false, queued: [], isRetrying: false, retryAttempt: 0, pad: text },
	} as unknown as ServerFrame;
}

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, contextWindow: 0 };

/** 策略向一帧收取的字节尺寸：它的 JSON 长度。 */
function sizeOf(frame: ServerFrame): number {
	return Buffer.byteLength(JSON.stringify(frame));
}

/** 一帧被测试起的名字，失败时用来打印序列。 */
function nameOf(frame: ServerFrame): string {
	return (frame as { item?: { pad?: string } }).item?.pad ?? "?";
}

function options(overrides: Partial<ResolvedMuxOptions>): ResolvedMuxOptions {
	return {
		pingIntervalMs: 60_000,
		maxMissedPongs: 2,
		heartbeatIntervalMs: 60_000,
		stallBudgetBytes: 4 * 1024 * 1024,
		stallDeadlineMs: 10_000,
		log: () => {},
		...overrides,
	};
}

const root = await mkdtemp(join(tmpdir(), "my-agent-backpressure-"));
const hub = new SessionHub({ workDirAbsPath: root });

try {
	process.stdout.write("the moment write() says no, nothing jumps the queue\n");

	// -------------------------------------------------------------------
	// 1. 一次 `false`，直接路径就关上了。
	// -------------------------------------------------------------------
	{
		const sink = scriptedSink();
		sink.mode = "stall";
		const connection = new MuxConnection(sink, hub, options({ stallDeadlineMs: 60_000 }), answers);

		const first = payloadFrame("first");
		const second = payloadFrame("second");
		const third = payloadFrame("third");
		connection.send(first);
		check("the refused frame was still handed over — it sits in the socket's buffer", JSON.stringify(sink.handed.map(nameOf)) === JSON.stringify(["first"]), JSON.stringify(sink.handed.map(nameOf)));
		check("and it counts as stalled from that moment", connection.queuedByteLength === 0);

		connection.send(second);
		connection.send(third);
		// 泵每次 send 跑一次：第一次发现队列为空，第二次重试 `second` 并停在拒绝处。头之后的
		// 什么都没被碰——这正是整个策略。
		check(
			"the socket saw the refusal and one retry of the head, nothing more",
			JSON.stringify(sink.handed.map(nameOf)) === JSON.stringify(["first", "second"]),
			JSON.stringify(sink.handed.map(nameOf)),
		);
		const expected = sizeOf(second) + sizeOf(third);
		check(
			"and both frames are in the queue, in bytes the policy itself counts",
			connection.queuedByteLength === expected,
			`queued=${connection.queuedByteLength} expected=${expected}`,
		);
		check("nothing was accepted while stalled", sink.accepted.length === 0);
		check("nothing was closed yet", sink.closes.length === 0 && sink.terminates === 0);
		connection.close();
	}

	// -------------------------------------------------------------------
	// 2. 队列绝不越过交给它的预算。
	// -------------------------------------------------------------------
	{
		const sink = scriptedSink();
		sink.mode = "stall";
		const lines: string[] = [];
		const connection = new MuxConnection(
			sink,
			hub,
			options({ stallBudgetBytes: 300, stallDeadlineMs: 60_000, log: (line) => lines.push(line) }),
			answers,
		);

		connection.send(payloadFrame("x".repeat(100)));
		// 两帧各约 150 字节，第二帧就越过了 300 字节预算。策略当场作答而不是等截止时间：预算
		// 正是一个坏 peer 不许花掉的东西。
		connection.send(payloadFrame("y".repeat(100)));
		check("crossing the budget closes the connection at once", sink.closes.length === 1, JSON.stringify(sink.closes));
		check("the whole connection is done, not half of it", connection.isClosed);
		check("a log line went out with it", lines.length >= 1, JSON.stringify(lines));
	}

	// -------------------------------------------------------------------
	// 3. 停滞的连接在截止时间前被关闭，且截止时间是真的。
	// -------------------------------------------------------------------
	{
		const sink = scriptedSink();
		sink.mode = "stall";
		const lines: string[] = [];
		const deadlineMs = 200;
		const connection = new MuxConnection(
			sink,
			hub,
			options({ stallDeadlineMs: deadlineMs, log: (line) => lines.push(line) }),
			answers,
		);

		const started = Date.now();
		connection.send(payloadFrame("stalled"));
		let closedAt = -1;
		const closed = await until(() => {
			if (sink.closes.length > 0) {
				closedAt = Date.now() - started;
				return true;
			}
			return false;
		}, deadlineMs + 2_000);
		check("the stalled connection was closed", closed, JSON.stringify(sink.closes));
		check(
			"not before the deadline it was given",
			closedAt < 0 || closedAt >= deadlineMs - 30,
			`closed after ${closedAt} ms of ${deadlineMs} ms`,
		);
		check(
			"and within a tolerance of it, so a stalled peer does not hang around",
			closedAt < 0 || closedAt < deadlineMs + 1_500,
			`closed after ${closedAt} ms`,
		);
		check("the log line names the stall", lines.some((line) => line.includes("停滞")), JSON.stringify(lines));
	}

	// -------------------------------------------------------------------
	// 4. 重新开始读取的 peer 按序拿到积压，无洞。
	// -------------------------------------------------------------------
	{
		const sink = scriptedSink();
		// 第一帧落进 socket 自己的缓冲（`false` 的含义就是这个），它身后的一切入队，下一次写
		// 尝试在写自己的帧之前先排干队列里已有的东西。
		sink.mode = "stall";
		const connection = new MuxConnection(sink, hub, options({ stallDeadlineMs: 60_000 }), answers);

		const first = payloadFrame("first");
		const second = payloadFrame("second");
		const third = payloadFrame("third");
		const fourth = payloadFrame("fourth");
		connection.send(first);
		connection.send(second);
		connection.send(third);

		sink.mode = "accept";
		connection.send(fourth);
		check(
			"the peer took the backlog in order, then the new frame — no holes",
			JSON.stringify(sink.accepted.map(nameOf)) === JSON.stringify(["second", "third", "fourth"]),
			JSON.stringify(sink.accepted.map(nameOf)),
		);
		check("and the queue is empty afterwards", connection.queuedByteLength === 0, `queued=${connection.queuedByteLength}`);
		check("no close followed a recovery", sink.closes.length === 0 && sink.terminates === 0);
		connection.close();
	}

	// -------------------------------------------------------------------
	// 5. 泵到一半再度停滞的 drain 保住剩余的，按序。
	// -------------------------------------------------------------------
	{
		const sink = scriptedSink();
		sink.mode = "stall";
		const connection = new MuxConnection(sink, hub, options({ stallDeadlineMs: 60_000 }), answers);

		const [first, second, third, fourth, fifth] = ["a", "b", "c", "d", "e"].map(payloadFrame);
		connection.send(first!); // 落进 socket 缓冲；停滞从这里开始
		connection.send(second!);
		connection.send(third!);
		connection.send(fourth!);

		// 恰好收下一帧，然后再次拒绝：泵写下 `b` 并停在 `c` 上，触发 drain 的那一帧重新回到拒绝
		// 所保住的那些之后的队尾。
		let acceptedCount = 0;
		sink.mode = "accept";
		sink.send = (frame: ServerFrame): boolean => {
			sink.handed.push(frame);
			acceptedCount += 1;
			if (acceptedCount > 1) {
				sink.mode = "stall";
				return false;
			}
			sink.accepted.push(frame);
			return true;
		};
		connection.send(fifth!);

		check(
			"the pump wrote one frame and stopped at the second refusal",
			JSON.stringify(sink.accepted.map(nameOf)) === JSON.stringify(["b"]),
			JSON.stringify(sink.accepted.map(nameOf)),
		);
		check(
			"and the queue holds exactly what the refusal left behind, in order",
			connection.queuedByteLength === sizeOf(third!) + sizeOf(fourth!) + sizeOf(fifth!),
			`queued=${connection.queuedByteLength}`,
		);
		check("the connection is still open, waiting rather than giving up", sink.closes.length === 0 && sink.terminates === 0);
		connection.close();
	}

	// smoke 从不读 RSS：队列自己的字节计数器才是策略所约束的数字，而 Node 进程里的 RSS 断言
	// 测量的垃圾收集器与策略一样多。
} finally {
	await rm(root, { recursive: true, force: true });
	process.stdout.write(failures === 0 ? "\nbackpressure ok\n" : `\n${failures} failure(s)\n`);
	process.exitCode = failures === 0 ? 0 : 1;
}
