import type { QueueMode } from "@my-agent/loop";
import type { RunScope, SessionEventListener, SessionListener } from "../agent.ts";
import { createSessionRuntime, type SessionRuntime } from "./session-runtime.ts";

/**
 * One session this process has touched, as a registry entry: the live half (ADR-0006 §4) plus the
 * two attach points and the cross-stack run slot that ride with it.
 *
 * Everything here answers one question: *what is in progress and nowhere on disk*. The queues and
 * the active run cannot be rebuilt from the ledger; neither can the subscriber sets a window
 * attached through `onChange` / `onEvent`, or the run slot a mid-run reader reaches through. A
 * process restart drops the whole entry on purpose — queued messages are lost, subscribers are
 * re-attached by the next connection, the run slot is empty — and the session file is not, so a
 * reopen and a restart land in the same place.
 *
 * The name is the entry's, not the state's: {@link SessionRuntime} keeps its narrow definition —
 * the queues and the run in flight — and this entry *holds* one rather than replacing it
 * (ADR-0007 §4). What an entry deliberately does not hold is a session's durable half: the
 * transcript's `SessionState` is its ledger's business, held by the session manager's cache or not
 * at all, and never here — an entry and a ledger cache are two tables and stay two tables.
 */
export interface OpenSession {
	/** The session's live half: the queues a run drains, and the run in flight. */
	readonly runtime: SessionRuntime;
	/** Subscribers to the session's state, attached through the session's `onChange`. */
	readonly listeners: Set<SessionListener>;
	/** Subscribers to the session's events, attached through the session's `onEvent`. */
	readonly eventListeners: Set<SessionEventListener>;
	/**
	 * The run in flight, as the handle a cross-stack reader reaches it through.
	 *
	 * The run's transients ({@link RunScope}) are locals of the run itself; this slot is what a
	 * snapshot or a queued prompt reads them through while the run is on the stack — the same
	 * structural role `runtime.activeRun` plays for an abort. Set before the loop starts, cleared
	 * the moment the run settles.
	 */
	run: RunScope | undefined;
}

/**
 * Build one session's registry entry, empty.
 *
 * The queue modes are the workspace settings' answer at creation time; a config patch that moves
 * either mode later writes it onto the queue in place, so nothing here is captured for good.
 */
export function createOpenSession(steeringMode: QueueMode, followUpMode: QueueMode): OpenSession {
	return {
		runtime: createSessionRuntime(steeringMode, followUpMode),
		listeners: new Set(),
		eventListeners: new Set(),
		run: undefined,
	};
}

/**
 * The live halves of the sessions this process has touched, keyed by session id (ADR-0007 §4).
 *
 * A narrow registry and nothing more. Its charter is the runtime's own, widened to the whole
 * entry: only what cannot be rebuilt from disk enters it, a process restart drops every entry,
 * and the first touch of a session builds a fresh one — which is also what a host closing a
 * session does, one entry at a time, so a reopen after a close never inherits a stale run, a
 * drained queue, or a subscriber nobody re-attached.
 */
export class OpenSessions {
	private readonly entries = new Map<string, OpenSession>();

	/**
	 * The entry an id names, created on first touch by the caller's own factory.
	 *
	 * The factory rather than the registry builds the entry, because what creation reads — the
	 * queue modes — is the workspace settings' answer, and the registry stays dumb about where
	 * those come from: the caller reads them only when a creation actually happens, which keeps
	 * the timing where it has always been.
	 */
	ensure(id: string, create: () => OpenSession): OpenSession {
		const existing = this.entries.get(id);
		if (existing) return existing;
		const created = create();
		this.entries.set(id, created);
		return created;
	}

	/** Drop one entry: the session's host has closed, so its live half goes with it. */
	delete(id: string): boolean {
		return this.entries.delete(id);
	}

	/** Drop every entry: the process is shutting down, which is the restart the invariant names. */
	clear(): void {
		this.entries.clear();
	}
}
