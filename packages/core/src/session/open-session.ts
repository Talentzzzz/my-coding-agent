import type { AgentTool, QueueMode } from "@my-agent/loop";
import type { ModelState } from "../models.ts";
import type { ToolState } from "../tools/manager.ts";
import type { Workspace } from "../workspace.ts";
import type { RunScope, SessionEventListener, SessionListener } from "../agent.ts";
import type { AgentsMdFile } from "../context/agents-md.ts";
import type { SettingsState } from "../settings-manager.ts";
import { createSessionRuntime, type SessionRuntime } from "./session-runtime.ts";

/**
 * One session this process has touched, as a registry entry: the live half (ADR-0006 §4) plus the
 * assembly the session runs on, and the two attach points and the cross-stack run slot that ride
 * with it.
 *
 * Everything here answers one of two questions. *What is in progress and nowhere on disk*: the
 * queues and the active run cannot be rebuilt from the ledger; neither can the subscriber sets a
 * window attached through `onChange` / `onEvent`, or the run slot a mid-run reader reaches through.
 * *What one open resolved*: the workspace fence, the settings bag, the model selection, and the
 * tool seed are the products of the seed→fill assembly (ADR-0006 §2) — the per-session answers a
 * stateless orchestrator would otherwise have nowhere to put, arrived at when the entry was created
 * and read by every call that follows. A process restart drops the whole entry on purpose — queued
 * messages are lost, subscribers are re-attached by the next connection, the run slot is empty, and
 * the assembly is re-run by the reopen — and the session file is not, so a reopen and a restart land
 * in the same place.
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
	/** The directory this session's tools resolve inside, resolved once at assembly. */
	readonly workspace: Workspace;
	/** The workspace's settings, as the bag every settings call in this session passes. */
	readonly settings: SettingsState;
	/**
	 * The model selection in force, as the seed assembly resolved: the row's name and the level.
	 *
	 * The bag is the session's one live model state, and it lives here rather than on the session
	 * because the orchestrator is stateless (ADR-0007 §5): a selection that arrived with a message
	 * is written onto it by the session, a branch move rewrites it from the branch's own recording,
	 * and every request lays the live row's facts over it with `fillModel` before anything reads
	 * them. What is *recorded* is the ledger's account, written by the request that is made with the
	 * selection — this bag is what that request was made from.
	 */
	readonly modelSelection: ModelState;
	/**
	 * The deliberate loadout assembly handed in, as the fallback the tool choice derives against, or
	 * undefined when the session follows the global default's live view.
	 *
	 * A seed, never a state: the SubAgent child's read-only narrowing arrives this way, and the
	 * recorded `tool_config` entries still have the last word — the seed answers only on a branch
	 * that carries no entry.
	 */
	readonly toolSeed: ToolState | undefined;
	/**
	 * The tools this session has that the shared catalog does not: the delegation pair, built against
	 * this session's own workspace and transcript.
	 *
	 * Here rather than in a registry of the session's own because the registry is process structure —
	 * one catalog over one set of definitions — while these are assembly products, closing over the
	 * parent a delegation reports to. The session reads them back through {@link registryView} on
	 * every tool resolution, so the executable set is still built per request and nothing here is
	 * mutable. Empty for a session that may not delegate, which is how delegation does not nest.
	 */
	readonly localTools: readonly AgentTool<any>[];
	/**
	 * The `AGENTS.md` files that apply to this workspace, read once by the open that assembled it.
	 *
	 * A prompt input rather than a setting: the builder is handed them, so one builder can serve every
	 * session this process runs. They are read when the entry is created and not followed afterwards,
	 * exactly like the rest of the assembly — reopening the session reads the files again.
	 */
	readonly agentsMd: readonly AgentsMdFile[];
}

/** What one open resolved, as the entry's starting contents. */
export interface OpenSessionSeed {
	workspace: Workspace;
	settings: SettingsState;
	modelSelection: ModelState;
	toolSeed?: ToolState;
	localTools?: readonly AgentTool<any>[];
	agentsMd?: readonly AgentsMdFile[];
	steeringMode: QueueMode;
	followUpMode: QueueMode;
}

/**
 * Build one session's registry entry.
 *
 * The queue modes are the workspace settings' answer at creation time; a config patch that moves
 * either mode later writes it onto the queue in place, so nothing here is captured for good. The
 * assembly fields are the caller's resolved answers — the orchestrator reads them and never
 * re-resolves them, so there is exactly one place a session's assembly lives.
 */
export function createOpenSession(seed: OpenSessionSeed): OpenSession {
	return {
		runtime: createSessionRuntime(seed.steeringMode, seed.followUpMode),
		listeners: new Set(),
		eventListeners: new Set(),
		run: undefined,
		workspace: seed.workspace,
		settings: seed.settings,
		modelSelection: seed.modelSelection,
		toolSeed: seed.toolSeed,
		localTools: seed.localTools ?? [],
		agentsMd: seed.agentsMd ?? [],
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
