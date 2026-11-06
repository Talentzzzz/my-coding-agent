import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type ChatTransport,
	createAssistantMessageEventStream,
	createSystemMessage,
	isContextOverflow,
	type Context,
	type JsonValue,
	type Message,
	type RetryCallbacks,
	retryAssistantCall,
	type SimpleStreamOptions,
	toToolDeclaration,
	type Tool,
	type ToolCall,
	type ToolResult,
	type ToolResultMessage,
	type Usage,
	validateToolArguments,
} from "./llm/index.ts";
import { type AgentsMdFile, loadAgentsMd } from "./context/agents-md.ts";
import {
	compact as compactTranscript,
	compactionThresholdFor,
	estimateTokens,
	shouldCompact,
	type Summarize,
} from "./context/compaction.ts";
import { clearableToolResultIds, isCacheProbablyExpired } from "./context/clear-tool-results.ts";
import { trimmableToolArgEntryIds } from "./context/trim-tool-call-args.ts";
import type { Hooks } from "./hooks.ts";
import {
	type Model,
	type ModelConfig,
	modelFor,
	normalizeThinkingLevel,
	rowFor,
	type ThinkingLevel,
	unconfiguredStream,
} from "./models.ts";
import type { ConfigPatch, ModelSelection, PendingApproval, PromptBehavior, SessionSnapshot } from "./protocol.ts";
import type { AgentState } from "./session/agent-state.ts";
import { danglingApprovalsOf } from "./session/dangling.ts";
import { type AgentSessionEvent, messageDeltaOf, type SessionEventListener, type SessionListener } from "./session/events.ts";
import {
	appendMessageEntry,
	approvalsOf,
	dropQueued,
	emitEvent,
	emitQueueUpdate,
	nextStamp,
	publishState,
	type SessionServices,
	snapshotOf,
} from "./session/fanout.ts";
import type { PendingMessageQueue } from "./session/queues.ts";
import {
	type Session,
	type SessionEntry,
	type SessionManager,
	sessionEntryToContextMessages,
} from "./session/session-manager.ts";
import { toolStateOf } from "./session/tool-config.ts";
import type { SettingManager } from "./setting-manager.ts";
import type { ToolManager, ToolRunContext, ToolState } from "./tools/index.ts";
import type {
	AfterToolCallResult,
	AgentEvent,
	AgentRequestUpdate,
	BeforeToolCallResult,
	RunRecoveryOptions,
	ToolCallAnswer,
	ToolCallHooks,
	ToolCallOutcome,
} from "./types.ts";

// The event surface is defined beside the fan-out that publishes it (`session/events.ts`) and
// re-exported here, because `index.ts` has always answered for it from this module.
export type { AgentSessionEvent, MessageDelta, SessionEventListener, SessionListener } from "./session/events.ts";

/**
 * The services one orchestrator coordinates, already built by the caller.
 *
 * The session never loads settings, creates a working directory, reads AGENTS.md, or picks a model: every
 * method names a session by id and fetches what it needs, at the line that needs it, from the
 * service that owns it — the transcript from the session manager's cache, the live half from the
 * session's own state, the model from the ledger and the live rows. That is what makes the class
 * stateless (ADR-0007): there is no per-session field here beyond the state table itself, so a test
 * drives a session by assembling its state in the factory and handing it over with `adopt`, and a
 * host that owns the services does the same. `session-factory.ts` does the assembling for the real
 * process.
 *
 * None of these fields is session *state*. The services this class coordinates — the ledger,
 * the configuration (settings and model rows together, one {@link SettingManager}), the tool
 * table, the seams, the prompt builder, and the transport — each hold their own pure-data
 * state (ADR-0006 §1–2); what used to be the `Agent`'s private session fields are gone: the
 * run-time transients are locals of the run (ADR-0006 §5), the approvals are derived from the
 * ledger, the stamps are derived from the file, and the assembly rides the state the open adopted
 * into the table this class holds (ADR-0011).
 */
export interface AgentConfig {
	/**
	 * The stateless session service every transcript read and write goes through.
	 *
	 * A host that owns one — the hub, so every session of the process shares a single service and
	 * its single store knowledge — hands its own in. The service holds no bag of its own: a held
	 * session's bag is the one this class's table answers with (`agentState(id).session`), and a
	 * cold one is `open(id)`, a replay the caller drops.
	 */
	sessionManager: SessionManager;
	/**
	 * The configuration every settings and model read goes through.
	 *
	 * Handed over rather than copied, because configuration is the thing most likely to change while a
	 * session is open: the manager holds nothing, so every read is a fresh read of the files behind it
	 * — a key corrected in the settings panel, a mode toggled, a row added with an editor — each is
	 * the answer the next request gives. The per-request fill re-derives the session's model from the
	 * catalog it finds here, so the key, the endpoint, the window, and the wire id are all as fresh as
	 * the row is.
	 */
	settings: SettingManager;
	/**
	 * The tools this build knows, plus whatever a caller registered on it — a test's custom tool.
	 * Structure only: the choice is not here.
	 *
	 * The active set and the approval map are derived from the session's recorded choices — the
	 * `.json` snapshot's current values — on every read (the global default's live view is the
	 * fallback), so nothing mutates when the choice moves. The table holds behaviour and no
	 * directory: a request declares the instances its names resolve to, and the per-request values
	 * those instances act with arrive on `execute`'s `run` (ADR-0016).
	 */
	tools: ToolManager;
	/**
	 * The seams every dispatch goes through: `context`, `before_tool` (the approval gate), `after_tool`.
	 *
	 * The same instance the factory installs its defaults on, because a host that adds a handler
	 * registers it after them and refines what they decided — see {@link Agent.hooks}.
	 */
	hooks: Hooks;
	/**
	 * Builds the prompt for the tools the model may call, from the session's live settings.
	 *
	 * A function rather than a string because two things it names can change mid-session: the active
	 * tool set, and which of those tools ask for approval. A captured prompt would offer the model
	 * tools the run then refuses to run, or promise an approval the session no longer asks for. The
	 * working directory and the project instructions arrive per request for the same reason.
	 */
	systemPrompt: (
		workDirAbsPath: string,
		agentsMd: readonly AgentsMdFile[],
		toolNames: readonly string[],
		approvals: Record<string, boolean>,
	) => string;
	/**
	 * The transport every request this session makes goes over.
	 *
	 * A model is what a request is made with and the transport is how it is sent, so each model is
	 * constructed with the one it was assembled with, and every one re-derived from a row afterwards.
	 * Resolved by the factory (`anthropicMessages`, the only one this app speaks) rather than
	 * defaulted here, because the smokes hand in a scripted one.
	 */
	api: ChatTransport;
}
/**
 * One orchestration service for every conversation this process runs.
 *
 * This is the orchestration layer of the stateless architecture (ADR-0006 §1): the four domains are
 * stateless singletons, and the cross-domain order — apply the composer's choice, resolve the
 * session by id, write the message, run the engine, then report what moved — lives here and nowhere
 * else, because it belongs to no single domain.
 *
 * The engine is not a second object: ADR-0012 put it in a `LoopManager` and ADR-0013 took its
 * services away, which left an object with nothing of its own to be — so it is a method again
 * (ADR-0014). What the class holds beyond the session table is the engine's services, and a run
 * reads them off `this`: the ledger, the configuration, the tool table, the seams, the prompt
 * builder, and the transport. Everything else here is the session's own command surface — the
 * transcript reads, the approvals, the config moves, and the fan-out a command answers through.
 *
 * The class holds no session state: a method names its session by id, resolves the ledger bag from
 * the session manager and the live half from the table, and rebuilds everything a command needs
 * from those two. A resumed session and a live session run the same chain, which is what makes them
 * indistinguishable.
 */
export class Agent {
	/**
	 * The stateless session service every transcript read and write goes through.
	 *
	 * Exposed rather than hidden because it is the durable half's owner: a host that has to fork,
	 * list, or name the file reads it here, and there is no second copy of that state to keep in step.
	 * The bag a call operates on is never held here — a held session's is the table's
	 * (`agentState(id).session`), a cold one is `open(id)`'s, and the id is the caller's.
	 */
	readonly sessionManager: SessionManager;
	/**
	 * The configuration every settings and model read goes through.
	 *
	 * Exposed rather than hidden because it is the owner of both files: a host that answers a settings
	 * command or lists the rows reads it here, and there is no second copy of either file to keep in
	 * step. See {@link AgentConfig.settings}.
	 */
	readonly settings: SettingManager;
	/**
	 * The seams sessions dispatch through, including the defaults `openAgent` installed.
	 *
	 * Exposed so a host that already has a session can add behaviour to it: a handler registered here
	 * runs after the defaults and refines what they answered.
	 */
	readonly hooks: Hooks;

	private readonly tools: ToolManager;
	/** The prompt builder a request is built from; {@link Agent.prepareRequest} is what calls it. */
	private readonly systemPrompt: AgentConfig["systemPrompt"];
	/** Where a request actually leaves: the transport, before the retry policy wraps it. */
	private readonly api: ChatTransport;
	/**
	 * The states of the sessions this process runs, keyed by id (ADR-0011).
	 *
	 * One bag per session — the durable half, the settings the open resolved, the live half, the
	 * subscribers — and the only thing this class holds between calls. States enter through
	 * {@link Agent.adopt} and leave through {@link Agent.evict} / {@link Agent.drop}, both owned
	 * here: one writer, one deleter.
	 */
	private readonly sessions = new Map<string, AgentState>();

	constructor(config: AgentConfig) {
		this.sessionManager = config.sessionManager;
		this.settings = config.settings;
		this.tools = config.tools;
		this.hooks = config.hooks;
		this.systemPrompt = config.systemPrompt;
		this.api = config.api;
		// Nothing per session is built here: a state is assembled by the factory and adopted, and an
		// id is resolved at the top of each method against the table below. No run-scoped object is
		// built here either: everything a run holds is its own local.
	}

	/**
	 * The three services a fan-out call reads through, gathered at the call site.
	 *
	 * Not a field: a held bag is the thing ADR-0007 deleted, and every one of these three is
	 * already a field on this class — this is the shape `session/fanout.ts` asks for, built where
	 * it is asked for.
	 */
	private get services(): SessionServices {
		return { sessionManager: this.sessionManager, settings: this.settings, tools: this.tools };
	}

	// ---------------------------------------------------------------------------- resolution

	/**
	 * Put one assembled state in the table. The only way in.
	 *
	 * The factory (`session-factory.ts`) is what assembles — the working directory, the settings, the
	 * live half, the model choice seeded onto the session — and the caller hands the result here,
	 * whether that caller is a host adopting into its long-lived orchestrator or a test adopting
	 * into one of its own. First adoption wins: a state already in the table is kept, never
	 * replaced, because the one it would replace holds the queues, the subscribers, and the run in
	 * flight (ADR-0007 §4) — and re-adopting the same id is the ordinary idempotent move, not an
	 * error.
	 */
	adopt(state: AgentState): void {
		if (this.sessions.has(state.session.sessionId)) return;
		this.sessions.set(state.session.sessionId, state);
	}

	/**
	 * Drop one session's state from the table, when nothing holds it.
	 *
	 * The eviction criteria (ADR-0011, issue 04): no run in flight, nothing parked at the approval
	 * gate, and a durable half actually on disk — a session whose file is not born yet has no
	 * half to rebuild from, so dropping its state would be deleting the id, and its life ends
	 * with the first message or the process, never with a sweep. Refusing (returning `false`) is
	 * the answer to a caller that named a session still held.
	 */
	evict(id: string): boolean {
		const state = this.sessions.get(id);
		if (state === undefined) return false;
		if (state.live.activeRun !== undefined || state.live.suspended) return false;
		if (state.session.fileCreated !== true) return false;
		return this.sessions.delete(id);
	}

	/**
	 * Drop one session's state from the table, whatever it holds.
	 *
	 * The unconditional half of the teardown (issue 03 §7): the user has deleted the session, so
	 * the id is gone from disk and no criteria apply — there is nothing left for the state to
	 * protect. Anything queued or in flight dies with it, exactly as a process restart would have
	 * killed it.
	 */
	drop(id: string): boolean {
		return this.sessions.delete(id);
	}

	/**
	 * Whether the table holds a state for `id` — whether this process is holding the session.
	 *
	 * The public boolean beside {@link Agent.agentState}, for a caller that needs to branch before it
	 * reads: a held session is written through its own bag, a cold one is a replay of its file, and
	 * the two roads must be chosen before either is walked. Answering nothing about observers or
	 * claims — those are other questions with other answers — it is only the table's membership.
	 */
	has(id: string): boolean {
		return this.sessions.has(id);
	}

	/**
	 * The state the session `id` names — the durable half, the settings, the live half, the
	 * subscribers — or the refusal that says this process is not holding it.
	 *
	 * The public read of the table, for a caller outside the class that must reach the same bag a
	 * method here would: a hub reading the entry map behind a live session, a projection reading a
	 * title off the bag a turn is being written through. A missing one is a wrong road rather than a
	 * state to invent — `has` is how a caller asks first — and only `adopt` puts a state here.
	 */
	agentState(id: string): AgentState {
		const state = this.sessions.get(id);
		if (state === undefined) throw new Error(`Session is not running: ${id}`);
		return state;
	}

	// ---------------------------------------------------------------------------- the read surface

	/**
	 * The state of the session `id` names, built by the one function that also serves a cold reader.
	 *
	 * This is the whole read surface: every scalar a caller used to ask for by name — the row, the
	 * level, the tool set, the depth, the retry state — is a field here, so there is one answer rather
	 * than a getter per field to keep in step with it.
	 *
	 * The construction is `snapshotOf` (`session/fanout.ts`), the same function the fan-out publishes
	 * through, so a frame and a REST read cannot disagree: the five fields only a live session knows —
	 * `submitting`, `queued`, `isRetrying`, `retryAttempt`, `pendingApprovals` — are read off the live
	 * half there, and a cold reader supplies them from the files alone.
	 */
	snapshot(id: string): SessionSnapshot {
		return snapshotOf(this.agentState(id), this.services);
	}

	/**
	 * The approval map in force: the directory's settings with this session's own choices over them.
	 *
	 * The single read point for the gate, the snapshot, and the prompt — all three answer the same
	 * question, so none of them may reach past this to the settings alone. The session's own
	 * half is the recorded choice, read off the `.json` snapshot beside the tool set it was written
	 * beside.
	 */
	getApprovals(id: string): Record<string, boolean> {
		return approvalsOf(this.services, this.agentState(id).session);
	}

	/**
	 * Whether the transcript holds a tool call nobody has answered.
	 *
	 * Only an idle session reports one. A call that dangles *during* a run is a result in the middle
	 * of landing, not a question waiting for a person, and reporting it would flash a banner on every
	 * tool batch; the calls that wait for an answer are the ones whose run has already ended.
	 */
	hasPendingApprovals(id: string): boolean {
		const state = this.agentState(id);
		return state.live.activeRun === undefined && this.danglingApprovals(state.session).length > 0;
	}

	/** Subscribe to the session's state. The returned function unsubscribes. */
	onChange(id: string, listener: SessionListener): () => void {
		const listeners = this.agentState(id).listeners;
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	/** Subscribe to the session's events. The returned function unsubscribes. */
	onEvent(id: string, listener: SessionEventListener): () => void {
		const listeners = this.agentState(id).eventListeners;
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	// ---------------------------------------------------------------------------- the run lifecycle

	/**
	 * Append a user message and run the engine until the agent stops.
	 *
	 * `selection` is the composer's model and level, applied here and recorded by the request that
	 * follows. Both come with the message rather than as a command of their own, so a choice that was
	 * never sent with is nowhere.
	 *
	 * While a run is streaming the message is queued instead of rejected: `steer` is injected at the
	 * current turn's next drain point, `followUp` waits until the agent would otherwise stop. Either
	 * way it is handed to the engine unwritten, and the drain that takes it is what the store records —
	 * a drained message is one the conversation has reached, so the file gains it in the place the
	 * model met it, behind the answer it interrupted. A message the run never drains is dropped with
	 * the run (the fan-out's `dropQueued`): the send contract is fire-and-forget, and queued never
	 * promised stored.
	 */
	async prompt(id: string, text: string, options: { behavior?: PromptBehavior; selection?: ModelSelection } = {}): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;

		// The composer's choice arrives with the message, so this is the only place either half is
		// applied. A message that never reaches here — an empty one, a rejected send — moves nothing.
		if (options.selection !== undefined) this.applyModelSelection(id, options.selection);

		const state = this.agentState(id);
		if (state.live.activeRun !== undefined) {
			const message: Message = {
				role: "user",
				content: [{ type: "text", text: trimmed }],
				timestamp: nextStamp(this.sessionManager, state.session),
			};
			const queue = options.behavior ?? "followUp";
			if (queue === "steer") state.live.steeringQueue.enqueue(message);
			else {
				state.live.followUpQueue.enqueue(message);
				emitQueueUpdate(state);
			}
			publishState(state, this.services);
			return;
		}

		await this.startPromptedRun(state, trimmed);
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
	private async startPromptedRun(state: AgentState, trimmed: string): Promise<void> {
		const message: Message = {
			role: "user",
			content: [{ type: "text", text: trimmed }],
			timestamp: nextStamp(this.sessionManager, state.session),
		};
		appendMessageEntry(state, this.sessionManager, message);
		publishState(state, this.services);
		await this.run(state, { prompt: message });
	}

	/**
	 * Stop the session's current run and wait for it to settle.
	 *
	 * Settling means the engine finished persisting the turn it was in the middle of, including tool
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
		const state = this.agentState(id);
		// Read once: the run clears its own registration as it settles, and the promise is what waits
		// for that settlement.
		const active = state.live.activeRun;
		active?.abortController.abort();
		await (active?.promise ?? Promise.resolve());
		// The run drops its own slot in its `finally`, a microtask after the idle promise resolves;
		// wait for that too, so the sweep below sees the idle session it is defined on.
		while (state.live.activeRun !== undefined) await Promise.resolve();
		this.denyAllApprovals(id, "The run was aborted.");
		// The same end a finished run publishes, and for the same reason: an abort is how a run that
		// nobody asked to stop otherwise reports that it has. See {@link Agent.prompt}.
		publishState(state, this.services);
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
	 * Refused while a run is in flight, because the run appends to the leaf: a move under it would
	 * file the rest of that turn under a branch the turn was not answering.
	 */
	branchTo(id: string, entryId: string, descend = true): string {
		const state = this.agentState(id);
		if (state.live.activeRun !== undefined) throw new Error("A run is in flight: the branch cannot move under it");

		const leafId = descend ? this.sessionManager.getBranchTip(state.session, entryId) : entryId;
		this.sessionManager.branch(state.session, leafId);
		// No config report rides the move: the model, the level, and the tool choices are the
		// session's own values now (the `.json` snapshot), so a leaf move changes none of them —
		// unlike the days when they were replayed off the branch's entries.
		emitEvent(state, { type: "branch_changed", leafId });
		publishState(state, this.services);
		return leafId;
	}

	/**
	 * Narrow the tools the model may call. An unknown name throws and leaves the session as it was.
	 *
	 * The change is recorded on the session's `.json` snapshot and takes effect on the next request:
	 * the fill chain derives the choice from the ledger with every request, so the model is told about
	 * the narrowed set when the next prompt is built.
	 */
	setActiveTools(id: string, names: string[]): void {
		const state = this.agentState(id);
		const previous = toolStateOf(this.sessionManager, state.session, this.settings, this.tools.names()).activeToolNames;
		const known = new Set(this.tools.names());
		const unknown = names.filter((name) => !known.has(name));
		if (unknown.length > 0) {
			throw new Error(`Unknown tool${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
		}
		if (names.length === previous.length && names.every((name, index) => name === previous[index])) return;

		this.sessionManager.setToolConfig(state.session, [...names], approvalsOf(this.services, state.session));
		publishState(state, this.services);
		this.emitConfigChanged(state, { tools: [...names] });
	}

	/**
	 * Point this session at another row, another level, or both.
	 *
	 * There is no entry here and no settings write: a choice is not something that happened until a
	 * request is made with it, so it lands on the session's own setting field — in memory, where the
	 * snapshot and the next request read it — and reaches the transcript in
	 * {@link Agent.prepareRequest}, the fill chain, at the moment the request it belongs to is built. What a caller
	 * gets back immediately is the change itself — the snapshot, the level, and the next request are
	 * all about the new model, whether or not that request is ever sent.
	 *
	 * A level the chosen model has no room for is refused rather than clamped, because the caller is a
	 * composer that offered the levels of the model it is moving to; "off" is the exception and is
	 * always accepted, since it means "as quiet as this model gets".
	 */
	applyModelSelection(id: string, selection: ModelSelection): void {
		const state = this.agentState(id);
		const setting = state.session.sessionSetting;
		const previousName = setting.model?.name;
		const previousLevel = normalizeThinkingLevel(setting.model?.thinkingLevel);
		// Nothing named is nothing to do, which is how a caller sends an ordinary message.
		if (selection.model === undefined && selection.thinkingLevel === undefined) return;

		const name = selection.model ?? previousName;
		const userModel = this.settings.modelCatalog().find((userModel) => userModel.name === name);
		if (userModel === undefined) throw new Error(`Unknown model: ${name}`);

		// The choice is the client's selection, written as it arrived onto the session's own setting:
		// the row's name, and the level the caller named or the one already in force. Nothing of the
		// row follows it — the wire id is what the request made with the choice records
		// (`recordSelection`), and a snapshot taken before the next request already reads the row the
		// name picks out, because every build looks the name up in the catalog, so an edit to that row
		// wins without anything here being refreshed. The write is in memory only: until a request is
		// made with the choice, the file keeps the choice it was last made with.
		const renamed = previousName !== userModel.name;
		setting.model = {
			// A rename drops the wire id along with the name it belonged to.
			...(renamed ? {} : setting.model),
			name: userModel.name,
			thinkingLevel: selection.thinkingLevel ?? normalizeThinkingLevel(setting.model?.thinkingLevel),
		};

		publishState(state, this.services);
		this.emitConfigChanged(state, {
			...(setting.model.name === previousName ? {} : { model: userModel.name }),
			...(normalizeThinkingLevel(setting.model.thinkingLevel) === previousLevel
				? {}
				: { thinkingLevel: setting.model.thinkingLevel }),
		});
	}

	/**
	 * Update settings and persist them. Approval changes take effect on the next tool call.
	 *
	 * The two halves of a patch live in different places. Approval is session-scoped: it merges into
	 * this session's own choices and is recorded on its `.json` snapshot, so another session over
	 * this directory is untouched. The rest goes to the settings through the {@link SettingManager},
	 * which owns the files — and onto the runtime's queues, which read the mode at each drain.
	 *
	 * The model and the thinking level are not part of a patch at all. They are chosen in the composer
	 * and arrive with the message they belong to ({@link ModelSelection}), so there is nothing here to
	 * apply: a config change that no request followed is not a config change.
	 */
	applyConfig(id: string, patch: ConfigPatch): void {
		const state = this.agentState(id);
		const workDirAbsPath = state.session.sessionSetting.workDirAbsPath;
		const previousApprovals = approvalsOf(this.services, state.session);
		if (patch.approval !== undefined) {
			// The snapshot records the whole map in force — the settings with this session's choice over
			// them — which is the shape every read of the ledger answers from.
			const approvals = { ...previousApprovals, ...patch.approval };
			const activeToolNames = toolStateOf(this.sessionManager, state.session, this.settings, this.tools.names()).activeToolNames;
			this.sessionManager.setToolConfig(state.session, activeToolNames, approvals);
		}
		// The rest of the patch goes to the settings through the manager, which owns the write: the
		// change lands on the files, and every later read — this session's and any other session over
		// the directory — answers from them.
		this.settings.applySettings(workDirAbsPath, patch.approval === undefined ? patch : { ...patch, approval: undefined });
		state.live.steeringQueue.mode = this.settings.getSteeringMode(workDirAbsPath);
		state.live.followUpQueue.mode = this.settings.getFollowUpMode(workDirAbsPath);
		publishState(state, this.services);
		this.emitConfigChanged(state, {
			approvals: changedApprovals(previousApprovals, approvalsOf(this.services, state.session)),
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
	private danglingApprovals(session: Session): PendingApproval[] {
		return danglingApprovalsOf(this.sessionManager.buildContextEntries(session));
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
		const state = this.agentState(id);
		return (
			state.live.activeRun === undefined &&
			this.danglingApprovals(state.session).some((call) => call.toolCallId === toolCallId)
		);
	}

	/**
	 * Answer one unanswered tool call, and resume the run that asked for it.
	 *
	 * The answering half of the end-restart chain (ADR-0006 §5): the run that asked is over, the call
	 * dangles in the ledger, and the answer starts the run that closes it. The engine's recovery pass
	 * pairs the answer with the call by id — a grant re-runs the call through the gate and the tool
	 * itself, a denial closes it with the sentence a press of "deny" writes — and the run continues
	 * from there, so the model sees the call resolved and carries on in the same run. A grant also
	 * records the session's approval choice for that tool — the tool stops asking — on the session's
	 * `.json` snapshot, the same move a config patch makes: the recovery pass re-runs the call
	 * through the gate, and the gate lets through only a tool the map no longer gates.
	 *
	 * An id nothing is waiting on is ignored: the caller checked first, and answered it. A dangling
	 * call the answer does not name is closed by the recovery pass as an orphan — which is what keeps
	 * the resumed request provider-legal when a crash left several calls behind.
	 */
	async respondApproval(id: string, toolCallId: string, approved: boolean): Promise<void> {
		const state = this.agentState(id);
		if (state.live.activeRun !== undefined) return;
		const call = this.danglingApprovals(state.session).find((candidate) => candidate.toolCallId === toolCallId);
		if (call === undefined) return;
		const answer: ToolCallAnswer = approved
			? { approved: true }
			: { approved: false, reason: `The user denied permission to run ${call.toolName}.` };
		if (approved) {
			// The grant is the session's own choice for this tool, recorded as the whole map in force
			// with the tool turned off — the same move a config patch makes.
			const approvals = { ...approvalsOf(this.services, state.session), [call.toolName]: false };
			const activeToolNames = toolStateOf(this.sessionManager, state.session, this.settings, this.tools.names()).activeToolNames;
			this.sessionManager.setToolConfig(state.session, activeToolNames, approvals);
		}
		// Said before the run starts: the choice is the session's own and lands now, while the call
		// itself stays dangling until the run's recovery pass closes it.
		publishState(state, this.services);
		await this.run(state, { answers: { [toolCallId]: answer } });
	}

	/**
	 * Close every unanswered tool call with the reason nothing answered.
	 *
	 * The reason rides the answer into the transcript: each closed call's tool result says what
	 * actually happened — the run was aborted, no window answered — rather than the same sentence a
	 * press of "deny" writes, which would record an abandonment as a choice.
	 *
	 * Only an idle session closes anything: a call that dangles mid-run is a result the engine itself is
	 * about to write, and closing it here would write the answer twice.
	 *
	 * The queues go with it. A suspended run keeps them because the recovery run it is waiting for is
	 * what drains them; this is the notice that no recovery run is coming, so nothing would ever take
	 * what was accepted — and a depth nobody will lower is a session `settle` waits on forever.
	 */
	denyAllApprovals(id: string, reason: string): void {
		const state = this.agentState(id);
		if (state.live.activeRun !== undefined) return;
		const dangling = this.danglingApprovals(state.session);
		if (dangling.length === 0) return;
		for (const call of dangling) this.appendDanglingResult(state, call, { approved: false, reason });
		// The abandonment sweep is where a parked session's reading ends: no recovery run is coming,
		// so the suspended flag has nothing left to say — and left standing it would keep the state's
		// own eviction refused forever (the criteria read this flag).
		state.live.suspended = false;
		if (dropQueued(state)) emitQueueUpdate(state);
		publishState(state, this.services);
	}

	/** Write the result that closes one dangling call, and announce the entry like any other message. */
	private appendDanglingResult(
		state: AgentState,
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
		appendMessageEntry(state, this.sessionManager, message);
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
		const state = this.agentState(id);
		return approvalsOf(this.services, state.session)[name] === true;
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
	 * A run the gate ended is settled, not awaited: its queue is kept for the recovery run, and
	 * `stillBusy` reads a dangling call as "a question, not work" — the same reading {@link
	 * Agent.close} makes when it leaves a parkable call unanswered for a person. Without that, a
	 * parked session would look busy to every caller that settles one — the hub's reap above all.
	 *
	 * A pending retry is part of the run too, so it is waited for rather than resolved past: the
	 * retry runs inside the stream the engine is awaiting, which keeps the agent non-idle for the whole
	 * backoff, and the condition is here so that stays true if that ever changes.
	 */
	async settle(id: string): Promise<void> {
		const state = this.agentState(id);
		// Read through a closure: the run slot is reassigned across the awaits below, and a narrow
		// taken before them would tell the checker the slot is always empty here.
		const stillBusy = (): boolean =>
			(state.live.followUpQueue.size > 0 && this.danglingApprovals(state.session).length === 0) ||
			state.live.retrying === true;
		for (;;) {
			await (state.live.activeRun?.promise ?? Promise.resolve());
			// The run drops its own slot a microtask after the idle promise resolves; wait for that too,
			// so a caller that settles sees the idle session — and the dangling calls the run ended
			// with — rather than one still finishing its writes. The same bounded wait `abort` makes.
			while (state.live.activeRun !== undefined) await Promise.resolve();
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
		this.agentState(id).live.activeRun?.abortController.abort();
		await this.settle(id);
	}

	/**
	 * Run the compaction ladder against a session named by id.
	 *
	 * The fill chain calls the same three steps on every request, inside the loop; this public shape
	 * lets a caller drive them against a session it names — the smoke that exercises the pruning
	 * ladder does exactly that.
	 */
	maybeCompact(
		id: string,
		entries: readonly SessionEntry[],
		now: number,
		signal?: AbortSignal,
		transport?: ChatTransport,
	): Promise<readonly SessionEntry[]> {
		const state = this.agentState(id);
		const model = modelFor(state.session.sessionSetting.model ?? {}, this.settings.modelCatalog(), transport);
		return this.compactFor(state, entries, now, signal, model);
	}

	// ---------------------------------------------------------------------------- the config report

	/** Report a config change with only the fields that moved; silence when none did. */
	private emitConfigChanged(
		state: AgentState,
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
		emitEvent(state, { type: "config_changed", ...changes });
	}

	// ---------------------------------------------------------------------------- the engine
	//
	// Everything below runs one conversation turn by turn: the entry and its exit (`run`), the
	// per-request fill chain, the compaction ladder, the retry pump under the transport, the two
	// tool-call gates, and the sink every event is persisted and fanned out through. It is a member
	// again rather than an object of its own (ADR-0014): the object that held it held nothing else,
	// and a run's services are this class's services.

	/**
	 * Run the engine once, over everything the transcript already holds.
	 *
	 * A run starts one of two ways. A prompted run hands over the message that started it, which the
	 * store already holds — the engine's own echo of it must not be recorded twice. A resumed run hands
	 * over the approval answers instead: the engine's recovery pass pairs them with the calls the last
	 * run left dangling and continues from there, so no message is written and none is echoed.
	 *
	 * This is where the run lives, and it is the whole reason the class holds no run state: the
	 * transport, the retry scope, the event handler, and the engine's own take points are all built
	 * with the run, closed over its locals, and dropped when the run settles. What crosses the stack
	 * is exactly what the state names — the queues, the active run, the subscribers — and the live
	 * half itself, which is how a reader outside the run sees its transients: the run writes its
	 * partial message, its model, and its retry state onto `state.live` as it goes. The zeroing is
	 * the run's first act, so it never inherits what a previous run left; the `finally` retires only
	 * the model, so an idle session answers from the catalog again — the other readings stay as the
	 * run left them, which is how a session parked at the gate reads as parked until the recovery
	 * run or the abandonment sweep says otherwise. The session the run serves is
	 * resolved once, at the top, and every closure below threads the same locals: no request
	 * re-resolves its way to a different bag.
	 */
	private async run(
		state: AgentState,
		start: RunStart,
	): Promise<void> {
		const live = state.live;
		// The run's readings start at zero, in one place: a run neither inherits the previous run's
		// model nor answers for its leftover partial or retry state. The suspended flag is the one
		// with a life between runs — a recovery run starts while it is still set from the run before
		// it, which is why the reset is here rather than in the `finally`.
		live.partial = undefined;
		live.model = undefined;
		live.suspended = false;
		live.retrying = false;
		live.retryAttempt = 0;

		// The run's send policy rides on every request object this run's models are built with. The
		// engine is never told about it: it asks for a stream from whatever model it holds, and the
		// model answers through this — so retries, and the "no row behind this model" answer, happen
		// below everything that could report them.
		const transport: ChatTransport = {
			stream: (model, context, options) => {
				const outer = createAssistantMessageEventStream();
				// Deliberately not awaited: the run owns the stream's lifetime, and a failure that
				// cannot be retried comes back as an error event on it rather than as a rejection out
				// of the stream function (which the engine's contract forbids anyway).
				void this.pumpAttempts(state, outer, model as Model, context, options);
				return outer;
			},
		};

		try {
			// The transcript and the tools are built per run — the engine keeps no state of its own —
			// and both are rebuilt for the request that actually goes out by the fill chain anyway.
			// The engine's take points read this session's own queues, so nothing is wired in.
			await this.runEngine(state, transport, start);
		} finally {
			// A message accepted in the last moment of the run — after the engine had already decided to
			// stop looking for one — is on a queue nothing will drain, so it is dropped here rather than
			// carried into a later run. The ordinary end path has already emptied both lists by this
			// point, which is what makes this a no-op for a run that ended the way it should.
			//
			// A suspended run is the exception: its queues are what the recovery run drains, and the
			// message someone typed while this run was streaming is theirs, not this run's to bin.
			// A drop that took something is a queue change the window has not heard yet, so it is the
			// one end path that publishes here; a parked run keeps its queue and says nothing.
			if (!live.suspended && dropQueued(state)) emitQueueUpdate(state);
			// The model comes down with the run: an idle session answers from the catalog again, which
			// is what makes "in flight, read the run; idle, read the choice" a state rather than a
			// leak. The other readings are left as the run ended them — a suspended run's flag is
			// what says the session is parked, and it is the recovery run's or the abandonment
			// sweep's to clear, not the end path's.
			live.model = undefined;
			// The run is not over until the engine's `runEngine` resolves — after every awaited listener for
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
			publishState(state, this.services);
		}
	}

	/**
	 * The engine: one entry and one exit, over the context as it stands.
	 *
	 * The body is what `packages/loop` used to run, then what `Agent` ran as a method of its own
	 * (ADR-0008), and now a method of the object that owns the run (ADR-0012). Its seams are this
	 * object's: the run registers itself on the session's live half (`live.activeRun`, where an abort
	 * from any layer lands), every event goes through {@link Agent.dispatchEvent} — which
	 * persists it and fans it out — the per-turn fill is {@link Agent.prepareRequest}, and both
	 * take points drain this session's own queues. Nothing here
	 * outlives the stack, which is why the model the run is on is a local rather than a field: it is
	 * the one thing a request may replace, and a member would hand it to a second session's run. What
	 * crosses the stack is the live half's own slot, for the snapshot that reads it mid-delta.
	 *
	 * A run either starts on a prompt — which enters the transcript at the first drain point, exactly
	 * where a steered message enters on a later turn — or resumes: it opens on the transcript as it
	 * stands, and its first act is the recovery pass over the calls a previous run left dangling.
	 * Returns the messages the run produced.
	 */
	private async runEngine(
		state: AgentState,
		transport: ChatTransport,
		start: RunStart,
	): Promise<Message[]> {
		const { sessionManager, settings, tools } = this;
		// This run's values — the directory and the bash timeouts — collected once and carried by every
		// call the run makes: they are per-request facts that now travel as a value rather than being
		// closed over by a tool instance (ADR-0016).
		const run: ToolRunContext = this.runContext(state);
		const session = state.session;
		const live = state.live;
		if (live.activeRun !== undefined) {
			throw new Error(
				"A run is already in flight. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}

		const abortController = new AbortController();
		let settle = () => {};
		const promise = new Promise<void>((done) => {
			settle = done;
		});
		live.activeRun = { promise, resolve: settle, abortController };
		const signal = abortController.signal;

		// The model the run is on. Seeded from the choice as it stands; `prepareRequest` answers with
		// the one each request is actually sent with, so a synthesized failure still names a real model
		// even when the run dies before its first request. The slot on the live half is what a snapshot
		// outside this stack reads instead of going back to the catalog.
		let model: Model = modelFor(session.sessionSetting.model ?? {}, settings.modelCatalog(), transport);
		live.model = model;
		const hooks = this.toolCallHooks(session);
		const emit: AgentEventSink = (event) => this.dispatchEvent(state, event);

		try {
			const newMessages: Message[] = [];
			let currentContext: Context = {
				messages: [...sessionManager.buildSessionContext(session).messages],
				tools: this.declaredTools(tools, toolStateOf(sessionManager, session, settings, tools.names()).activeToolNames),
			};

			await emit({ type: "agent_start" });

			// Recovery pass (ADR-0006 §5): a call in the context that no tool result answers would make
			// the first request illegal, so every run closes what it finds before its first turn — a
			// grant re-runs the call, a denial and an orphan get synthesized results. A suspend here
			// (the grant this run resumed on did not clear the gate) ends the run before any request.
			let suspendedAtEntry = false;
			const dangling = danglingToolCallsOf(currentContext.messages);
			if (dangling.length > 0) {
				const recovered = await recoverPendingToolCalls(
					currentContext,
					dangling,
					{ answers: start.answers },
					hooks,
					tools,
					run,
					signal,
					emit,
				);
				for (const message of recovered.messages) {
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				suspendedAtEntry = recovered.suspended === true;
			}
			if (suspendedAtEntry) {
				// The recovery pass re-ran the granted call and the gate refused it again, so this run
				// ends the same way the last one did — and keeps the queues for the same reason.
				live.suspended = true;
				await emit({ type: "agent_end", messages: newMessages });
				return newMessages;
			}

			// The run's prompt occupies the first drain point: every turn — the first one included — is
			// `turn_start`, then a drain, then a request. A resumed run has no prompt; its recovered
			// results are already in the context. Steering is polled at the end of each turn, so the
			// earliest a steered message surfaces is after the first response.
			let pendingMessages: Message[] = start.prompt === undefined ? [] : [start.prompt];

			// Outer loop: continues when queued follow-up messages arrive after the agent would stop.
			while (true) {
				let hasMoreToolCalls = true;
				// Set when the gate suspends a batch: the run ends at that turn, before the take points.
				let suspended = false;

				// Inner loop: process tool calls and steering messages.
				while (hasMoreToolCalls || pendingMessages.length > 0) {
					await emit({ type: "turn_start" });

					// Process queued messages before the next assistant response. The run's own prompts drain
					// here on the first turn, exactly where a steered message drains on a later one.
					for (const message of pendingMessages) {
						await emit({ type: "message_start", message });
						await emit({ type: "message_end", message });
						currentContext.messages.push(message);
						newMessages.push(message);
					}
					pendingMessages = [];

					// The per-request fill chain (ADR-0006 §2): adopt the live row, record the selection,
					// replay the ledger into a view, compact it if it is over the window, build the prompt
					// from the live tool and approval answers, and hand the request back — built here, used
					// once, dropped.
					const requestUpdate = await this.prepareRequest(transport, currentContext, signal, state);
					if (requestUpdate) {
						currentContext = requestUpdate.context ?? currentContext;
						model = requestUpdate.model ?? model;
						// The model this request goes out with is the one a snapshot taken during it
						// should report, and the one the meter measures the answer against.
						live.model = model;
					}

					// A run can be cut short while its request is being built — an abort from `close()`,
					// a stop from the window — and `prepareRequest` has awaits of its own (a compaction
					// summary, the project instructions read off disk). A request issued after that point
					// would go out on a dead signal: nothing it returns could be used, and a transport is
					// free to answer an already-aborted call however it likes. Ending here is the same
					// ending an abort mid-stream gets, arrived at one step earlier.
					if (signal?.aborted === true) throw signal.reason ?? new Error("The run was aborted");

					// Stream assistant response.
					const message = await streamAssistantResponse(currentContext, model, signal, emit);
					newMessages.push(message);

					if (message.stopReason === "error" || message.stopReason === "aborted") {
						await emit({ type: "turn_end", message, toolResults: [] });
						await emit({ type: "agent_end", messages: newMessages });
						return newMessages;
					}

					const toolCalls = message.content.filter((block): block is ToolCall => block.type === "toolCall");

					const toolResults: ToolResultMessage[] = [];
					hasMoreToolCalls = false;
					if (toolCalls.length > 0) {
						// A "length" stop means the output was cut off by the token limit, so every tool call
						// in the message may carry truncated arguments. Fail them all instead of executing
						// potentially borked calls.
						const executedToolBatch =
							message.stopReason === "length"
								? await failToolCallsFromTruncatedMessage(toolCalls, emit)
								: await executeToolCalls(currentContext, message, hooks, tools, run, signal, emit);
						toolResults.push(...executedToolBatch.messages);
						hasMoreToolCalls = !executedToolBatch.terminate;
						suspended = executedToolBatch.suspended === true;
						if (suspended) live.suspended = true;

						for (const result of toolResults) {
							currentContext.messages.push(result);
							newMessages.push(result);
						}
					}

					await emit({ type: "turn_end", message, toolResults });

					// A suspended batch ends the run here: the take points are skipped, so nothing new is
					// taken into a run the gate has already stopped — what was accepted waits on the queues
					// and the caller's end-of-run sweep writes it, and the answer to the suspended call
					// arrives from outside any run to start the next one.
					if (suspended) break;

					pendingMessages = await this.drainTranscribed(live.steeringQueue, state);
				}

				// A suspend ends the follow-up side of the run with it: the queued messages were never
				// taken, and the run that would answer them is over.
				if (suspended) break;

				// The run would stop here. Take whatever the follow-up queue holds.
				const followUpMessages = await this.drainTranscribed(live.followUpQueue, state);
				if (followUpMessages.length > 0) {
					// Set as pending so the inner loop processes them.
					pendingMessages = followUpMessages;
					emitQueueUpdate(state);
					continue;
				}

				break;
			}

			await emit({ type: "agent_end", messages: newMessages });
			return newMessages;
		} catch (error) {
			// A throw outside the engine's own error encoding — a bug in the engine, or persistence that
			// escaped its own handling — still surfaces as a complete event stream so subscribers see a
			// terminal state.
			await this.handleRunFailure(emit, model, error, signal.aborted);
			return [];
		} finally {
			this.finishRun(state);
		}
	}

	/**
	 * The two tool-call gates, as this run's own pair.
	 *
	 * The batch helpers are file-level and hold no session, so the run hands them the seams it needs:
	 * the session's `before_tool` gate and its `after_tool` one. An `after_tool` rewrite is final —
	 * the message is written with exactly the content the hooks left — so neither gate closes over the
	 * run's transients any more; the session id is all either one reads through.
	 */
	private toolCallHooks(state: Session): ToolCallHooks {
		const sessionId = state.sessionId;
		return {
			beforeToolCall: async ({ toolCall, args }) =>
				this.beforeTool(sessionId, toolCall.id, toolCall.name, args),
			afterToolCall: async ({ toolCall, result, isError }) =>
				this.afterTool(sessionId, toolCall.id, toolCall.name, result, isError),
		};
	}

	/**
	 * Write the failure a run died of as a message, and close the run's event stream with it.
	 *
	 * The message is synthesized rather than reported: a run that threw has no assistant message to
	 * point at, and a subscriber that only ever sees `agent_end` would have no account of why nothing
	 * came back. The model named is the one the last request was made with.
	 */
	private async handleRunFailure(
		emit: AgentEventSink,
		model: Model,
		error: unknown,
		aborted: boolean,
	): Promise<void> {
		const failureMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			model: model.id,
			usage: NO_USAGE,
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		} satisfies Message;
		await emit({ type: "message_start", message: failureMessage });
		await emit({ type: "message_end", message: failureMessage });
		await emit({ type: "turn_end", message: failureMessage, toolResults: [] });
		await emit({ type: "agent_end", messages: [failureMessage] });
	}

	/** Settle the run: fire the promise idle-waiters sleep on, then give the slot up. */
	private finishRun(state: AgentState): void {
		state.live.activeRun?.resolve();
		state.live.activeRun = undefined;
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
		context: Context,
		signal: AbortSignal | undefined,
		state: AgentState,
	): Promise<AgentRequestUpdate> {
		const { sessionManager, settings, tools, hooks, systemPrompt } = this;
		const session = state.session;
		// The model this request is made with, built from the live row before anything else reads it,
		// because the compaction decision below is measured against its context window and a threshold
		// taken from a window the row had a moment ago would compact the wrong transcript. This is the
		// whole of "an edit takes effect without reopening anything": the endpoint, the wire id, the
		// window, and the key are read here, from the catalog, and never captured when the session was
		// assembled. A row that is gone — deleted, or renamed under a session that was using it —
		// leaves the choice as it is, and `unconfiguredStream` is what answers for that.
		const catalog = settings.modelCatalog();
		const model = modelFor(session.sessionSetting.model ?? {}, catalog, transport);
		// The choice this request is made with reaches the transcript here, at the moment a request
		// is built from it — so a model or a level the user moved and never sent with is not in the
		// file at all. It runs before the compaction decision below, which measures the prompt
		// against this model's window.
		this.recordSelection(session, catalog);
		// One pass decides both what the request carries and whether it has to be summarized: the
		// trigger, the clearing of stale tool results, and the summary all read the same entries, so the
		// decision and the request cannot disagree about how large the prompt is.
		const entries = await this.compactFor(
			state,
			sessionManager.buildContextEntries(session),
			Date.now(),
			signal,
			model,
		);
		// The prompt is rebuilt here, not remembered: `applyConfig` can move the approval set and
		// `setActiveTools` the tool set, and the model must be told about both on the next request.
		// Both are derived from the ledger at this moment, so a choice that just landed is what the
		// prompt describes.
		const toolState = toolStateOf(sessionManager, session, settings, tools.names());
		// The project instructions are read here, per request, rather than taken from the state: an
		// edit to a file on disk is meant to reach the very next request, the same way an edit to a
		// model row does, and the walk is a handful of stats. What it costs is a prompt that can change
		// between two requests of one run — the tool set already can, for the same reason.
		const agentsMd = await loadAgentsMd(session.sessionSetting.workDirAbsPath);
		const prompt = systemPrompt(
			session.sessionSetting.workDirAbsPath,
			agentsMd,
			toolState.activeToolNames,
			approvalsOf(this.services, session),
		);
		// The tool results the request carries are read replay-side (`buildContextEntries` applied the
		// ledger's own view records), so there is no per-request pass over them: a tool result in the
		// ledger is already the version the model is served.
		const injected = { sessionId: session.sessionId, messages: messagesOf(entries), systemPrompt: prompt };
		const rewritten = await hooks.apply("context", injected);
		// The leading system message is replaced rather than appended to, and every other system
		// message is dropped: the prompt is rebuilt whole on this request, so a second one would
		// describe a state that is already gone. A hook that wants to change the prompt returns
		// `systemPrompt`; one that pushes a system message into `messages` loses it here.
		const system = createSystemMessage(rewritten?.systemPrompt ?? injected.systemPrompt);
		// A compaction checkpoint is already the user turn it stands for — `sessionEntryToContextMessages`
		// wraps the summary in tags — so the transcript goes to the provider as it is.
		const conversation = pairLateToolResults((rewritten?.messages ?? injected.messages).filter((message) => message.role !== "system"));
		return {
			// Built above, from the row this request is made with: run-local, used for the one
			// request, dropped.
			model,
			context: {
				...context,
				messages: system === undefined ? conversation : [system, ...conversation],
				// The live set, taken from the one table by the choice derived above: the array is new per
				// request, its elements are the table's own instances. The engine declares it on the
				// request (`toToolDeclaration`) rather than reading it out of the transcript, so a tool
				// switched on mid-session reaches the model on the next request and the two cannot drift.
				tools: this.declaredTools(tools, toolState.activeToolNames),
			},
		};
	}

	/**
	 * The tools one request declares: the names this request derived, looked up in the one table.
	 *
	 * The array is rebuilt per request — a session can narrow or widen its set between two of them —
	 * while its elements are the table's own instances, so two requests of one session, or two
	 * sessions, hold the same objects (ADR-0016).
	 */
	private declaredTools(manager: ToolManager, names: readonly string[]): Tool<any>[] {
		const declared: Tool<any>[] = [];
		for (const name of names) {
			const tool = manager.get(name);
			if (tool !== undefined) declared.push(tool);
		}
		return declared;
	}

	/**
	 * The value objects this run's tools are called with: the working directory, read off the
	 * session's own setting, and the bash timeouts, read off the settings the same way. Collected
	 * once per run and carried by every call it makes — nothing here outlives the run that reads it.
	 */
	private runContext(state: AgentState): ToolRunContext {
		const workDirAbsPath = state.session.sessionSetting.workDirAbsPath;
		return {
			workDirAbsPath,
			// Read live, like every other settings read: a timeout the user moved reaches the next
			// run's calls without anything being reopened.
			bash: this.settings.getBashSettings(workDirAbsPath),
		};
	}

	/**
	 * Write what this request is being made with into the session, once per move.
	 *
	 * The model and the level are recorded here rather than where the user chose them, because these
	 * are the transcript's account of what answered a turn: a row the user picked and never
	 * sent with answered nothing, and a level that was never asked at was never in force. The write
	 * baseline is the snapshot on disk, read fresh — not the bag, which already carries the choice in
	 * force (`applyModelSelection` and the assembly seed put it there, issue 03 §7), so comparing
	 * against the bag would be self-comparison and a level-only move would never reach the file. A
	 * run of turns on one selection still costs one write: when the disk already says what is in
	 * force, nothing is written.
	 *
	 * The catalog is the caller's, so this and the model the request is built with read the file once
	 * between them. A choice no row answers records no row — there is no wire id to write, and the
	 * request it belongs to is about to be refused by the transport rather than sent; its level, if
	 * it has one, still records. This is the one place a choice reaches the disk: `applyModelSelection`
	 * and the assembly seed only move the in-memory field (issue 03 §7), and the request made with the
	 * choice is what commits it. The setters run first to keep the bag the whole truth (the wire id
	 * only lands here), then the flush carries whatever the bag holds to the snapshot — the setters'
	 * own gates compare against the bag, so a level already in the bag passes them silently.
	 */
	private recordSelection(session: Session, catalog: readonly ModelConfig[]): void {
		const { sessionManager } = this;
		const recorded = sessionManager.recordedOnDisk(session);
		const row = rowFor(session.sessionSetting.model ?? {}, catalog);
		const level = normalizeThinkingLevel(session.sessionSetting.model?.thinkingLevel) as ThinkingLevel;
		if (
			level === recorded.thinkingLevel &&
			(row === undefined || (row.name === recorded.model?.name && row.id === recorded.model?.modelId))
		) {
			return;
		}
		if (row !== undefined) sessionManager.setModel(session, row.name, row.id);
		sessionManager.setThinkingLevel(session, level);
		sessionManager.flushMeta(session);
	}

	/**
	 * Run one provider call through the retry policy, pumping it into the stream the engine reads.
	 *
	 * Retries live on the transport, below the engine, because an error response is a hard exit: the
	 * engine emits `turn_end` and `agent_end` the moment a stream ends in `stopReason: "error"` and
	 * returns, so there is no later turn in which a failed assistant message could be rewritten. Below
	 * the engine the failed attempt is never a message at all: the transcript gains exactly one
	 * assistant message, the store keeps none of the failures, and the next request has no leftover
	 * error to explain.
	 *
	 * `retryAssistantCall` owns the classification, the backoff, and abort normalization — an abort
	 * during the sleep comes back as an aborted message — so nothing here counts attempts or sleeps. It
	 * wants `() => Promise<AssistantMessage>`, so each attempt is drained here and its events are
	 * forwarded as they arrive; only the terminal event is decided after the attempt, because that is
	 * what says whether this attempt is the one the engine gets to keep.
	 *
	 * The engine must see exactly one `start`: on a retry the failed attempt already put a partial
	 * message in its context, and a second `start` would append a second assistant message instead of
	 * replacing the abandoned one. So `start` is forwarded once per request and the retried attempt's
	 * deltas overwrite that same slot in place.
	 */
	private async pumpAttempts(
		state: AgentState,
		outer: AssistantMessageEventStream,
		model: Model,
		context: Context,
		options: SimpleStreamOptions | undefined,
	): Promise<void> {
		const { settings, api } = this;
		const live = state.live;
		let started = false;
		const produce = async (): Promise<AssistantMessage> => {
			// A session with no row has nothing to send with, so it answers with the sentence that says
			// what to do instead of a request to a placeholder endpoint.
			const inner =
				settings.modelCatalog().find((userModel) => userModel.name === model.name) === undefined
					? unconfiguredStream(model)
					: await api.stream(model, context, options);
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

		// One read for the whole pump: the policy the retry loop enforces and the `maxAttempts` the
		// `retry_start` event reports are the same answer, taken at the call site rather than stored —
		// a settings edit mid-backoff lands with the next request, not this one. The counting matches
		// `retryAssistantCall`'s own: retries, not calls.
		const retrySettings = settings.getRetrySettings(state.session.sessionSetting.workDirAbsPath);
		const maxAttempts = retrySettings.enabled ? retrySettings.maxRetries : 0;
		let final: AssistantMessage;
		try {
			final = await retryAssistantCall(
				produce,
				retrySettings,
				options?.signal,
				this.retryCallbacks(state, maxAttempts),
			);
		} catch (error) {
			// A stream function that throws breaks the engine's contract, so it ends up as an error
			// message here rather than as a rejected promise nobody is left to catch.
			final = error instanceof ContextOverflow ? error.message : failureMessage(model, error);
		}
		// A retry the policy never announced an end for — the run was cut short above — still has to
		// close, or `isRetrying` would outlive the run.
		if (live.retrying) this.endRetry(state, false, live.retryAttempt, final.errorMessage);
		pushTerminal(outer, final);
		outer.end();
	}

	/**
	 * The three notifications `retryAssistantCall` makes, mapped one-to-one onto session events.
	 *
	 * `maxAttempts` arrives from the pump — the one read of the policy this run's retries answer to —
	 * because the callback the policy makes for `retry_start` carries no policy of its own, and
	 * nothing here stores the answer between events.
	 */
	private retryCallbacks(state: AgentState, maxAttempts: number): RetryCallbacks {
		const live = state.live;
		return {
			onRetryScheduled: (attempt, scheduledMax, delayMs, errorMessage) => {
				live.retrying = true;
				live.retryAttempt = attempt;
				emitEvent(state, {
					type: "retry_scheduled",
					attempt,
					maxAttempts: scheduledMax,
					delayMs,
					errorMessage,
				});
				publishState(state, this.services);
			},
			onRetryAttemptStart: () => {
				emitEvent(state, {
					type: "retry_start",
					attempt: live.retryAttempt,
					maxAttempts,
				});
				publishState(state, this.services);
			},
			onRetryFinished: (success, attempt, finalError) =>
				this.endRetry(state, success, attempt, finalError),
		};
	}

	/** Leave the retrying state and say how the retry ended. */
	private endRetry(
		state: AgentState,
		success: boolean,
		attempt: number,
		finalError?: string,
	): void {
		state.live.retrying = false;
		state.live.retryAttempt = 0;
		emitEvent(state, { type: "retry_end", success, attempt, finalError });
		publishState(state, this.services);
	}

	// ---------------------------------------------------------------------------- compaction


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
		state: AgentState,
		entries: readonly SessionEntry[],
		now: number,
		signal: AbortSignal | undefined,
		model: Model,
	): Promise<readonly SessionEntry[]> {
		const { sessionManager, settings } = this;
		const threshold = compactionThresholdFor(model.contextWindow);
		if (!shouldCompact(messagesOf(entries), threshold)) return entries;

		const trimmed = this.trimRecordedArgs(state, entries);
		if (!shouldCompact(messagesOf(trimmed), threshold)) return trimmed;

		const cleared = this.clearStaleToolResults(state, trimmed, now);
		if (!shouldCompact(messagesOf(cleared), threshold)) return cleared;

		// The one completion compaction makes: the same model the turn is on, with the summary
		// instructions. It is the caller's model — the one this request is built from — so the summary
		// carries the same key, endpoint, and window as the conversation it summarizes rather than
		// reaching for a second configuration.
		const summarize: Summarize = async (request) => {
			// The same absence a turn meets: a session with no row answers with the sentence that says what
			// to add, rather than sending a summary request to a placeholder endpoint.
			if (settings.modelCatalog().find((userModel) => userModel.name === model.name) === undefined) {
				return unconfiguredStream(model).result();
			}
			const messages: Message[] = [
				{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() },
			];
			return model
				.stream({ messages, system: createSystemMessage(request.systemPrompt), tools: [] }, {
					// The row's key, said here rather than only carried on the model: this is the one call
					// that does not travel through the engine, and the engine is what copies the key into options.
					apiKey: model.apiKey,
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
				emitEvent(state, {
					type: "compaction_failed",
					message: error instanceof Error ? error.message : String(error),
				});
			}
			return cleared;
		}
		if (!outcome) return cleared;

		sessionManager.appendCompaction(
			state.session,
			outcome.summary,
			outcome.firstKeptEntryId,
			outcome.tokensBefore,
			outcome.usage,
		);
		// Published after the transcript moved, so a listener that reacts reads back the same numbers:
		// `summarized` is what this pass folded in, `contextTokens` is what the provider will now be sent.
		const compacted = sessionManager.buildContextEntries(state.session);
		emitEvent(state, {
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
	 * the files they changed, so the view loses nothing the machine does not hold. It is also the
	 * reason this runs before the clear rather than beside it:
	 * the clear needs an expired cache to be worth its cache invalidation, and this does not, because
	 * when the transcript is over the trigger the next request is in trouble whatever the cache says.
	 */
	private trimRecordedArgs(
		state: AgentState,
		entries: readonly SessionEntry[],
	): readonly SessionEntry[] {
		const { sessionManager } = this;
		const trimmed = trimmableToolArgEntryIds(entries);
		if (trimmed.length === 0) return entries;

		const tokensBefore = estimateTokens(messagesOf(entries));
		sessionManager.appendTrimToolCallArgs(state.session, trimmed, tokensBefore);
		const view = sessionManager.buildContextEntries(state.session);
		emitEvent(state, {
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
		state: AgentState,
		entries: readonly SessionEntry[],
		now: number,
	): readonly SessionEntry[] {
		const { sessionManager } = this;
		if (!isCacheProbablyExpired(entries, now)) return entries;

		const cleared = clearableToolResultIds(entries);
		if (cleared.length === 0) return entries;

		const tokensBefore = estimateTokens(messagesOf(entries));
		sessionManager.appendClearToolResults(state.session, cleared, tokensBefore);
		const view = sessionManager.buildContextEntries(state.session);
		emitEvent(state, {
			type: "tool_results_cleared",
			cleared: cleared.length,
			tokensBefore,
			contextTokens: estimateTokens(messagesOf(view)),
		});
		return view;
	}

	// ---------------------------------------------------------------------------- the run's event half

	/**
	 * Run the `before_tool` hooks.
	 *
	 * The engine's seam can block a call, suspend one, or let it through, so those are the decisions
	 * that reach it: an `args` refinement goes as far as the handlers registered after this one. A
	 * suspend comes from the approval gate, and it is the whole end-restart move (ADR-0006 §5): the
	 * engine ends the run at that call without writing a result, the call dangles in the ledger, and
	 * the answer that arrives over REST starts the recovery run that closes it.
	 *
	 * The gate's own answer is the effective approval map, which the default handler reads through
	 * `authorize` — the same merge the snapshot and the prompt describe, so the three cannot disagree.
	 */
	private async beforeTool(
		sessionId: string,
		toolCallId: string,
		toolName: string,
		args: unknown,
	): Promise<BeforeToolCallResult | undefined> {
		const decided = await this.hooks.apply("before_tool", { sessionId, toolCallId, toolName, args });
		if (decided?.suspend === true) return { suspend: true };
		if (decided?.block === undefined) return undefined;
		return {
			block: true,
			reason: decided.block.reason,
			...(decided.terminate === true ? { terminate: true } : {}),
		};
	}

	/**
	 * Run the `after_tool` hooks. Their answer is final.
	 *
	 * The engine builds the transcript message from what this returns, and the message is written with
	 * exactly that content: a rewrite is a decision about the one version of the result that will ever
	 * exist, made the moment the result does. A hook that means to bound a result archives the full
	 * text itself (`archiveToolResult`, `context/spill.ts`) and puts the path in what it returns; the
	 * write boundary's backstop below still catches a result nobody bounded.
	 */
	private async afterTool(
		sessionId: string,
		toolCallId: string,
		toolName: string,
		result: ToolResult<unknown>,
		isError: boolean,
	): Promise<AfterToolCallResult | undefined> {
		const decided = await this.hooks.apply("after_tool", {
			sessionId,
			toolCallId,
			toolName,
			content: result.content,
			isError,
		});
		if (decided?.content === undefined) return undefined;
		return { content: decided.content };
	}

	/**
	 * Drain one queue, writing each message to the transcript the moment it is taken.
	 *
	 * The write rides the drain rather than the engine's echo of it: taking a message off the queue is
	 * the moment the run takes responsibility for it, so the ledger gains it there and the gap where
	 * a message was neither queued nor stored never opens. The echo never persists user messages, so
	 * nothing has to mark these as already written.
	 */
	private drainTranscribed(queue: PendingMessageQueue, state: AgentState): Message[] {
		const messages = queue.drain();
		for (const message of messages) {
			appendMessageEntry(state, this.sessionManager, message);
		}
		return messages;
	}

	/**
	 * The engine's sink: persist what the run reports, and pass it on.
	 *
	 * This is the one listener a run has — the engine awaits it, which is what makes a run settle only
	 * after its writes landed — and the run's transients are this handler's closure rather than
	 * anything on the session. It is the successor of the `Loop.subscribe` callback the engine used to
	 * be handed, and it is why the engine needs no listener registry of its own.
	 */
	private async dispatchEvent(state: AgentState, event: AgentEvent): Promise<void> {
		const live = state.live;
		if (event.type === "message_update") {
			// The hot path: one event per provider delta. Keep the running message for a baseline that
			// has to hand a mid-run attach the text it missed, and publish only what moved since the
			// last frame. Nothing is written here — the message is persisted when it ends.
			live.partial = event.message;
			const delta = messageDeltaOf(event);
			if (delta !== undefined) emitEvent(state, { type: "message_update", delta });
			return;
		}
		if (event.type === "message_end" || event.type === "agent_end") live.partial = undefined;
		if (event.type === "message_end") {
			// The echo never persists a user message: every one of them reached the engine already
			// written — the prompt before the run started, a queued message at the drain. Everything
			// else the engine announces has no other writer and is written here as it stands —
			// the content is final by the time it lands (the write boundary is the last rewrite).
			if (event.message.role !== "user") {
				appendMessageEntry(state, this.sessionManager, event.message);
			}
		}
		if (event.type === "agent_end" && !live.suspended) {
			// A message still queued is one the run never reached — an abort, a failure, a prompt that
			// arrived in the moment the engine stopped looking. Nothing will drain it, and the send
			// contract is fire-and-forget: it goes with the run, and the queues empty so the depth
			// falls to zero, which is what `settle()` waits on. See `dropQueued`.
			//
			// A run the gate ended is the one exception, and it is checked here rather than only in
			// `run`'s `finally` because this fires first: the recovery run drains what this one
			// leaves behind, so the depth stays up and the window keeps showing it.
			if (dropQueued(state)) emitQueueUpdate(state);
		}
		emitEvent(state, event);
		if (event.type === "message_start" || event.type === "message_end" || event.type === "turn_end") {
			publishState(state, this.services);
		}
	}}

/**
 * The approval keys whose value differs, or undefined when none do.
 *
 * `config_changed` carries only what moved, so an `applyConfig` that re-sends the current settings —
 * which is what a reconnect or an unchanged form does — must not claim anything changed.
 */
function changedApprovals(
	before: Record<string, boolean>,
	after: Record<string, boolean>,
): Record<string, boolean> | undefined {
	const changed: Record<string, boolean> = {};
	let moved = false;
	for (const [key, value] of Object.entries(after)) {
		if (before[key] === value) continue;
		changed[key] = value;
		moved = true;
	}
	return moved ? changed : undefined;
}

// ---------------------------------------------------------------------------- the engine's machinery
//
// Everything below is stateless: a turn's stream, a tool batch, the recovery pass, and the shapes
// they pass between themselves. It runs outside any instance and takes the two tool-call gates as
// the run's own `ToolCallHooks`, which is why it is a set of functions rather than more methods.
// The recovery machine is exported because it is a contract a smoke drives directly (ADR-0006 §5);
// the rest is private to this file.

/** Where one run's events go. Awaited, so a run settles only after what it emitted has been handled. */
type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
	/**
	 * The gate suspended the batch: the call it stopped on and every call after it have no result,
	 * and the run ends without another request — the answer the gate waits for comes from outside
	 * any run, and the host resumes the calls through a recovery run.
	 */
	suspended?: boolean;
};

/**
 * A call that passed the gate and the schema: what to run, with which arguments.
 *
 * It names the tool and carries the arguments; it does not carry the tool object. Execution resolves
 * the name against the table again, so what runs is the table's instance rather than a reference
 * taken earlier (the table is append-only, so the two are the same object — `ToolManager.execute`).
 */
type PreparedToolCall = {
	kind: "prepared";
	toolCall: ToolCall;
	args: unknown;
};

type SuspendedToolCall = {
	kind: "suspended";
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: ToolResult<unknown>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: ToolResult<unknown>;
	isError: boolean;
};

type ToolUpdateSink = (partialResult: ToolResult<unknown>) => Promise<void> | void;

type FinalizedToolCallEntry = ToolCallOutcome | (() => Promise<ToolCallOutcome>);

/**
 * Stream one assistant response from the model, into the transcript and out through the sink.
 *
 * The model carries its own transport — the run's retry-wrapping one — so this asks the model it was
 * handed and the request is authed with exactly the key that model carries. Tools reach the request
 * as a parameter, not as a message, so the set this request offers is declared here:
 * `toToolDeclaration` keeps the name, description, and schema and drops the rest. The system prompt
 * stays where the caller put it — a leading system message — and the transport reads it from there
 * when the request carries no explicit `system`.
 */
async function streamAssistantResponse(
	context: Context,
	model: Model,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<AssistantMessage> {
	const requestContext: Context = {
		messages: context.messages,
		tools: context.tools.map((tool) => toToolDeclaration(tool)),
	};

	const response = await model.stream(requestContext, {
		apiKey: model.apiKey,
		signal,
	});
	// Record the requested level, whichever stream function answered. It is read off the model the
	// request was made with, so the transcript cannot report a strength the wire never carried.
	// A thunk, not a value: the stream only has a final message once it is drained, and both exits
	// below ask for it after the loop has seen the terminal event.
	const settled = async () =>
		Object.assign(await response.result(), { thinkingLevel: model.thinkingLevel ?? "off" });

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await settled();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await settled();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * Fail all tool calls from an assistant message that was truncated by the output token limit.
 *
 * Streamed tool-call arguments are finalized with a best-effort JSON salvage parser, so a truncated
 * message can yield tool calls whose arguments parse and validate but are silently incomplete. None of
 * them are safe to execute; report each as an error so the model can re-issue them.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: ToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: ToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/** One tool call the transcript still waits on: the call block, and the message that issued it. */
export type DanglingToolCall = {
	toolCall: ToolCall;
	assistantMessage: AssistantMessage;
};

/**
 * The tool calls in a context that no tool-result message answers, in transcript order.
 *
 * A call dangles when its run ended before the result landed — a crash, or the end-restart approval
 * gate, which leaves the call it stopped on unanswered on purpose. Either way a provider request that
 * carries it is illegal, which is why every run closes what it finds before its first request.
 */
export function danglingToolCallsOf(messages: Message[]): DanglingToolCall[] {
	const calls: DanglingToolCall[] = [];
	const answered = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			answered.add(message.toolCallId);
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			calls.push({ toolCall: block, assistantMessage: message });
		}
	}
	return calls.filter(({ toolCall }) => !answered.has(toolCall.id));
}

/**
 * Close the dangling calls a run was entered with, before its first request.
 *
 * The recovery machine of the end-restart architecture (ADR-0006 §5): an answer closes the call with
 * itself — a grant re-runs the call through the same steps a live batch uses (gate, validation,
 * execution, `afterToolCall`), so the resumed call is indistinguishable from one the model just
 * issued; a denial synthesizes the result its reason names. A call no answer names is closed with a
 * synthesized error result while `enablePendingToolRecovery` allows it. Every closed call emits the
 * events its counterpart in a live batch would, so the window and the store learn of it the same way
 * as any other tool result.
 *
 * A gate that suspends again mid-recovery — the grant this run resumed on did not actually clear it —
 * stops the recovery where it stands: the remaining calls stay dangling and the caller ends the run
 * without a request, exactly as a live batch's suspend does.
 *
 * Exported because it is the one part of the engine a host can drive without a run: the smoke that
 * pins this contract calls it with a transcript, a set of answers, and the table the calls run
 * against — no orchestrator, no run of its own. The resume is a run of its own, so the table and the
 * run values arrive the way they do everywhere else on this chain: as arguments, not through the
 * context.
 */
export async function recoverPendingToolCalls(
	currentContext: Context,
	dangling: DanglingToolCall[],
	recovery: RunRecoveryOptions | undefined,
	hooks: ToolCallHooks,
	manager: ToolManager,
	run: ToolRunContext,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const answers = recovery?.answers ?? {};
	const enabled = recovery?.enablePendingToolRecovery !== false;
	const messages: ToolResultMessage[] = [];

	for (const { toolCall, assistantMessage } of dangling) {
		const answer = answers[toolCall.id];
		if (answer !== undefined && answer.approved) {
			const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, hooks, manager, signal);
			if (preparation.kind === "suspended") {
				return { messages, terminate: true, suspended: true };
			}
			await emit({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.arguments,
			});
			let finalized: ToolCallOutcome;
			if (preparation.kind === "immediate") {
				finalized = { toolCall, result: preparation.result, isError: preparation.isError };
			} else {
				const executed = await executePreparedToolCall(
					preparation,
					manager,
					run,
					signal,
					emitToolExecutionUpdate(toolCall, emit),
				);
				finalized = await finalizeExecutedToolCall(currentContext, assistantMessage, preparation, executed, hooks, signal);
			}
			await emitToolExecutionEnd(finalized, emit);
			const toolResultMessage = createToolResultMessage(finalized);
			await emitToolResultMessage(toolResultMessage, emit);
			messages.push(toolResultMessage);
			continue;
		}
		// Toggle off is the host taking the calls into its own hands: they go to the provider
		// unanswered, and nothing is synthesized for them here.
		if (answer === undefined && !enabled) continue;
		const text =
			answer !== undefined
				? answer.reason ?? `The user denied permission to run ${toolCall.name}.`
				: `Tool call "${toolCall.name}" was left unanswered: the run that issued it ended before a result landed. Issue the call again if it is still needed.`;
		messages.push(await synthesizeToolResult(toolCall, text, emit));
	}
	return { messages, terminate: true };
}

/** Close one unanswered call with a synthesized error result, carrying the events of a live batch. */
async function synthesizeToolResult(
	toolCall: ToolCall,
	text: string,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	await emit({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
	});
	const finalized: ToolCallOutcome = {
		toolCall,
		result: createErrorToolResult(text),
		isError: true,
	};
	await emitToolExecutionEnd(finalized, emit);
	const toolResultMessage = createToolResultMessage(finalized);
	await emitToolResultMessage(toolResultMessage, emit);
	return toolResultMessage;
}

/**
 * Execute the tool calls one assistant message issued: sequential when any of them says so, parallel
 * otherwise. Both paths prepare the calls in source order and write their results as messages.
 *
 * The mode is read off the table rather than off what the request declared: a call's behaviour is a
 * property of the tool, and the table is where the tool lives.
 */
async function executeToolCalls(
	currentContext: Context,
	assistantMessage: AssistantMessage,
	hooks: ToolCallHooks,
	manager: ToolManager,
	run: ToolRunContext,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((block): block is ToolCall => block.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => manager.get(tc.name)?.executionMode === "sequential",
	);
	if (hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, hooks, manager, run, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, hooks, manager, run, signal, emit);
}

async function executeToolCallsSequential(
	currentContext: Context,
	assistantMessage: AssistantMessage,
	toolCalls: ToolCall[],
	hooks: ToolCallHooks,
	manager: ToolManager,
	run: ToolRunContext,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: ToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		// Prepared before it is announced: a suspended call is announced never — the gate ended the
		// run at it, no result is written, and the events stay silent so the window shows no card for
		// a call that never ran. The call and everything after it in the batch stay unanswered.
		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, hooks, manager, signal);
		if (preparation.kind === "suspended") {
			return { messages, terminate: true, suspended: true };
		}
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		let finalized: ToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(
				preparation,
				manager,
				run,
				signal,
				emitToolExecutionUpdate(toolCall, emit),
			);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				hooks,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: Context,
	assistantMessage: AssistantMessage,
	toolCalls: ToolCall[],
	hooks: ToolCallHooks,
	manager: ToolManager,
	run: ToolRunContext,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];
	let suspended = false;

	for (const toolCall of toolCalls) {
		// Prepared before it is announced, as in the sequential path: a suspended call gets no events
		// and no result, and the calls after it are not prepared either. The calls already queued
		// above run to completion — they were underway when the gate answered.
		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, hooks, manager, signal);
		if (preparation.kind === "suspended") {
			suspended = true;
			break;
		}
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies ToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			if (signal?.aborted) {
				const finalized = {
					toolCall,
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				} satisfies ToolCallOutcome;
				await emitToolExecutionEnd(finalized, emit);
				return finalized;
			}
			const executed = await executePreparedToolCall(
				preparation,
				manager,
				run,
				signal,
				emitToolExecutionUpdate(toolCall, emit),
			);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				hooks,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: suspended || shouldTerminateToolBatch(orderedFinalizedCalls),
		suspended: suspended || undefined,
	};
}

function shouldTerminateToolBatch(finalizedCalls: ToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: Tool<any>, toolCall: ToolCall): ToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

/**
 * Resolve one call's tool and take it through the steps that precede execution.
 *
 * The tool is resolved against the process table, not against what the request declared: the table
 * is the one place a tool lives (ADR-0016), and the declaration is that table's view for the
 * transport. `prepareArguments` and the schema validation then read the fields of the resolved
 * instance, so the shim the model's arguments are shaped by and the code that runs them are the
 * same object. An unknown name is answered here, before the gate, because a call nobody can run is
 * not a call to ask permission for.
 */
async function prepareToolCall(
	currentContext: Context,
	assistantMessage: AssistantMessage,
	toolCall: ToolCall,
	hooks: ToolCallHooks,
	manager: ToolManager,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome | SuspendedToolCall> {
	const tool = manager.get(toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (hooks.beforeToolCall) {
			const beforeResult = await hooks.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			// The gate ended the run at this call: no result is written for it here — the caller sees
			// `suspended` on the batch and ends the run, and a recovery run closes the call from the
			// answer that arrives later. `block` alongside it would write a result, so suspend wins.
			if (beforeResult?.suspend === true) {
				return { kind: "suspended" };
			}
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

function emitToolExecutionUpdate(toolCall: ToolCall, emit: AgentEventSink): ToolUpdateSink {
	return (partialResult) =>
		emit({
			type: "tool_execution_update",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
			partialResult,
		});
}

/** Options for {@link runToolCall}. */
interface RunToolCallOptions extends ToolCallHooks {
	/** The table the nested call resolves and runs against. */
	manager: ToolManager;
	/** This call's run values: the directory it acts in and the bash timeouts it runs under. */
	run: ToolRunContext;
	/** Passed to the hooks as the message that issued the call. */
	assistantMessage: AssistantMessage;
	/** Passed to the hooks as the current agent context. */
	context: Context;
	signal?: AbortSignal;
	onUpdate?: ToolUpdateSink;
}

/**
 * Run one tool call through the same steps as a model-issued call: argument preparation, schema
 * validation, `beforeToolCall`, execution, and `afterToolCall`. Emits no events and adds no
 * messages. Tools that call other tools use this so the hooks (for example permission checks)
 * apply to those calls too.
 *
 * Never rejects for tool failures: unknown tools, validation errors, blocked calls, and thrown
 * errors come back as `isError: true`. Nothing in this build calls it yet — a tool that wants to
 * nest another call would — so it stays internal to this file rather than exported.
 */
async function runToolCall(toolCall: ToolCall, options: RunToolCallOptions): Promise<ToolCallOutcome> {
	const { assistantMessage, context, signal } = options;
	const preparation = await prepareToolCall(context, assistantMessage, toolCall, options, options.manager, signal);
	if (preparation.kind === "immediate") {
		return { toolCall, result: preparation.result, isError: preparation.isError };
	}
	// A nested call has no batch to suspend and no run of its own to end, so the suspend comes back
	// as the error result it is: the tool did not run, and the caller sees why.
	if (preparation.kind === "suspended") {
		return {
			toolCall,
			result: createErrorToolResult(`Tool call "${toolCall.name}" was suspended before it ran`),
			isError: true,
		};
	}
	const executed = await executePreparedToolCall(
		preparation,
		options.manager,
		options.run,
		signal,
		options.onUpdate ?? (() => {}),
	);
	return finalizeExecutedToolCall(context, assistantMessage, preparation, executed, options, signal);
}

/**
 * Run a call that passed the gate, through the table.
 *
 * The name is resolved here rather than carried in `prepared`, so the only `Tool.execute` call in
 * production code is the table's own (`ToolManager.execute`, ADR-0016): what the engine owns is the
 * orchestration around one call — the update sink, the abort signal, and turning a throw into the
 * error result the model reads. An unknown name at this point is a bug upstream (the gate resolves
 * first) and lands in the same catch, as an error result.
 */
async function executePreparedToolCall(
	prepared: PreparedToolCall,
	manager: ToolManager,
	run: ToolRunContext,
	signal: AbortSignal | undefined,
	onUpdate: ToolUpdateSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await manager.execute(
			prepared.toolCall.name,
			prepared.toolCall.id,
			prepared.args,
			run,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(Promise.resolve(onUpdate(partialResult)));
			},
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: result.isError === true };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}

async function finalizeExecutedToolCall(
	currentContext: Context,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	hooks: ToolCallHooks,
	signal: AbortSignal | undefined,
): Promise<ToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (hooks.afterToolCall) {
		try {
			const afterResult = await hooks.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				// Structured content not replaced along with the content may no longer match it.
				const structuredContent =
					afterResult.structuredContent ?? (afterResult.content ? undefined : result.structuredContent);
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				if (structuredContent === undefined) delete result.structuredContent;
				else result.structuredContent = structuredContent;
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): ToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: ToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: ToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools can return results without content; normalize so the null never enters session
		// history or provider payloads.
		content: finalized.result.content ?? [],
		// A tool's details are arbitrary JSON the ledger stores verbatim, so the one narrowing this
		// file makes is here: the transcript's message shape says `JsonValue`, and the tool's own
		// `details` is untyped by design.
		details: finalized.result.details as JsonValue | undefined,
		usage: finalized.result.usage,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}

/**
 * What one run is started with: the message that opened it, or the answers a resume closes its
 * dangling calls with.
 *
 * The two are alternatives rather than fields that may both be set: a prompted run has nothing to
 * recover but what a crash left behind, and a resumed run has no new message — its first act is the
 * recovery pass over the calls the run before it left unanswered.
 */
export type RunStart =
	| { prompt: Message; answers?: undefined }
	| { prompt?: undefined; answers: Record<string, ToolCallAnswer> };


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

/** A stream function that threw, in the shape the engine ends a run on. */
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
 * The engine's terminal branch is driven by this event, and `AssistantMessageEventStream.result()`
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
