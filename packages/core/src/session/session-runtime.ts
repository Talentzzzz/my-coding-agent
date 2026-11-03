import type { QueueMode } from "../types.ts";
import { PendingMessageQueue } from "./queues.ts";

/**
 * One run in flight: the handle a caller uses to stop it, and the run-local handles it leaves behind.
 *
 * The abort controller is where an abort from any layer lands — the session's, the hub's, a process
 * shutdown's. The promise/resolve pair is the run's context handle for everyone else: "wait for this
 * run to settle" resolves on the promise, and the engine that finishes the run is the one that fires
 * the resolve, so the pair travels with the run rather than living anywhere longer.
 */
export interface ActiveRun {
	abortController: AbortController;
	/** Resolved when the run and every awaited listener for it have settled. */
	promise: Promise<void>;
	/** Internal: completes {@link ActiveRun.promise}. The engine holds it for its own finish. */
	resolve: () => void;
}

/**
 * A session's live half, and the only cross-stack in-memory state a session has (ADR-0006 §4).
 *
 * Everything here answers one question: *what is in progress and nowhere on disk*. The two queues
 * hold messages accepted mid-run that the run has not drained yet — a drained message is persisted
 * at its drain point, so an unconsumed one exists only here — and `activeRun` is the run in flight.
 * A process restart drops all of it on purpose: queued messages are lost, the session file is not.
 *
 * Nothing else belongs in this bag. The ledger, the settings, the models, and the tools are replayed
 * from disk and configuration on every request (route B), so a session's durable facts never gain a
 * second, memory-resident copy to keep in step.
 */
export interface SessionRuntime {
	/** Messages steered into the running turn, drained at each turn's end. */
	steeringQueue: PendingMessageQueue;
	/** Messages waiting for the run to end, drained where the run would otherwise stop. */
	followUpQueue: PendingMessageQueue;
	/** The run in flight, or nothing when the session is idle. */
	activeRun?: ActiveRun;
}

/**
 * Build a session's live half, empty.
 *
 * The queue modes are the settings' answer at creation time; a config patch that moves
 * either mode later writes it onto the queue in place, so nothing here is captured for good.
 */
export function createSessionRuntime(steeringMode: QueueMode, followUpMode: QueueMode): SessionRuntime {
	return {
		steeringQueue: new PendingMessageQueue(steeringMode),
		followUpQueue: new PendingMessageQueue(followUpMode),
	};
}
