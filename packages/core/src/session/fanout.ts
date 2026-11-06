import type { Message } from "../llm/index.ts";
import { spillOversizedToolResult } from "../context/spill.ts";
import { boundToolContent } from "../hooks.ts";
import { modelFor } from "../models.ts";
import type { SessionSnapshot } from "../protocol.ts";
import type { SettingManager } from "../setting-manager.ts";
import type { ToolManager } from "../tools/index.ts";
import type { AgentState } from "./agent-state.ts";
import { danglingApprovalsOf } from "./dangling.ts";
import type { AgentSessionEvent } from "./events.ts";
import type { Session, SessionManager } from "./session-manager.ts";
import { sessionSnapshot } from "./snapshot.ts";
import { followsGlobalOf, toolStateOf } from "./tool-config.ts";

/**
 * The three services a fan-out call reads through, passed at the call site.
 *
 * Every function below is stateless — it works on the state it is handed and the services it is
 * given — so none of them is a member of anything. The orchestrator's command surface and its run
 * both publish, append, and project through them, which is what keeps the engine free of a fan-out
 * of its own: ADR-0008's rule — stateful parts become members, stateless ones become file-level
 * functions — applied to the half the two of them share.
 */
export interface SessionServices {
	sessionManager: SessionManager;
	settings: SettingManager;
	tools: ToolManager;
}

/**
 * The approval map in force: the directory's settings with this session's own choices over them.
 *
 * The single read point for the gate, the snapshot, and the prompt — all three answer the same
 * question, so none of them may reach past this to the settings alone. The session's own
 * half is the recorded choice, read off the `.json` snapshot beside the tool set it was written
 * beside.
 */
export function approvalsOf(services: SessionServices, session: Session): Record<string, boolean> {
	return {
		...services.settings.getApprovals(session.sessionSetting.workDirAbsPath),
		...toolStateOf(services.sessionManager, session, services.settings, services.tools.names()).approvalOverride,
	};
}

/**
 * A stamp no other message from this session shares.
 *
 * `Date.now()` is not enough: two messages queued in the same millisecond would be
 * indistinguishable, and the echo of one would then be mistaken for the other. Derived from the
 * ledger rather than held, so a restart — which forgets every counter — still cannot issue a stamp
 * an existing message already has: the newest timestamp the file holds is the floor.
 */
export function nextStamp(sessions: SessionManager, session: Session): number {
	let newest = 0;
	for (const entry of sessions.getEntries(session)) {
		if (entry.type !== "message") continue;
		const stamp = entry.message.timestamp;
		if (typeof stamp === "number" && stamp > newest) newest = stamp;
	}
	return Math.max(Date.now(), newest + 1);
}

/**
 * The state of one held session, read out of its transcript and what its run is doing.
 *
 * The populated half of `sessionSnapshot`: everything a cold reader has to be told, this reads off
 * the live half — the run's model, the partial message, the two queues, the retry state — and
 * everything else it derives from the ledger. Both the orchestrator's `snapshot` and the fan-out's
 * publish answer through here, so a window frame and a REST read cannot disagree.
 */
export function snapshotOf(state: AgentState, services: SessionServices): SessionSnapshot {
	const session = state.session;
	const live = state.live;
	return sessionSnapshot({
		sessions: services.sessionManager,
		session,
		workDirAbsPath: session.sessionSetting.workDirAbsPath,
		// The run's own model is the one its request went out with, so the meter measures the window
		// the answer was actually asked against. An idle session has no run to ask, and builds it
		// from the catalog — one small file read, on a command rather than on a delta. The choice
		// read here is the one in force: the assembly seeds it onto the session before the first
		// message, and a request records it (issue 03 §7).
		model: live.model ?? modelFor(session.sessionSetting.model ?? {}, services.settings.modelCatalog()),
		approvals: approvalsOf(services, session),
		allTools: services.tools.names(),
		activeTools: toolStateOf(services.sessionManager, session, services.settings, services.tools.names()).activeToolNames,
		// Judged against this directory's own settings, the same way a cold read judges it, so the
		// panel's "沿用全局" label cannot disagree with itself between the two paths.
		...followsGlobalOf(services.sessionManager, session, services.settings, services.tools.names()),
		...(live.partial === undefined ? {} : { partial: live.partial }),
		submitting: live.activeRun !== undefined,
		queued: live.followUpQueue.previews(),
		isRetrying: live.retrying,
		retryAttempt: live.retryAttempt,
		pendingApprovals: live.activeRun === undefined ? danglingApprovalsOf(services.sessionManager.buildContextEntries(session)) : [],
	});
}

/** Fan one event out. The only place a session publishes an event. */
export function emitEvent(state: AgentState, event: AgentSessionEvent): void {
	for (const listener of state.eventListeners) listener(event);
}

/**
 * Publish the queue's current contents.
 *
 * Called only where the queue itself changed — a message accepted onto it, a drain point taking
 * one, a run dropping what it never reached — so no baseline is kept: the fact of the call is the
 * change. The queue is read off the live half.
 */
export function emitQueueUpdate(state: AgentState): void {
	emitEvent(state, { type: "queue_update", queued: state.live.followUpQueue.previews() });
}

/**
 * Append a message entry and announce it.
 *
 * Both writers of message entries go through here — a prompt for the optimistic user write and the
 * run's own event sink for everything the engine hands back — so a listener that follows
 * `entry_appended` sees the whole transcript, not just the engine's half of it. It is also the write
 * boundary: the version of a tool result the ledger keeps is decided here, once.
 */
export function appendMessageEntry(state: AgentState, sessions: SessionManager, message: Message): void {
	// A message appended where something already followed is a *second* alternative at that message
	// rather than a continuation of its tip — which is what rewinding and asking again is. The tree
	// gained a branch point there, so the windows are told where the leaf is, exactly as a move does:
	// their branch points came from a snapshot and this append changed them.
	// The count is the raw child count, so a `leaf` entry — the record a branch move writes — counts
	// too. The cost is one
	// extra full-snapshot frame that shows no extra branch point, which is harmless.
	const parent = state.session.leafId;
	const continued = parent !== null && sessions.getChildren(state.session, parent).length > 0;

	const entryId = sessions.appendMessage(state.session, finalizeToolResult(state, message));
	if (continued) emitEvent(state, { type: "branch_changed", leafId: entryId });
	emitEvent(state, { type: "entry_appended", entryId, kind: "message" });
}

/**
 * Empty the queues a run leaves behind.
 *
 * A message still queued when the run ends is one the run never reached — an abort, a failure,
 * a prompt that arrived in the moment the engine stopped looking. Nothing will drain it, and the
 * send contract is fire-and-forget: the message drops with the run rather than being stored
 * unasked, and the queues empty so the depth falls to zero — which is what `settle()` waits on —
 * and no later run inherits what this one never took.
 *
 * Returns whether anything was actually dropped, so the caller publishes a queue change only
 * when there was one.
 *
 * The one end that does not come here is the gate's: a suspended run keeps its queue for the
 * recovery run the answer starts, which drains it at its take points (`live.suspended`). The
 * abandonment sweep is the exception to that exception — `Agent.denyAllApprovals` calls this,
 * because no recovery run is coming to take them.
 */
export function dropQueued(state: AgentState): boolean {
	const dropped = state.live.steeringQueue.size > 0 || state.live.followUpQueue.size > 0;
	state.live.steeringQueue.clear();
	state.live.followUpQueue.clear();
	return dropped;
}

/** Tell every listener what the session looks like now. */
export function publishState(state: AgentState, services: SessionServices): void {
	const snapshot = snapshotOf(state, services);
	for (const listener of state.listeners) listener(snapshot);
}

/**
 * The version of a tool result the ledger keeps, decided once at the write boundary.
 *
 * This is the backstop for a result nothing bounded on the way in — every built-in tool bounds its
 * own output, and an `after_tool` rewrite is final by the time it gets here, so what remains is the
 * tool that forgot. A result too large for the context is archived whole under the working directory
 * (`context/spill.ts`) and stored as its head and tail plus the archive's path, so nothing is lost
 * that cannot be read back; when the archive cannot be written, the hard clip in `boundToolContent`
 * is the floor. Anything else passes through untouched: for a well-bounded result the whole check is
 * one length sum.
 *
 * Running it here, at the one door every write walks through, is what lets the request read the
 * ledger as it is: the content on disk is the content the model is served, on this process and on
 * every later one.
 */
function finalizeToolResult(state: AgentState, message: Message): Message {
	if (message.role !== "toolResult") return message;
	const spilled = spillOversizedToolResult(
		state.session.sessionSetting.workDirAbsPath,
		state.session.sessionId,
		message.toolName,
		message.toolCallId,
		message.content,
	);
	const content = spilled ?? boundToolContent(message.content);
	return content === undefined ? message : { ...message, content };
}
