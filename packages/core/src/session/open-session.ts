import type { QueueMode } from "../types.ts";
import type { ModelChoice } from "../models.ts";
import type { SessionEventListener, SessionListener } from "../agent.ts";
import type { SettingsState } from "../settings-manager.ts";
import { createSessionRuntime, type SessionRuntime } from "./session-runtime.ts";

/**
 * One session this process has touched, as a registry entry: the live half (ADR-0006 §4) plus the
 * assembly the session runs on, and the two attach points that ride with it.
 *
 * Everything here answers one of two questions. *What is in progress and nowhere on disk*: the
 * queues and the active run cannot be rebuilt from the ledger; neither can the subscriber sets a
 * window attached through `onChange` / `onEvent`. *What one open resolved*: the working directory,
 * the settings bag, and the model selection are the
 * products of the seed→fill assembly (ADR-0006 §2) — the per-session answers a stateless orchestrator
 * would otherwise have nowhere to put, arrived at when the entry was created and read by every call
 * that follows. A process restart drops the whole entry on purpose — queued
 * messages are lost, subscribers are re-attached by the next connection, and
 * the assembly is re-run by the reopen — and the session file is not, so a reopen and a restart land
 * in the same place.
 *
 * The name is the entry's, not the state's: {@link SessionRuntime} keeps its narrow definition —
 * the queues and the run in flight — and this entry *holds* one rather than replacing it
 * (ADR-0007 §4). What an entry deliberately does not hold is a session's durable half: the
 * transcript's `Session` is its ledger's business, held by the session manager's cache or not
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
	 * The working directory this session's tools resolve against and start commands in.
	 *
	 * Resolved once at assembly and a plain path, not an object with rules: it is the reference frame
	 * for a relative path, and nothing more. An absolute path a tool receives is taken as it stands,
	 * wherever it points.
	 */
	readonly workDirAbsPath: string;
	/** The directory's settings, as the bag every settings call in this session passes. */
	readonly settings: SettingsState;
	/**
	 * The model choice in force, as the seed assembly resolved it: the row's name and the level.
	 *
	 * The choice lives here rather than on the session because the orchestrator is stateless
	 * (ADR-0007 §5): a selection that arrived with a message is written onto it by the session, and
	 * every read — a snapshot, a request, a compaction trigger — builds its model from it by looking
	 * the name up in the catalog. Nothing of the row is kept: the key, the endpoint, and the window
	 * are read at that moment, which is what makes an edit to the file reach the very next request
	 * with nothing refreshed. What is *recorded* is the ledger's account, written by the request that
	 * is made with the choice — this is what that request was made from.
	 */
	readonly modelSelection: ModelChoice;
}

/** What one open resolved, as the entry's starting contents. */
export interface OpenSessionSeed {
	/** The working directory, absolute: the header's own `workDirAbsPath`, resolved. */
	workDirAbsPath: string;
	settings: SettingsState;
	modelSelection: ModelChoice;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
}

/**
 * Build one session's registry entry.
 *
 * The queue modes are the settings' answer at creation time; a config patch that moves either mode
 * later writes it onto the queue in place, so nothing here is captured for good. The assembly fields
 * are the caller's resolved answers — the orchestrator reads them and never re-resolves them, so
 * there is exactly one place a session's assembly lives.
 */
export function createOpenSession(seed: OpenSessionSeed): OpenSession {
	return {
		runtime: createSessionRuntime(seed.steeringMode, seed.followUpMode),
		listeners: new Set(),
		eventListeners: new Set(),
		workDirAbsPath: seed.workDirAbsPath,
		settings: seed.settings,
		modelSelection: seed.modelSelection,
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
	 * queue modes, the assembly — is the open's own answer, and the registry stays dumb about
	 * where those come from: the caller resolves them only when a creation actually happens, which
	 * keeps the timing where it has always been.
	 */
	ensure(id: string, create: () => OpenSession): OpenSession {
		const existing = this.entries.get(id);
		if (existing) return existing;
		const created = create();
		this.entries.set(id, created);
		return created;
	}

	/** The entry an id names, or undefined when this process has never touched the session. */
	get(id: string): OpenSession | undefined {
		return this.entries.get(id);
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
