import { resolve as resolvePath } from "node:path";
import type { ChatTransport } from "./llm/index.ts";
import { type ModelChoice, type ModelConfig, modelFor } from "./models.ts";
import type { SessionSnapshot } from "./protocol.ts";
import { createAgentState, type AgentState, createLive } from "./session/agent-state.ts";
import { danglingApprovalsOf } from "./session/dangling.ts";
import { type SessionServices } from "./session/fanout.ts";
import { modelChoiceOf } from "./session/model-choice.ts";
import { type Session, SessionManager } from "./session/session-manager.ts";
import { sessionSnapshot } from "./session/snapshot.ts";
import { followsGlobalOf, toolStateOf } from "./session/tool-config.ts";
import { SettingManager } from "./setting-manager.ts";
import { type ToolManager, createToolManager } from "./tools/index.ts";

/** What a caller must supply to build a session. Everything else is discovered here. */
export interface OpenAgentOptions {
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
	 * {@link AssembleAgentStateOptions}.
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
 * What {@link Agent.assembleAgentStateBySession} needs: the transcript, and — for the composition
 * road a test takes — the row it should open on.
 *
 * Deliberately narrower than {@link OpenAgentOptions}. The difference is the authority argument:
 * this door belongs to the orchestrator, so the services are *its own* — a caller cannot hand it a
 * second `SettingManager` or a table of its own, which is exactly the mismatch `adopt` allowed and
 * nothing checked. What remains here is the part the orchestrator cannot know: **which** transcript
 * (the host's decision, and the session manager's replay) — the transcript carries its own working
 * directory on `sessionSetting.workDirAbsPath`.
 *
 * The model fields are not a host's handle on the default. The host-facing verbs (`create`,
 * `hold`, `snapshotOf`) do not take one: a session's model is a settings fact, read fresh from
 * disk by the assembly below on every open. Only `openAgent` — the one-transcript composition a
 * smoke drives — passes one, so a scripted run can open on a row of its own without writing a
 * settings file.
 */
export interface AssembleAgentStateOptions {
	/** The transcript to assemble and put in the table; it carries its own working directory. */
	session: Session;
	/** Test-only override: the row this composition opens on, instead of the settings' default. */
	model?: string;
	thinkingLevel?: string;
}

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
 * rather than a fact: `Agent.assembleAgentStateBySession` is its one caller on the activate side, so an import back would
 * close the cycle `agent.ts` → `assembly.ts` → `agent.ts`.
 */
async function assemble(services: SessionServices, options: AssembleAgentStateOptions): Promise<Assembled> {
	// The one place the workDirAbsPath becomes absolute, so every later read of the entry's `workDirAbsPath` — a tool's
	// run context, the prompt, a snapshot — is the same value. The directory is the transcript's own:
	// `createSession` seeds it resolved and a replay restores it, so there is no override here — the
	// session decides where it lives, and no caller hands a second answer in.
	const workDirAbsPath = resolvePath(options.session.sessionSetting.workDirAbsPath);
	// The project settings file lives under the working directory, so it is found from the same path:
	// `<workDirAbsPath>/.my-agent/settings.json`, over the agent home's own file. Nothing is cached:
	// every read is a fresh read of the files behind whichever manager the caller handed over.
	const { settings, sessionManager, tools } = services;
	const rows = settings.modelCatalog();
	// The choice is the client's own: the row's name and the level, and nothing the row owns. The
	// facts behind it — endpoint, key, window, compat — are read from this catalog at the moment a
	// model is built, by this assembly and by every request after, so an edit to the row reaches the
	// next message without anything here being refreshed.
	//
	// It is derived rather than computed here (ADR-0019), because a session's every later read has to
	// answer the same question from a bag it just replayed: `modelChoiceOf` is that one answer, and
	// this call is it with the caller's override on top. A session with no row still opens, and
	// `Agent` answers for it with the sentence that says what to add: `modelFor` builds the
	// placeholder's facts under no name at all, and the transport is what refuses to send.
	const modelChoice: ModelChoice = modelChoiceOf(sessionManager, options.session, settings, {
		...(options.model === undefined ? {} : { name: options.model }),
		...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
	});
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
 * What this produces is the **live half** — the queues, their modes, and the one transcript no replay
 * can produce (ADR-0019). The transcript it is handed is an *input*, not a member: a born bag is
 * dropped here, because `bag(id)` replays it again on demand, and an unborn one is kept on
 * `live.unwritten`, because nothing else can answer it until the first message creates the files.
 * The working directory stays on that bag (every later call replays it), and the settings are never
 * part of any state — they are read live through the {@link SettingManager} the orchestrator holds.
 *
 * The model choice is neither kept nor seeded: every read derives it (`session/model-choice.ts`),
 * which is the only shape that survives a bag being dropped. The one piece of the choice a
 * derivation cannot reproduce is a row the *caller* named, so that — and only that — lands on
 * `live.openedOn`.
 *
 * The services are a required argument rather than options, which is what makes the narrow door's
 * guarantee structural: the only caller is {@link Agent.assembleAgentStateBySession}, which hands its
 * own three, and a caller cannot reach this function to assemble a state over a second
 * `SettingManager` — the mismatch `adopt` allowed and nothing checked has nowhere to happen. This
 * builds; it does not register. Registration is that same door's: it calls this, puts the result in
 * the table under first-come-wins, and hands back the state the table actually holds. Not exported
 * from the package for the same reason: an externally assembled state can enter no table, so a public
 * assembly would be surface with no reader.
 *
 * Records nothing: a session opened and never spoken to does not grow entries, and neither does one
 * opened on another model or level than the branch last used — a write happens when something is
 * actually chosen (`applyModelSelection`) or when the first request is built (`recordSelection`).
 */
export async function assembleSession(services: SessionServices, options: AssembleAgentStateOptions): Promise<AgentState> {
	const { workDirAbsPath, settings } = await assemble(services, options);
	const session = options.session;
	// First touch creates the state: the live half is empty — its queue modes are the settings' answer
	// at this moment, read live through the manager; a config patch moves them on the queues in place
	// afterwards — and the transcript is *not* part of it (ADR-0019). The one exception is a bag whose
	// files do not exist yet: no replay can produce it, so it is the live half's own field until the
	// first write puts it on disk.
	const live = createLive(settings.getSteeringMode(workDirAbsPath), settings.getFollowUpMode(workDirAbsPath));
	if (!session.fileCreated) live.unwritten = session;
	// The choice the assembly resolved is *derived* by every later read (`modelChoiceOf`), not seeded
	// onto the bag: a seeded bag is a copy, and a copy is what a replay throws away. The one part of
	// the answer no derivation can reproduce is an override the caller named — nothing writes it to
	// the transcript — so that, and only that, is kept, on the live half it belongs to.
	if (options.model !== undefined || options.thinkingLevel !== undefined) {
		live.openedOn = {
			...(options.model === undefined ? {} : { name: options.model }),
			...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
		};
	}
	return createAgentState(session.sessionId, live);
}
