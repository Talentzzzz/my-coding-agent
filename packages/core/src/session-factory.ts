import { anthropicMessages, type ChatTransport } from "./llm/index.ts";
import { Agent } from "./agent.ts";
import { createAgentState, type AgentState, createLive } from "./session/agent-state.ts";
import type { AgentsMdFile } from "./context/agents-md.ts";
import { buildSystemPrompt } from "./context/system-prompt.ts";
import { danglingApprovalsOf } from "./session/dangling.ts";
import { createHooks, type Hooks } from "./hooks.ts";
import {
	DEFAULT_MODEL_NAME,
	type ModelChoice,
	type ModelConfig,
	modelFor,
} from "./models.ts";
import type { SessionSnapshot } from "./protocol.ts";
import { type Session, SessionManager } from "./session/session-manager.ts";
import { sessionSnapshot } from "./session/snapshot.ts";
import {
	approvalToolsOf,
	followsGlobalOf,
	toolStateOf,
} from "./session/tool-config.ts";
import { SettingManager } from "./setting-manager.ts";
import { type ToolRegistry, createToolRegistry, toolDefinitions } from "./tools/index.ts";
import { resolve as resolvePath } from "node:path";

/** What a caller must supply to build a session. Everything else is discovered here. */
export interface OpenAgentOptions {
	/**
	 * The working directory the session's tools resolve relative paths against and start commands in.
	 *
	 * A starting point, not a boundary: an absolute path a tool is given is taken as it stands. It is
	 * resolved here so every later read of `session.sessionSetting.workDirAbsPath` is absolute.
	 */
	workDirAbsPath: string;
	/**
	 * The stateless session service the bag-passing calls inside the session go through.
	 *
	 * A host that owns one — the hub, so every session of the process shares a single service and
	 * its single store knowledge — hands its own in. Omitted means a fresh service, which behaves
	 * identically: the service holds no bag of its own (ADR-0007 §2), and the calls the session
	 * makes name their bag at the call site.
	 */
	sessionManager?: SessionManager;
	/**
	 * The transcript this session will read and write, as the bag every call names.
	 *
	 * Built by the caller rather than here, because deciding *which* session to open — a new one, the
	 * newest, one named by id — is the host's job, and a test opens an in-memory one instead.
	 */
	session: Session;
	/**
	 * The configuration every settings and model read goes through.
	 *
	 * Omitted means a fresh manager over the machine's own files — the same default a hub without
	 * options would build. A host that reads under a non-default agent home — the hub — hands its own
	 * in, because the fallback has no way to know that home; a test hands in an in-memory one so the
	 * machine's files are never touched. The manager holds nothing: every read is a fresh read of the
	 * files behind it, which is what makes an edit reach a session that never reopened.
	 */
	settings?: SettingManager;
	/** Overrides the stored default with a row's name. */
	model?: string;
	thinkingLevel?: string;
	/**
	 * The transport every request in this session goes over.
	 *
	 * Omitted in the real process, where it means Anthropic Messages. A smoke passes a scripted
	 * transport so the run can be driven with no provider key.
	 */
	api?: ChatTransport;
	/** Defaults to the six built-ins. A test passes a registry of its own to add a tool. */
	tools?: ToolRegistry;
}

/**
 * What a session *is*, resolved but not yet activated: the working directory, the settings, the
 * model, and the tools it runs.
 *
 * No `Agent` exists at this point and no entry has been appended. Splitting this out of
 * {@link openAgent} is what lets {@link readSessionSnapshot} answer a transcript this process is not
 * running from the same decisions a live session would have been assembled with, rather than from a
 * second implementation that could disagree.
 */
interface Assembled {
	/** The working directory, absolute. */
	workDirAbsPath: string;
	/** The manager every settings and model read of this session goes through. */
	settings: SettingManager;
	/** The session's model choice: the row's name and the level, and nothing the row itself owns. */
	modelChoice: ModelChoice;
	/** The rows this assembly read, so a caller that builds a model from the choice does not re-read. */
	rows: readonly ModelConfig[];
	/** What this build can build: the catalog every session shares, read here only for its names. */
	registry: ToolRegistry;
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
	// The one place the workDirAbsPath becomes absolute, so every later read of the entry's `workDirAbsPath` — a tool's
	// run context, the prompt, a snapshot — is the same value.
	const workDirAbsPath = resolvePath(options.workDirAbsPath);
	// The project settings file lives under the working directory, so it is found from the same path:
	// `<workDirAbsPath>/.my-agent/settings.json`, over the agent home's own file. Nothing is cached:
	// the caller's own manager wins — the hub builds one over its own agent home and hands it over —
	// and the fallback is a fresh manager over the machine's files.
	const settings = options.settings ?? new SettingManager();
	// One service per assembly, so the session and anything it builds forward through the same
	// instance; omitted means a fresh one, which behaves identically (ADR-0007 §2).
	const sessionManager = options.sessionManager ?? new SessionManager();
	const merged = settings.getSettings(workDirAbsPath);
	const recorded = sessionManager.getRecordedSettings(options.session);
	const rows = settings.modelCatalog();
	const row = selectModel(rows, options.model ?? recordedRefOf(recorded.model) ?? merged.model);
	// A session with no row still runs, and `Agent` answers for it with the sentence that says what to
	// add: `modelFor` builds the placeholder's facts under no name at all, and the transport is what
	// refuses to send.
	//
	// The level is settled here and handed over *with* the name, so a session is never on one row and
	// asked at a level that belongs to another. It comes from the caller or from what the session
	// recorded on its snapshot; a session that has neither opens at "off", which is the request that
	// asks for nothing.
	const level = row === undefined ? undefined : options.thinkingLevel ?? recorded.thinkingLevel;
	// The choice is the client's own: the row's name and the level, and nothing the row owns. The
	// facts behind it — endpoint, key, window, compat — are read from this catalog at the moment a
	// model is built, by this assembly and by every request after, so an edit to the row reaches the
	// next message without anything here being refreshed.
	const modelChoice: ModelChoice =
		row === undefined ? {} : { name: row.name, ...(level === undefined ? {} : { thinkingLevel: level }) };
	// The catalog: the shared read-only definitions, unless the caller handed a registry of its own —
	// a test's custom tool. No directory is resident — the executable set is built per request against
	// the run context. Nothing is chosen here either: the active set and the approvals derive from the
	// ledger on every read, against the global default's live view.
	const registry = options.tools ?? createToolRegistry(toolDefinitions());

	return { workDirAbsPath, settings, modelChoice, rows, registry, sessionManager };
}

/**
 * Read one session's state without activating it.
 *
 * The cold half of {@link openAgent}: it goes through the same {@link assemble}, so the working
 * directory, the model, the thinking levels, the tool set, and the approval map are what a live
 * session over this transcript would have had — and it stops there. No `Agent`, no loop, no hooks; the
 * fields a loop would have answered are supplied as the idle values they are, because there is no run
 * to report on.
 *
 * Like assembly it appends nothing. Reading a transcript must not be an event in it, or opening a
 * session's history would be indistinguishable from using it.
 */
export async function readSessionSnapshot(options: OpenAgentOptions): Promise<SessionSnapshot> {
	const { workDirAbsPath, settings, modelChoice, rows, registry, sessionManager } = await assemble(options);
	// The same derivation a live session runs — the ledger over the global default's live view — so a
	// cold read answers the choice a live session opens on, without replaying it into anything.
	const tools = toolStateOf(sessionManager, options.session, settings, registry);
	return sessionSnapshot({
		sessions: sessionManager,
		session: options.session,
		workDirAbsPath,
		// The snapshot reads only the name, the level, and the window off the model; the request object
		// is as throwaway here as it is in a request. Built from the rows this assembly already read, so
		// a cold read costs the file once.
		model: modelFor(modelChoice, rows),
		// The same merge `Agent.getApprovals` performs: the directory's defaults with the session's own
		// recorded choices over them. Neither half is optional, or the header's toggles would show a
		// gate the live session does not have.
		approvals: { ...settings.getApprovals(workDirAbsPath), ...tools.approvalOverride },
		// Read off the registry with the derived choice, so the toggles match a live session's exactly.
		allTools: registry.names(),
		activeTools: registry.activeNames(tools),
		// Judged against this directory's own settings, the same way the live session's getter does it:
		// a cold read and a live snapshot must agree here, or the panel would flip its "沿用全局" label
		// the moment a session went from open to merely read.
		...followsGlobalOf(sessionManager, options.session, settings, registry),
		submitting: false,
		queued: [],
		isRetrying: false,
		retryAttempt: 0,
		// Derived from the ledger exactly as the live session derives it: a call left dangling by a
		// run that ended — the gate's, or a crash's — is a question the cold read shows too, because
		// the answer that closes it arrives over REST to whichever process is running the session.
		pendingApprovals: danglingApprovalsOf(sessionManager.buildContextEntries(options.session)),
	});
}

/**
 * Assemble a session's state: the seed→fill lifecycle's seeding half (ADR-0006 §2).
 *
 * The working directory, the model choice in force, and the live half are resolved once here and
 * land in the {@link AgentState} — the assembly product *is* the state (ADR-0011) — so every later
 * call, which names the session by id, reads them back instead of re-resolving them. The settings are
 * deliberately *not* part of the state: they are read live through the {@link SettingManager} the
 * orchestrator holds, so a settings edit reaches every session over the directory with nothing to
 * refresh. The model choice is seeded onto the session's own setting field, in memory: the choice in
 * force before the first request is the assembly's answer, and the request made with the choice is
 * what records it on disk (`Agent.recordSelection`).
 *
 * Registration is the caller's: `Agent.adopt(state)` is the only way a state enters an orchestrator's
 * table, and a host that runs many sessions adopts each one as it assembles it (ADR-0011).
 *
 * Nothing here builds an orchestrator. That is the separation {@link createSessionAgent} exists for: a
 * host that runs many sessions assembles one state per session and keeps one orchestrator over all
 * of them, and a caller that wants a session of its own composes the two.
 *
 * Records nothing else: a session opened and never spoken to does not grow entries, and neither does
 * one opened on another model or level than the branch last used — both reach the transcript in
 * `recordSelection`, at the moment the first request is built from them.
 */
export async function assembleSession(options: OpenAgentOptions): Promise<{
	sessionManager: SessionManager;
	state: AgentState;
}> {
	const { workDirAbsPath, settings, modelChoice, sessionManager } = await assemble(options);
	const session = options.session;
	// The choice in force before the first request (issue 03 §7): the assembly's answer, merged onto
	// the session's own setting field in memory. The write is deliberately not a recorded one — the
	// disk write belongs to the request that is made with the choice, so a choice nobody sent with
	// stays out of the file. A rename drops the recorded wire id along with the name it belonged to.
	if (modelChoice.name !== undefined || modelChoice.thinkingLevel !== undefined) {
		const previous = session.sessionSetting.model;
		const renamed = modelChoice.name !== undefined && previous?.name !== modelChoice.name;
		session.sessionSetting.model = {
			...(renamed ? {} : previous),
			...(modelChoice.name === undefined ? {} : { name: modelChoice.name }),
			...(modelChoice.thinkingLevel === undefined ? {} : { thinkingLevel: modelChoice.thinkingLevel }),
		};
	}
	// First touch creates the state: the durable half is the caller's transcript bag as it stands, and
	// the live half is empty — its queue modes are the settings' answer at this moment, read live
	// through the manager; a config patch moves them on the queues in place afterwards.
	const state = createAgentState(
		session,
		createLive(settings.getSteeringMode(workDirAbsPath), settings.getFollowUpMode(workDirAbsPath)),
	);
	return { sessionManager, state };
}

/**
 * The services one orchestrator coordinates, for a caller that builds one.
 *
 * Everything here is process-level: the ledger, the configuration every settings and model read goes
 * through, the catalog, and the transport. Nothing in it is a session's — which is what lets a host
 * keep one orchestrator for every conversation it runs (ADR-0007 §6). A session's state is not here
 * either: it is assembled by {@link assembleSession} and adopted by the orchestrator the host owns.
 */
export interface SessionAgentServices {
	sessionManager: SessionManager;
	/** The configuration every settings and model read of every session this orchestrator runs goes through. */
	settings: SettingManager;
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
 * not share — a smoke, a test — calls it once per session after {@link assembleSession}.
 * Either way the two halves of a session's setup are the same two halves, so what the host runs and
 * what a smoke drives cannot drift apart.
 *
 * The defaults are installed on the surface the caller gets back rather than hard-coded in the class,
 * so a host can add a handler after them and refine what they decided. See
 * {@link installDefaultHooks}.
 */
export function createSessionAgent(services: SessionAgentServices): Agent {
	const hooks = createHooks();
	// Resolved once and handed to both halves: the registry a run's executable set is built from and
	// the registry a command narrows are the same one, and a second resolution here would let a
	// caller's own tool reach one and not the other.
	const tools = services.tools ?? createToolRegistry(toolDefinitions());
	const session = new Agent({
		sessionManager: services.sessionManager,
		settings: services.settings,
		tools,
		hooks,
		// The one assembly of a process: the transport is resolved here rather than defaulted inside
		// the orchestrator, so everything a run can leave the process through is decided in one file.
		api: services.api ?? anthropicMessages,
		// Rebuilt whenever the active set or the approval set moves, so the prompt cannot promise tools
		// or approvals the session no longer has. The working directory and the project instructions are
		// handed over per request for the same reason they are not captured: one builder serves every
		// session this orchestrator runs, and both facts belong to the session, not to the builder.
		systemPrompt: (workDirAbsPath, agentsMd, toolNames, approvals) =>
			buildSystemPrompt({
				workDirAbsPath,
				toolNames,
				// Every tool the map gates, not just the active ones: the map is the session's whole
				// choice, and a tool narrowed away is a tool the prompt should still say is gated rather
				// than one it silently drops.
				approvalTools: approvalToolsOf(approvals),
				agentsMd,
			}),
	});
	installDefaultHooks(hooks, session);
	return session;
}

/**
 * The default handler every orchestrator dispatches through.
 *
 * `before_tool` is the approval gate. The session owns the bookkeeping of what the transcript is
 * still waiting on and the UI that answers it; the hook only translates an unanswered approval into
 * the suspend that ends the run (ADR-0006 §5): the call is left dangling in the ledger with no result
 * — that is what the banner is derived from — and the answer arrives over REST to start the recovery
 * run that pairs it and continues.
 *
 * There is no default `after_tool`: a rewrite there is final — the ledger keeps exactly the content
 * the hooks returned — so the seam belongs to whoever has a reason to rewrite. The output backstop
 * that used to live here moved to the write boundary (`finalizeToolResult` in `agent.ts`), where it
 * catches a result nobody bounded without spending a hook on it; a hook that wants to bound a result
 * itself archives the full text with `archiveToolResult` and returns the path in the content.
 */
function installDefaultHooks(hooks: Hooks, session: Agent): void {
	hooks.on("before_tool", async ({ sessionId, toolCallId, toolName, args }) => {
		const needsApproval = await session.authorize(sessionId, toolName, toolCallId, args);
		return needsApproval ? { suspend: true } : undefined;
	});
}

/**
 * Open one session and hand back an orchestrator of its own.
 *
 * The composition of {@link assembleSession} and {@link createSessionAgent}, for a caller that wants a
 * session it does not share with anything else: a smoke driving a scripted transport, or a test
 * opening one directory by hand. A process that runs many sessions builds
 * the two halves once each instead — see the hub — and that is the shape this exists to keep honest:
 * opening a session and resuming one are the same act, whichever of the two roads is taken.
 */
export async function openAgent(options: OpenAgentOptions): Promise<Agent> {
	const { sessionManager, state } = await assembleSession(options);
	const agent = createSessionAgent({
		sessionManager,
		settings: options.settings ?? new SettingManager(),
		...(options.tools === undefined ? {} : { tools: options.tools }),
		...(options.api === undefined ? {} : { api: options.api }),
	});
	// The state enters the orchestrator's table here, through the same door a host uses: the
	// orchestrator was built first and reads nothing at construction, so the order — state, then
	// adopt — is the only one there is.
	agent.adopt(state);
	return agent;
}

/** The ref the session's recorded model choice names: the row name and the wire id it named. */
function recordedRefOf(model: { name: string; modelId: string } | undefined): string | undefined {
	return model === undefined ? undefined : `${model.name}/${model.modelId}`;
}

/**
 * The row this session opens on: what the caller named, else the built-in default, else the first row.
 *
 * Two callers hand a *ref* rather than a name — `settings.model` as a repair script wrote it, and a
 * session's recorded model choice — and both spell it `<name>/<model-id>`. The name is what identifies the
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
