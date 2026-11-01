import type { ChatTransport } from "@my-agent/llm";
import type { AgentTool } from "@my-agent/loop";
import { Agent } from "./agent.ts";
import { loadAgentsMd, type AgentsMdFile } from "./context/agents-md.ts";
import { buildSystemPrompt } from "./context/system-prompt.ts";
import { spillOversizedToolResult } from "./context/spill.ts";
import { danglingApprovalsOf } from "./session/dangling.ts";
import { boundToolContent, createHooks, type Hooks } from "./hooks.ts";
import {
	DEFAULT_MODEL_NAME,
	fillModel,
	type ModelConfig,
	type ModelState,
	type ModelSource,
	normalizeThinkingLevel,
	placeholderModelState,
	resolvedModel,
} from "./models.ts";
import type { SessionSnapshot, ToolApprovalKey } from "./protocol.ts";
import {
	type SessionState,
	SessionManager,
	buildContextEntries,
	getAbsSessionFile,
	getRecordedSettings,
} from "./session/session-manager.ts";
import { sessionSnapshot } from "./session/snapshot.ts";
import {
	approvalToolsOf,
	followsGlobalOf,
	toolStateOf,
} from "./session/tool-config.ts";
import {
	SettingsManager,
	type SettingsState,
	getApprovals,
	getFollowUpMode,
	getSettings,
	getSteeringMode,
	inMemorySettingsState,
} from "./settings-manager.ts";
import { type ToolRegistry, type ToolState, createToolRegistry, registryView, toolDefinitions } from "./tools/index.ts";
import { createSubagentTools } from "./tools/subagent.ts";
import { createOpenSession, OpenSessions } from "./session/open-session.ts";
import { Workspace } from "./workspace.ts";

/** What a caller must supply to build a session. Everything else is discovered here. */
export interface OpenAgentOptions {
	/** The workspace the tools resolve inside, absolute. */
	absWorkspaceRoot: string;
	/**
	 * The stateless session service the bag-passing calls inside the session go through.
	 *
	 * A host that owns one — the hub, whose `stateOf` cache must be the same object the session
	 * writes through — hands its own in. Omitted means a fresh service, which behaves identically:
	 * the service is stateless (ADR-0007 §2) and its cache is only filled through `stateOf` and
	 * `forkFrom`, neither of which the session itself calls.
	 */
	sessionManager?: SessionManager;
	/**
	 * The transcript this session will read and write, as the bag every call names.
	 *
	 * Built by the caller rather than here, because deciding *which* session to open — a new one, the
	 * newest, one named by id — is the host's job, and a test opens an in-memory one instead.
	 */
	sessionState: SessionState;
	models: ModelSource;
	/** Overrides the stored default with a row's name. */
	model?: string;
	thinkingLevel?: string;
	/**
	 * The transport every request in this session goes over.
	 *
	 * Omitted in the real process, where it means Anthropic Messages. A smoke passes a scripted
	 * transport so the loop can be driven with no provider key.
	 */
	api?: ChatTransport;
	/**
	 * The settings service this session reads and writes through.
	 *
	 * Defaults to a fresh service. A host that owns one — the hub, whose per-workspace cache must be
	 * the same object every session over that workspace reads — hands its own in. A service built
	 * around a non-default agent home must arrive with {@link settingsState} beside it: the fallback
	 * below fills from the default home, and has no way to know this one's.
	 */
	settingsManager?: SettingsManager;
	/**
	 * The settings of this workspace, as the bag every call passes.
	 *
	 * Defaults to the service's own answer for this workspace — the agent home's file merged with the
	 * workspace's own, filled once and shared. A host that runs several sessions over one workspace
	 * passes the same state to each, so a change made through any of them is what the others read; a
	 * test passes {@link inMemorySettingsState} instead.
	 */
	settingsState?: SettingsState;
	/** Defaults to the six built-ins. A test passes a registry of its own to add a tool. */
	tools?: ToolRegistry;
	/**
	 * A deliberate loadout for the session's tool choice, as the fallback seed the derivation reads
	 * against: the SubAgent child's read-only narrowing is handed in this way. Still only the seed —
	 * a recorded `tool_config` entry has the last word — and the global default's live view is the
	 * fallback when this is omitted.
	 */
	toolState?: ToolState;
	/**
	 * Whether this session may delegate to a SubAgent. Default true.
	 *
	 * A SubAgent's own session passes false: delegation does not nest, so a child's registry holds
	 * the read-only tools and nothing that could start a grandchild.
	 */
	subagents?: boolean;
	/**
	 * The session's registry: its live half plus the assembly the open resolved, keyed by id.
	 *
	 * A host that owns the state — the hub, whose {@link OpenSessions} registry holds one entry per
	 * session and drops it when the host closes — hands its own in, so what it holds and what the
	 * session runs on are one object. A caller that does not care gets a fresh one, which behaves
	 * identically for the one session it serves.
	 */
	openSessions?: OpenSessions;
}

/**
 * What a session *is*, resolved but not yet activated: the workspace, the settings, the model, the
 * project instructions, and the tools that belong to it alone.
 *
 * No `Agent` exists at this point and no entry has been appended. Splitting this out of
 * {@link openAgent} is what lets {@link readSessionSnapshot} answer a transcript this process is not
 * running from the same decisions a live session would have been assembled with, rather than from a
 * second implementation that could disagree.
 */
interface Assembled {
	workspace: Workspace;
	/** The workspace's settings as the bag every settings call in the session passes. */
	settingsState: SettingsState;
	/** The session's model as a bag: the seed, with the row's facts laid in once by assembly. */
	modelState: ModelState;
	/** What this build can build: the catalog every session shares, read here only for its names. */
	registry: ToolRegistry;
	/** The tools this session has of its own — the delegation pair, or nothing when it may not delegate. */
	localTools: readonly AgentTool<any>[];
	/** The workspace's own instructions, already loaded, for the prompt this session will build. */
	agentsMd: AgentsMdFile[];
	/** The session service, resolved once here so every consumer of one assembly shares it. */
	sessionManager: SessionManager;
}

/**
 * Resolve what one session is, without activating it.
 *
 * Everything a session needs and nothing that runs: no `Agent` is constructed, no hook is installed,
 * and no entry is appended to the transcript. Both {@link openAgent} and {@link readSessionSnapshot}
 * go through here, which is the property that matters — a session this process is not running is
 * described by the same decisions, in the same order, as the one it would have assembled.
 */
async function assemble(options: OpenAgentOptions): Promise<Assembled> {
	const workspace = new Workspace(options.absWorkspaceRoot);
	// The project settings file is looked up beside the workspace, so it is resolved after the
	// workspace is: `<workspace>/.my-agent/settings.json`, over the agent home's own file. The state
	// comes from the service's per-workspace cache, so a host that handed its own service in — the
	// hub — answers every session over the workspace with the same bag.
	const settingsManager = options.settingsManager ?? new SettingsManager();
	const settingsState = options.settingsState ?? settingsManager.stateOf(workspace.absRoot);
	// One service per assembly, so the subagent tools and the session itself forward through the
	// same instance; omitted means a fresh one, which behaves identically (ADR-0007 §2).
	const sessionManager = options.sessionManager ?? new SessionManager();
	const settings = getSettings(settingsState);
	const agentsMd = await loadAgentsMd(workspace.absRoot);
	const recorded = getRecordedSettings(options.sessionState);
	const rows = options.models.list();
	const row = selectModel(rows, options.model ?? recordedRefOf(recorded.model) ?? settings.model);
	// A session with no row still runs, on the placeholder: see `placeholderModelState`. What it cannot
	// do is send anything, and `Agent` answers for it with the sentence that says what to add.
	//
	// The level is settled here and handed over *in the seed*, so a session is never on one row and
	// asked at a level that belongs to another. It comes from the caller or from what the branch
	// recorded; a session that has neither opens at "off", which is the request that asks for nothing.
	const level = row === undefined ? undefined : options.thinkingLevel ?? recorded.thinkingLevel;
	// The seed is the client's own selection shape: the row's name and the level, nothing else. The
	// row's facts — endpoint, key, window, compat — are fill products: laid in here once so a snapshot
	// reads settled values, and re-laid by every request after, which is what makes an edit to the row
	// reach the next message.
	const modelState: ModelState =
		row === undefined
			? placeholderModelState()
			: { name: row.name, ...(level === undefined ? {} : { thinkingLevel: level }) };
	if (row !== undefined) fillModel(rows, modelState);
	// The level the bag came back with, which is the level a subagent inherits: `fillModel` already
	// settled what the seed means for this row, so asking again here could only disagree.
	const thinkingLevel = normalizeThinkingLevel(modelState.thinkingLevel);
	// The catalog: the shared read-only definitions, unless the caller handed a registry of its own —
	// a test's custom tool. No workspace is resident — the executable set is built per request against
	// the run context, so a child and its parent share the definitions and none of the tools. Nothing
	// is chosen here either: the active set and the approvals derive from the ledger on every read,
	// against the seed below.
	const registry = options.tools ?? createToolRegistry(toolDefinitions());

	// Delegation is part of assembly rather than of the definitions, because a child needs the
	// model and the transcript this session resolved — things only the factory has in hand. They are
	// built here and ride the registry entry ({@link OpenSession.localTools}), because they close over
	// this session: the process's catalog could not hold one session's delegation without holding it
	// for every session. The SubAgent's own sessions pass `subagents: false`, so a child can never
	// spawn a grandchild.
	const absSessionFile = getAbsSessionFile(options.sessionState);
	const localTools =
		options.subagents === false
			? []
			: createSubagentTools({
					workspace,
					models: options.models,
					...(row === undefined ? {} : { model: row.name }),
					thinkingLevel,
					parentSessionManager: sessionManager,
					parentSessionState: options.sessionState,
					...(options.api === undefined ? {} : { api: options.api }),
					...(absSessionFile === undefined ? {} : { parentSessionFile: absSessionFile }),
				});

	return { workspace, settingsState, modelState, registry, localTools, agentsMd, sessionManager };
}

/**
 * Read one session's state without activating it.
 *
 * The cold half of {@link openAgent}: it goes through the same {@link assemble}, so the workspace, the
 * model, the thinking levels, the tool set, and the approval map are what a live session over this
 * transcript would have had — and it stops there. No `Agent`, no loop, no hooks; the fields a loop
 * would have answered are supplied as the idle values they are, because there is no run to report on.
 *
 * Like assembly it appends nothing. Reading a transcript must not be an event in it, or opening a
 * session's history would be indistinguishable from using it.
 */
export async function readSessionSnapshot(options: OpenAgentOptions): Promise<SessionSnapshot> {
	const { workspace, settingsState, modelState, registry, localTools } = await assemble(options);
	// The catalog this session would run with: the shared definitions plus the tools that are its own,
	// which is what a live session reads off its registry entry.
	const catalog = registryView(registry, localTools);
	// The same derivation a live session runs — the ledger over the seed, or the global default's
	// live view when nothing was handed in — so a cold read answers the choice a live session opens
	// on, without replaying it into anything.
	const tools = toolStateOf(options.sessionState, settingsState, catalog, options.toolState);
	return sessionSnapshot({
		sessionState: options.sessionState,
		absWorkspaceRoot: workspace.absRoot,
		// The snapshot reads only the name, the level, and the window off the model, all of which the
		// filled bag already holds; the request object is as throwaway here as it is in a request.
		model: resolvedModel(modelState),
		// The same merge `Agent.getApprovals` performs: the workspace's defaults with the session's own
		// recorded choices over them. Neither half is optional, or the header's toggles would show a
		// gate the live session does not have.
		approvals: { ...getApprovals(settingsState), ...tools.approvalOverride },
		// Read off the registry with the derived choice, so the toggles match a live session's exactly.
		allTools: catalog.names(),
		activeTools: catalog.activeNames(tools),
		// Judged against this workspace's own settings, the same way the live session's getter does it:
		// a cold read and a live snapshot must agree here, or the panel would flip its "沿用全局" label
		// the moment a session went from open to merely read.
		...followsGlobalOf(options.sessionState, settingsState, catalog),
		submitting: false,
		queued: 0,
		isRetrying: false,
		retryAttempt: 0,
		// Derived from the ledger exactly as the live session derives it: a call left dangling by a
		// run that ended — the gate's, or a crash's — is a question the cold read shows too, because
		// the answer that closes it arrives over REST to whichever process is running the session.
		pendingApprovals: danglingApprovalsOf(buildContextEntries(options.sessionState)),
	});
}

/** The two services one open resolves, as the orchestrator that serves it needs them. */
export interface SessionServices {
	sessionManager: SessionManager;
	openSessions: OpenSessions;
}

/**
 * Assemble a session and give it a registry entry: the seed→fill lifecycle's seeding half (ADR-0006 §2).
 *
 * The workspace, the settings, the model selection, the project instructions, and the tools the
 * session has of its own are resolved once here and land on the entry — the assembly product *is* the
 * entry (ADR-0007 §4) — so every later call, which names the session by id, reads them back instead of
 * re-resolving them. The caller's transcript bag is adopted by the session service, so the id answers
 * the same object this open was handed, before the first message has put a file on disk.
 *
 * Nothing here builds an orchestrator. That is the separation {@link createSessionAgent} exists for: a
 * host that runs many sessions opens one entry per session and keeps one orchestrator over all of
 * them, and a caller that wants a session of its own composes the two.
 *
 * Records nothing: a session opened and never spoken to does not grow entries, and neither does one
 * opened on another model or level than the branch last used — both reach the transcript in
 * `recordSelection`, at the moment the first request is built from them.
 */
export async function ensureSession(options: OpenAgentOptions): Promise<SessionServices> {
	const { workspace, settingsState, modelState, localTools, agentsMd, sessionManager } = await assemble(options);
	const sessionId = options.sessionState.sessionId;
	const openSessions = options.openSessions ?? new OpenSessions();
	// First touch creates the entry, and its fields are the resolved answers every later call reads —
	// the workspace fence, the settings bag, the model selection the fill chain re-fills per request,
	// the deliberate loadout the tool choice derives against, the project instructions the prompt is
	// built from, and the session's own tools. The queue modes are the same settings' answer at this
	// moment; a config patch moves them on the queues in place afterwards.
	openSessions.ensure(sessionId, () =>
		createOpenSession({
			workspace,
			settings: settingsState,
			modelSelection: modelState,
			...(options.toolState === undefined ? {} : { toolSeed: options.toolState }),
			localTools,
			agentsMd,
			steeringMode: getSteeringMode(settingsState),
			followUpMode: getFollowUpMode(settingsState),
		}),
	);
	// The caller's bag is the session's bag: registering it is what lets every later call — which
	// names the session by id — answer with this exact object, before the first message puts the file
	// on disk. An id the service already caches is re-registered to the same object, which changes
	// nothing.
	sessionManager.adopt(options.sessionState);
	return { sessionManager, openSessions };
}

/**
 * The services one orchestrator coordinates, for a caller that builds one.
 *
 * Everything here is process-level: the ledger, the models this process can run, the catalog, the
 * live registry, and the transport. Nothing in it is a session's — which is what lets a host keep one
 * orchestrator for every conversation it runs (ADR-0007 §6).
 */
export interface SessionAgentServices extends SessionServices {
	models: ModelSource;
	/**
	 * The catalog callers of this orchestrator share. Omitted means the six built-ins alone; a test
	 * that adds a tool of its own hands in a registry of its own, so nothing it registered reaches a
	 * session outside the test.
	 */
	tools?: ToolRegistry;
	/** The transport every request this orchestrator makes goes over. Defaults to Anthropic Messages. */
	api?: ChatTransport;
}

/**
 * Build the orchestrator: one object over the services, with the seams it dispatches through installed.
 *
 * A host that runs every session of a process calls this once; a caller that wants a session it does
 * not share — a test, a SubAgent's own child — calls it once per session after {@link ensureSession}.
 * Either way the two halves of a session's setup are the same two halves, so what the host runs and
 * what a smoke drives cannot drift apart.
 *
 * The defaults are installed on the surface the caller gets back rather than hard-coded in the class,
 * so a host can add a handler after them and refine what they decided. See
 * {@link installDefaultHooks}.
 */
export function createSessionAgent(services: SessionAgentServices): Agent {
	const hooks = createHooks();
	const session = new Agent({
		sessionManager: services.sessionManager,
		models: services.models,
		tools: services.tools ?? createToolRegistry(toolDefinitions()),
		openSessions: services.openSessions,
		...(services.api === undefined ? {} : { api: services.api }),
		hooks,
		// Rebuilt whenever the active set or the approval set moves, so the prompt cannot promise tools
		// or approvals the session no longer has. The workspace and the project instructions are handed
		// over per request for the same reason they are not captured: one builder serves every session
		// this orchestrator runs, and both facts belong to the session, not to the builder.
		systemPrompt: (workspace, agentsMd, toolNames, approvals) =>
			buildSystemPrompt({
				absWorkspaceRoot: workspace.absRoot,
				toolNames,
				// Every tool the map gates, not just the active ones: the map is the session's whole
				// choice, and a tool narrowed away is a tool the prompt should still say is gated rather
				// than one it silently drops.
				approvalTools: approvalToolsOf(approvals),
				agentsMd,
			}),
	});
	installDefaultHooks(hooks, session, services.openSessions);
	return session;
}

/**
 * The two default handlers every orchestrator dispatches through.
 *
 * `before_tool` is the approval gate. The session owns the bookkeeping of what the transcript is
 * still waiting on and the UI that answers it; the hook only translates an unanswered approval into
 * the suspend that ends the run (ADR-0006 §5): the call is left dangling in the ledger with no result
 * — that is what the banner is derived from — and the answer arrives over REST to start the recovery
 * run that pairs it and continues.
 *
 * `after_tool` is the output backstop. Every built-in tool bounds its own output; this catches the
 * tool that forgets. A result too large for the context is archived into the workspace whole and the
 * model is served its head and tail plus the archive's path, so nothing is lost that cannot be read
 * back; when the archive cannot be written, the hard clip in `boundToolContent` is the floor.
 *
 * Both are process-level: they reach the session their event names, rather than closing over one. The
 * workspace comes from that session's registry entry, which is also what makes a result arriving as a
 * session closes fall back to the clip instead of inventing a directory to archive into.
 */
function installDefaultHooks(hooks: Hooks, session: Agent, openSessions: OpenSessions): void {
	hooks.on("before_tool", async ({ sessionId, toolCallId, toolName, args }) => {
		const needsApproval = await session.authorize(sessionId, toolName, toolCallId, args);
		return needsApproval ? { suspend: true } : undefined;
	});
	hooks.on("after_tool", ({ sessionId, toolCallId, toolName, content }) => {
		const workspace = openSessions.get(sessionId)?.workspace;
		const spilled =
			workspace === undefined
				? undefined
				: spillOversizedToolResult(workspace, sessionId, toolName, toolCallId, content);
		const bounded = spilled ?? boundToolContent(content);
		return bounded === undefined ? undefined : { content: bounded };
	});
}

/**
 * Open one session and hand back an orchestrator of its own.
 *
 * The composition of {@link ensureSession} and {@link createSessionAgent}, for a caller that wants a
 * session it does not share with anything else: a smoke driving a scripted transport, and a SubAgent's
 * own child, whose catalog is narrowed to the read-only set. A process that runs many sessions builds
 * the two halves once each instead — see the hub — and that is the shape this exists to keep honest:
 * opening a session and resuming one are the same act, whichever of the two roads is taken.
 */
export async function openAgent(options: OpenAgentOptions): Promise<Agent> {
	const services = await ensureSession(options);
	return createSessionAgent({
		sessionManager: services.sessionManager,
		models: options.models,
		openSessions: services.openSessions,
		...(options.tools === undefined ? {} : { tools: options.tools }),
		...(options.api === undefined ? {} : { api: options.api }),
	});
}

/** The ref a transcript's `model_change` entry recorded: the row name and the wire id it named. */
function recordedRefOf(model: { name: string; modelId: string } | undefined): string | undefined {
	return model === undefined ? undefined : `${model.name}/${model.modelId}`;
}

/**
 * The row this session opens on: what the caller named, else the built-in default, else the first row.
 *
 * Two callers hand a *ref* rather than a name — `settings.model` as a repair script wrote it, and a
 * transcript's `model_change` — and both spell it `<name>/<model-id>`. The name is what identifies the
 * row, so both spellings are resolved here instead of at each caller; before, a ref simply matched
 * nothing and the session quietly opened on somebody else's row.
 *
 * {@link DEFAULT_MODEL_NAME} is the third rung and is hardcoded rather than a guess at which vendor
 * the user has a key for: it is the model this app was built around, so a default naming a row that
 * has been deleted, or a settings file that names none, still opens on it. Only a machine without that
 * row falls through to `rows[0]`, and only a machine with no rows at all gets `undefined` — which the
 * caller answers with the placeholder rather than throwing, because a session has to be buildable for
 * the window to open far enough to say what is missing.
 */
function selectModel(rows: readonly ModelConfig[], ref: string | undefined): ModelConfig | undefined {
	const name = ref?.split("/")[0];
	if (name !== undefined) {
		const named = rows.find((row) => row.name === name);
		if (named) return named;
	}
	return rows.find((row) => row.name === DEFAULT_MODEL_NAME) ?? rows[0];
}
