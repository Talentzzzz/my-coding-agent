import {
	Loop,
	type AfterToolCallResult,
	type AgentEvent,
	type AgentTool,
	type AgentToolResult,
	type BeforeToolCallResult,
} from "@my-agent/loop";
import { PendingMessageQueue } from "./session/queues.ts";
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
import { type Settings } from "./config.ts";
import {
	compact as compactTranscript,
	compactionThresholdFor,
	estimateTokens,
	shouldCompact,
	type Summarize,
} from "./context/compaction.ts";
import { trimmableToolArgEntryIds } from "./context/trim-tool-call-args.ts";
import { clearableToolResultIds, isCacheProbablyExpired } from "./context/clear-tool-results.ts";
import { spillOversizedToolResult } from "./context/spill.ts";
import { boundToolContent, createHooks, type Hooks, type ToolResultContent } from "./hooks.ts";
import {
	applyRowToModel,
	createModel,
	type Model,
	type ModelSource,
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
import { type SessionEntry, SessionManager, sessionEntryToContextMessages } from "./session/session-manager.ts";
import {
	applyRecordedToolConfig,
	defaultToolNames,
	followsGlobalOf,
} from "./session/tool-config.ts";
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
	 * reach the next message — {@link Agent.adoptCurrentRow} re-derives the session's model from the row
	 * it finds here, so the key, the endpoint, the window, and the wire id are all as fresh as the row is.
	 */
	models: ModelSource;
	/**
	 * The transport every model this session builds carries.
	 *
	 * A model is what a request is made with and the transport is how it is sent, so the session hands
	 * one to each model it constructs — the one it was assembled with, and every one it re-derives from
	 * a row afterwards. Defaults to Anthropic Messages, which is the only one this app speaks. It is
	 * injectable because the smokes drive the real loop against a scripted answer, and a seam that could
	 * not be handed a different transport would mean testing the session through a network.
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
	 * one row and asked at a level that belongs to another. The session mutates this object rather than
	 * replacing it — see {@link Agent.adoptCurrentRow} — which is why the session never has to hand the
	 * loop a new one.
	 */
	model: Model;
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

/** One unanswered approval: what the banner shows, and the promise the tool call is parked on. */
interface PendingApprovalEntry {
	approval: PendingApproval;
	resolve(answer: ApprovalAnswer): void;
}

/**
 * How one approval was answered, and — when it was denied by something other than a person pressing
 * "deny" — the sentence the tool result should carry.
 *
 * The reason is what keeps an abandonment from being recorded as a user's choice: a grace timer that
 * denies an approval nobody answered used to leave the same "The user denied permission" line in the
 * transcript as a press of the button, which was a lie about who answered. `approve()` carries no
 * reason — a person really did answer — so a denial there falls back to that sentence, where it is
 * true. An abort's denial never reaches the transcript through here at all: the loop normalizes an
 * aborted call's result itself, before the block branch is ever taken.
 */
interface ApprovalAnswer {
	approved: boolean;
	/** Why the call was denied, when the denial came from somewhere other than the approve endpoint. */
	reason?: string;
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
 * One message accepted during a run, and the queue it is waiting on.
 *
 * The queue is the behaviour the composer asked for: a steered message is injected into the running
 * turn, so it is spent by the time that turn ends, while a follow-up is still waiting — and only
 * follow-ups are the depth a composer shows.
 */
interface AcceptedMessage {
	message: Message;
	queue: PromptBehavior;
}

/**
 * One conversation: the pi-agent-core `Loop`, the workspace, the JSONL store, and the approval gate.
 *
 * The store is the source of truth for the conversation. Before every provider request,
 * {@link prepareRequestOnLoop} asks the `context` hook for the transcript the model should see — by
 * default the store's current view, which is where compaction shows up — and puts a fresh leading
 * system message in front of it, because the prompt and the tool declarations reach the model as a
 * system message and the loop holds no prompt of its own. That is what keeps a resumed session and
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
	 * Messages accepted mid-run, oldest first, each with the queue it is waiting on.
	 *
	 * Nothing is written to the store here. A message accepted mid-run is persisted when the loop
	 * drains it, so the file's order is the order the loop takes them in — which is the order the model
	 * is shown them in, and the order a reconnect's baseline replays. Persisting at acceptance instead
	 * puts the file's copy of the message in front of the answer it interrupted, and a view rebuilt
	 * from the file then draws a bubble between a question and its own reply.
	 *
	 * One list rather than one per queue, because two things read it whole: the depth counts the
	 * follow-ups among them, and a run that ends without draining them appends them as they stand —
	 * which is acceptance order, the only order left for a message nobody answered.
	 */
	private readonly accepted: AcceptedMessage[] = [];
	/** Messages that started a run, whose echoes must not be written twice either. */
	private readonly promptWrites: number[] = [];
	/**
	 * The queues a run drains at its take points.
	 *
	 * Steered messages are pulled at the end of each turn; follow-ups when the loop would otherwise
	 * stop. The queues live here rather than in the loop because they belong to the session that
	 * accepts messages — the loop only pulls through the config hooks handed to {@link prompt}.
	 */
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;
	/** Last stamp this session handed out, so two messages in one millisecond stay distinguishable. */
	private lastStamp = 0;
	/** Queue depth as last published, so `queue_update` fires on a change and not on every touch. */
	private lastQueued = 0;
	/**
	 * The assistant message being written right now, as the loop last reported it.
	 *
	 * The loop's `message_update` carries the whole partial message and this session republishes only
	 * its delta — but a window that attaches mid-run has missed every delta so far, so a baseline has
	 * to carry the running text once. Cleared when the message ends, which is also when the store
	 * gains it and a snapshot starts reading it from the transcript instead.
	 */
	private partial: Message | undefined;
	/** True between `retry_scheduled` and `retry_end`: the run is waiting out a backoff. */
	private retrying = false;
	/**
	 * True while {@link prompt} is inside the run it started.
	 *
	 * The session owns this flag because it owns the run: the loop is a stateless
	 * engine, and the promise its `runLoop` returns already covers the whole
	 * lifetime the loop used to report — through the `agent_end` listeners and
	 * the engine's own `finally`.
	 */
	private running = false;
	/** The attempt the policy is on, 1-based, or 0 when no retry is pending. */
	private retryAttemptNumber = 0;
	private retryMaxAttempts = 0;
	/** The failure this retry was scheduled for, for a retry the package never announced an end for. */
	private retryError?: string;
	/**
	 * Where a request actually leaves: the injected transport.
	 *
	 * A model's `stream()` goes through {@link Agent.transport}, which is this one wrapped in the retry
	 * policy — so this is the seam the policy wraps, and the only place a provider is reached.
	 */
	private readonly base: ChatTransport;
	/**
	 * The transport every model this session builds carries, with the retry policy around it.
	 *
	 * The loop is handed a stream function, not a transport: it asks the model it holds for a stream,
	 * and the model answers through whatever transport it carries. So the policy is installed on the
	 * model rather than on the loop, and every request — the loop's, and compaction's — goes through
	 * {@link pumpAttempts} without either of them knowing retries exist.
	 *
	 * See {@link pumpAttempts} for why retries live below the loop rather than between turns.
	 */
	private readonly transport: ChatTransport;
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
		if (this.models.list().find((userModel) => userModel.name === this.model.name) === undefined) return unconfiguredStream(this.model).result();
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() },
		];
		return this.model
			.stream({ messages, system: createSystemMessage(request.systemPrompt) }, {
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
	/** The one object a request is made with, mutated in place as the row behind it changes. */
	private model: Model;

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
		this.base = config.api ?? anthropicMessages;
		// The session's send policy is installed on the model it was handed. The loop is never told
		// about it: it asks for a stream from whatever model it holds, and the model answers through
		// this — so retries, and the "no row behind this model" answer, happen below everything that
		// could report them.
		this.transport = {
			stream: (model, context, options) => {
				const outer = createAssistantMessageEventStream();
				// Deliberately not awaited: the loop owns the stream's lifetime, and a failure that
				// cannot be retried comes back as an error event on it rather than as a rejection out
				// of the stream function (which the loop's contract forbids anyway).
				//
				// The loop hands back the object this session built — `runLoop` is seeded with
				// `this.model` and `prepareRequest` returns it every turn — so the assertion only
				// restores the type `ChatTransport` widens to in order to stay usable by any model.
				void this.pumpAttempts(outer, model as Model, context, options);
				return outer;
			},
		};
		this.model.transport = this.transport;
		// What the branch already says, so the first request appends only what is missing. A session that
		// reopens on the same row and level has moved nowhere and writes nothing; one whose branch records
		// neither — a session that has never spoken — writes both, because what it is about to use is a
		// fact the file does not have yet.
		const recorded = config.sessionManager.getRecordedSettings();
		this.recordedModelId = recorded.model?.modelId;
		this.recordedThinkingLevel = recorded.thinkingLevel as ThinkingLevel | undefined;

		this.loop = new Loop({
			// The one thing the engine needs to know about a model: how it answers. A function rather
			// than the model itself keeps the ownership where it belongs — this session owns the model
			// and may replace it at any time, while the loop only ever asks the model it was handed.
			streamFn: (model, context, options) => model.stream(context, options),
			beforeToolCall: async ({ toolCall, args }) => this.beforeTool(toolCall.id, toolCall.name, args),
			afterToolCall: async ({ toolCall, result, isError }) =>
				this.afterTool(toolCall.id, toolCall.name, result, isError),
		});
		this.steeringQueue = new PendingMessageQueue(config.settingsManager.getSteeringMode());
		this.followUpQueue = new PendingMessageQueue(config.settingsManager.getFollowUpMode());

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
			// trigger, the clearing of stale tool results, and the summary all read the same entries, so the
			// decision and the request cannot disagree about how large the prompt is.
			const entries = await this.maybeCompact(this.sessionManager.buildContextEntries(), Date.now(), signal);
			// The prompt is rebuilt here, not remembered: `applyConfig` can move the approval set and
			// `setActiveTools` the tool set, and the model must be told about both on the next request.
			const injected = { messages: messagesOf(entries), systemPrompt: this.buildSystemPrompt() };
			const rewritten = await this.hooks.apply("context", injected);
			const messages = this.forModel(rewritten?.messages ?? injected.messages);
			// The leading system message is replaced rather than appended to, and every other system
			// message is dropped: the prompt is rebuilt whole on this request, so a second one would
			// describe a state that is already gone. A hook that wants to change the prompt returns
			// `systemPrompt`; one that pushes a system message into `messages` loses it here.
			const system = createSystemMessage(rewritten?.systemPrompt ?? injected.systemPrompt);
			// A compaction checkpoint is already the user turn it stands for — `sessionEntryToContextMessages`
			// wraps the summary in tags — so the transcript goes to the provider as it is.
			const conversation = messages.filter((message) => message.role !== "system");
			return {
				model: this.model,
				context: {
					...context,
					messages: system === undefined ? conversation : [system, ...conversation],
					// The live executable set. The loop declares it on the request (`toToolDeclaration`)
					// rather than reading it out of the transcript, so a tool switched on mid-session
					// reaches the model on the next request and the two cannot drift.
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
		const userModel = this.models.list().find((userModel) => userModel.name === this.model.name);
		if (userModel === undefined) return;

		// Re-derived in place rather than rebuilt: the object is the one the loop has, so the fields the
		// next request reads are the row's current ones without a new object having to be threaded
		// through a run that is already going.
		applyRowToModel(this.model, userModel, this.model.thinkingLevel);
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
		const userModel = this.models.list().find((userModel) => userModel.name === (recorded.model?.name ?? this.model.name));
		if (userModel !== undefined) {
			applyRowToModel(this.model, userModel, recorded.thinkingLevel ?? userModel.defaultThinkingLevel);
		}
		this.recordedModelId = recorded.model?.modelId;
		this.recordedThinkingLevel = recorded.thinkingLevel as ThinkingLevel | undefined;
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
		return this.sessionManager.getAbsSessionFile();
	}

	/** The row's name the session is on, which a config patch and the picker both name it by. */
	get modelName(): string {
		return this.model.name;
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
	get isLooping(): boolean {
		return this.running;
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
	 * A queued message stays counted until the loop emits it back. A steered
	 * message is not counted: it goes into the turn that is already running.
	 */
	get queued(): number {
		let waiting = 0;
		for (const accepted of this.accepted) if (accepted.queue === "followUp") waiting += 1;
		return waiting;
	}

	/** True while a tool call is waiting for an approval nobody has answered yet. */
	get hasPendingApprovals(): boolean {
		return this.pendingApprovals.size > 0;
	}

	/**
	 * Whether this id names an approval that is waiting for an answer. Read-only.
	 *
	 * The approvals endpoint checks this before answering, because the check has to happen without
	 * answering: `approve` publishes synchronously, and the frame that reports a settlement is built
	 * from that publication — running it first would make every grant read as a denial by whatever
	 * reads the answer back. An unknown id is the endpoint's 409, not a silent no-op: a button that
	 * answers nothing and says so to no one is worse than an error the client can show.
	 */
	hasPendingApproval(toolCallId: string): boolean {
		return this.pendingApprovals.has(toolCallId);
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
			absWorkspaceRoot: this.workspace.absRoot,
			model: this.model,
			approvals: this.getApprovals(),
			allTools: this.tools.all().map((tool) => tool.name),
			activeTools: this.tools.activeNames(),
			// Judged against this workspace's own settings, the same way a cold read judges it, so the
			// panel's "沿用全局" label cannot disagree with itself between the two paths.
			...followsGlobalOf(this.sessionManager, this.settingsManager, this.tools),
			...(this.partial === undefined ? {} : { partial: this.partial }),
			submitting: this.running,
			queued: this.queued,
			isRetrying: this.retrying,
			retryAttempt: this.retryAttemptNumber,
			pendingApprovals: [...this.pendingApprovals.values()].map((entry) => entry.approval),
		});
	}

	/** Usage summed over the transcript, with the window it is measured against. */
	get usage(): UsageTotals {
		return sessionUsage(this.sessionManager, this.model.contextWindow);
	}

	/**
	 * What the provider is sent, before hooks and before the leading system message.
	 *
	 * Read from the session manager every time rather than cached, because that is the whole point of
	 * it being the single record: `appendCompaction` between two requests changes this, and so does
	 * anything a host appends.
	 */
	private transcript(): Message[] {
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
	 * way it is handed to the loop unwritten, and the loop's own echo of it is what the store records —
	 * a drained message is one the conversation has reached, so the file gains it in the place the
	 * model met it, behind the answer it interrupted. A run that ends before draining it writes it
	 * anyway ({@link flushAccepted}), so accepted still means persisted, exactly once.
	 */
	async prompt(text: string, options: { behavior?: PromptBehavior; selection?: ModelSelection } = {}): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;

		// The composer's choice arrives with the message, so this is the only place either half is
		// applied. A message that never reaches here — an empty one, a rejected send — moves nothing.
		if (options.selection !== undefined) this.applyModelSelection(options.selection);

		const message: Message = {
			role: "user",
			content: [{ type: "text", text: trimmed }],
			timestamp: this.nextStamp(),
		};
		if (this.running) {
			const queue = options.behavior ?? "followUp";
			if (queue === "steer") this.steeringQueue.enqueue(message);
			else this.followUpQueue.enqueue(message);
			this.accepted.push({ message, queue });
			this.emitQueueUpdate();
			this.publish();
			return;
		}

		this.appendMessage(message);
		this.rememberPrompt(message);
		this.emitQueueUpdate();
		this.publish();
		this.running = true;
		try {
			// The transcript and the tools are handed over per run — the loop keeps no state of its
			// own — and both are rebuilt for the request that actually goes out by
			// {@link prepareRequestOnLoop} anyway. The queues' drain hooks are what connect the
			// engine's take points to the queues this session owns.
			await this.loop.runLoop(
				{ messages: this.transcript(), tools: this.tools.active() },
				message,
				{
					model: this.model,
					getSteeringMessages: async () => this.steeringQueue.drain(),
					getFollowUpMessages: async () => this.followUpQueue.drain(),
				},
			);
		} finally {
			this.running = false;
			// A message accepted in the last moment of the run — after the loop had already decided to
			// stop looking for one — is on a queue nothing will drain, so it is written here rather than
			// lost. The ordinary drain path has already emptied both lists by this point, which is what
			// makes this a no-op for a run that ended the way it should.
			this.flushAccepted();
			// `agent_end` is the last *event* of a run, but the run is not over until the loop's
			// `runLoop` resolves — after every awaited listener for that event and the engine's own
			// `finally`. So this is the first moment `running` is false, and without publishing here
			// nothing ever reports it: a subscriber to {@link onChange} would keep reading `true` for
			// a run that had ended, which is exactly what a stream needs to know.
			//
			// In a `finally` rather than after the `await`, because the two ends of a run reach this point
			// by different roads: a run that ends normally falls through, but a run whose own failure
			// handling rejected — the persistence that reports the failure is the persistence that broke —
			// arrives here as a rejection, and a publish placed after the `await` would be skipped by
			// exactly the run that most needs the frame. Every end path a run has goes through this one
			// block; the error frame that may precede it is announced by the caller that learns of the
			// rejection, not by the session.
			this.publish();
		}
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
		if (this.running) throw new Error("A run is in flight: the branch cannot move under it");

		const leafId = descend ? this.sessionManager.getBranchTip(entryId) : entryId;
		const previousName = this.modelName;
		const previousLevel = this.thinkingLevel;
		this.sessionManager.branch(leafId);
		this.applyBranchSelection();
		this.applyBranchToolConfig();
		// Reported because neither field is in the branch payload, and every stream other than the one
		// that asked is holding a snapshot taken before the move.
		this.emitConfigChanged({
			...(this.modelName === previousName ? {} : { model: this.modelName }),
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
	 * A branch that recorded nothing falls back on the global default the settings files name — or the
	 * registry's full set when they name none — which is what a session that never chose runs on; the
	 * settings files say which tools are active, so a move onto an unrecorded branch restores that
	 * answer rather than keeping the branch it left behind. Only a recorded `tool_config` can name
	 * something else, and every move ends on the branch's answer rather than the previous one's.
	 */
	private applyBranchToolConfig(): void {
		const recorded = applyRecordedToolConfig(this.sessionManager, this.tools, defaultToolNames(this.settingsManager, this.tools));
		this.approvalOverride = recorded.approval ?? {};
		// Reported because neither map is in the branch payload, and every stream other than the one
		// that asked is holding a snapshot taken before the move. Both maps travel whole: this is the
		// branch's state, not a delta, and a client applies either shape.
		this.emitConfigChanged({ approvals: this.getApprovals(), tools: this.tools.activeNames() });
	}

	/**
	 * Narrow the tools the model may call. An unknown name throws and leaves the session as it was.
	 *
	 * The change is recorded as one `tool_config` entry and takes effect on the next request:
	 * {@link prepareRequestOnLoop} offers the registry's live active set with every request, so the
	 * model is told about the narrowed set when the next prompt is built.
	 */
	setActiveTools(names: string[]): void {
		const previous = this.tools.activeNames();
		this.tools.setActive(names);
		const active = this.tools.activeNames();
		if (active.length === previous.length && active.every((name, index) => name === previous[index])) return;

		this.sessionManager.appendToolConfig(active, this.getApprovals());
		this.publish();
		this.emitConfigChanged({ tools: active });
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
	applyModelSelection(selection: ModelSelection): void {
		const previousName = this.modelName;
		const previousLevel = this.thinkingLevel;
		// Nothing named is nothing to do, which is how a caller sends an ordinary message.
		if (selection.model === undefined && selection.thinkingLevel === undefined) return;

		const name = selection.model ?? previousName;
		const userModel = this.models.list().find((userModel) => userModel.name === name);
		if (userModel === undefined) throw new Error(`Unknown model: ${name}`);

		// A row named without a level lands on that row's own default, which is the answer an assembled
		// session opens on; a level named on the current row is the caller's. Either way the pair is
		// built once, so a level the model has no room for is refused rather than half-applied.
		const thinkingLevel =
			selection.thinkingLevel ??
			(selection.model === undefined ? this.model.thinkingLevel : userModel.defaultThinkingLevel);
		const candidate = createModel(userModel, thinkingLevel, this.transport);
		const level = candidate.thinkingLevel ?? "off";
		if (selection.thinkingLevel !== undefined && level !== selection.thinkingLevel && selection.thinkingLevel !== "off") {
			throw new Error(`${candidate.id} does not support thinking level "${selection.thinkingLevel}"`);
		}

		this.model = candidate;
		this.publish();
		this.emitConfigChanged({
			...(this.modelName === previousName ? {} : { model: this.modelName }),
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
		this.steeringQueue.mode = this.settingsManager.getSteeringMode();
		this.followUpQueue.mode = this.settingsManager.getFollowUpMode();
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
		entry.resolve({ approved });
		this.publish();
	}

	/**
	 * Deny every waiting approval, for example when the socket that owns them disconnects.
	 *
	 * The reason rides the answer into the transcript: each denied call's tool result says what
	 * actually happened — the run was aborted, the session closed, no window answered — rather than
	 * the same sentence a press of "deny" writes, which would record an abandonment as a choice.
	 */
	denyAllApprovals(reason: string): void {
		if (this.pendingApprovals.size === 0) return;
		for (const [toolCallId, entry] of [...this.pendingApprovals]) {
			this.pendingApprovals.delete(toolCallId);
			entry.resolve({ approved: false, reason });
		}
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
	async maybeCompact(
		entries: readonly SessionEntry[],
		now: number,
		signal?: AbortSignal,
	): Promise<readonly SessionEntry[]> {
		const threshold = compactionThresholdFor(this.model.contextWindow);
		if (!shouldCompact(messagesOf(entries), threshold)) return entries;

			const trimmed = this.trimRecordedArgs(entries);
			if (!shouldCompact(messagesOf(trimmed), threshold)) return trimmed;

			const cleared = this.clearStaleToolResults(trimmed, now);
			if (!shouldCompact(messagesOf(cleared), threshold)) return cleared;

			let outcome;
			try {
				outcome = await compactTranscript(cleared, this.model, this.summarize, signal);
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
			return cleared;
		}
		if (!outcome) return cleared;

		this.sessionManager.appendCompaction(
			outcome.summary,
			outcome.firstKeptEntryId,
			outcome.tokensBefore,
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
	 * workspace does not hold. It is also the reason this runs before the clear rather than beside it:
	 * the clear needs an expired cache to be worth its cache invalidation, and this does not, because
	 * when the transcript is over the trigger the next request is in trouble whatever the cache says.
	 */
	private trimRecordedArgs(entries: readonly SessionEntry[]): readonly SessionEntry[] {
		const trimmed = trimmableToolArgEntryIds(entries);
		if (trimmed.length === 0) return entries;

		const tokensBefore = estimateTokens(messagesOf(entries));
		this.sessionManager.appendTrimToolCallArgs(trimmed, tokensBefore);
		const view = this.sessionManager.buildContextEntries();
		this.emit({
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
	private clearStaleToolResults(entries: readonly SessionEntry[], now: number): readonly SessionEntry[] {
		if (!isCacheProbablyExpired(entries, now)) return entries;

		const cleared = clearableToolResultIds(entries);
		if (cleared.length === 0) return entries;

		const tokensBefore = estimateTokens(messagesOf(entries));
		this.sessionManager.appendClearToolResults(cleared, tokensBefore);
		const view = this.sessionManager.buildContextEntries();
		this.emit({
			type: "tool_results_cleared",
			cleared: cleared.length,
			tokensBefore,
			contextTokens: estimateTokens(messagesOf(view)),
		});
		return view;
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

		const answer = await new Promise<ApprovalAnswer>((resolve) => {
			this.pendingApprovals.set(toolCallId, {
				approval: { toolCallId, toolName: name, args, summary: describeToolCall(name, args) },
				resolve,
			});
			this.publish();
		});

		if (answer.approved) return undefined;
		// An answer with no reason of its own is a person pressing "deny" — the sentence below is true
		// for exactly that case, which is why only the endpoint's denial falls back to it.
		return answer.reason ?? `The user denied permission to run ${name}.`;
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
	private transcriptMessage(message: Message): Message {
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
	private forModel(messages: readonly Message[]): Message[] {
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
		if (event.type === "message_update") {
			// The hot path: one event per provider delta. Keep the running message for a baseline that
			// has to hand a mid-run attach the text it missed, and publish only what moved since the
			// last frame. Nothing is written here — the message is persisted when it ends.
			this.partial = event.message;
			const delta = messageDeltaOf(event);
			if (delta !== undefined) this.emit({ type: "message_update", delta });
			return;
		}
		if (event.type === "message_end" || event.type === "agent_end") this.partial = undefined;
		if (event.type === "message_end") {
			// The one user message the store already holds is the one that started a run: `prompt()`
			// wrote it before handing it to the loop, so the loop's own emit of it must not be recorded
			// twice. Everything else the loop announces is written here — including a message it just
			// drained out of a queue, whose write was deliberately left to this moment so that the file
			// gains it behind the answer it interrupted rather than in front of it.
			if (!this.isOptimisticEcho(event.message)) {
				this.takeAccepted(event.message);
				this.appendMessage(this.transcriptMessage(event.message));
			}
		}
		if (event.type === "agent_end") {
			// An accepted message the run never reached — an abort, a failure, a prompt that arrived in
			// the moment the loop stopped looking. Nothing will drain it now, so the end of the run is
			// where it is written. See {@link flushAccepted}.
			this.flushAccepted();
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
	private appendMessage(message: Message): void {
		// A message appended where something already followed is a *second* alternative at that message
		// rather than a continuation of its tip — which is what rewinding and asking again is. The tree
		// gained a branch point there, so the windows are told where the leaf is, exactly as a move does:
		// their branch points came from a snapshot and this append changed them.
		// The count is the raw child count, so a `leaf` entry — the record a branch move writes — counts
		// too, the same way a `model_change` written in front of a message already does. The cost is one
		// extra full-snapshot frame that shows no extra branch point, which is harmless.
		const parent = this.sessionManager.getLeafId();
		const continued = parent !== null && this.sessionManager.getChildren(parent).length > 0;

		const entryId = this.sessionManager.appendMessage(message);
		if (continued) this.emit({ type: "branch_changed", leafId: entryId });
		this.emit({ type: "entry_appended", entryId, kind: "message" });
	}

	/**
	 * Record that this session, not the loop, wrote the user message that started a run.
	 *
	 * The one write the session makes ahead of the loop: a prompt is what starts a run, so the store
	 * gains it before the loop can echo it, and {@link isOptimisticEcho} is what keeps that echo from
	 * writing it a second time.
	 */
	private rememberPrompt(message: Message): void {
		if (message.role !== "user" || message.timestamp === undefined) return;
		this.promptWrites.push(message.timestamp);
	}

	/**
	 * True when the loop is echoing a user message this session already persisted.
	 *
	 * Only a prompt is written ahead of the loop: it is what starts a run, so there is a moment between
	 * the write and the loop's own emit of the same message, and the stamp identifies it — stamps are
	 * unique per message because this session issues them. A message drained out of a queue is not one
	 * of these; its write is the echo, so it must land here.
	 */
	private isOptimisticEcho(message: Message): boolean {
		if (message.role !== "user" || message.timestamp === undefined) return false;
		return this.consume(this.promptWrites, message.timestamp);
	}

	/**
	 * Take one accepted message off the list, now that the loop has drained it.
	 *
	 * The count a composer shows is what is left here, so this is where the depth drops: a follow-up
	 * stops being "accepted and waiting" at the drain point, not when the turn it opened ends. The
	 * message the loop hands back is the very object `prompt()` queued, so the stamp is the key.
	 */
	private takeAccepted(message: Message): void {
		if (message.role !== "user" || message.timestamp === undefined) return;
		const index = this.accepted.findIndex((entry) => entry.message.timestamp === message.timestamp);
		if (index !== -1) this.accepted.splice(index, 1);
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
	private flushAccepted(): void {
		if (this.accepted.length === 0) return;
		// Emptied before the writes, so a failed append can never turn into a second copy of one.
		const pending = this.accepted.splice(0);
		this.steeringQueue.clear();
		this.followUpQueue.clear();
		for (const entry of pending) this.appendMessage(entry.message);
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
 * The messages one selection of entries stands for — the same projection the store hands a request.
 *
	 * It is the only way the trigger measures a prompt, so `maybeCompact` can compare the transcript as
	 * stored with the transcript after a clear without building the request twice.
 */
function messagesOf(entries: readonly SessionEntry[]): Message[] {
	return entries.flatMap((entry) => sessionEntryToContextMessages(entry));
}
