import {
	Loop,
	type AfterToolCallResult,
	type AgentEvent,
	type AgentRequestUpdate,
	type AgentToolResult,
	type BeforeToolCallResult,
	type LoopContext,
	type ToolCallAnswer,
} from "@my-agent/loop";
import type { OpenSession, OpenSessions } from "./session/open-session.ts";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	anthropicMessages,
	type ChatTransport,
	createAssistantMessageEventStream,
	createSystemMessage,
	isContextOverflow,
	type LlmContext,
	type Message,
	type RetryCallbacks,
	retryAssistantCall,
	type SimpleStreamOptions,
	type Usage,
} from "@my-agent/llm";
import {
	compact as compactTranscript,
	compactionThresholdFor,
	estimateTokens,
	shouldCompact,
	type Summarize,
} from "./context/compaction.ts";
import { trimmableToolArgEntryIds } from "./context/trim-tool-call-args.ts";
import { clearableToolResultIds, isCacheProbablyExpired } from "./context/clear-tool-results.ts";
import { toolResultViewsOf, type ToolResultView } from "./context/tool-result-views.ts";
import { spillOversizedToolResult } from "./context/spill.ts";
import { danglingApprovalsOf } from "./session/dangling.ts";
import { boundToolContent, createHooks, type Hooks } from "./hooks.ts";
import {
	type Model,
	fillModel,
	type ModelSource,
	normalizeThinkingLevel,
	resolvedModel,
	type ThinkingLevel,
	thinkingLevelsFor,
	unconfiguredStream,
} from "./models.ts";
import {
	type ConfigPatch,
	type ModelSelection,
	type PendingApproval,
	type PromptBehavior,
	type SessionSnapshot,
	type ToolApprovalKey,
	type UsageTotals,
} from "./protocol.ts";
import { sessionSnapshot, sessionUsage } from "./session/snapshot.ts";
import {
	type SessionEntry,
	type SessionState,
	SessionManager,
	sessionEntryToContextMessages,
} from "./session/session-manager.ts";
import { followsGlobalOf, toolStateOf } from "./session/tool-config.ts";
import { getApprovals } from "./settings-manager.ts";
import {
	applySettings,
	getBashSettings,
	getFollowUpMode,
	getRetrySettings,
	getSteeringMode,
} from "./settings-manager.ts";
import { type ToolRegistry, type ToolRunContext, type ToolState } from "./tools/index.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The services one orchestrator coordinates, already built by the caller.
 *
 * The session never loads settings, creates a workspace, reads AGENTS.md, or picks a model: every
 * method names a session by id and fetches what it needs, at the line that needs it, from the
 * service that owns it — the transcript from the session manager's cache, the live half from the
 * registry entry, the model from the ledger and the live rows. That is what makes the class
 * stateless (ADR-0007): there is no session field here to hold state, so a test drives a session by
 * passing an in-memory session manager and registering an in-memory entry, and a host that owns the
 * services hands its own. `session-factory.ts` does the assembling for the real process.
 *
 * None of these fields is session *state*. The five singletons this orchestrator coordinates — the
 * ledger, the settings, the model rows, the tool definitions, and this class — each hold their own
 * pure-data state (ADR-0006 §1–2); what used to be the `Agent`'s private session fields are gone:
 * the run-time transients are locals of the run (ADR-0006 §5), the approvals are derived from the
 * ledger, the stamps are derived from the file, and the assembly rides the registry entry the open
 * created.
 */
export interface AgentConfig {
	/**
	 * The stateless session service every transcript read and write goes through.
	 *
	 * A host that owns one — the hub, whose `stateOf` cache must be the same object the session
	 * writes through — hands its own in. Methods resolve a session's bag with `stateOf(id)`, so the
	 * cache is what makes an id answer the one bag every writer shares.
	 */
	sessionManager: SessionManager;
	/**
	 * The user's models, read on every request.
	 *
	 * Handed over rather than copied, because a row is the thing most likely to change while a session
	 * is open: a session that cached one would keep sending a key the user has already corrected, to an
	 * endpoint they have already moved. Reading through this is what makes an edit in the settings panel
	 * reach the next message — the per-request fill re-derives the session's model from the row
	 * it finds here, so the key, the endpoint, the window, and the wire id are all as fresh as the row is.
	 */
	models: ModelSource;
	/**
	 * The tool definitions this build knows, plus whatever local tools assembly registered — the
	 * delegation pair, a test's custom tool. Structure only: the choice is not here.
	 *
	 * The active set and the approval map are derived from the ledger's `tool_config` entries on every
	 * read (the entry's `toolSeed` is the fallback), so nothing mutates when the choice moves. No
	 * workspace is resident either: the executable set is built fresh against the run context every
	 * request asks for it, so the workspace is a value object that arrives with the request.
	 */
	tools: ToolRegistry;
	/**
	 * The live registry: one entry per session this process runs, keyed by id (ADR-0007 §4).
	 *
	 * Every method resolves the entry its id names — the queues a run drains, the run in flight, the
	 * subscribers, the run slot, and the assembly the open resolved (workspace, settings, model
	 * selection, tool seed). Entries are built by the first touch of a session and dropped when its
	 * host closes, so a method called on an id nobody runs is refused rather than answered from
	 * something stale.
	 */
	openSessions: OpenSessions;
	/**
	 * The transport every model this orchestrator builds carries.
	 *
	 * A model is what a request is made with and the transport is how it is sent, so each model is
	 * constructed with the one it was assembled with, and every one it re-derives from a row
	 * afterwards. Defaults to Anthropic Messages, which is the only one this app speaks. It is
	 * injectable because the smokes drive the real loop against a scripted answer, and a seam that could
	 * not be handed a different transport would mean testing the session through a network.
	 */
	api?: ChatTransport;
	/**
	 * The seams sessions dispatch through: the provider transcript, the approval gate, and the
	 * tool-result backstop. Defaults are installed by {@link openAgent}; a session built without one
	 * still runs, it just has nothing to dispatch to.
	 */
	hooks?: Hooks;
	/**
	 * Builds the prompt for the tools the model may call, from the session's live settings.
	 *
	 * A function rather than a string because two things it names can change mid-session: the active
	 * tool set, and which of those tools ask for approval. A captured prompt would offer the model tools
	 * the loop then refuses to run, or promise an approval the session no longer asks for. It is handed
	 * both answers rather than reaching for them, so the builder never has to know where a session keeps
	 * its choices: `toolNames` is the active set, and `approvals` is the effective approval map — the
	 * whole map the gate reads, including the tools that are not active.
	 */
	systemPrompt: (toolNames: readonly string[], approvals: Record<ToolApprovalKey, boolean>) => string;
}

/** Called with the session's state whenever anything a reader can see has moved. */
export type SessionListener = (snapshot: SessionSnapshot) => void;

/**
 * One `message_update` as a session publishes it: the characters that just arrived, not the message.
 *
 * The loop's own event carries both the whole partial message and the provider's delta, and a session
 * used to republish both — so a token at the end of a long answer cost a frame the size of the answer,
 * serialized once here and parsed once in the window, and the window then re-read the whole text to
 * find what changed. What actually moves between two frames is one delta, so that is what is sent.
 * The full message still travels on `message_start` and `message_end`, and once more in a baseline's
 * `partial` for a window that attaches mid-run.
 *
 * The message is named by `timestamp` rather than by entry id: the entry does not exist until the
 * message ends, and the stamp is what a transcript already keys an item on.
 */
export interface MessageDelta {
	timestamp: number;
	/** Which of the two running texts moved; a tool call has its own events and is not a delta. */
	kind: "text" | "thinking";
	/** Where the block sits in the message, so a second block can be joined the way a full message is. */
	contentIndex: number;
	/** The characters that arrived. */
	text: string;
}

/**
 * Everything one session publishes: the loop's events as they arrive, plus the facts the loop has no
 * words for — queue depth, a compaction, an entry landing in the store, a settings change.
 *
 * The union is flat rather than nested, so a consumer keeps one `switch` over event types. That is
 * safe only because no `AgentEvent` type name collides with the names added here: a new session event
 * must therefore never reuse one of the loop's names. `message_update` is the one member deliberately
 * *replaced* rather than added beside the loop's: the session keeps the loop's full-message shape for
 * itself (it is what a mid-run baseline needs) and republishes the delta alone.
 */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "message_update" }>
	| { type: "message_update"; delta: MessageDelta }
	| { type: "queue_update"; queued: number }
	| {
			type: "compaction";
			/** The summary that now stands for everything before `firstKeptEntryId`. */
			summary: string;
			firstKeptEntryId: string;
			/** How many messages were folded into the summary. */
			summarized: number;
			/** The estimated prompt size before the compaction ran. */
			tokensBefore: number;
			/** The estimated prompt size the next request will carry. */
			contextTokens: number;
	  }
	/**
	 * A compaction that was attempted and could not produce a summary; the transcript is unchanged.
	 */
	| { type: "compaction_failed"; message: string }
	| {
			type: "tool_results_cleared";
			/**
			 * Tool results were cleared out of the transcript, and recorded as one `clear_tool_result`
			 * entry.
			 *
			 * Reported because it is invisible otherwise: the entries it names keep their place in the
			 * file, so a reader comparing messages would see the notice appear with nothing to explain it.
			 */
			/** How many tool results were cleared. */
			cleared: number;
			/** The estimated prompt size before the clear. */
			tokensBefore: number;
			/** The estimated prompt size the next request will carry. */
			contextTokens: number;
	  }
	| {
			type: "tool_call_args_trimmed";
			/**
			 * Recorded tool-call arguments were shortened, and recorded as one `trim_tool_call_arg` entry.
			 *
			 * Reported for the same reason `tool_results_cleared` is: the file keeps the full arguments,
			 * and the view drops their bodies, so a reader comparing messages would otherwise see the cut
			 * with nothing to explain it.
			 */
			/** How many entries had their recorded tool-call arguments shortened. */
			trimmed: number;
			/** The estimated prompt size before the trim. */
			tokensBefore: number;
			/** The estimated prompt size the next request will carry. */
			contextTokens: number;
	  }
	| { type: "entry_appended"; entryId: string; kind: SessionEntry["type"] }
	| {
			type: "branch_changed";
			/**
			 * The branch structure changed: the leaf moved, or a message was appended behind one that
			 * already had a continuation — which is the same event, seen from the other side.
			 *
			 * Emitted rather than only answered on the request that asked for it, because neither is the
			 * requesting client's business alone. Every window on this session holds branch points that
			 * came from a snapshot and may be showing a chain that is no longer the active one, so each
			 * stream re-reads the snapshot on this event rather than trusting what it drew before.
			 */
			leafId: string;
	  }
	| {
			type: "config_changed";
			model?: string;
			thinkingLevel?: string;
			approvals?: Record<string, boolean>;
			/** The active tool names, when `setActiveTools` moved them. */
			tools?: string[];
	  }
	/**
	 * A transient provider failure was classified as retryable, before its backoff sleep.
	 */
	| { type: "retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	/**
	 * The backoff ended and the retried provider call is starting.
	 */
	| { type: "retry_start"; attempt: number; maxAttempts: number }
	/**
	 * The retry loop ended, whichever way it ended. Emitted once per scheduled retry.
	 */
	| { type: "retry_end"; success: boolean; attempt: number; finalError?: string };

/** Called with every event the session publishes, in the order they happened. */
export type SessionEventListener = (event: AgentSessionEvent) => void;

/**
 * The transients of one run, as the run's own locals.
 *
 * Under the end-restart architecture nothing here is session state (ADR-0006 §5): the bag exists
 * while `runLoop` is on the stack and is dropped with it. It is referenced from one place outside
 * the run — the registry entry's `run` slot ({@link OpenSession.run}), the cross-stack handle a
 * mid-run reader (a snapshot, a queued prompt) reaches through, exactly as `runtime.activeRun` is
 * the handle an abort reaches through — and dropped from that slot the moment the run settles.
 */
export interface RunScope {
	/**
	 * The assistant message being written right now, as the loop last reported it.
	 *
	 * The loop's `message_update` carries the whole partial message and the session republishes only
	 * its delta — but a window that attaches mid-run has missed every delta so far, so a baseline has
	 * to carry the running text once. Cleared when the message ends, which is also when the store
	 * gains it and a snapshot starts reading it from the transcript instead.
	 */
	partial: Message | undefined;
	/**
	 * Messages accepted mid-run, oldest first, each waiting on one of the runtime's queues.
	 *
	 * Nothing is written to the store here. A message accepted mid-run is persisted when the loop
	 * drains it, so the file's order is the order the loop takes them in — which is the order the model
	 * is shown them in, and the order a reconnect's baseline replays. The list exists for the run's end:
	 * a run that stops before draining what it accepted appends the leftovers in acceptance order,
	 * which is the only order left for a message nobody answered.
	 */
	accepted: Message[];
	/** Stamps of the user messages this run wrote ahead of the loop, whose echoes must not be written twice. */
	promptWrites: number[];
	/**
	 * Tool results a hook rewrote during the run, awaiting the entry that makes them durable.
	 *
	 * `after_tool` answers with what the model should see, but the shown half becomes a
	 * `tool_result_view` entry only when its toolResult message lands — see
	 * {@link Agent.recordToolResultView}. From that moment the ledger is the only source: the request reads
	 * the views back through `toolResultViewsOf`, so each pending copy is dropped as it is written out.
	 */
	pendingToolResultViews: Map<string, ToolResultView>;
	/** True between `retry_scheduled` and `retry_end`: the run is waiting out a backoff. */
	retrying: boolean;
	/** The attempt the policy is on, 1-based, or 0 when no retry is pending. */
	retryAttempt: number;
	retryMaxAttempts: number;
	/** Queue depth as last published, so `queue_update` fires on a change and not on every touch. */
	lastQueued: number;
}

/**
 * The delta a loop `message_update` is worth, or `undefined` for the frames that carry no characters.
 *
 * Start/end frames and tool-call deltas are dropped: a block boundary needs no frame of its own — the
 * first delta of a block is what opens it in the window — and a tool call's card is built from the
 * tool events, which carry the arguments and the result rather than the JSON being assembled. An
 * empty delta is dropped for the same reason: it says nothing a frame could carry.
 */
function messageDeltaOf(event: Extract<AgentEvent, { type: "message_update" }>): MessageDelta | undefined {
	const inner = event.assistantMessageEvent;
	if (inner.type !== "text_delta" && inner.type !== "thinking_delta") return undefined;
	if (inner.delta.length === 0) return undefined;
	const stamp = (event.message as { timestamp?: unknown }).timestamp;
	if (typeof stamp !== "number") return undefined;
	return {
		timestamp: stamp,
		kind: inner.type === "text_delta" ? "text" : "thinking",
		contentIndex: inner.contentIndex,
		text: inner.delta,
	};
}

/**
 * One orchestration service for every conversation this process runs.
 *
 * This is the orchestration layer of the stateless architecture (ADR-0006 §1): the four domains are
 * stateless singletons, and the cross-domain order — record the selection, fill the model, replay
 * the ledger, build the request, assemble the tools, merge the approvals, build the prompt, run the
 * loop — lives here and nowhere else, because it belongs to no single domain. The class itself holds
 * no session state: a method names its session by id, resolves the ledger bag from the session
 * manager and the live half from the registry entry, and rebuilds everything a request needs from
 * those two. A resumed session and a live session run the same chain, which is what makes them
 * indistinguishable.
 */
export class Agent {
	/**
	 * The stateless session service every transcript read and write goes through.
	 *
	 * Exposed rather than hidden because it is the durable half's owner: a host that has to fork,
	 * list, or name the file reads it here, and there is no second copy of that state to keep in step.
	 * The bag a call operates on is never exposed — it is `stateOf(id)`'s answer, and the id is the
	 * caller's.
	 */
	readonly sessionManager: SessionManager;
	/** The user's models, as every session reads them: see {@link AgentConfig.models}. */
	readonly models: ModelSource;
	/**
	 * The seams sessions dispatch through, including the defaults `openAgent` installed.
	 *
	 * Exposed so a host that already has a session can add behaviour to it: a handler registered here
	 * runs after the defaults and refines what they answered.
	 */
	readonly hooks: Hooks;

	/** The caller's prompt builder; {@link Agent.prepareRequest} is what a request calls it from. */
	private readonly promptBuilder: (toolNames: readonly string[], approvals: Record<ToolApprovalKey, boolean>) => string;
	private readonly tools: ToolRegistry;
	/** Where a request actually leaves: the injected transport, before the retry policy wraps it. */
	private readonly base: ChatTransport;
	/** The live registry every method resolves its session's entry from: see {@link AgentConfig.openSessions}. */
	private readonly openSessions: OpenSessions;

	constructor(config: AgentConfig) {
		this.sessionManager = config.sessionManager;
		this.models = config.models;
		this.tools = config.tools;
		this.openSessions = config.openSessions;
		this.promptBuilder = config.systemPrompt;
		this.hooks = config.hooks ?? createHooks();
		this.base = config.api ?? anthropicMessages;
		// Nothing per session is read or cached here: an id is resolved at the top of each method, the
		// ledger bag from the session manager and the live half from the registry entry, and the locals
		// thread through the stack as parameters. No loop is built here either: the loop is per run,
		// assembled with the run's own closures — see {@link Agent.startRun}.
	}

	// ---------------------------------------------------------------------------- resolution

	/**
	 * The entry the session's live half lives in.
	 *
	 * Every method needs it — the queues, the run in flight, the subscribers, the assembly — and a
	 * missing one is a bug in the caller rather than a state to invent: only the first touch of a
	 * session builds an entry, and only its host knows when that is. Refusing here is what keeps a
	 * method from answering a session nobody runs from something it just made up.
	 */
	private entryOf(id: string): OpenSession {
		const entry = this.openSessions.get(id);
		if (entry === undefined) throw new Error(`Session is not running: ${id}`);
		return entry;
	}

	// ---------------------------------------------------------------------------- the read surface

	/**
	 * The state of the session `id` names, built by the one function that also serves a cold reader.
	 *
	 * The construction lives in `sessionSnapshot` rather than here so that a transcript this process
	 * is *not* running is answered by the same code from the same parts: the only fields the two
	 * callers can disagree on are the five they supply — `submitting`, `queued`, `isRetrying`,
	 * `retryAttempt`, `pendingApprovals` — and everything a transcript can answer is read identically.
	 * Of those five, four are the run's locals and one is derived from the ledger.
	 */
	snapshot(id: string): SessionSnapshot {
		return this.snapshotOf(this.sessionManager.stateOf(id), this.entryOf(id));
	}

	/** Usage summed over the transcript, with the window it is measured against. */
	usage(id: string): UsageTotals {
		const entry = this.entryOf(id);
		return sessionUsage(this.sessionManager.stateOf(id), resolvedModel(entry.modelSelection).contextWindow);
	}

	/** The JSONL file the session appends to, or undefined for a session that is never written. */
	sessionFile(id: string): string | undefined {
		return this.sessionManager.getAbsSessionFile(this.sessionManager.stateOf(id));
	}

	/** The row's name the session is on, which a config patch and the picker both name it by. */
	modelName(id: string): string {
		return this.entryOf(id).modelSelection.name!;
	}

	/** The level this session is asked at, read off the selection and normalized. */
	thinkingLevel(id: string): string {
		return normalizeThinkingLevel(this.entryOf(id).modelSelection.thinkingLevel);
	}

	/** The levels any model can be asked at, in the order the picker shows them. */
	thinkingLevels(): string[] {
		return thinkingLevelsFor();
	}

	/** Whether a run is in flight. True from `prompt` until the run settles, whatever it ends on. */
	isLooping(id: string): boolean {
		return this.entryOf(id).run !== undefined;
	}

	/**
	 * The tool choice in force, derived from the ledger, on every read.
	 *
	 * Never held: every write of it lands in the ledger in the same stack (`setActiveTools`, an
	 * approval choice), so deriving here is what keeps a branch move — which only moves the leaf —
	 * answered by the branch's own entries, and a settings edit answered live when the fallback is
	 * the global default. See {@link toolStateOf}.
	 */
	private toolStateOf(state: SessionState, entry: OpenSession): ToolState {
		return toolStateOf(state, entry.settings, this.tools, entry.toolSeed);
	}

	/** Names of the tools the model may call right now, in registration order. */
	activeTools(id: string): string[] {
		const entry = this.entryOf(id);
		return this.toolStateOf(this.sessionManager.stateOf(id), entry).activeToolNames;
	}

	/**
	 * The approval map in force: the workspace's settings with this session's own choices over them.
	 *
	 * The single read point for the gate, the snapshot, and the prompt — all three answer the same
	 * question, so none of them may reach past this to the settings alone. The session's own
	 * half is the recorded `tool_config` choice, derived with the tool set it was written beside.
	 */
	getApprovals(id: string): Record<ToolApprovalKey, boolean> {
		const state = this.sessionManager.stateOf(id);
		return this.approvalsOf(state, this.entryOf(id));
	}

	/** The one merge the gate, the snapshot, and the prompt all read through. */
	private approvalsOf(state: SessionState, entry: OpenSession): Record<ToolApprovalKey, boolean> {
		return { ...getApprovals(entry.settings), ...this.toolStateOf(state, entry).approvalOverride };
	}

	/**
	 * Whether the transcript holds a tool call nobody has answered.
	 *
	 * Only an idle session reports one. A call that dangles *during* a run is a result in the middle
	 * of landing, not a question waiting for a person, and reporting it would flash a banner on every
	 * tool batch; the calls that wait for an answer are the ones whose run has already ended.
	 */
	hasPendingApprovals(id: string): boolean {
		const entry = this.entryOf(id);
		return entry.run === undefined && this.danglingApprovals(this.sessionManager.stateOf(id)).length > 0;
	}

	/** True while a transient provider failure is waiting out its backoff. */
	isRetrying(id: string): boolean {
		return this.entryOf(id).run?.retrying ?? false;
	}

	/** The 1-based retry attempt in flight, or 0 when no retry is pending. */
	retryAttempt(id: string): number {
		return this.entryOf(id).run?.retryAttempt ?? 0;
	}

	/** The state one open session publishes, resolved from the bag and the entry its caller named. */
	private snapshotOf(state: SessionState, entry: OpenSession): SessionSnapshot {
		const run = entry.run;
		return sessionSnapshot({
			sessionState: state,
			absWorkspaceRoot: entry.workspace.absRoot,
			// The snapshot reads only the name, the level, and the window off the model, all of which the
			// filled bag already holds; no transport is needed for a read that sends nothing.
			model: resolvedModel(entry.modelSelection),
			approvals: this.approvalsOf(state, entry),
			allTools: this.tools.names(),
			activeTools: this.toolStateOf(state, entry).activeToolNames,
			// Judged against this workspace's own settings, the same way a cold read judges it, so the
			// panel's "沿用全局" label cannot disagree with itself between the two paths.
			...followsGlobalOf(state, entry.settings, this.tools),
			...(run?.partial === undefined ? {} : { partial: run.partial }),
			submitting: run !== undefined,
			queued: entry.runtime.followUpQueue.size,
			isRetrying: run?.retrying ?? false,
			retryAttempt: run?.retryAttempt ?? 0,
			pendingApprovals: run === undefined ? this.danglingApprovals(state) : [],
		});
	}

	/** Subscribe to the session's state. The returned function unsubscribes. */
	onChange(id: string, listener: SessionListener): () => void {
		const listeners = this.entryOf(id).listeners;
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	/** Subscribe to the session's events. The returned function unsubscribes. */
	onEvent(id: string, listener: SessionEventListener): () => void {
		const listeners = this.entryOf(id).eventListeners;
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	// ---------------------------------------------------------------------------- the run lifecycle

	/**
	 * Append a user message and run the loop until the agent stops.
	 *
	 * `selection` is the composer's model and level, applied here and recorded by the request that
	 * follows. Both come with the message rather than as a command of their own, so a choice that was
	 * never sent with is nowhere.
	 *
	 * While a run is streaming the message is queued instead of rejected: `steer` is injected at the
	 * current turn's next drain point, `followUp` waits until the agent would otherwise stop. Either
	 * way it is handed to the loop unwritten, and the loop's own echo of it is what the store records —
	 * a drained message is one the conversation has reached, so the file gains it in the place the
	 * model met it, behind the answer it interrupted. A run that ends before draining it writes it
	 * anyway ({@link Agent.flushAccepted}), so accepted still means persisted, exactly once.
	 */
	async prompt(id: string, text: string, options: { behavior?: PromptBehavior; selection?: ModelSelection } = {}): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;

		// The composer's choice arrives with the message, so this is the only place either half is
		// applied. A message that never reaches here — an empty one, a rejected send — moves nothing.
		if (options.selection !== undefined) this.applyModelSelection(id, options.selection);

		const state = this.sessionManager.stateOf(id);
		const entry = this.entryOf(id);
		if (entry.run !== undefined) {
			const message: Message = {
				role: "user",
				content: [{ type: "text", text: trimmed }],
				timestamp: this.nextStamp(state),
			};
			const queue = options.behavior ?? "followUp";
			if (queue === "steer") entry.runtime.steeringQueue.enqueue(message);
			else entry.runtime.followUpQueue.enqueue(message);
			entry.run.accepted.push(message);
			this.emitQueueUpdate(entry);
			this.publish(state, entry);
			return;
		}

		await this.startPromptedRun(state, entry, trimmed);
	}

	/**
	 * Send a message into the running turn's next drain point.
	 *
	 * The same session as {@link Agent.prompt} with `behavior: "steer"` — named on its own because it
	 * is its own answer in the protocol's terms: a steered message is spent by the turn it interrupted.
	 * On an idle session it is an ordinary prompt, because a message nobody is running cannot steer.
	 */
	steer(id: string, text: string, options: { selection?: ModelSelection } = {}): Promise<void> {
		return this.prompt(id, text, { ...options, behavior: "steer" });
	}

	/**
	 * Queue a message for when the run ends.
	 *
	 * The same session as {@link Agent.prompt} with `behavior: "followUp"`: the message waits until the
	 * agent would otherwise stop, and the depth it adds is what the composer shows.
	 */
	followUp(id: string, text: string, options: { selection?: ModelSelection } = {}): Promise<void> {
		return this.prompt(id, text, { ...options, behavior: "followUp" });
	}

	/** Write the prompted message into the transcript, then run over it. */
	private async startPromptedRun(state: SessionState, entry: OpenSession, trimmed: string): Promise<void> {
		const message: Message = {
			role: "user",
			content: [{ type: "text", text: trimmed }],
			timestamp: this.nextStamp(state),
		};
		this.appendMessage(state, entry, message);
		this.publish(state, entry);
		await this.startRun(state, entry, { prompt: message });
	}

	/**
	 * Run the loop once, over everything the transcript already holds.
	 *
	 * A run starts one of two ways. A prompted run hands over the message that started it, which the
	 * store already holds — the loop's own echo of it must not be recorded twice. A resumed run hands
	 * over the approval answers instead: the loop's recovery pass pairs them with the calls the last
	 * run left dangling and continues from there, so no message is written and none is echoed.
	 *
	 * This is where the run lives, and it is the whole reason the class holds no run state: the loop,
	 * the transport, the retry scope, and the event handler are all built here, closed over the run's
	 * locals, and dropped when the run settles. What crosses the stack is exactly what the entry
	 * names — the queues, the active run, the subscribers — plus the entry's `run` slot, which is how
	 * a reader outside the run sees its transients. The session the run serves is resolved once, at
	 * the top, and every closure below threads the same locals: no request re-resolves its way to a
	 * different bag.
	 */
	private async startRun(
		state: SessionState,
		entry: OpenSession,
		start: { prompt: Message; answers?: undefined } | { prompt?: undefined; answers: Record<string, ToolCallAnswer> },
	): Promise<void> {
		const sessionId = state.sessionId;
		const settings = entry.settings;
		const scope: RunScope = {
			partial: undefined,
			accepted: [],
			// The one user message the store already holds is the one that started the run: it is written
			// before the loop runs, so the loop's own echo of it must not be recorded twice.
			promptWrites: start.prompt === undefined ? [] : [start.prompt.timestamp],
			pendingToolResultViews: new Map(),
			retrying: false,
			retryAttempt: 0,
			retryMaxAttempts: 0,
			lastQueued: 0,
		};
		entry.run = scope;

		// The run's send policy rides on every request object this run's models are built with. The loop
		// is never told about it: it asks for a stream from whatever model it holds, and the model
		// answers through this — so retries, and the "no row behind this model" answer, happen below
		// everything that could report them.
		const transport: ChatTransport = {
			stream: (model, context, options) => {
				const outer = createAssistantMessageEventStream();
				// Deliberately not awaited: the loop owns the stream's lifetime, and a failure that
				// cannot be retried comes back as an error event on it rather than as a rejection out
				// of the stream function (which the loop's contract forbids anyway).
				void this.pumpAttempts(scope, state, entry, outer, model as Model, context, options);
				return outer;
			},
		};
		const loop = new Loop({
			// The one thing the engine needs to know about a model: how it answers. A function rather
			// than the model itself keeps the ownership where it belongs — the orchestrator owns the model
			// and may replace it at any time, while the loop only ever asks the model it was handed.
			streamFn: (model, context, options) => model.stream(context, options),
			// The run registers itself on the session's live half, so an abort from any layer — this
			// session's, the hub's, a process shutdown's — lands on the one controller the run sleeps on.
			runtime: entry.runtime,
			beforeToolCall: async ({ toolCall, args }) => this.beforeTool(toolCall.id, toolCall.name, args),
			afterToolCall: async ({ toolCall, result, isError }) =>
				this.afterTool(scope, toolCall.id, toolCall.name, result, isError),
			// The per-request fill chain (ADR-0006 §2): adopt the live row, record the selection, replay
			// the ledger into a view, compact it if it is over the window, build the prompt from the live
			// tool and approval answers, and hand the request back — built here, used once, dropped.
			prepareRequest: async ({ context }, signal) => this.prepareRequest(transport, context, signal, sessionId, state, entry),
		});
		// The run's own subscription. Persistence and the per-run transients — the partial, the accepted
		// list, the rewritten views — are the run's locals, so the handler is assembled with the run
		// rather than on the session; the `finally` below is the last thing that touches it.
		loop.subscribe(async (event) => this.handleEvent(scope, state, entry, event));

		try {
			// The transcript and the tools are handed over per run — the loop keeps no state of its
			// own — and both are rebuilt for the request that actually goes out by the fill chain
			// anyway. The queues' drain hooks are what connect the engine's take points to the queues
			// the runtime holds.
			await loop.runLoop(
				{
					messages: this.sessionManager.buildSessionContext(state).messages,
					tools: this.tools.active(this.toolStateOf(state, entry), this.runContext(entry)),
				},
				start.prompt,
				{
					// A request object from the selection as it stands; the fill chain fills the selection and
					// hands back a fresh one before anything is sent.
					model: resolvedModel(entry.modelSelection, transport),
					// The approval answers a resumed run closes its dangling calls with. A prompted run
					// carries none: the recovery pass then only sweeps what a crash left behind.
					recovery: { answers: start.answers },
					getSteeringMessages: async () => entry.runtime.steeringQueue.drain(),
					getFollowUpMessages: async () => entry.runtime.followUpQueue.drain(),
				},
			);
		} finally {
			// A message accepted in the last moment of the run — after the loop had already decided to
			// stop looking for one — is on a queue nothing will drain, so it is written here rather than
			// lost. The ordinary drain path has already emptied both lists by this point, which is what
			// makes this a no-op for a run that ended the way it should.
			this.flushAccepted(scope, state, entry);
			// The depth the run is leaving behind, said before the slot is dropped: after this the depth
			// is zero and the baseline is the idle one.
			this.emitQueueUpdate(entry);
			entry.run = undefined;
			// The run is not over until the loop's `runLoop` resolves — after every awaited listener for
			// `agent_end` and the engine's own `finally`. So this is the first moment nothing is in
			// flight, and without publishing here nothing ever reports it.
			//
			// In a `finally` rather than after the `await`, because the two ends of a run reach this point
			// by different roads: a run that ends normally falls through, but a run whose own failure
			// handling rejected — the persistence that reports the failure is the persistence that broke —
			// arrives here as a rejection, and a publish placed after the `await` would be skipped by
			// exactly the run that most needs the frame. Every end path a run has goes through this one
			// block; the error frame that may precede it is announced by the caller that learns of the
			// rejection, not by the session.
			this.publish(state, entry);
		}
	}

	/**
	 * The per-request fill chain, from the ledger to the request object.
	 *
	 * In order: the model is re-derived from the live row (an edit takes effect without reopening
	 * anything), the selection this request is made with is recorded — exactly one entry per move, so
	 * a choice that was never sent with is not in the file — the ledger is replayed into the view, the
	 * view is compacted if it is over this model's window, the prompt is built from the live tool and
	 * approval answers, and the whole thing is returned as the one request object this turn sends.
	 * Nothing here outlives the request.
	 */
	private async prepareRequest(
		transport: ChatTransport,
		context: LoopContext,
		signal: AbortSignal | undefined,
		sessionId: string,
		state: SessionState,
		entry: OpenSession,
	): Promise<AgentRequestUpdate> {
		// The model is re-derived from the live row before anything else reads it, because the
		// compaction decision below is measured against its context window and a threshold taken from
		// the window the row had a moment ago would compact the wrong transcript. This is the whole of
		// "an edit takes effect without reopening anything": the endpoint, the wire id, the window, and
		// the key are all read here rather than captured when the session was assembled. A row that is
		// gone — deleted, or renamed under a session that was using it — leaves the selection as it is,
		// and `unconfiguredStream` is what answers for that.
		this.adoptCurrentRow(entry);
		// The choice this request is made with reaches the transcript here, at the moment a request
		// is built from it — so a model or a level the user moved and never sent with is not in the
		// file at all. It runs before the compaction decision below, which measures the prompt
		// against this model's window.
		this.recordSelection(state, entry);
		// One pass decides both what the request carries and whether it has to be summarized: the
		// trigger, the clearing of stale tool results, and the summary all read the same entries, so the
		// decision and the request cannot disagree about how large the prompt is.
		const entries = await this.compactFor(state, entry, this.sessionManager.buildContextEntries(state), Date.now(), signal, transport);
		// The views come from the same selection of entries the request is built from, so what the
		// model is shown and what the request carries cannot disagree about a rewrite.
		const views = toolResultViewsOf(entries);
		// The prompt is rebuilt here, not remembered: `applyConfig` can move the approval set and
		// `setActiveTools` the tool set, and the model must be told about both on the next request.
		// Both are derived from the ledger at this moment, so a choice that just landed is what the
		// prompt describes.
		const toolState = this.toolStateOf(state, entry);
		const injected = {
			messages: messagesOf(entries),
			systemPrompt: this.promptBuilder(toolState.activeToolNames, this.approvalsOf(state, entry)),
		};
		const rewritten = await this.hooks.apply("context", injected);
		const messages = this.forModel(rewritten?.messages ?? injected.messages, views, entry, sessionId);
		// The leading system message is replaced rather than appended to, and every other system
		// message is dropped: the prompt is rebuilt whole on this request, so a second one would
		// describe a state that is already gone. A hook that wants to change the prompt returns
		// `systemPrompt`; one that pushes a system message into `messages` loses it here.
		const system = createSystemMessage(rewritten?.systemPrompt ?? injected.systemPrompt);
		// A compaction checkpoint is already the user turn it stands for — `sessionEntryToContextMessages`
		// wraps the summary in tags — so the transcript goes to the provider as it is.
		const conversation = pairLateToolResults(messages.filter((message) => message.role !== "system"));
		return {
			// Built here, from the selection this request just filled: run-local, used for the one
			// request, dropped.
			model: resolvedModel(entry.modelSelection, transport),
			context: {
				...context,
				messages: system === undefined ? conversation : [system, ...conversation],
				// The live executable set, built fresh against this request's run context from the choice
				// derived above. The loop declares it on the request (`toToolDeclaration`) rather than
				// reading it out of the transcript, so a tool switched on mid-session reaches the model on
				// the next request and the two cannot drift.
				tools: this.tools.active(toolState, this.runContext(entry)),
			},
		};
	}

	/**
	 * The value objects this request's tools are built against: the workspace, read off the entry's
	 * assembly, and the bash timeouts, read off the settings the same way. Per request, like the tool
	 * list itself — nothing here outlives the request that carries it.
	 */
	private runContext(entry: OpenSession): ToolRunContext {
		return { workspace: entry.workspace, bash: getBashSettings(entry.settings) };
	}

	/**
	 * Lay the live row the selection names over the selection, if that row still exists.
	 *
	 * A row is the user's to edit, so this runs before every request: the key, the endpoint, the wire
	 * id, the window, and the compat overrides are all read fresh, which is what `Model.apiKey` and
	 * `Model.compat` riding on the request object depend on. The fill is `fillModel` — idempotent, in
	 * place — so a corrected key, a moved endpoint and a resized window all reach the next request
	 * with nothing rebuilt, and the level, the context meter, and the reported ref are about the model
	 * the request is actually made with.
	 *
	 * A row that is gone — deleted, or renamed under a session that was using it — leaves the bag as it
	 * last was, and `unconfiguredStream` is what answers for that, in the transport where the "no row"
	 * answer has always lived.
	 *
	 * Nothing is recorded here: {@link Agent.recordSelection} does that once the model is final, because a row
	 * read mid-flight is not yet what the request went out with.
	 */
	private adoptCurrentRow(entry: OpenSession): void {
		try {
			fillModel(this.models.list(), entry.modelSelection);
		} catch {
			// No row answers the name any more. The bag keeps what it last had, which is never sent: the
			// transport's own lookup answers `unconfiguredStream` first.
		}
	}

	/**
	 * Write what this request is being made with into the transcript, once per move.
	 *
	 * The model and the level are recorded here rather than where the user chose them, because these
	 * entries are the transcript's account of what answered a turn: a row the user picked and never
	 * sent with answered nothing, and a level that was never asked at was never in force. Both guards
	 * key on what the branch already says — read from the ledger, not cached, so the
	 * baseline is the file's own and cannot drift from it — so a run of turns on one selection costs
	 * one entry.
	 *
	 * Only the wire id moves a `model_change`: a rename is the same model under another name, and the
	 * refs built from the old name are already accounted for as a rename.
	 */
	private recordSelection(state: SessionState, entry: OpenSession): void {
		const recorded = this.sessionManager.getRecordedSettings(state);
		if (entry.modelSelection.id !== recorded.model?.modelId) {
			const entryId = this.sessionManager.appendModelChange(state, entry.modelSelection.name!, entry.modelSelection.id!);
			this.emit(entry, { type: "entry_appended", entryId, kind: "model_change" });
		}
		const level = normalizeThinkingLevel(entry.modelSelection.thinkingLevel) as ThinkingLevel;
		if (level !== recorded.thinkingLevel) {
			const entryId = this.sessionManager.appendThinkingLevelChange(state, level);
			this.emit(entry, { type: "entry_appended", entryId, kind: "thinking_level_change" });
		}
	}

	/**
	 * Put the session back on the model and level the branch now in force recorded.
	 *
	 * The same argument as the branch move's tool report: which model answered and how hard it was
	 * asked are facts about where the leaf is, so moving the leaf moves them, and a session that
	 * carried the choice from the branch it left would be one session with two answers. The precedence
	 * is assembly's — the branch's recorded level, else nothing asked for — so a move and a reopen
	 * of the same file land in the same place.
	 *
	 * The branch's choices are the seed now, and the row's facts reach the bag with the same fill a
	 * request would run, so a snapshot taken before the next request already reads the branch's model.
	 * There is no baseline to update: {@link Agent.recordSelection} reads what the branch says each time,
	 * which is what keeps a move from being recorded twice.
	 */
	private applyBranchSelection(state: SessionState, entry: OpenSession): void {
		const recorded = this.sessionManager.getRecordedSettings(state);
		const userModel = this.models.list().find((userModel) => userModel.name === (recorded.model?.name ?? entry.modelSelection.name));
		if (userModel !== undefined) {
			entry.modelSelection.name = userModel.name;
			entry.modelSelection.thinkingLevel = recorded.thinkingLevel ?? entry.modelSelection.thinkingLevel;
			fillModel(this.models.list(), entry.modelSelection);
		}
	}

	/**
	 * Run one provider call through the retry policy, pumping it into the stream the loop reads.
	 *
	 * Retries live on `streamFn`, below the loop, because an error response is a hard exit: the loop
	 * emits `turn_end` and `agent_end` the moment a stream ends in `stopReason: "error"` and returns,
	 * so there is no later turn in which a failed assistant message could be rewritten. Below the
	 * loop the failed attempt is never a message at all: the transcript gains exactly one assistant
	 * message, the store keeps none of the failures, and the next request has no leftover error to
	 * explain.
	 *
	 * `retryAssistantCall` owns the classification, the backoff, and abort normalization — an abort
	 * during the sleep comes back as an aborted message — so nothing here counts attempts or sleeps. It
	 * wants `() => Promise<AssistantMessage>`, so each attempt is drained here and its events are
	 * forwarded as they arrive; only the terminal event is decided after the attempt, because that is
	 * what says whether this attempt is the one the loop gets to keep.
	 *
	 * The loop must see exactly one `start`: on a retry the failed attempt already put a partial message
	 * in its context, and a second `start` would append a second assistant message instead of replacing
	 * the abandoned one. So `start` is forwarded once per request and the retried attempt's deltas
	 * overwrite that same slot in place.
	 */
	private async pumpAttempts(
		scope: RunScope,
		state: SessionState,
		entry: OpenSession,
		outer: AssistantMessageEventStream,
		model: Model,
		context: LlmContext,
		options: SimpleStreamOptions | undefined,
	): Promise<void> {
		let started = false;
		const produce = async (): Promise<AssistantMessage> => {
			// A session with no row has nothing to send with, so it answers with the sentence that says
			// what to do instead of a request to a placeholder endpoint.
			const inner =
				this.models.list().find((userModel) => userModel.name === model.name) === undefined
					? unconfiguredStream(model)
					: await this.base.stream(model, context, options);
			for await (const event of inner) {
				if (event.type === "done" || event.type === "error") continue;
				if (event.type === "start") {
					if (started) continue;
					started = true;
				}
				outer.push(event);
			}
			const message = await inner.result();
			if (message.stopReason === "error" && isContextOverflow(message, model.contextWindow)) {
				// Context overflow is compaction's problem, never transient: stop the retry loop before
				// it can classify this as something worth trying again.
				throw new ContextOverflow(message);
			}
			return message;
		};

		let final: AssistantMessage;
		try {
			final = await retryAssistantCall(
				produce,
				getRetrySettings(entry.settings),
				options?.signal,
				this.retryCallbacks(scope, state, entry),
			);
		} catch (error) {
			// A stream function that throws breaks the loop's contract, so it ends up as an error
			// message here rather than as a rejected promise nobody is left to catch.
			final = error instanceof ContextOverflow ? error.message : failureMessage(model, error);
		}
		// A retry the policy never announced an end for — the loop was cut short above — still has to
		// close, or `isRetrying` would outlive the run.
		if (scope.retrying) this.endRetry(scope, state, entry, false, scope.retryAttempt, final.errorMessage);
		pushTerminal(outer, final);
		outer.end();
	}

	/** The three notifications `retryAssistantCall` makes, mapped one-to-one onto session events. */
	private retryCallbacks(scope: RunScope, state: SessionState, entry: OpenSession): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				scope.retrying = true;
				scope.retryAttempt = attempt;
				scope.retryMaxAttempts = maxAttempts;
				this.emit(entry, { type: "retry_scheduled", attempt, maxAttempts, delayMs, errorMessage });
				this.publish(state, entry);
			},
			onRetryAttemptStart: () => {
				this.emit(entry, {
					type: "retry_start",
					attempt: scope.retryAttempt,
					maxAttempts: scope.retryMaxAttempts,
				});
				this.publish(state, entry);
			},
			onRetryFinished: (success, attempt, finalError) => this.endRetry(scope, state, entry, success, attempt, finalError),
		};
	}

	/** Leave the retrying state and say how the loop ended. */
	private endRetry(scope: RunScope, state: SessionState, entry: OpenSession, success: boolean, attempt: number, finalError?: string): void {
		scope.retrying = false;
		scope.retryAttempt = 0;
		scope.retryMaxAttempts = 0;
		this.emit(entry, { type: "retry_end", success, attempt, finalError });
		this.publish(state, entry);
	}

	/**
	 * Stop the session's current run and wait for it to settle.
	 *
	 * Settling means the loop finished persisting the turn it was in the middle of, including tool
	 * results. The abort lands on the run's controller — the one the run registered on the runtime —
	 * and the run that ends writes what it was writing, so a stopped turn is a complete turn on disk.
	 * Calls the transcript would otherwise show without a result are closed by
	 * {@link Agent.denyAllApprovals}, so an abort never leaves a question the next request cannot ask.
	 *
	 * A retry that is only waiting out its backoff is cancelled by the same call: the abort signal is
	 * the one `retryAssistantCall` sleeps on, so it returns an aborted message instead of sleeping to
	 * the end. Nothing here has to know whether the run is live or in a backoff.
	 */
	async abort(id: string): Promise<void> {
		const state = this.sessionManager.stateOf(id);
		const entry = this.entryOf(id);
		// Read once: the run clears its own registration as it settles, and the promise is what waits
		// for that settlement.
		const active = entry.runtime.activeRun;
		active?.abortController.abort();
		await (active?.promise ?? Promise.resolve());
		// The run drops its own slot in its `finally`, a microtask after the idle promise resolves;
		// wait for that too, so the sweep below sees the idle session it is defined on.
		while (entry.run !== undefined) await Promise.resolve();
		this.denyAllApprovals(id, "The run was aborted.");
		// The same end a finished run publishes, and for the same reason: an abort is how a run that
		// nobody asked to stop otherwise reports that it has. See {@link Agent.prompt}.
		this.publish(state, entry);
	}

	// ---------------------------------------------------------------------------- config moves

	/**
	 * Move the conversation onto another branch of its own tree.
	 *
	 * The store has always been a tree — an entry may have any number of children — and this is the one
	 * way a window moves through it. The leaf lands on the newest tip of `entryId`'s subtree, so
	 * choosing an alternative brings the whole of it back into view at the point it stopped, and the
	 * next prompt continues from there. Nothing is deleted: the branch that was left keeps its entries,
	 * still reachable by id, and a fork from any of them still copies what it always would.
	 *
	 * `descend: false` is the other half of the same gesture — rewinding to a message itself, so the
	 * next prompt starts a *new* alternative at it instead of continuing one. Switching between
	 * alternatives that already exist and rewinding to make another are one operation with two ends.
	 *
	 * Refused while a run is in flight, because the loop appends to the leaf: a move under it would
	 * file the rest of that turn under a branch the turn was not answering.
	 */
	branchTo(id: string, entryId: string, descend = true): string {
		const state = this.sessionManager.stateOf(id);
		const entry = this.entryOf(id);
		if (entry.run !== undefined) throw new Error("A run is in flight: the branch cannot move under it");

		const leafId = descend ? this.sessionManager.getBranchTip(state, entryId) : entryId;
		const previousName = entry.modelSelection.name!;
		const previousLevel = normalizeThinkingLevel(entry.modelSelection.thinkingLevel);
		this.sessionManager.branch(state, leafId);
		this.applyBranchSelection(state, entry);
		this.emitBranchToolConfig(state, entry);
		// Reported because neither field is in the branch payload, and every stream other than the one
		// that asked is holding a snapshot taken before the move.
		this.emitConfigChanged(entry, {
			...(entry.modelSelection.name === previousName ? {} : { model: entry.modelSelection.name! }),
			...(normalizeThinkingLevel(entry.modelSelection.thinkingLevel) === previousLevel
				? {}
				: { thinkingLevel: normalizeThinkingLevel(entry.modelSelection.thinkingLevel) }),
		});
		this.emit(entry, { type: "branch_changed", leafId });
		this.publish(state, entry);
		return leafId;
	}

	/**
	 * Report the choices the branch now in force recorded.
	 *
	 * Moving the leaf is the one moment a session's own config can be wrong — except there is nothing
	 * to move: the choice is derived from the ledger on every read, so a leaf that now stands on
	 * another branch's entries is already answered by them. A branch that recorded nothing falls back
	 * on the global default the settings files name — or the assembly's seed when they name none —
	 * which is what a session that never chose runs on. Only a recorded `tool_config` can name
	 * something else, and every move ends on the branch's answer rather than the previous one's.
	 *
	 * What is left is the report: every stream other than the one that asked is holding a snapshot
	 * taken before the move, and neither map is in the branch payload. Both travel whole: this is the
	 * branch's state, not a delta, and a client applies either shape.
	 */
	private emitBranchToolConfig(state: SessionState, entry: OpenSession): void {
		this.emitConfigChanged(entry, { approvals: this.approvalsOf(state, entry), tools: this.toolStateOf(state, entry).activeToolNames });
	}

	/**
	 * Narrow the tools the model may call. An unknown name throws and leaves the session as it was.
	 *
	 * The change is recorded as one `tool_config` entry and takes effect on the next request: the
	 * fill chain derives the choice from the ledger with every request, so the model is told about
	 * the narrowed set when the next prompt is built.
	 */
	setActiveTools(id: string, names: string[]): void {
		const state = this.sessionManager.stateOf(id);
		const entry = this.entryOf(id);
		const previous = this.toolStateOf(state, entry).activeToolNames;
		const known = new Set(this.tools.names());
		const unknown = names.filter((name) => !known.has(name));
		if (unknown.length > 0) {
			throw new Error(`Unknown tool${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
		}
		if (names.length === previous.length && names.every((name, index) => name === previous[index])) return;

		this.sessionManager.appendToolConfig(state, [...names], this.approvalsOf(state, entry));
		this.publish(state, entry);
		this.emitConfigChanged(entry, { tools: [...names] });
	}

	/**
	 * Point this session at another row, another level, or both.
	 *
	 * There is no entry here and no settings write: a choice is not something that happened until a
	 * request is made with it, so it lands on the session's selection and reaches the transcript in
	 * {@link Agent.recordSelection}, at the moment the request it belongs to is built. What a caller gets
	 * back immediately is the change itself — the snapshot, the level, and the next request are
	 * all about the new model, whether or not that request is ever sent.
	 *
	 * A level the chosen model has no room for is refused rather than clamped, because the caller is a
	 * composer that offered the levels of the model it is moving to; "off" is the exception and is
	 * always accepted, since it means "as quiet as this model gets".
	 */
	applyModelSelection(id: string, selection: ModelSelection): void {
		const state = this.sessionManager.stateOf(id);
		const entry = this.entryOf(id);
		const previousName = entry.modelSelection.name!;
		const previousLevel = normalizeThinkingLevel(entry.modelSelection.thinkingLevel);
		// Nothing named is nothing to do, which is how a caller sends an ordinary message.
		if (selection.model === undefined && selection.thinkingLevel === undefined) return;

		const name = selection.model ?? previousName;
		const userModel = this.models.list().find((userModel) => userModel.name === name);
		if (userModel === undefined) throw new Error(`Unknown model: ${name}`);

		// The seed is the client's selection, written as it arrived: the row's name, and the level the
		// caller named or the one already in force. The row's facts are laid in with the same fill a
		// request would run, so a snapshot taken before that request already reads the row it names —
		// and the per-request fill re-derives all of it, so an edit between the two still wins.
		entry.modelSelection.name = userModel.name;
		entry.modelSelection.thinkingLevel = selection.thinkingLevel ?? normalizeThinkingLevel(entry.modelSelection.thinkingLevel);
		fillModel(this.models.list(), entry.modelSelection);

		this.publish(state, entry);
		this.emitConfigChanged(entry, {
			...(entry.modelSelection.name === previousName ? {} : { model: entry.modelSelection.name! }),
			...(normalizeThinkingLevel(entry.modelSelection.thinkingLevel) === previousLevel
				? {}
				: { thinkingLevel: normalizeThinkingLevel(entry.modelSelection.thinkingLevel) }),
		});
	}

	/**
	 * Update settings and persist them. Approval changes take effect on the next tool call.
	 *
	 * The two halves of a patch live in different places. Approval is session-scoped: it merges into
	 * this session's own choices and is recorded as one `tool_config` entry, so another session over
	 * this workspace is untouched. The queue modes go to the settings bag, which owns both the
	 * merged value and the file it goes in — and onto the runtime's queues, which read the mode at
	 * each drain.
	 *
	 * The model and the thinking level are not part of a patch at all. They are chosen in the composer
	 * and arrive with the message they belong to ({@link ModelSelection}), so there is nothing here to
	 * apply: a config change that no request followed is not a config change.
	 */
	applyConfig(id: string, patch: ConfigPatch): void {
		const state = this.sessionManager.stateOf(id);
		const entry = this.entryOf(id);
		const previousApprovals = this.approvalsOf(state, entry);
		if (patch.approval !== undefined) {
			// The entry records the whole map in force — the settings with this session's choice over
			// them — which is the shape every read of the ledger answers from.
			const approvals = { ...previousApprovals, ...patch.approval };
			this.sessionManager.appendToolConfig(state, this.toolStateOf(state, entry).activeToolNames, approvals);
		}
		applySettings(entry.settings, patch.approval === undefined ? patch : { ...patch, approval: undefined });
		entry.runtime.steeringQueue.mode = getSteeringMode(entry.settings);
		entry.runtime.followUpQueue.mode = getFollowUpMode(entry.settings);
		this.publish(state, entry);
		this.emitConfigChanged(entry, {
			approvals: changedApprovals(previousApprovals, this.approvalsOf(state, entry)),
		});
	}

	// ---------------------------------------------------------------------------- approvals

	/**
	 * The tool calls the transcript is still waiting on, as the approval flow sees them.
	 *
	 * Derived from the ledger, never held (ADR-0006 §5): an approval that is waiting *is* a dangling
	 * call in the view, and the answer arrives over REST to close it. See
	 * {@link Agent.hasPendingApprovals} for why a run in flight reports none.
	 */
	private danglingApprovals(state: SessionState): PendingApproval[] {
		return danglingApprovalsOf(this.sessionManager.buildContextEntries(state));
	}

	/**
	 * Whether this id names a tool call nobody has answered. Read-only.
	 *
	 * The approvals endpoint checks this before answering, because the check has to happen without
	 * answering: an answer starts the recovery run that closes the call, and the frame that reports
	 * the settlement is built from the change that lands when it does — recording the answer first is
	 * what keeps that frame from reading as a denial by whatever reads the answer back. An unknown id
	 * is the endpoint's 409, not a silent no-op: a button that answers nothing and says so to no one
	 * is worse than an error the client can show.
	 */
	hasPendingApproval(id: string, toolCallId: string): boolean {
		const entry = this.entryOf(id);
		return (
			entry.run === undefined &&
			this.danglingApprovals(this.sessionManager.stateOf(id)).some((call) => call.toolCallId === toolCallId)
		);
	}

	/**
	 * Answer one unanswered tool call, and resume the run that asked for it.
	 *
	 * The answering half of the end-restart chain (ADR-0006 §5): the run that asked is over, the call
	 * dangles in the ledger, and the answer starts the run that closes it. The loop's recovery pass
	 * pairs the answer with the call by id — a grant re-runs the call through the gate and the tool
	 * itself, a denial closes it with the sentence a press of "deny" writes — and the loop continues
	 * from there, so the model sees the call resolved and carries on in the same run. A grant also
	 * records the session's approval choice for that tool — the tool stops asking — as one
	 * `tool_config` entry, the same move a config patch makes: the recovery pass re-runs the call
	 * through the gate, and the gate lets through only a tool the map no longer gates.
	 *
	 * An id nothing is waiting on is ignored: the caller checked first, and answered it. A dangling
	 * call the answer does not name is closed by the recovery pass as an orphan — which is what keeps
	 * the resumed request provider-legal when a crash left several calls behind.
	 */
	async respondApproval(id: string, toolCallId: string, approved: boolean): Promise<void> {
		const state = this.sessionManager.stateOf(id);
		const entry = this.entryOf(id);
		if (entry.run !== undefined) return;
		const call = this.danglingApprovals(state).find((candidate) => candidate.toolCallId === toolCallId);
		if (call === undefined) return;
		const answer: ToolCallAnswer = approved
			? { approved: true }
			: { approved: false, reason: `The user denied permission to run ${call.toolName}.` };
		if (approved) {
			// The grant is the session's own choice for this tool, recorded as the whole map in force
			// with the tool turned off — the same move a config patch makes.
			const approvals = { ...this.approvalsOf(state, entry), [call.toolName as ToolApprovalKey]: false };
			this.sessionManager.appendToolConfig(state, this.toolStateOf(state, entry).activeToolNames, approvals);
		}
		// Said before the run starts: the choice is the session's own and lands now, while the call
		// itself stays dangling until the run's recovery pass closes it.
		this.publish(state, entry);
		await this.startRun(state, entry, { answers: { [toolCallId]: answer } });
	}

	/**
	 * Close every unanswered tool call with the reason nothing answered.
	 *
	 * The reason rides the answer into the transcript: each closed call's tool result says what
	 * actually happened — the run was aborted, no window answered — rather than the same sentence a
	 * press of "deny" writes, which would record an abandonment as a choice.
	 *
	 * Only an idle session closes anything: a call that dangles mid-run is a result the loop itself is
	 * about to write, and closing it here would write the answer twice.
	 */
	denyAllApprovals(id: string, reason: string): void {
		const state = this.sessionManager.stateOf(id);
		const entry = this.entryOf(id);
		if (entry.run !== undefined) return;
		const dangling = this.danglingApprovals(state);
		if (dangling.length === 0) return;
		for (const call of dangling) this.appendDanglingResult(state, entry, call, { approved: false, reason });
		this.publish(state, entry);
	}

	/** Write the result that closes one dangling call, and announce the entry like any other message. */
	private appendDanglingResult(
		state: SessionState,
		entry: OpenSession,
		call: PendingApproval,
		answer: { approved: boolean; reason?: string },
	): void {
		const text = answer.approved
			? `The user approved running ${call.toolName}. Issue the call again to run it.`
			: answer.reason ?? `The user denied permission to run ${call.toolName}.`;
		const message: Message = {
			role: "toolResult",
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			content: [{ type: "text", text }],
			details: {},
			isError: !answer.approved,
			timestamp: Date.now(),
		};
		this.appendMessage(state, entry, message);
	}

	/**
	 * Whether a tool that settings mark as requiring approval still needs the user's answer.
	 *
	 * The gate's decision, not its wording: what comes back is only whether the call may run now.
	 * Under the end-restart semantics a call that needs the answer does not get a block or a result —
	 * the `before_tool` gate turns this answer into the suspend that ends the run with the call
	 * dangling in the ledger, and the answer arrives over REST to start the recovery run that closes
	 * it. A tool the map does not gate runs without asking.
	 */
	async authorize(id: string, name: string, _toolCallId: string, _args: unknown): Promise<boolean> {
		const state = this.sessionManager.stateOf(id);
		return this.approvalsOf(state, this.entryOf(id))[name as ToolApprovalKey] === true;
	}

	// ---------------------------------------------------------------------------- waiting and closing

	/**
	 * Wait for the current run to finish and for its writes to reach the file system, without stopping
	 * anything. A run that is already idle returns immediately.
	 *
	 * A queued message is part of the run that accepted it, so the run is drained to the end: the queue
	 * can still be non-empty when one turn settles, which is exactly the case a caller waiting for "the
	 * transcript is complete" must not resolve on. {@link Agent.close} stops the run first, which is
	 * what makes it terminate.
	 *
	 * A pending retry is part of the run too, so it is waited for rather than resolved past: the
	 * retry runs inside the stream the loop is awaiting, which keeps the agent non-idle for the whole
	 * backoff, and the condition is here so that stays true if that ever changes.
	 */
	async settle(id: string): Promise<void> {
		const entry = this.entryOf(id);
		// Read through a closure: the run slot is reassigned across the awaits below, and a narrow
		// taken before them would tell the checker the slot is always empty here.
		const stillBusy = (): boolean => entry.runtime.followUpQueue.size > 0 || entry.run?.retrying === true;
		for (;;) {
			await (entry.runtime.activeRun?.promise ?? Promise.resolve());
			// The run drops its own slot a microtask after the idle promise resolves; wait for that too,
			// so a caller that settles sees the idle session — and the dangling calls the run ended
			// with — rather than one still finishing its writes. The same bounded wait `abort` makes.
			while (entry.run !== undefined) await Promise.resolve();
			if (!stillBusy()) return;
		}
	}

	/**
	 * Stop the run, if any, and wait for the session to go quiet.
	 *
	 * A call left dangling stays a question: the transcript is the only state (ADR-0006 §5), so the
	 * reopen derives it from the ledger and shows it again, and the answer that arrives then starts
	 * the run that closes it. Closing does not answer for the user — the denials an exit used to
	 * write recorded an abandonment as a choice, and the reopen that inherited them inherited a lie.
	 * {@link Agent.abort} is the deliberate stop, and the denial is its answer; a process shutdown
	 * and a reap that has already denied both land here.
	 */
	async close(id: string): Promise<void> {
		this.entryOf(id).runtime.activeRun?.abortController.abort();
		await this.settle(id);
	}

	// ---------------------------------------------------------------------------- compaction

	// The per-request fill chain calls the resolver below; this public shape lets a caller run the
	// same three steps against a session it names by id — the smoke that exercises the pruning
	// ladder drives it directly.
	maybeCompact(
		id: string,
		entries: readonly SessionEntry[],
		now: number,
		signal?: AbortSignal,
		transport?: ChatTransport,
	): Promise<readonly SessionEntry[]> {
		const state = this.sessionManager.stateOf(id);
		return this.compactFor(state, this.entryOf(id), entries, now, signal, transport);
	}

	/**
	 * Shrink the context before the next request, and answer with the entries that request should carry.
	 *
	 * Three steps, cheapest first. The trigger is this session's own model's window minus a fixed reserve,
	 * so the same transcript compacts under a small-window model and does not under a large one. When it
	 * fires, the recorded arguments of the heavy tools are shortened first — the bodies a `write` or an
	 * `edit` carried live in the files they changed, so dropping them from the view costs nothing and no
	 * request. Then results that can be fetched again are cleared if the provider has probably forgotten
	 * the cache — an hour without a request means the prompt is being paid for in full, and what a tool
	 * can reproduce is the next cheapest thing to lose. Only if that is still not enough is the
	 * transcript folded into a summary, which costs a request; nothing is kept verbatim but the turn in
	 * flight.
	 *
	 * Both steps before the summary are *recorded*, not held in memory: `appendTrimToolCallArgs` and
	 * `appendClearToolResults` name the entries, and the store's own view applies them from then on.
	 * So a resumed process, the next request in the run, and the window all read one transcript
	 * instead of each re-deciding.
	 *
	 * A summary that cannot be produced leaves the transcript exactly as it was and is reported rather
	 * than thrown: compaction is an optimization, and failing the turn over it would replace a clear
	 * context-overflow error with a mysterious crash inside the request path.
	 *
	 * Returns the entries to send: the ones it was given when no step changed anything, the store's view
	 * after whichever step was enough, and that view again once a checkpoint was written. The counts are
	 * reported by the `tool_call_args_trimmed`, `tool_results_cleared`, and `compaction` events, not by this answer.
	 */
	private async compactFor(
		state: SessionState,
		entry: OpenSession,
		entries: readonly SessionEntry[],
		now: number,
		signal?: AbortSignal,
		transport?: ChatTransport,
	): Promise<readonly SessionEntry[]> {
		const model = resolvedModel(entry.modelSelection, transport);
		const threshold = compactionThresholdFor(model.contextWindow);
		if (!shouldCompact(messagesOf(entries), threshold)) return entries;

		const trimmed = this.trimRecordedArgs(state, entry, entries);
		if (!shouldCompact(messagesOf(trimmed), threshold)) return trimmed;

		const cleared = this.clearStaleToolResults(state, entry, trimmed, now);
		if (!shouldCompact(messagesOf(cleared), threshold)) return cleared;

		// The one completion compaction makes: the session's own model, with the summary instructions.
		// It goes over the model a turn goes over — the selection, filled and built into a request
		// object here — so the summary carries the same key, endpoint, and window as the conversation it
		// summarizes rather than reaching for a second configuration. Built per call, because the
		// transport it goes over is the run's own.
		const summarize: Summarize = async (request) => {
			// The same absence a turn meets: a session with no row answers with the sentence that says what
			// to add, rather than sending a summary request to a placeholder endpoint.
			if (this.models.list().find((userModel) => userModel.name === entry.modelSelection.name) === undefined) {
				return unconfiguredStream(model).result();
			}
			const messages: Message[] = [
				{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() },
			];
			return model
				.stream({ messages, system: createSystemMessage(request.systemPrompt) }, {
					// The row's key, said here rather than only carried on the model: this is the one call
					// that does not travel through the loop, and the loop is what copies the key into options.
					apiKey: entry.modelSelection.apiKey,
					maxTokens: request.maxTokens,
					// A one-off summary is never sent again, so paying to cache it would buy nothing.
					cacheRetention: "none",
					...(request.signal === undefined ? {} : { signal: request.signal }),
				})
				.result();
		};

		let outcome;
		try {
			outcome = await compactTranscript(cleared, model, summarize, signal);
		} catch (error) {
			// An abort is not a compaction failure: the run is ending, and the transcript simply keeps the
			// history it already had. Anything else is worth saying out loud, because the next request may
			// then be the one that overflows.
			if (signal?.aborted !== true) {
				this.emit(entry, {
					type: "compaction_failed",
					message: error instanceof Error ? error.message : String(error),
				});
			}
			return cleared;
		}
		if (!outcome) return cleared;

		this.sessionManager.appendCompaction(
			state,
			outcome.summary,
			outcome.firstKeptEntryId,
			outcome.tokensBefore,
			outcome.usage,
		);
		// Published after the transcript moved, so a listener that reacts reads back the same numbers:
		// `summarized` is what this pass folded in, `contextTokens` is what the provider will now be sent.
		const compacted = this.sessionManager.buildContextEntries(state);
		this.emit(entry, {
			type: "compaction",
			summary: outcome.summary,
			firstKeptEntryId: outcome.firstKeptEntryId,
			summarized: outcome.summarized,
			tokensBefore: outcome.tokensBefore,
			contextTokens: estimateTokens(messagesOf(compacted)),
		});
		return compacted;
	}

	/**
	 * Shorten the recorded arguments of the heavy tools, and record it.
	 *
	 * This is the cheapest step compaction has: no request, and no clock to wait out — the bodies a
	 * `write` or an `edit` carried are already in the files they changed, so the view loses nothing the
	 * workspace does not hold. It is also the reason this runs before the clear rather than beside it:
	 * the clear needs an expired cache to be worth its cache invalidation, and this does not, because
	 * when the transcript is over the trigger the next request is in trouble whatever the cache says.
	 */
	private trimRecordedArgs(state: SessionState, entry: OpenSession, entries: readonly SessionEntry[]): readonly SessionEntry[] {
		const trimmed = trimmableToolArgEntryIds(entries);
		if (trimmed.length === 0) return entries;

		const tokensBefore = estimateTokens(messagesOf(entries));
		this.sessionManager.appendTrimToolCallArgs(state, trimmed, tokensBefore);
		const view = this.sessionManager.buildContextEntries(state);
		this.emit(entry, {
			type: "tool_call_args_trimmed",
			trimmed: trimmed.length,
			tokensBefore,
			contextTokens: estimateTokens(messagesOf(view)),
		});
		return view;
	}

	/**
	 * Clear what can be fetched again, and record it, when the provider has probably dropped the cache.
	 *
	 * A warm cache is the reason not to do this: rewriting the middle of a prompt the provider has
	 * already read costs more than the tokens it saves, which is why the summary — one deliberate
	 * invalidation that shrinks the transcript for good — is the answer for a warm transcript.
	 */
	private clearStaleToolResults(
		state: SessionState,
		entry: OpenSession,
		entries: readonly SessionEntry[],
		now: number,
	): readonly SessionEntry[] {
		if (!isCacheProbablyExpired(entries, now)) return entries;

		const cleared = clearableToolResultIds(entries);
		if (cleared.length === 0) return entries;

		const tokensBefore = estimateTokens(messagesOf(entries));
		this.sessionManager.appendClearToolResults(state, cleared, tokensBefore);
		const view = this.sessionManager.buildContextEntries(state);
		this.emit(entry, {
			type: "tool_results_cleared",
			cleared: cleared.length,
			tokensBefore,
			contextTokens: estimateTokens(messagesOf(view)),
		});
		return view;
	}

	// ---------------------------------------------------------------------------- the run's event half

	/**
	 * A stamp no other message from this session shares.
	 *
	 * `Date.now()` is not enough: two messages queued in the same millisecond would be
	 * indistinguishable, and the echo of one would then be mistaken for the other. Derived from the
	 * ledger rather than held, so a restart — which forgets every counter — still cannot issue a stamp
	 * an existing message already has: the newest timestamp the file holds is the floor.
	 */
	private nextStamp(state: SessionState): number {
		let newest = 0;
		for (const entry of this.sessionManager.getEntries(state)) {
			if (entry.type !== "message") continue;
			const stamp = entry.message.timestamp;
			if (typeof stamp === "number" && stamp > newest) newest = stamp;
		}
		return Math.max(Date.now(), newest + 1);
	}

	/**
	 * Run the `before_tool` hooks.
	 *
	 * The loop's seam can block a call, suspend one, or let it through, so those are the decisions
	 * that reach it: an `args` refinement goes as far as the handlers registered after this one. A
	 * suspend comes from the approval gate, and it is the whole end-restart move (ADR-0006 §5): the
	 * loop ends the run at that call without writing a result, the call dangles in the ledger, and
	 * the answer that arrives over REST starts the recovery run that closes it.
	 *
	 * The gate's own answer is the effective approval map, which the default handler reads through
	 * `authorize` — the same merge the snapshot and the prompt describe, so the three cannot disagree.
	 */
	private async beforeTool(
		toolCallId: string,
		toolName: string,
		args: unknown,
	): Promise<BeforeToolCallResult | undefined> {
		const decided = await this.hooks.apply("before_tool", { toolCallId, toolName, args });
		if (decided?.suspend === true) return { suspend: true };
		if (decided?.block === undefined) return undefined;
		return {
			block: true,
			reason: decided.block.reason,
			...(decided.terminate === true ? { terminate: true } : {}),
		};
	}

	/**
	 * Run the `after_tool` hooks and keep both halves of their answer.
	 *
	 * The loop builds the transcript message from what this returns, so the hooks' content goes back to
	 * it: that is what the model is shown for this turn. {@link Agent.transcriptMessage} then records the
	 * tool's own output instead, because a bound — or any rewrite — is about what the model sees, and
	 * the file must still hold what the tool produced.
	 */
	private async afterTool(
		scope: RunScope,
		toolCallId: string,
		toolName: string,
		result: AgentToolResult<unknown>,
		isError: boolean,
	): Promise<AfterToolCallResult | undefined> {
		const decided = await this.hooks.apply("after_tool", {
			toolCallId,
			toolName,
			content: result.content,
			isError,
		});
		if (decided?.content === undefined) return undefined;
		scope.pendingToolResultViews.set(toolCallId, { stored: result.content, shown: decided.content });
		return { content: decided.content };
	}

	/**
	 * The message the store records for a tool result.
	 *
	 * The loop hands back the content the hooks produced; the store keeps what the tool actually
	 * returned, so bounding the model's context can never lose the tool's output.
	 */
	private transcriptMessage(scope: RunScope, message: Message): Message {
		if (message.role !== "toolResult") return message;
		const view = scope.pendingToolResultViews.get(message.toolCallId);
		return view === undefined ? message : { ...message, content: view.stored };
	}

	/**
	 * Write the shown half of a rewritten result as its own entry, now that the stored half is in the
	 * file.
	 *
	 * The entry follows its toolResult message in the log — as its child, and so on every replay of
	 * the branch — which is both the order the two facts happened in and the order the red line asks
	 * the replay to keep. From here on the ledger is the only source of the view: the next request
	 * reads it back through `toolResultViewsOf`, so the pending copy is dropped as it is written out.
	 */
	private recordToolResultView(scope: RunScope, state: SessionState, message: Message): void {
		if (message.role !== "toolResult") return;
		const view = scope.pendingToolResultViews.get(message.toolCallId);
		if (view === undefined) return;
		scope.pendingToolResultViews.delete(message.toolCallId);
		this.sessionManager.appendToolResultView(state, message.toolCallId, view.shown);
	}

	/**
	 * The messages the provider is sent.
	 *
	 * A tool result a hook rewrote is served back as the hook left it, so the model sees the bounded
	 * version of a result the transcript holds in full. The views are the ledger's — replayed from the
	 * `tool_result_view` entries of the same selection of entries the request is built from — so a
	 * rewrite outlives the process that made it, and a clear takes the view with the result it emptied.
	 * A result too large for the context is served head and tail with the full text archived in the
	 * workspace (`context/spill.ts`) — the backstop for a tool that does not bound or paginate its own
	 * output, and the one that survives a restart, because the archive path is derived from the session
	 * and the call id. Anything else oversized is clipped here: a result with no view to replay and no
	 * archive is kept out of the context by the budget.
	 */
	private forModel(messages: readonly Message[], views: ReadonlyMap<string, ToolResultView>, entry: OpenSession, sessionId: string): Message[] {
		return messages.map((message) => {
			if (message.role !== "toolResult") return message;
			const view = views.get(message.toolCallId);
			if (view !== undefined) return { ...message, content: view.shown };
			const spilled = spillOversizedToolResult(entry.workspace, sessionId, message.toolName, message.toolCallId, message.content);
			if (spilled !== undefined) return { ...message, content: spilled };
			const content = boundToolContent(message.content);
			return content === undefined ? message : { ...message, content };
		});
	}

	/** Persist what the loop reports, and pass it on. The run's locals are this handler's closure. */
	private async handleEvent(scope: RunScope, state: SessionState, entry: OpenSession, event: AgentEvent): Promise<void> {
		if (event.type === "message_update") {
			// The hot path: one event per provider delta. Keep the running message for a baseline that
			// has to hand a mid-run attach the text it missed, and publish only what moved since the
			// last frame. Nothing is written here — the message is persisted when it ends.
			scope.partial = event.message;
			const delta = messageDeltaOf(event);
			if (delta !== undefined) this.emit(entry, { type: "message_update", delta });
			return;
		}
		if (event.type === "message_end" || event.type === "agent_end") scope.partial = undefined;
		if (event.type === "message_end") {
			// The one user message the store already holds is the one that started a run: the run wrote
			// it before handing it to the loop, so the loop's own emit of it must not be recorded
			// twice. Everything else the loop announces is written here — including a message it just
			// drained out of a queue, whose write was deliberately left to this moment so that the file
			// gains it behind the answer it interrupted rather than in front of it.
			if (!isOptimisticEcho(scope, event.message)) {
				takeAccepted(scope, event.message);
				this.appendMessage(state, entry, this.transcriptMessage(scope, event.message));
				this.recordToolResultView(scope, state, event.message);
			}
		}
		if (event.type === "agent_end") {
			// An accepted message the run never reached — an abort, a failure, a prompt that arrived in
			// the moment the loop stopped looking. Nothing will drain it now, so the end of the run is
			// where it is written. See {@link Agent.flushAccepted}.
			this.flushAccepted(scope, state, entry);
		}
		this.emit(entry, event);
		// The echo of a drained message is what lowers the depth, so this is where the count goes live.
		this.emitQueueUpdate(entry);
		if (event.type === "message_start" || event.type === "message_end" || event.type === "turn_end") {
			this.publish(state, entry);
		}
	}

	// ---------------------------------------------------------------------------- the fan-out

	/** Fan one event out. The only place a session publishes an event. */
	private emit(entry: OpenSession, event: AgentSessionEvent): void {
		for (const listener of entry.eventListeners) listener(event);
	}

	/**
	 * Report the queue depth whenever it moved.
	 *
	 * Called from wherever the depth can change — accepting a message, and the loop echoing a drained
	 * one — so a composer can show the number without polling `snapshot`. The depth is read off the
	 * runtime's queues; the baseline it is compared against lives with the run, because the depth is
	 * meaningful only while one is in flight.
	 */
	private emitQueueUpdate(entry: OpenSession): void {
		const queued = entry.runtime.followUpQueue.size;
		const last = entry.run?.lastQueued ?? 0;
		if (queued === last) return;
		if (entry.run !== undefined) entry.run.lastQueued = queued;
		this.emit(entry, { type: "queue_update", queued });
	}

	/** Report a config change with only the fields that moved; silence when none did. */
	private emitConfigChanged(
		entry: OpenSession,
		changes: {
			model?: string;
			thinkingLevel?: string;
			approvals?: Record<string, boolean>;
			tools?: string[];
		},
	): void {
		if (
			changes.model === undefined &&
			changes.thinkingLevel === undefined &&
			changes.approvals === undefined &&
			changes.tools === undefined
		) {
			return;
		}
		this.emit(entry, { type: "config_changed", ...changes });
	}

	/**
	 * Append a message entry and announce it.
	 *
	 * Both writers of message entries go through here — a prompt for the optimistic user write and
	 * {@link Agent.handleEvent} for everything the loop hands back — so a listener that follows
	 * `entry_appended` sees the whole transcript, not just the loop's half of it.
	 */
	private appendMessage(state: SessionState, entry: OpenSession, message: Message): void {
		// A message appended where something already followed is a *second* alternative at that message
		// rather than a continuation of its tip — which is what rewinding and asking again is. The tree
		// gained a branch point there, so the windows are told where the leaf is, exactly as a move does:
		// their branch points came from a snapshot and this append changed them.
		// The count is the raw child count, so a `leaf` entry — the record a branch move writes — counts
		// too, the same way a `model_change` written in front of a message already does. The cost is one
		// extra full-snapshot frame that shows no extra branch point, which is harmless.
		const parent = this.sessionManager.getLeafId(state);
		const continued = parent !== null && this.sessionManager.getChildren(state, parent).length > 0;

		const entryId = this.sessionManager.appendMessage(state, message);
		if (continued) this.emit(entry, { type: "branch_changed", leafId: entryId });
		this.emit(entry, { type: "entry_appended", entryId, kind: "message" });
	}

	/**
	 * Write the accepted messages a run never drained, in the order they were accepted.
	 *
	 * The run is over, so nothing will ever drain them: a message accepted while a run was in flight
	 * that the run never reached — an abort, a failure, a prompt that arrived after the loop had
	 * already decided to stop — is appended here, behind everything the run answered. Letting them go
	 * instead would lose words the user typed, and would leave the depth above zero, which is what
	 * `settle()` waits on.
	 *
	 * The loop's own queues are emptied with them, and that is not a convenience: they belong to the
	 * run that just ended, and a message left on one would be drained into some later run and written
	 * a second time.
	 */
	private flushAccepted(scope: RunScope, state: SessionState, entry: OpenSession): void {
		if (scope.accepted.length === 0) {
			entry.runtime.steeringQueue.clear();
			entry.runtime.followUpQueue.clear();
			return;
		}
		// Emptied before the writes, so a failed append can never turn into a second copy of one.
		const pending = scope.accepted.splice(0);
		entry.runtime.steeringQueue.clear();
		entry.runtime.followUpQueue.clear();
		for (const message of pending) this.appendMessage(state, entry, message);
	}

	/** Tell every listener what the session looks like now. */
	private publish(state: SessionState, entry: OpenSession): void {
		const snapshot = this.snapshotOf(state, entry);
		for (const listener of entry.listeners) listener(snapshot);
	}
}

/**
 * True when the loop is echoing a user message the session already persisted.
 *
 * Only a prompt is written ahead of the loop: it is what starts a run, so there is a moment between
 * the write and the loop's own emit of the same message, and the stamp identifies it — stamps are
 * unique per message because this session issues them. A message drained out of a queue is not one
 * of these; its write is the echo, so it must land here.
 */
function isOptimisticEcho(scope: RunScope, message: Message): boolean {
	if (message.role !== "user" || message.timestamp === undefined) return false;
	return consume(scope.promptWrites, message.timestamp);
}

/**
 * Take one accepted message off the run's list, now that the loop has drained it.
 *
 * The depth a composer shows is the follow-up queue's, and the drain took the message off it; what
 * is left here is the flush's business — a message still on the list when the run ends is one the
 * run never reached. The message the loop hands back is the very object `prompt()` queued, so the
 * stamp is the key.
 */
function takeAccepted(scope: RunScope, message: Message): void {
	if (message.role !== "user" || message.timestamp === undefined) return;
	const index = scope.accepted.findIndex((accepted) => accepted.timestamp === message.timestamp);
	if (index !== -1) scope.accepted.splice(index, 1);
}

/** Take one outstanding write off its list, and say whether there was one. */
function consume(writes: number[], timestamp: number): boolean {
	const index = writes.indexOf(timestamp);
	if (index === -1) return false;
	writes.splice(index, 1);
	return true;
}

/**
 * The approval keys whose value differs, or undefined when none do.
 *
 * `config_changed` carries only what moved, so an `applyConfig` that re-sends the current settings —
 * which is what a reconnect or an unchanged form does — must not claim anything changed.
 */
function changedApprovals(
	before: Record<ToolApprovalKey, boolean>,
	after: Record<ToolApprovalKey, boolean>,
): Record<string, boolean> | undefined {
	const changed: Record<string, boolean> = {};
	let moved = false;
	for (const [key, value] of Object.entries(after)) {
		if (before[key as ToolApprovalKey] === value) continue;
		changed[key] = value;
		moved = true;
	}
	return moved ? changed : undefined;
}

/**
 * Thrown out of an attempt that failed with a context overflow, so the retry policy never sees it.
 *
 * `retryAssistantCall` classifies what `produce` returns, so the only way to keep an overflow out of
 * the retry budget is to not return it: the pump catches this and ends the run with the same error
 * message, exactly as it would for a failure the classifier rejects.
 */
class ContextOverflow {
	readonly message: AssistantMessage;

	constructor(message: AssistantMessage) {
		this.message = message;
	}
}

/** A zero `Usage`, for a message no provider produced. */
const NO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A stream function that threw, in the shape the loop ends a run on. */
function failureMessage(model: Model, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		model: model.id,
		usage: NO_USAGE,
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/**
 * End the session's stream the way a provider would.
 *
 * The loop's terminal branch is driven by this event, and `AssistantMessageEventStream.result()`
 * answers with exactly the message it carries, so the event is rebuilt from the message the retry
 * policy settled on rather than copied from the attempt that produced it — an attempt that was
 * retried had its own terminal event discarded.
 */
function pushTerminal(outer: AssistantMessageEventStream, message: AssistantMessage): void {
	const { stopReason } = message;
	if (stopReason === "error" || stopReason === "aborted" || stopReason === "pending") {
		// `pending` means the stream ended without a terminal event at all; report it as the failure
		// it is rather than as a completed turn.
		outer.push({ type: "error", reason: stopReason === "pending" ? "error" : stopReason, error: message });
		return;
	}
	outer.push({ type: "done", reason: stopReason, message });
}

/**
 * Move each late tool result back beside the call it answers.
 *
 * The ledger is append-only, so a result can stand behind messages its call never saw: a prompt the
 * orchestrator wrote before the run's recovery pass closed the call, a message the run flushed at its
 * end after the gate had already left the call dangling. On disk that order is the honest one — the
 * prompt really did come before the answer — but a provider request that carries it is not legal: the
 * wire wants every tool result in the user turn that follows its own assistant message, and a call
 * answered two turns later reads as a call never answered.
 *
 * The repair is the request's, never the file's: a result is late when its call was issued, left
 * unanswered across a non-result message, and answered afterwards; each late result is hoisted to
 * directly after the assistant message that carries its call, in the order the calls were made.
 * Everything else stays exactly where the ledger put it.
 */
function pairLateToolResults(messages: readonly Message[]): Message[] {
	// Which results are late: a call still open when a non-result message arrives is answered too
	// late by whatever comes after, because the wire has already moved on.
	const lateIds = new Set<string>();
	{
		const open = new Set<string>();
		for (const message of messages) {
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "toolCall") open.add(block.id);
				}
			} else if (message.role === "toolResult") {
				open.delete(message.toolCallId);
			} else if (open.size > 0) {
				for (const id of open) lateIds.add(id);
			}
		}
	}
	if (lateIds.size === 0) return messages as Message[];

	// The late results, grouped by call id and kept in the order the ledger gave them.
	const late = new Map<string, Message[]>();
	for (const message of messages) {
		if (message.role === "toolResult" && lateIds.has(message.toolCallId)) {
			const grouped = late.get(message.toolCallId) ?? [];
			grouped.push(message);
			late.set(message.toolCallId, grouped);
		}
	}

	const out: Message[] = [];
	for (const message of messages) {
		if (message.role === "toolResult" && lateIds.has(message.toolCallId)) continue;
		out.push(message);
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const grouped = late.get(block.id);
				if (grouped !== undefined) out.push(...grouped);
			}
		}
	}
	return out;
}

/**
 * The messages one selection of entries stands for — the same projection the store hands a request.
 *
 * It is the only way the trigger measures a prompt, so `maybeCompact` can compare the transcript as
 * stored with the transcript after a clear without building the request twice.
 */
function messagesOf(entries: readonly SessionEntry[]): Message[] {
	return entries.flatMap((entry) => sessionEntryToContextMessages(entry));
}
