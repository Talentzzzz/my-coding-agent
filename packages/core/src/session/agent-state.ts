import type { Message, Model } from "../llm/index.ts";
import type { ModelChoice } from "../models.ts";
import type { QueueMode } from "../protocol.ts";
import type { SessionListener, SessionEventListener } from "../agent.ts";
import type { Session } from "./session-manager.ts";
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
 * One session this process knows about, as a single bag: its subscribers and its live half.
 *
 * The durable half is deliberately **not** here (ADR-0019). A session's transcript is a file, and
 * every operation that needs it opens it and drops it: a run opens one at its start and carries it
 * for its length, a command opens one for the length of the call. What is left is exactly what no
 * file can answer — who is watching, what is queued, what is running, what has not been written
 * yet. A process restart drops the whole state on purpose: the transcript replays from the files,
 * and the live half is the part that was nowhere on disk.
 */
export interface AgentState {
	/** Which session this state belongs to; the key it is filed under, carried so a call need not repeat it. */
	readonly sessionId: string;
	/** Subscribers to the session's state, attached through the session's `onChange`. */
	readonly listeners: Set<SessionListener>;
	/** Subscribers to the session's events, attached through the session's `onEvent`. */
	readonly eventListeners: Set<SessionEventListener>;
	/** The session's live half: what is in progress and nowhere on disk. */
	readonly live: Live;
}

/**
 * What is in progress and nowhere on disk, for one session.
 *
 * The two queues hold messages accepted mid-run that the run has not drained yet — a drained
 * message is persisted at its drain point, so an unconsumed one exists only here. `activeRun` is
 * the run in flight; `partial` is the assistant message it is writing right now, which a window
 * attaching mid-run needs the characters of; `model` is the row the run streams from, so a
 * snapshot mid-run answers from the run rather than from a fresh lookup — Live while a run is in
 * flight, the bag when idle.
 * `retrying` / `retryAttempt` are the retry policy's public face; `suspended` marks a run parked at
 * the approval gate.
 *
 * `unwritten` is the one transcript that is here rather than on disk, and it is here because there
 * is nothing to read: a session earns its files with its first message (ADR-0009), so between
 * `create` and that message the bag *is* the session's only copy. It is not a cache — no replay can
 * produce it — and it leaves the moment the files exist, after which every read is a replay again.
 *
 * A process restart drops all of it on purpose: queued messages are lost, subscribers re-attach,
 * and the session file is not — which is what makes the drop survivable.
 */
export interface Live {
	/** Messages steered into the running turn, drained at each turn's end. */
	steeringQueue: PendingMessageQueue;
	/** Messages waiting for the run to end, drained where the run would otherwise stop. */
	followUpQueue: PendingMessageQueue;
	/** The run in flight, or nothing when the session is idle. */
	activeRun?: ActiveRun;
	/** The assistant message the run is writing right now, or nothing when idle. */
	partial: Message | undefined;
	/** The model the run in flight streams from, or nothing when idle. */
	model?: Model;
	/** True while the retry policy is backing off between attempts of the run in flight. */
	retrying: boolean;
	/** Which attempt the run in flight is on, once the first retry has happened. */
	retryAttempt: number;
	/** True while the run in flight is parked at the approval gate. */
	suspended: boolean;
	/**
	 * The row this session was opened on, when the caller named one — the test-only override.
	 *
	 * Not a copy of anything on disk: every other reading of "which model is this session on" is
	 * derived from the file and the settings at the moment it is asked for (`modelChoiceOf`, ADR-0019).
	 * This is the one answer no file can give back, because nothing wrote it there — a session opened
	 * on a row of the caller's choosing carries that choice for as long as the open does, and the
	 * first choice that reaches the transcript outranks it. A production open names nothing, so it is
	 * absent there.
	 */
	openedOn?: ModelChoice;
	/**
	 * The bag of a session whose transcript is not on disk yet — created and never spoken in, or a
	 * session this build never writes at all (`inMemorySession`). Dropped at the first write that
	 * gives the session its files; every read after that is `open(id)`.
	 */
	unwritten?: Session;
}

/**
 * Build a session's live half, empty.
 *
 * The queue modes arrive as arguments — the settings' answer at creation time, read by the caller
 * through its own {@link SettingManager}; a config patch that moves either mode later writes it onto
 * the queue in place, so nothing here is captured for good.
 */
export function createLive(steeringMode: QueueMode, followUpMode: QueueMode): Live {
	return {
		steeringQueue: new PendingMessageQueue(steeringMode),
		followUpQueue: new PendingMessageQueue(followUpMode),
		partial: undefined,
		retrying: false,
		retryAttempt: 0,
		suspended: false,
	};
}

/**
 * Assemble one session's state from its live half.
 *
 * The state is the live half and the subscriber sets, and nothing else: the transcript is a file the
 * caller opens where it needs it (ADR-0019), so there is no third thing to gather here. The
 * subscriber sets start empty — attaching is the session's own business — and the live half arrives
 * built, because its queue modes are the settings' answer and this call only takes what the chain
 * produced.
 */
export function createAgentState(sessionId: string, live: Live): AgentState {
	return {
		sessionId,
		listeners: new Set(),
		eventListeners: new Set(),
		live,
	};
}
