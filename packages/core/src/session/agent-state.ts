import type { Message, Model } from "@my-agent/llm";
import type { SettingsState } from "../settings-manager.ts";
import { getFollowUpMode, getSteeringMode } from "../settings-manager.ts";
import type { SessionListener, SessionEventListener } from "../agent.ts";
import type { Session } from "./session-manager.ts";
import type { ActiveRun } from "./session-runtime.ts";
import { PendingMessageQueue } from "./queues.ts";

/**
 * One session this process holds, as a single bag: the durable half, the settings it was opened
 * against, its subscribers, and the live half (ADR-0011).
 *
 * The registry entry this replaces carried the live half and the assembly side by side; the state
 * carries them as one object because the two halves answer one id. The durable half is the session's
 * own bag — the ledger's replayed state, not a copy — and the settings are the bag every settings
 * call in this session passes, exactly what the open resolved. A process restart drops the whole
 * state on purpose: the durable half replays from the files, the live half is the part that was
 * nowhere on disk, and the settings are re-resolved by the reopen.
 */
export interface AgentState {
	/** Subscribers to the session's state, attached through the session's `onChange`. */
	readonly listeners: Set<SessionListener>;
	/** Subscribers to the session's events, attached through the session's `onEvent`. */
	readonly eventListeners: Set<SessionEventListener>;
	/** The directory's settings, as the bag every settings call in this session passes. */
	readonly setting: SettingsState;
	/** The session's durable half: the bag the ledger replays into and every session read answers from. */
	readonly session: Session;
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
}

/**
 * Build a session's live half, empty.
 *
 * The queue modes are the settings' answer at creation time; a config patch that moves either mode
 * later writes it onto the queue in place, so nothing here is captured for good.
 */
export function createLive(setting: SettingsState): Live {
	return {
		steeringQueue: new PendingMessageQueue(getSteeringMode(setting)),
		followUpQueue: new PendingMessageQueue(getFollowUpMode(setting)),
		partial: undefined,
		retrying: false,
		retryAttempt: 0,
		suspended: false,
	};
}

/**
 * Assemble one session's state from its three already-resolved halves.
 *
 * The build chain this sits at the end of is `fillSession` → `fillSettings` → `createLive`, and the
 * order is not free: the session names the model and thinking level it runs on, so it is filled
 * first and the settings only provide the defaults a choice may override. The subscriber sets start
 * empty — attaching is the session's own business — and the live half arrives built, because its
 * queue modes are the settings' answer and this call only gathers what the chain produced.
 */
export function createAgentState(session: Session, setting: SettingsState, live: Live): AgentState {
	return {
		listeners: new Set(),
		eventListeners: new Set(),
		setting,
		session,
		live,
	};
}
