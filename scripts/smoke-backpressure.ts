// Backpressure smoke test: drives the mux write side through an injected fake socket and asserts the
// stall policy where it lives — the moment `write()` says no, nothing jumps the queue; the queue never
// crosses the budget it was given; a stalled connection is closed by the deadline, not held forever;
// and a peer that starts reading again gets its backlog in order, with no holes.
//
// This is the seam the whole test stands on: the connection layer takes a `FrameSink`, not a socket
// (ticket 04's write side), so the "peer that never reads" case is a stub whose `send` returns `false`
// — no real network, no RFC6455 client, and nothing to assert about a pong (invisible by design; see
// ticket 15, decision 10). The end-to-end evidence for a truly stalled peer lives in
// `.scratch/client-server-refactor/prototype/backpressure-stalled-peer.mjs`.
//
// One behaviour of the policy has to be understood before the assertions make sense: there is no
// `drain` listener, so *the next write attempt is the drain*. Every `send` pumps the queue head first,
// and the pump stops at the first refusal — which is why a stalled connection's head frame is retried
// once per send attempt while everything behind it stays queued. The stub records both what it was
// handed and what it accepted, and the assertions below pin the difference.
//
// Nothing here touches a session or a model, so no provider key is needed.
// Run with: node scripts/smoke-backpressure.ts
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
 * A sink the test scripts, one behaviour at a time.
 *
 * `mode` is read per call, so a test flips it mid-run: `"accept"` is a healthy peer, `"stall"` the
 * peer that stopped reading. Two recordings, because the policy gives a refused frame a different
 * fate from an accepted one: `handed` lists every frame the socket was asked to write (a refusal
 * still hands the frame over — it sits in the socket's own buffer), `accepted` only the ones the
 * peer actually took. The queue's contents are what the layer keeps for later.
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

/** The answers table is per-process state no backpressure path reads; a stub is honest here. */
const answers: ApprovalAnswers = {
	remember(): void {},
	wasApproved: () => false,
	show(): void {},
	hide(): void {},
};

/** A stream frame with a payload sized by the caller, so the byte budget can be aimed precisely. */
function payloadFrame(text: string): ServerFrame {
	return {
		streamId: "s",
		item: { type: "status", usage: ZERO_USAGE, submitting: false, queued: [], isRetrying: false, retryAttempt: 0, pad: text },
	} as unknown as ServerFrame;
}

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, contextWindow: 0 };

/** The byte size the policy charges a frame: its JSON length. */
function sizeOf(frame: ServerFrame): number {
	return Buffer.byteLength(JSON.stringify(frame));
}

/** What a frame was named by the test, for printing a sequence on failure. */
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
	// 1. One `false`, and the direct path closes.
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
		// The pump ran once per send: the first found the queue empty, the second retried `second` and
		// stopped at the refusal. Nothing behind the head was touched — that is the whole policy.
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
	// 2. The queue never crosses the budget it was given.
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
		// Two frames of ~150 bytes each cross the 300-byte budget on the second one. The policy answers
		// at once rather than waiting out the deadline: the budget is the thing a broken peer must not
		// be able to spend.
		connection.send(payloadFrame("y".repeat(100)));
		check("crossing the budget closes the connection at once", sink.closes.length === 1, JSON.stringify(sink.closes));
		check("the whole connection is done, not half of it", connection.isClosed);
		check("a log line went out with it", lines.length >= 1, JSON.stringify(lines));
	}

	// -------------------------------------------------------------------
	// 3. A stalled connection is closed by the deadline, and the deadline is real.
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
	// 4. A peer that starts reading again gets its backlog in order, no holes.
	// -------------------------------------------------------------------
	{
		const sink = scriptedSink();
		// The first frame lands in the socket's own buffer (that is what `false` means), everything
		// after it queues, and the next write attempt drains what queued before writing its own frame.
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
	// 5. A drain that stalls again mid-pump keeps what is left, in order.
	// -------------------------------------------------------------------
	{
		const sink = scriptedSink();
		sink.mode = "stall";
		const connection = new MuxConnection(sink, hub, options({ stallDeadlineMs: 60_000 }), answers);

		const [first, second, third, fourth, fifth] = ["a", "b", "c", "d", "e"].map(payloadFrame);
		connection.send(first!); // into the socket's buffer; the stall begins here
		connection.send(second!);
		connection.send(third!);
		connection.send(fourth!);

		// Accept exactly one frame, then refuse again: the pump writes `b` and stops on `c`, and the
		// frame that triggered the drain rejoins the queue behind what the refusal saved.
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

	// The smoke never reads RSS: the queue's own byte counter is the number the policy bounds, and an
	// RSS assertion in a Node process measures the garbage collector as much as the policy.
} finally {
	await rm(root, { recursive: true, force: true });
	process.stdout.write(failures === 0 ? "\nbackpressure ok\n" : `\n${failures} failure(s)\n`);
	process.exitCode = failures === 0 ? 0 : 1;
}
