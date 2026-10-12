import {
	Loop,
	type AfterToolCallResult,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type AgentToolResult,
	type BeforeToolCallResult,
	type StreamFn,
} from "@my-agent/agent";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	anthropicMessages,
	type ChatTransport,
	contentText,
	createAssistantMessageEventStream,
	createInitialSystemMessage,
	isContextOverflow,
	type Message,
	type Model,
	normalizeContext,
	type RetryCallbacks,
	retryAssistantCall,
	type SimpleStreamOptions,
	toToolDeclaration,
	type TranscriptContext,
	type Usage,
} from "@my-agent/ai";
import { type Settings } from "./config.ts";
import {
	compact as compactTranscript,
	compactionThresholdFor,
	estimateTokens,
	shouldCompact,
	type Summarize,
} from "./context/compaction.ts";
import { trimmableToolArgEntryIds } from "./context/argtrim.ts";
import { clearableToolResultIds, isCacheProbablyExpired } from "./context/pruning.ts";
import { spillOversizedToolResult } from "./context/spill.ts";
import { boundToolContent, createHooks, type Hooks, type ToolResultContent } from "./hooks.ts";
import {
	modelFor,
	resolveModelRef,
	rowFor,
	thinkingLevelsFor,
	type ModelSource,
	type ThinkingLevel,
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
import { convertToLlm } from "./session/messages.ts";
import { foldUsage, sessionSnapshot } from "./session/snapshot.ts";
import { type SessionEntry, SessionManager, sessionEntryToContextMessages } from "./session/session-manager.ts";
import { applyRecordedToolConfig } from "./session/tool-config.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { describeToolCall, type ToolRegistry } from "./tools/index.ts";
import type { Workspace } from "./workspace.ts";

/**
 * Everything one session uses, already built by the caller.
 *
 * The session never loads settings, creates a workspace, reads AGENTS.md, or picks a model: it only
 * uses what it is handed. That is what makes it testable (pass an in-memory session manager and an
 * in-memory settings manager) and replaceable (a different settings manager is a different object,
 * not a change here). `session-factory.ts` does the assembling for the real process.
 */
export interface AgentConfig {
	/** The directory the agent may touch. Every tool path resolves inside it. */
	workspace: Workspace;
	/**
	 * The session's transcript, and the only record of it.
	 *
	 * The session appends to it and reads every request out of it, so what the provider is sent, what a
	 * resumed process sees, and what is on disk are the same thing rather than three things kept in
	 * step. It is built by the caller, which is what lets a test pass an in-memory one.
	 */
	sessionManager: SessionManager;
	/**
	 * The user's models, read on every request.
	 *
	 * Handed over rather than copied, because a row is the thing most likely to change while a session
	 * is open: a session that cached one would keep sending a key the user has already corrected, to an
	 * endpoint they have already moved. Reading through this is what makes an edit in the settings panel
	 * reach the next message — {@link Agent.adoptCurrentRow} rebuilds the model itself from the row it
	 * finds here, so the key, the endpoint, the window, and the wire id are all as fresh as the row is.
	 */
	models: ModelSource;
	/**
	 * The transport every request in this session goes over.
	 *
	 * Defaults to Anthropic Messages, which is the only one this app speaks. It is injectable because
	 * the smokes drive the real loop against a scripted answer, and a seam that could not be handed a
	 * different transport would mean testing the session through a network.
	 */
	api?: ChatTransport;
	/**
	 * The session's settings: the single owner of the values it runs with, and of the files behind them.
	 *
	 * Handed over rather than copied, because settings outlive one session: several sessions over one
	 * workspace share this object, so a change made through one is what the next one reads. The class
	 * exposes it unchanged as {@link Agent.settingsManager}.
	 */
	settingsManager: SettingsManager;
	/** The tool definitions, and the per-session active set the prompt is rebuilt from. */
	tools: ToolRegistry;
	/**
	 * The seams this session dispatches through: the provider transcript, the approval gate, and the
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
	/**
	 * Approval choices this session itself recorded, over the workspace's defaults.
	 *
	 * The replayed `tool_config` entries, handed in by assembly: a session that chose its own approvals
	 * reopens with them rather than with whatever the settings file has since become. Undefined keys
	 * fall through to {@link AgentConfig.settingsManager}, so a session that never chose is unchanged.
	 */
	approvalOverride?: Partial<Record<ToolApprovalKey, boolean>>;
	/**
	 * The model this session starts on, already carrying its thinking level.
	 *
	 * One object rather than a model and a level beside it, so there is no way for a session to be on
	 * one row and asked at a level that belongs to another.
	 */
	model: Model<Api>;
}

/** Called with the session's state whenever anything a reader can see has moved. */
export type SessionListener = (snapshot: SessionSnapshot) => void;

/**
 * Everything one session publishes: the loop's events as they arrive, plus the facts the loop has no
 * words for — queue depth, a compaction, an entry landing in the store, a settings change.
 *
 * The union is flat rather than nested, so a consumer keeps one `switch` over event types. That is
 * safe only because no `AgentEvent` type name collides with the names added here: a new session event
 * must therefore never reuse one of the loop's names.
 */
export type AgentSessionEvent =
	| AgentEvent
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
			type: "pruned";
			/**
			 * Tool results were cleared out of the transcript, and recorded as one `prune` entry.
			 *
			 * Reported because it is invisible otherwise: the entries it names keep their place in the
			 * file, so a reader comparing messages would see the notice appear with nothing to explain it.
			 */
			/** How many tool results were cleared. */
			cleared: number;
			/** The estimated prompt size before the prune. */
			tokensBefore: number;
			/** The estimated prompt size the next request will carry. */
			contextTokens: number;
	  }
	| {
			type: "arg_trimmed";
			/**
			 * Recorded tool-call arguments were shortened, and recorded as one `argtrim` entry.
			 *
			 * Reported for the same reason `pruned` is: the file keeps the full arguments, and the view
			 * drops their bodies, so a reader comparing messages would otherwise see the cut with nothing
			 * to explain it.
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

/** One unanswered approval: what the banner shows, and the promise the tool call is parked on. */
interface PendingApprovalEntry {
	approval: PendingApproval;
	resolve(approved: boolean): void;
}

/**
 * Both halves of a tool result a hook rewrote.
 *
 * The loop stores one message, but two audiences read it: the provider request is served the `shown`
 * half, and the transcript keeps the `stored` half, because bounding what the model sees must not
 * lose what the tool actually produced.
 */
interface ToolResultView {
	stored: ToolResultContent;
	shown: ToolResultContent;
}

/**
 * One conversation: the pi-agent-core `Loop`, the workspace, the JSONL store, and the approval gate.
 *
 * The store is the source of truth for the conversation. Before every provider request,
 * {@link prepareRequestOnLoop} asks the `context` hook for the transcript the model should see — by
 * default the store's current view, which is where compaction shows up — and puts a fresh leading
 * system message in front of it, because the prompt and the tool declarations reach the model as a
 * system message and `LoopState.systemPrompt` is read-only. That is what keeps a resumed session and
 * a live session on exactly the same context. The session owns no transport: the server subscribes to
 * {@link onEvent} and forwards events to the browser, so the same session could be driven from a
 * terminal instead.
 */
export class Agent {
	/** The directory every tool path resolves inside. */
	readonly workspace: Workspace;
	/**
	 * This session's transcript.
	 *
	 * Exposed rather than hidden because it is the session's durable half: a host that has to fork,
	 * list, or name the file reads it here, and there is no second copy of that state to keep in step.
	 */
	readonly sessionManager: SessionManager;
	/** The user's models, as this session reads them: see {@link AgentConfig.models}. */
	readonly models: ModelSource;
	/**
	 * This session's settings, and the only way it reads or writes them.
	 *
	 * Exposed rather than hidden because it is not the session's private state: it is the workspace's
	 * settings object, shared with every other session over that workspace, and the thing a host writes
	 * a UI toggle through. A host that reads {@link snapshot} sees the same values this object reports.
	 */
	readonly settingsManager: SettingsManager;
	/**
	 * This session's seams, including the defaults `openAgent` installed.
	 *
	 * Exposed so a host that already has a session can add behaviour to it: a handler registered here
	 * runs after the defaults and refines what they answered.
	 */
	readonly hooks: Hooks;

	private readonly loop: Loop;
	private readonly tools: ToolRegistry;
	/** The caller's prompt builder; {@link buildSystemPrompt} is what the session calls. */
	private readonly promptBuilder: (toolNames: readonly string[], approvals: Record<ToolApprovalKey, boolean>) => string;
	/**
	 * This session's own approval choices, over the workspace defaults.
	 *
	 * Grown by `applyConfig` and seeded from the replayed `tool_config` entries. Session-scoped by
	 * design: the settings files stay the defaults a new session opens on, and a change made here
	 * writes a `tool_config` entry into this session's transcript rather than onto the workspace.
	 */
	private approvalOverride: Partial<Record<ToolApprovalKey, boolean>>;
	/**
	 * What the transcript last says the session was using, so a move is recorded once.
	 *
	 * Kept here rather than read back from the file, which would be a scan of the whole branch before
	 * every request. Undefined means the branch records nothing — a session that has never made a
	 * request, or one that has just moved onto a branch where the first turn is still ahead — and then
	 * the next request appends what it used rather than staying silent. Seeded by the constructor and
	 * by {@link applyBranchSelection}, and advanced only by {@link recordSelection}.
	 */
	private recordedModelId: string | undefined;
	private recordedThinkingLevel: ThinkingLevel | undefined;
	private readonly listeners = new Set<SessionListener>();
	private readonly eventListeners = new Set<SessionEventListener>();
	private readonly pendingApprovals = new Map<string, PendingApprovalEntry>();
	/** Tool results a hook rewrote, so the transcript can keep what the tool produced. */
	private readonly toolResultViews = new Map<string, ToolResultView>();
	/**
	 * User messages this session already wrote to the store, oldest first.
	 *
	 * `prompt()` persists a message before handing it to the loop, so the loop's own emit of the same
	 * message must not be written again. Two lists because the loop consumes them differently: a
	 * steered message is injected into a running turn, so it is spent by the time that turn ends, while
	 * a follow-up is still waiting.
	 */
	private readonly steeredWrites: number[] = [];
	private readonly queuedWrites: number[] = [];
	/** Messages that started a run, whose echoes must not be written twice either. */
	private readonly promptWrites: number[] = [];
	/** Last stamp this session handed out, so two messages in one millisecond stay distinguishable. */
	private lastStamp = 0;
	/** Queue depth as last published, so `queue_update` fires on a change and not on every touch. */
	private lastQueued = 0;
	/** True between `retry_scheduled` and `retry_end`: the run is waiting out a backoff. */
	private retrying = false;
	/** The attempt the policy is on, 1-based, or 0 when no retry is pending. */
	private retryAttemptNumber = 0;
	private retryMaxAttempts = 0;
	/** The failure this retry was scheduled for, for a retry the package never announced an end for. */
	private retryError?: string;
	/**
	 * The provider call the loop is handed, with the retry policy around it.
	 *
	 * See {@link pumpAttempts} for why retries live here and not between turns.
	 */
	private readonly streamWithRetry: StreamFn = (model, context, options) => {
		const outer = createAssistantMessageEventStream();
		// Deliberately not awaited: the loop owns the stream's lifetime, and a failure that cannot be
		// retried comes back as an error event on it rather than as a rejection out of the stream
		// function (which the loop's contract forbids anyway).
		void this.pumpAttempts(outer, model, context, options);
		return outer;
	};
	/**
	 * The one completion compaction makes: the session's own model, with the summary instructions.
	 *
	 * It goes over the same model object a turn does, so the summary carries the same key, endpoint,
	 * and window as the conversation it summarizes rather than reaching for a second configuration —
	 * and it is that object because the loop's own `prepareRequest` keeps it fresh from the row, not
	 * because a key was fetched here.
	 */
	private readonly summarize: Summarize = async (request) => {
		// The same absence a turn meets: a session with no row answers with the sentence that says what
		// to add, rather than sending a summary request to a placeholder endpoint.
		if (rowFor(this.models, this.model) === undefined) return unconfiguredStream(this.model).result();
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() },
		];
		return this.api
			.streamSimple(this.model, normalizeContext({ systemPrompt: request.systemPrompt, messages }), {
				// The row's key, said here rather than only carried on the model: this is the one call
				// that does not travel through the loop, and the loop is what copies the key into options.
				apiKey: this.model.apiKey,
				maxTokens: request.maxTokens,
				// A one-off summary is never sent again, so paying to cache it would buy nothing.
				cacheRetention: "none",
				...(request.signal === undefined ? {} : { signal: request.signal }),
			})
			.result();
	};
	private model: Model<Api>;
	/** The transport every request goes over, defaulted in the constructor. */
	private readonly api: ChatTransport;

	constructor(config: AgentConfig) {
		this.workspace = config.workspace;
		this.sessionManager = config.sessionManager;
		this.models = config.models;
		this.settingsManager = config.settingsManager;
		this.tools = config.tools;
		this.promptBuilder = config.systemPrompt;
		this.approvalOverride = config.approvalOverride ?? {};
		this.hooks = config.hooks ?? createHooks();
		this.model = config.model;
		this.api = config.api ?? anthropicMessages;
		// What the branch already says, so the first request appends only what is missing. A session that
		// reopens on the same row and level has moved nowhere and writes nothing; one whose branch records
		// neither — a session that has never spoken — writes both, because what it is about to use is a
		// fact the file does not have yet.
		const recorded = config.sessionManager.getRecordedSettings();
		this.recordedModelId = recorded.model?.modelId;
		this.recordedThinkingLevel = recorded.thinkingLevel as ThinkingLevel | undefined;

		this.loop = new Loop({
			streamFn: this.streamWithRetry,
			initialState: {
				systemPrompt: this.buildSystemPrompt(),
				model: config.model,
				tools: this.tools.active(),
			},
			steeringMode: config.settingsManager.getSteeringMode(),
			followUpMode: config.settingsManager.getFollowUpMode(),
			beforeToolCall: async ({ toolCall, args }) => this.beforeTool(toolCall.id, toolCall.name, args),
			afterToolCall: async ({ toolCall, result, isError }) =>
				this.afterTool(toolCall.id, toolCall.name, result, isError),
		});

		this.loop.subscribe(async (event) => this.handleEvent(event));
		this.loop.prepareRequest = async ({ context }, signal) => {
			// The model is re-derived from the live row before anything else reads it, because the
			// compaction decision below is measured against its context window and a threshold taken from
			// the window the row had a moment ago would compact the wrong transcript. This is the whole of
			// "an edit takes effect without reopening anything": the endpoint, the wire id, the window, and
			// the key are all read here rather than captured when the session was assembled. A row that is
			// gone — deleted, or renamed under a session that was using it — leaves the model as it is, and
			// `unconfiguredStream` is what answers for that.
			this.adoptCurrentRow();
			// The choice this request is made with reaches the transcript here, at the moment a request
			// is built from it — so a model or a level the user moved and never sent with is not in the
			// file at all. It runs before the compaction decision below, which measures the prompt
			// against this model's window.
			this.recordSelection();
			// One pass decides both what the request carries and whether it has to be summarized: the
			// trigger, the prune of stale tool results, and the summary all read the same entries, so the
			// decision and the request cannot disagree about how large the prompt is.
			const entries = await this.maybeCompact(this.sessionManager.buildContextEntries(), Date.now(), signal);
			// The prompt is rebuilt here, not remembered: `applyConfig` can move the approval set and
			// `setActiveTools` the tool set, and the model must be told about both on the next request.
			const injected = { messages: messagesOf(entries), systemPrompt: this.buildSystemPrompt() };
			const rewritten = await this.hooks.apply("context", injected);
			const messages = this.forModel(rewritten?.messages ?? injected.messages);
			// The leading system message is replaced rather than appended to, and every other system
			// message is dropped: appending a second one concatenates two lists of available tools
			// instead of narrowing one (`getCurrentSystemMessage` in pi-ai).
			const system = createInitialSystemMessage(
				rewritten?.systemPrompt ?? injected.systemPrompt,
				this.tools.active().map((tool) => toToolDeclaration(tool)),
			);
			// A compaction checkpoint is a custom role the provider cannot read, so the transcript is
			// converted on the way out: the summary becomes the user turn it stands for.
			const conversation = convertToLlm(messages.filter((message) => message.role !== "system"));
			return {
				model: this.model,
				context: {
					...context,
					messages: system === undefined ? conversation : [system, ...conversation],
					// The live executable set, mirrored onto the request so the context names the tools this
					// request offers rather than what the transcript started with. Every tool change is resent
					// with the request, so the two cannot drift.
					tools: this.tools.active(),
				},
			};
		};
	}

	/**
	 * Point the session at the live row it names, if that row still exists.
	 *
	 * A row is the user's to edit, so this runs before every request: the key, the endpoint, the wire
	 * id, the window, and the level table are all read fresh, which is what `Model.apiKey` and
	 * `Model.thinkingLevelMap` riding on the model depend on. It moves the loop's state with it, so the
	 * level table, the context meter, and the reported ref are about the model the request is actually
	 * made with.
	 *
	 * The level the session is on is carried across rather than taken from the row: the row says what
	 * the model can be asked, and the session is the one that chose. Re-normalizing it here is what
	 * turns a row edited to stop reasoning into a session back at "off" instead of one still claiming a
	 * level the row no longer has.
	 *
	 * Nothing is recorded here: {@link recordSelection} does that once the model is final, because a row
	 * read mid-flight is not yet what the request went out with.
	 */
	private adoptCurrentRow(): void {
		const row = rowFor(this.models, this.model);
		if (row === undefined) return;

		this.model = modelFor(row, this.model.thinkingLevel);
		this.loop.state.model = this.model;
	}

	/**
	 * Write what this request is being made with into the transcript, once per move.
	 *
	 * The model and the level are recorded here rather than where the user chose them, because these
	 * entries are the transcript's account of what answered a turn: a row the user picked and never
	 * sent with answered nothing, and a level that was never asked at was never in force. Both guards
	 * key on what the branch already says, so a run of turns on one selection costs one entry.
	 *
	 * Only the wire id moves a `model_change`: a rename is the same model under another name, and the
	 * refs built from the old name are already accounted for as a rename.
	 */
	private recordSelection(): void {
		if (this.model.id !== this.recordedModelId) {
			const entryId = this.sessionManager.appendModelChange(this.model.name, this.model.id);
			this.recordedModelId = this.model.id;
			this.emit({ type: "entry_appended", entryId, kind: "model_change" });
		}
		const level = this.thinkingLevel as ThinkingLevel;
		if (level !== this.recordedThinkingLevel) {
			const entryId = this.sessionManager.appendThinkingLevelChange(level);
			this.recordedThinkingLevel = level;
			this.emit({ type: "entry_appended", entryId, kind: "thinking_level_change" });
		}
	}

	/**
	 * Put the session back on the model and level the branch now in force recorded.
	 *
	 * The same argument as {@link applyBranchToolConfig}: which model answered and how hard it was
	 * asked are facts about where the leaf is, so moving the leaf moves them, and a session that
	 * carried the choice from the branch it left would be one session with two answers. The precedence
	 * is assembly's — the branch's recorded level, else the row's own default — so a move and a reopen
	 * of the same file land in the same place.
	 *
	 * What the branch says also becomes the new baseline for {@link recordSelection}, which is what
	 * keeps a move from being recorded twice: an entry the branch already holds is not a move, and one
	 * it does not hold still is.
	 */
	private applyBranchSelection(): void {
		const recorded = this.sessionManager.getRecordedSettings();
		const row =
			recorded.model === undefined
				? rowFor(this.models, this.model)
				: resolveModelRef(this.models.list(), `${recorded.model.name}/${recorded.model.modelId}`);
		if (row !== undefined) {
			this.model = modelFor(row, recorded.thinkingLevel ?? row.defaultThinkingLevel);
			this.loop.state.model = this.model;
		}
		this.recordedModelId = recorded.model?.modelId;
		this.recordedThinkingLevel = recorded.thinkingLevel as ThinkingLevel | undefined;
	}

	/**
	 * Run one provider call through the retry policy, pumping it into the stream the loop reads.
	 *
	 * Retries live on `streamFn`, below the loop, because an error response is a hard exit: the loop
	 * emits `turn_end` and `agent_end` the moment a stream ends in `stopReason: "error"` and never
	 * calls `prepareNextTurn` after it, so there is no later turn in which a failed assistant message
	 * could be rewritten. Below the loop the failed attempt is never a message at all: the transcript
	 * gains exactly one assistant message, the store keeps none of the failures, and the next request
	 * has no leftover error to explain.
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
		outer: AssistantMessageEventStream,
		model: Model<Api>,
		context: TranscriptContext,
		options: SimpleStreamOptions | undefined,
	): Promise<void> {
		let started = false;
		const produce = async (): Promise<AssistantMessage> => {
			// A session with no row has nothing to send with, so it answers with the sentence that says
			// what to do instead of a request to a placeholder endpoint.
			const inner =
				rowFor(this.models, model) === undefined
					? unconfiguredStream(model)
					: await this.api.streamSimple(model, context, options);
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
				this.settingsManager.getRetrySettings(),
				options?.signal,
				this.retryCallbacks(),
			);
		} catch (error) {
			// A stream function that throws breaks the loop's contract, so it ends up as an error
			// message here rather than as a rejected promise nobody is left to catch.
			final = error instanceof ContextOverflow ? error.message : failureMessage(model, error);
		}
		// A retry the policy never announced an end for — the loop was cut short above — still has to
		// close, or `isRetrying` would outlive the run.
		if (this.retrying) this.endRetry(false, this.retryAttemptNumber, final.errorMessage);
		pushTerminal(outer, final);
		outer.end();
	}

	/** The three notifications `retryAssistantCall` makes, mapped one-to-one onto session events. */
	private retryCallbacks(): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this.retrying = true;
				this.retryAttemptNumber = attempt;
				this.retryMaxAttempts = maxAttempts;
				this.retryError = errorMessage;
				this.emit({ type: "retry_scheduled", attempt, maxAttempts, delayMs, errorMessage });
				this.publish();
			},
			onRetryAttemptStart: () => {
				this.emit({
					type: "retry_start",
					attempt: this.retryAttemptNumber,
					maxAttempts: this.retryMaxAttempts,
				});
				this.publish();
			},
			onRetryFinished: (success, attempt, finalError) => this.endRetry(success, attempt, finalError),
		};
	}

	/** Leave the retrying state and say how the loop ended. */
	private endRetry(success: boolean, attempt: number, finalError?: string): void {
		this.retrying = false;
		this.retryAttemptNumber = 0;
		this.retryMaxAttempts = 0;
		this.retryError = undefined;
		this.emit({ type: "retry_end", success, attempt, finalError });
		this.publish();
	}

	/** This session's id, which is the id of its file. */
	get id(): string {
		return this.sessionManager.getSessionId();
	}

	/** The JSONL file this session appends to, or undefined for a session that is never written. */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** `name/modelId`, the string a config patch and the picker both name. */
	get modelRef(): string {
		return `${this.model.name}/${this.model.id}`;
	}

	/** The level this session is asked at, read off the model it is on. */
	get thinkingLevel(): string {
		return this.model.thinkingLevel ?? "off";
	}

	/** The levels the current model can be asked at, in the order the picker shows them. */
	get thinkingLevels(): string[] {
		return thinkingLevelsFor(this.model);
	}

	/** Whether a run is in flight, including a run parked at an approval. */
	get isStreaming(): boolean {
		return this.loop.state.isStreaming;
	}

	/** Names of the tools the model may call right now, in registration order. */
	get activeTools(): string[] {
		return this.tools.activeNames();
	}

	/**
	 * The approval map in force: the workspace's settings with this session's own choices over them.
	 *
	 * The single read point for the gate, the snapshot, and the prompt — all three answer the same
	 * question, so none of them may reach past this to the settings manager alone.
	 */
	getApprovals(): Record<ToolApprovalKey, boolean> {
		return { ...this.settingsManager.getApprovals(), ...this.approvalOverride };
	}

	/**
	 * User messages accepted mid-run that the loop has not reached yet.
	 *
	 * Deliberately not `peekQueuedMessages().length`: that previews the messages selected for the next
	 * turn, so with `one-at-a-time` it reports 1 however many are waiting. What a composer needs is the
	 * depth, so a queued message stays counted until the loop emits it back. A steered message is not
	 * counted: it goes into the turn that is already running.
	 */
	get queued(): number {
		return this.queuedWrites.length;
	}

	/** True while a tool call is waiting for an approval nobody has answered yet. */
	get hasPendingApprovals(): boolean {
		return this.pendingApprovals.size > 0;
	}

	/** True while a transient provider failure is waiting out its backoff. */
	get isRetrying(): boolean {
		return this.retrying;
	}

	/** The 1-based retry attempt in flight, or 0 when no retry is pending. */
	get retryAttempt(): number {
		return this.retryAttemptNumber;
	}

	/**
	 * The state of this session, built by the one function that also serves a cold reader.
	 *
	 * The construction lives in `sessionSnapshot` rather than here so that a transcript this process
	 * is *not* running is answered by the same code from the same parts: the only fields the two
	 * callers can disagree on are the five they supply — `submitting`, `queued`, `isRetrying`,
	 * `retryAttempt`, `pendingApprovals` — and everything a transcript can answer is read identically.
	 */
	get snapshot(): SessionSnapshot {
		return sessionSnapshot({
			sessionManager: this.sessionManager,
			workspaceRoot: this.workspace.root,
			model: this.model,
			approvals: this.getApprovals(),
			allTools: this.tools.all().map((tool) => tool.name),
			activeTools: this.tools.activeNames(),
			submitting: this.loop.state.isStreaming,
			queued: this.queued,
			isRetrying: this.retrying,
			retryAttempt: this.retryAttemptNumber,
			pendingApprovals: [...this.pendingApprovals.values()].map((entry) => entry.approval),
		});
	}

	/** Usage summed over the transcript, with the window it is measured against. */
	get usage(): UsageTotals {
		const contextWindow = this.model.contextWindow;
		const totals = foldUsage(this.transcript(), contextWindow);
		return { ...totals, contextWindow };
	}

	/**
	 * What the provider is sent, before hooks and before the leading system message.
	 *
	 * Read from the session manager every time rather than cached, because that is the whole point of
	 * it being the single record: `appendCompaction` between two requests changes this, and so does
	 * anything a host appends.
	 */
	private transcript(): AgentMessage[] {
		return this.sessionManager.buildSessionContext().messages;
	}

	/** Subscribe to the session's state. The returned function unsubscribes. */
	onChange(listener: SessionListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Subscribe to the session's events. The returned function unsubscribes. */
	onEvent(listener: SessionEventListener): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	/**
	 * Append a user message and run the loop until the agent stops.
	 *
	 * `selection` is the composer's model and level, applied here and recorded by the request that
	 * follows. Both come with the message rather than as a command of their own, so a choice that was
	 * never sent with is nowhere.
	 *
	 * While a run is streaming the message is queued instead of rejected: `steer` is injected at the
	 * current turn's next drain point, `followUp` waits until the agent would otherwise stop. Either
	 * way the message is persisted here, so the transcript gains it before the loop echoes it — which
	 * is what {@link isOptimisticEcho} keeps from doubling.
	 */
	async prompt(text: string, options: { behavior?: PromptBehavior; selection?: ModelSelection } = {}): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;

		// The composer's choice arrives with the message, so this is the only place either half is
		// applied. A message that never reaches here — an empty one, a rejected send — moves nothing.
		if (options.selection !== undefined) this.chooseModel(options.selection);

		const message = this.userMessage(trimmed);
		if (this.loop.state.isStreaming) {
			const steer = (options.behavior ?? "followUp") === "steer";
			this.appendMessage(message);
			this.rememberWrite(message, steer ? "steer" : "followUp");
			if (steer) this.loop.steer(message);
			else this.loop.followUp(message);
			this.emitQueueUpdate();
			this.publish();
			return;
		}

		this.appendMessage(message);
		this.rememberWrite(message, "prompt");
		this.emitQueueUpdate();
		this.publish();
		await this.loop.prompt([message]);
		// `agent_end` is the last *event* of a run, but the run is not over until the loop has finished
		// with it — `loop.state.isStreaming` stays true through every awaited listener for that event and
		// is cleared only in the loop's own `finally`. So this is the first moment `submitting` is false,
		// and without publishing here nothing ever reports it: a subscriber to {@link onChange} would
		// keep reading `true` for a run that had ended, which is exactly what a stream needs to know.
		this.publish();
	}

	/**
	 * Stop the current run and wait for it to settle.
	 *
	 * Settling means the loop finished persisting the turn it was in the middle of, including tool
	 * results. Note that persistence happens in {@link handleEvent}, the session's own subscription
	 * to the agent loop, so it runs whether or not a transport is listening. The reason to wait is
	 * different: a caller that is about to hand this session's socket to a new session must not do so
	 * while frames for the old one are still being produced.
	 *
	 * A retry that is only waiting out its backoff is cancelled by the same call: the abort signal is
	 * the one `retryAssistantCall` sleeps on, so it returns an aborted message instead of sleeping to
	 * the end. Nothing here has to know whether the run is live or in a backoff.
	 */
	async abort(): Promise<void> {
		this.loop.abort();
		this.denyAllApprovals("The run was aborted.");
		await this.loop.waitForIdle();
		// The same end a finished run publishes, and for the same reason: an abort is how a run that
		// nobody asked to stop otherwise reports that it has. See {@link prompt}.
		this.publish();
	}

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
	branchTo(entryId: string, descend = true): string {
		if (this.loop.state.isStreaming) throw new Error("A run is in flight: the branch cannot move under it");

		const leafId = descend ? this.sessionManager.getBranchTip(entryId) : entryId;
		const previousRef = this.modelRef;
		const previousLevel = this.thinkingLevel;
		this.sessionManager.branch(leafId);
		this.declareConversation();
		this.applyBranchSelection();
		this.applyBranchToolConfig();
		// Reported because neither field is in the branch payload, and every stream other than the one
		// that asked is holding a snapshot taken before the move.
		this.emitConfigChanged({
			...(this.modelRef === previousRef ? {} : { model: this.modelRef }),
			...(this.thinkingLevel === previousLevel ? {} : { thinkingLevel: this.thinkingLevel }),
		});
		this.emit({ type: "branch_changed", leafId });
		this.publish();
		return leafId;
	}

	/**
	 * Put the session back on the choices the branch now in force recorded.
	 *
	 * Moving the leaf is the one moment a session's own config can be wrong: the choices belong to the
	 * branch, so which tools are active and which ask for approval are facts about where the leaf is,
	 * exactly as the conversation is. Without this, a session that chose on the branch it is leaving
	 * would carry that choice onto a branch that never had it, while a reopen of the same file restored
	 * the target branch's — the same session, two answers.
	 *
	 * A branch that recorded nothing leaves the registry alone — the settings files say nothing about
	 * which tools are active, so there is no default set to restore — and puts the approval map back on
	 * the settings, which is what a session that never chose runs on. Only a recorded `tool_config` can
	 * move the active set, and every move ends on the branch's answer rather than the previous one's.
	 */
	private applyBranchToolConfig(): void {
		const recorded = applyRecordedToolConfig(this.sessionManager, this.tools);
		this.approvalOverride = recorded.approval ?? {};
		this.declareTools();
		// Reported because neither map is in the branch payload, and every stream other than the one
		// that asked is holding a snapshot taken before the move. Both maps travel whole: this is the
		// branch's state, not a delta, and a client applies either shape.
		this.emitConfigChanged({ approvals: this.getApprovals(), tools: this.tools.activeNames() });
	}

	/**
	 * Point the loop's own message list at the store's current branch.
	 *
	 * Every request is built from the store, so this changes nothing about what a provider is sent — it
	 * is the same reason `declareTools` rewrites the loop's system message: the loop should not be left
	 * holding a tail the store no longer has, or the next turn it assembles would disagree with the one
	 * this session would send.
	 */
	private declareConversation(): void {
		const system = this.loop.state.messages.find((message) => message.role === "system");
		const messages = this.sessionManager.getBranch().flatMap((entry) => sessionEntryToContextMessages(entry));
		this.loop.state.messages = system === undefined ? messages : [system, ...messages];
	}

	/**
	 * Narrow the tools the model may call. An unknown name throws and leaves the session as it was.
	 *
	 * Two things have to move together. `loop.state.tools` is what the loop executes and rejects a
	 * scripted call against; the transcript's leading system message is the prompt and the tool
	 * declarations the model is sent. That message is replaced rather than appended to, because
	 * appending a second one concatenates two lists of available tools instead of narrowing one
	 * (`getCurrentSystemMessage` in pi-ai). The change takes effect on the next request.
	 */
	setActiveTools(names: string[]): void {
		const previous = this.tools.activeNames();
		this.tools.setActive(names);
		const active = this.tools.activeNames();
		if (active.length === previous.length && active.every((name, index) => name === previous[index])) return;

		this.sessionManager.appendToolConfig(active, this.getApprovals());
		this.declareTools();
		this.publish();
		this.emitConfigChanged({ tools: active });
	}

	/** Point the loop and the leading system message at the registry's current active set. */
	private declareTools(): void {
		const active = this.tools.active();
		this.loop.state.tools = active;

		const prompt = this.buildSystemPrompt();
		const system = createInitialSystemMessage(prompt, active.map((tool) => toToolDeclaration(tool)));
		const rest = this.loop.state.messages.filter((message) => message.role !== "system");
		this.loop.state.messages = system === undefined ? rest : [system, ...rest];
	}

	/** The fresh prompt: the caller's builder over the registry's current names and the live approvals. */
	private buildSystemPrompt(): string {
		// The approval map is the session's effective one, so the prompt promises exactly what the gate
		// will ask for rather than what the workspace defaults say.
		return this.promptBuilder(this.tools.activeNames(), this.getApprovals());
	}

	/**
	 * Point this session at another row, another level, or both.
	 *
	 * There is no entry here and no settings write: a choice is not something that happened until a
	 * request is made with it, so it lives on the model the session is on and reaches the transcript in
	 * {@link recordSelection}, at the moment the request it belongs to is built. What a caller gets
	 * back immediately is the change itself — the snapshot, the level table, and the next request are
	 * all about the new model, whether or not that request is ever sent.
	 *
	 * A level the chosen model has no room for is refused rather than clamped, because the caller is a
	 * composer that offered the levels of the model it is moving to; "off" is the exception and is
	 * always accepted, since it means "as quiet as this model gets".
	 */
	chooseModel(selection: ModelSelection): void {
		const previousRef = this.modelRef;
		const previousLevel = this.thinkingLevel;
		// Nothing named is nothing to do, which is how a caller sends an ordinary message.
		if (selection.model === undefined && selection.thinkingLevel === undefined) return;

		const ref = selection.model ?? previousRef;
		const row = resolveModelRef(this.models.list(), ref);
		if (row === undefined) throw new Error(`Unknown model: ${ref}`);

		// A row named without a level lands on that row's own default, which is the answer an assembled
		// session opens on; a level named on the current row is the caller's. Either way the pair is
		// built once, so a level the model has no room for is refused rather than half-applied.
		const requested =
			selection.thinkingLevel ??
			(selection.model === undefined ? this.model.thinkingLevel : row.defaultThinkingLevel);
		const candidate = modelFor(row, requested);
		const level = candidate.thinkingLevel ?? "off";
		if (selection.thinkingLevel !== undefined && level !== selection.thinkingLevel && selection.thinkingLevel !== "off") {
			throw new Error(`${candidate.id} does not support thinking level "${selection.thinkingLevel}"`);
		}

		this.model = candidate;
		this.loop.state.model = this.model;
		this.publish();
		this.emitConfigChanged({
			...(this.modelRef === previousRef ? {} : { model: this.modelRef }),
			...(this.thinkingLevel === previousLevel ? {} : { thinkingLevel: this.thinkingLevel }),
		});
	}

	/**
	 * Update settings and persist them. Approval changes take effect on the next tool call.
	 *
	 * The two halves of a patch live in different places. Approval is session-scoped: it merges into
	 * this session's own choices and is recorded as one `tool_config` entry, so another session over
	 * this workspace is untouched. The queue modes go to the settings manager, which owns both the
	 * merged value and the file it goes in.
	 *
	 * The model and the thinking level are not part of a patch at all. They are chosen in the composer
	 * and arrive with the message they belong to ({@link ModelSelection}), so there is nothing here to
	 * apply: a config change that no request followed is not a config change.
	 */
	applyConfig(patch: ConfigPatch): void {
		const previousApprovals = this.getApprovals();
		if (patch.approval !== undefined) {
			this.approvalOverride = { ...this.approvalOverride, ...patch.approval };
			this.sessionManager.appendToolConfig(this.tools.activeNames(), this.getApprovals());
		}
		this.settingsManager.applySettings(patch.approval === undefined ? patch : { ...patch, approval: undefined });
		this.loop.steeringMode = this.settingsManager.getSteeringMode();
		this.loop.followUpMode = this.settingsManager.getFollowUpMode();
		this.publish();
		this.emitConfigChanged({
			approvals: changedApprovals(previousApprovals, this.getApprovals()),
		});
	}

	/** Answer one waiting approval. An id nothing is waiting on is ignored. */
	approve(toolCallId: string, approved: boolean): void {
		const entry = this.pendingApprovals.get(toolCallId);
		if (!entry) return;
		this.pendingApprovals.delete(toolCallId);
		entry.resolve(approved);
		this.publish();
	}

	/** Deny every waiting approval, for example when the socket that owns them disconnects. */
	denyAllApprovals(reason: string): void {
		if (this.pendingApprovals.size === 0) return;
		for (const [toolCallId, entry] of [...this.pendingApprovals]) {
			this.pendingApprovals.delete(toolCallId);
			entry.resolve(false);
		}
		void reason;
		this.publish();
	}

	/**
	 * Wait for the current run to finish and for its writes to reach the file system, without stopping
	 * anything. A run that is already idle returns immediately.
	 *
	 * A queued message is part of the run that accepted it, so the loop is drained to the end: the queue
	 * can still be non-empty when one turn settles, which is exactly the case a caller waiting for "the
	 * transcript is complete" must not resolve on. {@link close} is this plus dropping unanswered
	 * approvals, which is what makes it terminate.
	 *
	 * A pending retry is part of the run too, so it is waited for rather than resolved past: the
	 * retry runs inside the stream the loop is awaiting, which keeps the agent non-idle for the whole
	 * backoff, and the condition is here so that stays true if that ever changes.
	 */
	async settle(): Promise<void> {
		do {
			await this.loop.waitForIdle();
		} while (this.queued > 0 || this.retrying);
	}

	/**
	 * Deny waiting approvals and wait for the session to go quiet, so exiting mid-run cannot truncate
	 * the transcript. `abort()` covers a live run; this also covers a run that is only blocked on an
	 * approval prompt.
	 */
	async close(): Promise<void> {
		this.denyAllApprovals("Session closed.");
		await this.settle();
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
	 * Both steps before the summary are *recorded*, not held in memory: `appendArgTrim` and `appendPrune`
	 * name the entries, and the store's own view applies them from then on. So a resumed process, the
	 * next request in the run, and the window all read one transcript instead of each re-deciding.
	 *
	 * A summary that cannot be produced leaves the transcript exactly as it was and is reported rather
	 * than thrown: compaction is an optimization, and failing the turn over it would replace a clear
	 * context-overflow error with a mysterious crash inside the request path.
	 *
	 * Returns the entries to send: the ones it was given when no step changed anything, the store's view
	 * after whichever step was enough, and that view again once a checkpoint was written. The counts are
	 * reported by the `arg_trimmed`, `pruned`, and `compaction` events, not by this answer.
	 */
	async maybeCompact(
		entries: readonly SessionEntry[],
		now: number,
		signal?: AbortSignal,
	): Promise<readonly SessionEntry[]> {
		const threshold = compactionThresholdFor(this.model.contextWindow);
		if (!shouldCompact(messagesOf(entries), threshold)) return entries;

		const trimmed = this.trimRecordedArgs(entries);
		if (!shouldCompact(messagesOf(trimmed), threshold)) return trimmed;

		const pruned = this.pruneStaleResults(trimmed, now);
		if (!shouldCompact(messagesOf(pruned), threshold)) return pruned;

		let outcome;
		try {
			outcome = await compactTranscript(pruned, this.model, this.summarize, signal);
		} catch (error) {
			// An abort is not a compaction failure: the run is ending, and the transcript simply keeps the
			// history it already had. Anything else is worth saying out loud, because the next request may
			// then be the one that overflows.
			if (signal?.aborted !== true) {
				this.emit({
					type: "compaction_failed",
					message: error instanceof Error ? error.message : String(error),
				});
			}
			return pruned;
		}
		if (!outcome) return pruned;

		this.sessionManager.appendCompaction(
			outcome.summary,
			outcome.firstKeptEntryId,
			outcome.tokensBefore,
			undefined,
			outcome.usage,
		);
		// Published after the transcript moved, so a listener that reacts reads back the same numbers:
		// `summarized` is what this pass folded in, `contextTokens` is what the provider will now be sent.
		const compacted = this.sessionManager.buildContextEntries();
		this.emit({
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
	 * workspace does not hold. It is also the reason this runs before the prune rather than beside it:
	 * the prune needs an expired cache to be worth its cache invalidation, and this does not, because
	 * when the transcript is over the trigger the next request is in trouble whatever the cache says.
	 */
	private trimRecordedArgs(entries: readonly SessionEntry[]): readonly SessionEntry[] {
		const trimmed = trimmableToolArgEntryIds(entries);
		if (trimmed.length === 0) return entries;

		const tokensBefore = estimateTokens(messagesOf(entries));
		this.sessionManager.appendArgTrim(trimmed, tokensBefore);
		const view = this.sessionManager.buildContextEntries();
		this.emit({
			type: "arg_trimmed",
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
	private pruneStaleResults(entries: readonly SessionEntry[], now: number): readonly SessionEntry[] {
		if (!isCacheProbablyExpired(entries, now)) return entries;

		const cleared = clearableToolResultIds(entries);
		if (cleared.length === 0) return entries;

		const tokensBefore = estimateTokens(messagesOf(entries));
		this.sessionManager.appendPrune(cleared, tokensBefore);
		const pruned = this.sessionManager.buildContextEntries();
		this.emit({
			type: "pruned",
			cleared: cleared.length,
			tokensBefore,
			contextTokens: estimateTokens(messagesOf(pruned)),
		});
		return pruned;
	}

	/** The message a user's text becomes: one text block, stamped by this session. */
	private userMessage(text: string): AgentMessage {
		return { role: "user", content: [{ type: "text", text }], timestamp: this.nextStamp() };
	}

	/**
	 * A stamp no other message from this session shares.
	 *
	 * `Date.now()` is not enough: two messages queued in the same millisecond would be
	 * indistinguishable, and the echo of one would then be mistaken for the other.
	 */
	private nextStamp(): number {
		this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
		return this.lastStamp;
	}

	/**
	 * Ask the UI before running a tool that settings mark as requiring approval.
	 *
	 * Answers with the reason to block the call, or `undefined` when it may run. Public because the
	 * default `before_tool` hook is installed outside the class: the session owns the pending-approval
	 * bookkeeping and the UI-facing `approve`/`denyAllApprovals`, while the hook only decides when to
	 * ask. A caller that answers nobody leaves the run waiting, which is what `close()` is for.
	 */
	async authorize(name: string, toolCallId: string, args: unknown): Promise<string | undefined> {
		const key = name as ToolApprovalKey;
		if (!this.getApprovals()[key]) return undefined;

		const approved = await new Promise<boolean>((resolve) => {
			this.pendingApprovals.set(toolCallId, {
				approval: { toolCallId, toolName: name, args, summary: describeToolCall(name, args) },
				resolve,
			});
			this.publish();
		});

		return approved ? undefined : `The user denied permission to run ${name}.`;
	}

	/**
	 * Run the `before_tool` hooks.
	 *
	 * The loop's seam can only block a call or let it through, so a block is the only decision that
	 * reaches it: an `args` refinement goes as far as the handlers registered after this one.
	 */
	private async beforeTool(
		toolCallId: string,
		toolName: string,
		args: unknown,
	): Promise<BeforeToolCallResult | undefined> {
		const decided = await this.hooks.apply("before_tool", { toolCallId, toolName, args });
		if (decided?.block === undefined) return undefined;
		return { block: true, reason: decided.block.reason };
	}

	/**
	 * Run the `after_tool` hooks and keep both halves of their answer.
	 *
	 * The loop builds the transcript message from what this returns, so the hooks' content goes back to
	 * it: that is what the model is shown for this turn. {@link transcriptMessage} then records the
	 * tool's own output instead, because a bound — or any rewrite — is about what the model sees, and
	 * the file must still hold what the tool produced.
	 */
	private async afterTool(
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
		this.toolResultViews.set(toolCallId, { stored: result.content, shown: decided.content });
		return { content: decided.content };
	}

	/**
	 * The message the store records for a tool result.
	 *
	 * The loop hands back the content the hooks produced; the store keeps what the tool actually
	 * returned, so bounding the model's context can never lose the tool's output.
	 */
	private transcriptMessage(message: AgentMessage): AgentMessage {
		if (message.role !== "toolResult") return message;
		const view = this.toolResultViews.get(message.toolCallId);
		return view === undefined ? message : { ...message, content: view.stored };
	}

	/**
	 * The messages the provider is sent.
	 *
	 * A tool result a hook rewrote is served back as the hook left it, so the model sees the bounded
	 * version of a result the transcript holds in full. A result too large for the context is served
	 * head and tail with the full text archived in the workspace (`context/spill.ts`) — the backstop for
	 * a tool that does not bound or paginate its own output, and the one that survives a restart,
	 * because the archive path is derived from the session and the call id. Anything else oversized is
	 * clipped here: a result stored by an earlier process has no view to replay, and the budget is what
	 * keeps it out of the context.
	 */
	private forModel(messages: readonly AgentMessage[]): AgentMessage[] {
		return messages.map((message) => {
			if (message.role !== "toolResult") return message;
			const view = this.toolResultViews.get(message.toolCallId);
			if (view !== undefined) return { ...message, content: view.shown };
			const spilled = spillOversizedToolResult(
				this.workspace,
				this.id,
				message.toolName,
				message.toolCallId,
				message.content,
			);
			if (spilled !== undefined) return { ...message, content: spilled };
			const content = boundToolContent(message.content);
			return content === undefined ? message : { ...message, content };
		});
	}

	/** Persist what the loop reports, and pass it on. */
	private async handleEvent(event: AgentEvent): Promise<void> {
		if (event.type === "message_end") {
			// `prompt()` already appended the user message optimistically, so the loop's own emit of
			// that same message must not be recorded twice.
			const duplicate = this.isOptimisticEcho(event.message);
			if (!duplicate) this.appendMessage(this.transcriptMessage(event.message));
		}
		if (event.type === "agent_end") {
			// A steered message belongs to the run it was injected into, so it is spent by the time the
			// run ends whether or not its echo was seen; leaving it outstanding would overstate the
			// queue forever. Clearing at the turn boundary would be too early: the drain point that
			// injected it can echo after the turn that accepted it.
			this.steeredWrites.length = 0;
		}
		this.emit(event);
		// The echo of a drained message is what lowers the depth, so this is where the count goes live.
		this.emitQueueUpdate();
		if (event.type === "message_start" || event.type === "message_end" || event.type === "turn_end") {
			this.publish();
		}
	}

	/** Fan one event out. The only place a session publishes an event. */
	private emit(event: AgentSessionEvent): void {
		for (const listener of this.eventListeners) listener(event);
	}

	/**
	 * Report the queue depth whenever it moved.
	 *
	 * Called from wherever the depth can change — accepting a message, and the loop echoing a drained
	 * one — so a composer can show the number without polling `snapshot`.
	 */
	private emitQueueUpdate(): void {
		const queued = this.queued;
		if (queued === this.lastQueued) return;
		this.lastQueued = queued;
		this.emit({ type: "queue_update", queued });
	}

	/** Report a config change with only the fields that moved; silence when none did. */
	private emitConfigChanged(changes: {
		model?: string;
		thinkingLevel?: string;
		approvals?: Record<string, boolean>;
		tools?: string[];
	}): void {
		if (
			changes.model === undefined &&
			changes.thinkingLevel === undefined &&
			changes.approvals === undefined &&
			changes.tools === undefined
		) {
			return;
		}
		this.emit({ type: "config_changed", ...changes });
	}

	/**
	 * Append a message entry and announce it.
	 *
	 * Both writers of message entries go through here — `prompt` for the optimistic user write and
	 * {@link handleEvent} for everything the loop hands back — so a listener that follows
	 * `entry_appended` sees the whole transcript, not just the loop's half of it.
	 */
	private appendMessage(message: AgentMessage): void {
		// A message appended where something already followed is a *second* alternative at that message
		// rather than a continuation of its tip — which is what rewinding and asking again is. The tree
		// gained a branch point there, so the windows are told where the leaf is, exactly as a move does:
		// their branch points came from a snapshot and this append changed them.
		const parent = this.sessionManager.getLeafId();
		const continued = parent !== null && this.sessionManager.getChildren(parent).length > 0;

		const entryId = this.sessionManager.appendMessage(message);
		if (continued) this.emit({ type: "branch_changed", leafId: entryId });
		this.emit({ type: "entry_appended", entryId, kind: "message" });
	}

	/** Record that this session, not the loop, wrote a user message. */
	private rememberWrite(message: AgentMessage, kind: "prompt" | "steer" | "followUp"): void {
		if (message.role !== "user" || message.timestamp === undefined) return;
		if (kind === "steer") this.steeredWrites.push(message.timestamp);
		else if (kind === "followUp") this.queuedWrites.push(message.timestamp);
		else this.promptWrites.push(message.timestamp);
	}

	/**
	 * True when the loop is echoing a user message this session already persisted.
	 *
	 * The loop hands back the message it was given, so the stamp identifies the echo, and stamps are
	 * unique per message because this session issues them. A match consumes the outstanding write: the
	 * message is in the store once, whether the loop echoes it or not.
	 */
	private isOptimisticEcho(message: AgentMessage): boolean {
		if (message.role !== "user" || message.timestamp === undefined) return false;
		return (
			this.consume(this.steeredWrites, message.timestamp) ||
			this.consume(this.queuedWrites, message.timestamp) ||
			this.consume(this.promptWrites, message.timestamp)
		);
	}

	/** Take one outstanding write off its list, and say whether there was one. */
	private consume(writes: number[], timestamp: number): boolean {
		const index = writes.indexOf(timestamp);
		if (index === -1) return false;
		writes.splice(index, 1);
		return true;
	}

	/** Tell every listener what the session looks like now. */
	private publish(): void {
		const snapshot = this.snapshot;
		for (const listener of this.listeners) listener(snapshot);
	}
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
function failureMessage(model: Model<Api>, error: unknown): AssistantMessage {
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
 * The messages one selection of entries stands for — the same projection the store hands a request.
 *
 * It is the only way the trigger measures a prompt, so `maybeCompact` can compare the transcript as
 * stored with the transcript after a prune without building the request twice.
 */
function messagesOf(entries: readonly SessionEntry[]): AgentMessage[] {
	return entries.flatMap((entry) => sessionEntryToContextMessages(entry));
}

/** Last assistant text in the transcript. */
export function lastAssistantText(messages: readonly AgentMessage[]): string | undefined {
	for (const message of messages.toReversed()) {
		if (message.role !== "assistant") continue;
		const text = contentText((message as { content: Parameters<typeof contentText>[0] }).content).trim();
		if (text.length > 0) return text;
	}
	return undefined;
}
