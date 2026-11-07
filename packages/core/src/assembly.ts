import { resolve as resolvePath } from "node:path";
import type { ChatTransport } from "./llm/index.ts";
import {
	DEFAULT_MODEL_NAME,
	type ModelChoice,
	type ModelConfig,
	modelFor,
} from "./models.ts";
import type { SessionSnapshot } from "./protocol.ts";
import { createAgentState, type AgentState, createLive } from "./session/agent-state.ts";
import { danglingApprovalsOf } from "./session/dangling.ts";
import { type SessionServices } from "./session/fanout.ts";
import { type Session, SessionManager } from "./session/session-manager.ts";
import { sessionSnapshot } from "./session/snapshot.ts";
import { followsGlobalOf, toolStateOf } from "./session/tool-config.ts";
import { SettingManager } from "./setting-manager.ts";
import { type ToolManager, createToolManager } from "./tools/index.ts";

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
	 * The stateless session service the cold read replays against.
	 *
	 * Only {@link readSessionSnapshot} reads this: the cold read names its bag by the session it is
	 * handed, and a fresh manager behaves identically because the service holds no bag of its own
	 * (ADR-0007 §2) — a caller's own instance only changes *which* store knowledge the walk uses.
	 * An orchestrator does not take one: {@link openAgent} forwards the settings, tools, and
	 * transport seams to the factory and leaves the ledger to the agent it builds, which owns its
	 * own.
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
	 * transport so the run can be driven with no provider key. Read by the orchestrator's
	 * construction alone — assembly never sends anything, which is why it is absent from
	 * {@link OpenSessionOptions}.
	 */
	api?: ChatTransport;
	/**
	 * The tools this assembly resolves against.
	 *
	 * Omitted means a table of this assembly's own, holding the six built-ins — what a smoke that
	 * opens one session wants. A host hands its own in: the hub keeps one table for the process, so
	 * a session it runs and one it merely reads a snapshot of answer the same tool names and hold the
	 * same instances (ADR-0016). A test hands one in after registering a tool of its own.
	 */
	tools?: ToolManager;
}

/**
 * What {@link Agent.open} needs: the transcript, and the choices a host pins on every session of
 * the process.
 *
 * Deliberately narrower than {@link OpenAgentOptions}. The difference is the authority argument:
 * this door belongs to the orchestrator, so the services are *its own* — a caller cannot hand it a
 * second `SettingManager` or a table of its own, which is exactly the mismatch `adopt` allowed and
 * nothing checked. What remains here is the part the orchestrator cannot know: **which** transcript
 * (the host's decision, and the session manager's replay), and the model and level a host pins
 * across every session it opens (the same two `OpenAgentOptions` carries — see
 * `SessionHub.sessionOptions`, which builds both shapes from one answer).
 */
export interface OpenSessionOptions {
	/** The transcript to assemble and put in the table. */
	session: Session;
	/** Defaults to the session's own `sessionSetting.workDirAbsPath`, which is what every caller passes. */
	workDirAbsPath?: string;
	/** Overrides the stored default with a row's name. */
	model?: string;
	thinkingLevel?: string;
}

/**
 * The model a host pins under the sessions it opens, when it pins one at all: the row's name and the
 * thinking level, the same two fields {@link OpenSessionOptions} carries without the transcript.
 *
 * The facade's open-shaped methods (`create`, `adoptFromDisk`, `snapshotOf`) take one so a host can
 * keep a `--model`-style default in force across every session without the orchestrator holding it:
 * a pin is the host's per-open argument, not a resident fact.
 */
export type ModelPins = Pick<OpenSessionOptions, "model" | "thinkingLevel">;

/**
 * What a session *is*, resolved but not yet activated: the working directory, the settings, the
 * model, and the tools it runs.
 *
 * No `Agent` exists at this point and no entry has been appended. Splitting this out of the
 * orchestrator's open — and living in this file rather than beside it — is what lets
 * {@link readSessionSnapshot} answer a transcript this process is not running from the same
 * decisions a live session would have been assembled with, rather than from a second
 * implementation that could disagree.
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
	/** The tools this build knows: one table per process, read here only for its names. */
	tools: ToolManager;
	/** The session service, resolved once here so every consumer of one assembly shares it. */
	sessionManager: SessionManager;
}

/**
 * Resolve what one session is, without activating it.
 *
 * Everything a session needs and nothing that runs: no `Agent` is constructed, no hook is installed,
 * and no entry is appended to the transcript. Both the orchestrator's open (through
 * {@link assembleSession}) and {@link readSessionSnapshot} go through here, which is the property
 * that matters — a session this process is not running is described by the same decisions, in the
 * same order, as the one it would have assembled.
 *
 * The services are a required argument, not options with fallbacks: the open's are its
 * orchestrator's own by construction, and the cold read has no orchestrator to take them from and
 * resolves a fresh set below. This file imports nothing from `agent.ts`, and that is a hard rule
 * rather than a fact: `Agent.open` is its one caller on the activate side, so an import back would
 * close the cycle `agent.ts` → `assembly.ts` → `agent.ts`.
 */
async function assemble(services: SessionServices, options: OpenSessionOptions): Promise<Assembled> {
	// The one place the workDirAbsPath becomes absolute, so every later read of the entry's `workDirAbsPath` — a tool's
	// run context, the prompt, a snapshot — is the same value. The fallback is the session's own
	// directory, which is what every caller passes anyway.
	const workDirAbsPath = resolvePath(options.workDirAbsPath ?? options.session.sessionSetting.workDirAbsPath);
	// The project settings file lives under the working directory, so it is found from the same path:
	// `<workDirAbsPath>/.my-agent/settings.json`, over the agent home's own file. Nothing is cached:
	// every read is a fresh read of the files behind whichever manager the caller handed over.
	const { settings, sessionManager, tools } = services;
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
	// The table's content is behaviour and no directory, so one table serves every session. Nothing
	// is chosen here either: the active set and the approvals derive from the ledger on every read,
	// against the global default's live view.
	return { workDirAbsPath, settings, modelChoice, rows, tools, sessionManager };
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
	// The cold read has no orchestrator to take services from, so the fallbacks `assemble` no longer
	// carries are resolved here. A fresh service behaves identically: the manager holds nothing and
	// the service owns no bag (ADR-0007 §2), so the only thing a caller's own instance changes is
	// *which* files and store are read — what the hub hands its own for.
	const services: SessionServices = {
		sessionManager: options.sessionManager ?? new SessionManager(),
		settings: options.settings ?? new SettingManager(),
		tools: options.tools ?? createToolManager(),
	};
	const { workDirAbsPath, settings, modelChoice, rows, tools, sessionManager } = await assemble(services, options);
	// The same derivation a live session runs — the ledger over the global default's live view — so a
	// cold read answers the choice a live session opens on, without replaying it into anything.
	const toolState = toolStateOf(sessionManager, options.session, settings, tools.names());
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
		approvals: { ...settings.getApprovals(workDirAbsPath), ...toolState.approvalOverride },
		// Read off the table with the derived choice, so the toggles match a live session's exactly.
		allTools: tools.names(),
		activeTools: toolState.activeToolNames,
		// Judged against this directory's own settings, the same way the live session's getter does it:
		// a cold read and a live snapshot must agree here, or the panel would flip its "沿用全局" label
		// the moment a session went from open to merely read.
		...followsGlobalOf(sessionManager, options.session, settings, tools.names()),
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
 * what records it on disk (`Agent.recordSelection`), so a choice nobody sent with stays out of the
 * file.
 *
 * The services are a required argument rather than options, which is what makes the narrow door's
 * guarantee structural: the only caller is {@link Agent.open}, which hands its own three, and a
 * caller cannot reach this function to assemble a state over a second `SettingManager` — the
 * mismatch `adopt` allowed and nothing checked has nowhere to happen. This builds; it does not
 * register. Registration is `Agent.open`'s: that door calls this, puts the result in the table under
 * first-come-wins, and hands back the state the table actually holds. Not exported from the package
 * for the same reason: an externally assembled state can enter no table, so a public assembly would
 * be surface with no reader.
 *
 * Records nothing else: a session opened and never spoken to does not grow entries, and neither does
 * one opened on another model or level than the branch last used — both reach the transcript in
 * `recordSelection`, at the moment the first request is built from them.
 */
export async function assembleSession(services: SessionServices, options: OpenSessionOptions): Promise<AgentState> {
	const { workDirAbsPath, settings, modelChoice } = await assemble(services, options);
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
	return state;
}

/** The ref the session's recorded model choice names: the row name and the wire id it named. */
function recordedRefOf(model: { name: string; modelId: string } | undefined): string | undefined {
	return model === undefined ? undefined : `${model.name}/${model.modelId}`;
}

/**
 * The row this session opens on: what the caller named, else the built-in default, else the first row.
 *
 * Two callers hand a *ref* rather than a name — `settings.model` as a repair script wrote it, and a
 * session's recorded model choice — and both spell it `<name>/<model-id>`. The name is what identifies
 * the row, so both spellings are resolved here instead of at each caller; before, a ref simply matched
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
