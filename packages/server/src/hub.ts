import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ChatTransport } from "@my-agent/llm";
import {
	type Agent,
	type AgentSessionEvent,
	type ModelSource,
	openAgent,
	readSessionSnapshot,
	resolvePath,
	type OpenAgentOptions,
	type SessionSnapshot,
	SessionManager,
	createSessionState,
	fillSession,
	type SessionState,
	OpenSessions,
	createOpenSession,
	type OpenSession,
	SettingsManager,
	type SettingsState,
	getFollowUpMode,
	getHiddenWorkspaces,
	getSteeringMode,
	workspaceDir,
	type ModelConfig,
	ModelConfigStore,
} from "@my-agent/core";

export interface HubOptions {
	/** The directory the process was started in; new sessions take it as their workspace. */
	absCwd: string;
	model?: string;
	thinkingLevel?: string;
	/** Session every connection lands on when it does not name one. */
	sessionId?: string;
	/**
	 * How long a run stopped at an approval waits for someone to answer it before the reap treats the
	 * silence as abandonment and denies it. Default ten minutes.
	 *
	 * An option rather than a constant only so a smoke can drive it in milliseconds; nothing else is
	 * expected to set it. Waiting on a person is its own question: it is deliberately not tied to any
	 * other timer, because "how long will someone take to come back to a question" has its own answer.
	 */
	approvalGraceMs?: number;
	/**
	 * The agent home the global settings are read from and written to. Defaults to the real one.
	 *
	 * A pass-through of `BootOptions`, for the same reason: a smoke that exercises a command which
	 * *writes* settings must not write the machine's own file. Nothing in production sets it, and a
	 * host that kept settings elsewhere would supply a storage backend rather than this path.
	 */
	settingsHome?: string;
	/**
	 * The transport every session this hub opens talks to.
	 *
	 * Omitted in the real process, where it means Anthropic Messages. A smoke passes a scripted
	 * transport so a live session's rows can be driven with no provider key — without it the only
	 * events a session ever publishes are the ones that need no model at all.
	 */
	api?: ChatTransport;
}

/** How long an unanswered approval is given before the last claim's departure is read as abandonment. */
const DEFAULT_APPROVAL_GRACE_MS = 10 * 60_000;
/** How often the reap looks for the answer that would end its grace wait early. */
const APPROVAL_WATCH_MS = 50;

/**
 * One session's own two feeds, handed over exactly as the running session has them.
 *
 * Raw rather than a finished frame: approval differences are per-subscriber state, so each subscriber
 * builds its own frames from these. Each subscribe returns the way to stop, which is what lets a
 * subscriber drop the pair when the host it was attached to goes away.
 */
export interface SessionFeeds {
	/** Every event the session publishes, in order. */
	onEvent(listener: (event: AgentSessionEvent) => void): () => void;
	/** The session's state, each time something published a new snapshot of it. */
	onChange(listener: (snapshot: SessionSnapshot) => void): () => void;
}

/**
 * Something watching one session *by id*, told when there is a live session to watch and when there
 * is not.
 *
 * Called with the feeds whenever this process runs the session and with `undefined` when it stops —
 * including for a session that is only being watched, which gets the second call with nothing having
 * been attached in the first place. A subscriber told only about sessions it already had open would be
 * blind to exactly the case that matters: watching an idle one and having it start running when a
 * message arrives. Binding to the id rather than to an `Agent` is what makes that survivable.
 */
export type SessionObserver = (feeds: SessionFeeds | undefined) => void;

/**
 * One conversation this process keeps open, plus how many claims are on it.
 *
 * The count is what makes ownership work: a request that goes away must not stop a turn another
 * request is watching, and the last claim to go must not leave the session running forever.
 *
 * The session's live half — the queues a run drains and the run in flight — is deliberately not on
 * this class: it is the hub's {@link OpenSessions} registry, whose entries hold it, so the
 * in-progress state of every session is visible in one place and dies with the host that owns it.
 *
 * The workspace is per session rather than per process. A sidebar that lists every workspace this
 * machine has used can open any of them, and the tools of the session that opens must resolve inside
 * the directory its own transcript was written in — which is what the header of its file records.
 */
export class HostedSession {
	readonly id: string;
	readonly session: Agent;
	/** The directory this session's tools may touch, absolute. */
	readonly absWorkspaceRoot: string;
	/**
	 * Callers currently holding this session open.
	 *
	 * Today that is one per event stream plus one per request in flight, because a stream holds a
	 * claim for as long as it lives. Under the multiplexed transport the stream half goes away — a
	 * subscription takes no claim, and only a request that changes the session or a run in flight
	 * keeps one — but the counter itself does not change, and nothing else may start counting here.
	 */
	claims = 0;
	/** Set while the hub is deciding whether an unclaimed session can be closed. */
	reaping = false;

	constructor(session: Agent, absWorkspaceRoot: string) {
		this.session = session;
		this.id = session.id;
		this.absWorkspaceRoot = absWorkspaceRoot;
	}
}

/**
 * Told when this process gains or loses a session: one created, one forked, one opened, one closed.
 *
 * A different question from {@link SessionHub.observe}, and the two are kept apart on purpose. This
 * one answers "what does this process know about", so it fires with no connection involved at all;
 * `observe` answers "who is watching this session right now", and is the mirror an abandonment timer
 * reads. A reader that wanted the first and subscribed to the second would find itself never called
 * for a session nobody was watching — which is precisely the case it exists to notice.
 */
export type HostListener = (sessionId: string, host: HostedSession | undefined) => void;

/**
 * The sessions this process owns, keyed by session id.
 *
 * One agent loop per session id, however many browsers are watching it. That is the whole point:
 * deciding per stream meant two tabs on one session built two loops over one JSONL file and appended
 * to it independently. The file is still the durable copy; this map is who is running it.
 */
export class SessionHub {
	/**
	 * The directory this process was started in.
	 *
	 * It is a default, not the workspace: new sessions take it as their absCwd, and the default listing
	 * and settings are scoped to it. A session's actual workspace comes from its own header — see
	 * {@link HostedSession.absWorkspaceRoot} — which may name any directory on the machine.
	 *
	 * Nothing moves it after construction, which is why a folder the user renamed behind this
	 * process's back is not followed: a default that guessed at a new name would put the next new
	 * session somewhere nobody asked for.
	 */
	private absRoot: string;

	/** The current default workspace. */
	get absCwd(): string {
		return this.absRoot;
	}
	/**
	 * The models this process can run, read from the rows the user entered.
	 *
	 * One object for the whole process, handed to every session and read on each request rather than
	 * copied into it. That is what lets an edit reach a session that is already running: a key
	 * corrected in the panel is the key the next message uses, from a window that has been open the
	 * whole time, and it also means a row added with an editor is picked up without a restart.
	 */
	readonly models: ModelSource = { list: () => this.modelStore.list() };

	private readonly options: HubOptions;
	private readonly modelStore: ModelConfigStore;
	/** How long a parked approval is waited out before it is denied. See {@link HubOptions.approvalGraceMs}. */
	private readonly approvalGraceMs: number;
	/**
	 * The stateless settings service every workspace's settings read and write goes through.
	 *
	 * One instance rather than one per call, because the service's per-workspace cache is what keeps
	 * every reader and writer of a workspace on one `SettingsState`: a toggle written by a session is
	 * the value the next session reads, and the value the panel command below writes, rather than
	 * copies taken when each was assembled. See `SettingsManager.stateOf`.
	 */
	private readonly settings = new SettingsManager();
	private readonly hosts = new Map<string, HostedSession>();
	/**
	 * The stateless session service every open, rename, fork, and delete below goes through.
	 *
	 * One instance rather than one per call, because the service's fill-at-open cache is what keeps
	 * every write to a session on one bag: a rename appended here and a turn appended by the session's
	 * own loop land on the same `SessionState`. See `SessionManager.stateOf`.
	 */
	private readonly sessions = new SessionManager();
	/**
	 * The live half of every session this process has touched, keyed by session id — the narrow
	 * registry of ADR-0007 §4, holding exactly what cannot be rebuilt from disk: the queues a run
	 * drains, the run in flight, the subscriber sets, and the cross-stack run slot.
	 *
	 * An entry is created the first time a session is touched ({@link open}, which every first
	 * message and every claim arrives through) and dropped when its host closes, so the registry
	 * holds exactly the sessions this process is running and nothing else. A process restart clears
	 * it with everything else in memory and that is the whole recovery story: queued messages are
	 * lost, the session files are not, and a reopen builds a fresh entry from nothing.
	 */
	private readonly openSessions = new OpenSessions();
	/** Opens in flight, so two callers cannot build two sessions over one id. */
	private readonly opening = new Map<string, Promise<HostedSession>>();
	/** Closes in flight, so a new caller cannot open a file that is still being written. */
	private readonly closing = new Map<string, Promise<void>>();
	/**
	 * Who is watching each session, by id — the mirror a host's coming and going is written through.
	 *
	 * Never a count and never a reason to keep a session alive: watching a session does not keep it
	 * running, and running it does not mean anyone is watching. Two things read this table and nothing
	 * else — routing, and the abandonment timer that wants to know when a session stopped being watched.
	 */
	private readonly observers = new Map<string, Set<SessionObserver>>();
	/** The process-level listeners, told about every session this process gains or loses. */
	private readonly hostListeners = new Set<HostListener>();
	/**
	 * Sessions this process created whose file does not exist yet, by id.
	 *
	 * A creation writes nothing: the file appears with the first message (`persistEntry`
	 * gates on `hasConversation`). Between the id being handed out and that first message there is no
	 * file, so {@link has}, {@link snapshotOf}, and {@link open} read this map before the store —
	 * otherwise a window that creates a session and immediately opens it would be told the id it was
	 * just given names nothing. The map holds the bag itself, because a session with no file is the
	 * one state the service's fill-at-open cache cannot rebuild from disk (ADR-0007 §4).
	 *
	 * An entry leaves on the first lookup that finds the file on disk, so the map holds only the
	 * window it was made for. It is process state, so a session nobody ever spoke in dies with the
	 * process — and nothing was written for it, so nothing is lost.
	 */
	private readonly pending = new Map<string, SessionState>();
	private current?: Promise<string>;

	constructor(options: HubOptions) {
		this.options = options;
		this.absRoot = options.absCwd;
		this.modelStore = ModelConfigStore.create();
		this.approvalGraceMs = options.approvalGraceMs ?? DEFAULT_APPROVAL_GRACE_MS;
	}

	/** The models the user has entered, in the order they appear in the settings panel. */
	get userModels(): ModelConfig[] {
		return this.modelStore.list();
	}

	/**
	 * Replace the stored models.
	 *
	 * Nothing has to be brought in line afterwards: sessions read the store through {@link models} on
	 * every request and re-derive the model from the row it names, so the next message already uses the
	 * new rows — a key corrected in the panel is the key that message sends, and so is an endpoint, a
	 * window, or a wire id, including from a window that has been open the whole time.
	 */
	setModelConfigs(models: readonly ModelConfig[]): void {
		this.modelStore.replace(models);
	}

	/** The settings of one workspace, filled once by the service and shared by every session over it. */
	settingsStateOf(absWorkspaceRoot: string): SettingsState {
		return this.settings.stateOf(absWorkspaceRoot, this.options.settingsHome);
	}

	/**
	 * Whether this process's listings still name a workspace: one the user put aside is left out.
	 *
	 * One home for one rule, because there are two roads by which a window learns the machine's
	 * workspaces — the REST listing and the channel's overview — and two filters would be two answers
	 * the first time either side changed. The list itself is a settings fact, read through the manager
	 * that the command writing it goes through, so a hide is visible to both roads on the next look.
	 *
	 * A hub with no root answers "everything is listed". That is not a production state — `HubOptions`
	 * requires `absCwd` and `bootServer` always passes it — but `scripts/smoke-approval.ts` builds one
	 * without it on purpose (`docs/notes.md` §一 pins that construction, and the section mounts its own
	 * session and asks the workspace nothing). The filter's whole job is to leave a group out, and
	 * nothing has been left out.
	 */
	listsWorkspace(absCwd: string): boolean {
		if (typeof this.absRoot !== "string") return true;
		return !getHiddenWorkspaces(this.settingsStateOf(this.absRoot)).some((path) => samePath(path, absCwd));
	}

	/**
	 * Whether this id names a session at all: one this process is running, one it created and has not
	 * written yet, or one on disk.
	 *
	 * The search covers every workspace, not just the server's own: a client lists all of them and can
	 * ask for any of them, and answering "no such session" for a row the same server just listed would
	 * be the one contradiction a client cannot recover from.
	 */
	has(id: string): boolean {
		return this.hosts.has(id) || this.pendingManager(id) !== undefined || SessionManager.findSessionFilePathById(id) !== undefined;
	}

	/** Session ids this process is running right now. */
	get live(): readonly string[] {
		return [...this.hosts.keys()];
	}

	/**
	 * The session's current state: the live object when this process runs it, the log when it does not.
	 *
	 * Reading a transcript is not running a session, and this is where that stops being a slogan: the
	 * cold path builds the same snapshot {@link openAgent} would have produced, without assembling an
	 * `Agent`, without a loop, and without a claim. It deliberately does not read or write `hosts`,
	 * `opening`, or `closing`, and never calls `claim`: the whole point is that a read leaves no trace,
	 * so opening a session's history cannot keep it alive, evict it, or cost what running it costs.
	 *
	 * A session that *is* already live answers from the live object rather than from its file, because
	 * the file lags the turn in flight — a resumed read must not show a transcript the session has
	 * already moved past.
	 */
	async snapshotOf(id: string): Promise<SessionSnapshot> {
		const hosted = this.hosts.get(id);
		if (hosted) return hosted.session.snapshot;

		// A session created and not spoken in has no file to open, but this process still holds the
		// transcript it is building — reading it is the same cold read, over an empty log.
		const pending = this.pendingManager(id);
		if (pending !== undefined) return readSessionSnapshot(this.agentOptions(pending, pending.absCwd));

		const absPath = SessionManager.findSessionFilePathById(id);
		if (absPath === undefined) throw new Error(`Unknown session: ${id}`);
		// A transient replay rather than `stateOf`: a read must leave no trace, and pinning the whole
		// transcript of a session nobody is running is a trace. `open` goes through the cache instead,
		// because the state it builds is about to be written to.
		const state = fillSession(absPath);
		return readSessionSnapshot(this.agentOptions(state, state.absCwd));
	}

	/**
	 * The session's current state, synchronously, for a caller that is already holding a live host.
	 *
	 * The synchronous twin of {@link snapshotOf}, and it exists because of what the mux guarantees: a
	 * subscription's baseline has to be written in the same synchronous block that attached its feeds,
	 * or a change published between the two would reach the client before the state it describes. An
	 * `await` in that window is not merely slower — it is a hole in the one guarantee the whole
	 * recovery story rests on.
	 *
	 * So this refuses rather than guesses: reaching it means the caller believes the session is live,
	 * and if it is not, that belief is a bug worth hearing about rather than a snapshot worth inventing.
	 */
	snapshotNow(id: string): SessionSnapshot {
		const host = this.hosts.get(id);
		if (host === undefined) throw new Error(`Session is not running: ${id}`);
		return host.session.snapshot;
	}

	/**
	 * When the entry behind an id was written, for a transcript that orders by message time.
	 *
	 * Also synchronous, and for the same reason as {@link snapshotNow}: the frame that pairs an entry
	 * with its timestamp is produced from inside an event callback, where there is nothing to await.
	 *
	 * `undefined` for an entry that is gone or is not a message — the caller sends the frame without a
	 * timestamp, which is what the client already handles for an entry that carries no message.
	 */
	timestampOf(id: string, entryId: string): number | undefined {
		const host = this.hosts.get(id);
		if (host === undefined) return undefined;
		const entry = host.session.sessionManager.getEntry(host.session.sessionState, entryId);
		return entry?.type === "message" ? entry.message.timestamp : undefined;
	}

	/**
	 * The id a connection lands on when it does not name one.
	 *
	 * A client asks for this instead of choosing for itself, because the policy belongs to the
	 * server: `--session` pins one, and otherwise the first caller creates a session. A client that
	 * picked "the newest file" would silently ignore the pin and show a different conversation from
	 * the one the server is serving.
	 */
	currentSessionId(): Promise<string> {
		return this.currentId();
	}

	/**
	 * Claim a session for one connection, opening it if this process does not run it yet.
	 *
	 * Every path out of here either returns a session already in the map or waits for one being
	 * opened or closed on the same id, so two loops can never end up on one transcript.
	 */
	async claim(sessionId?: string): Promise<HostedSession> {
		const id = sessionId ?? (await this.currentId());

		const existing = this.hosts.get(id);
		if (existing) return this.hold(existing);

		const closing = this.closing.get(id);
		if (closing) await closing;

		const reopened = this.hosts.get(id);
		if (reopened) return this.hold(reopened);

		const opening = this.opening.get(id);
		if (opening) return this.hold(await opening);

		const started = this.open(id);
		this.opening.set(id, started);
		try {
			return this.hold(await started);
		} finally {
			this.opening.delete(id);
		}
	}

	/**
	 * Give up one connection's claim.
	 *
	 * Deliberately neither aborts nor closes here: a turn in flight keeps running and keeps
	 * persisting, so refreshing, closing a tab, or switching sessions cannot truncate a transcript.
	 * Once the last claim is gone the session is closed after its run settles, then forgotten; the
	 * JSONL file remains, and the next connection to ask for this id gets an equivalent session.
	 */
	release(host: HostedSession): void {
		host.claims -= 1;
		if (host.claims > 0 || host.reaping) return;
		void this.reap(host);
	}

	/**
	 * Watch one session's events and state, whether or not this process is running it yet.
	 *
	 * Returns the way to stop watching. The observation is keyed by id and re-bound whenever a host
	 * for that id appears, so "look at an idle session, then send it a message" keeps working: the
	 * moment the message assembles a host, the same observer is attached to it.
	 *
	 * Attaching is not claiming. An observer on an idle session neither keeps it assembled nor costs
	 * what running it costs — a read leaves no trace, and so does a watch.
	 */
	observe(sessionId: string, observer: SessionObserver): () => void {
		const watching = this.observers.get(sessionId) ?? new Set<SessionObserver>();
		if (!this.observers.has(sessionId)) this.observers.set(sessionId, watching);
		watching.add(observer);

		const host = this.hosts.get(sessionId);
		observer(host === undefined ? undefined : feedsOf(host));

		return () => {
			watching.delete(observer);
			if (watching.size === 0) this.observers.delete(sessionId);
		};
	}

	/**
	 * Whether anyone is watching a session right now.
	 *
	 * An emptiness question rather than a count, and deliberately not one: the only reader is an
	 * abandonment timer that wants to know when a session stopped being watched, and handing it a
	 * number invites it to reason about how many — which is the substitution that turns a set into the
	 * second counter this hub must not have.
	 */
	isWatched(sessionId: string): boolean {
		return (this.observers.get(sessionId)?.size ?? 0) > 0;
	}

	/**
	 * Be told about every session this process gains or loses.
	 *
	 * Fires for a session created or forked (with no host, because none is running yet), for one whose
	 * host opens, and for one whose host closes. Returns the way to stop listening.
	 *
	 * The reason this is a separate seam from {@link observe}: a caller that wants "every session I
	 * know about" must not have to also be a subscriber, or a session nobody watches would never be
	 * reported at all.
	 */
	onHostChange(listener: HostListener): () => void {
		this.hostListeners.add(listener);
		return () => {
			this.hostListeners.delete(listener);
		};
	}

	/**
	 * Start a conversation and make it what an unnamed connection lands on next.
	 *
	 * Returns an id rather than a claimed session so that claiming happens in exactly one place:
	 * the caller attaches through {@link claim}, which is the only thing that counts claims.
	 *
	 * `absCwd` decides where the session lands. Undefined is the server's own root; a path is accepted
	 * when it exists and is a directory, and nothing more — a first session in a directory nobody has
	 * worked in is the one way a new workspace enters the known list, and the workspace root is the
	 * tools' fence rather than the process's, so no known-workspace check belongs here.
	 */
	async newSession(absCwd?: string): Promise<string> {
		const absRoot = await workspaceRootForCreate(absCwd ?? this.absCwd);
		const id = this.createUnpersisted(absRoot);
		this.current = Promise.resolve(id);
		this.announceHost(id, undefined);
		return id;
	}

	/**
	 * Branch a session at one entry and return the new session's id.
	 *
	 * Like {@link newSession} this returns an id rather than a claimed session: the caller attaches
	 * through {@link claim}, so registration and claim counting stay in one place. A fork belongs
	 * here and not in `Connection` because the new session has to outlive the connection that asked
	 * for it — the same reason every other session does.
	 *
	 * The source is only read. Its file is untouched, its own `leafId` does not move, and a session
	 * this process is running is forked from the file it is writing, so no claim is disturbed and a
	 * live turn keeps whatever it was writing.
	 *
	 * The registry gains nothing here either: a fork nobody has claimed has no live half to hold —
	 * no queue has drained, no run is in flight — so its first touch is its first claim, and that is
	 * what builds its entry through {@link open}. Only `close` moves the registry, by dropping the
	 * entries of the sessions this process stops running.
	 */
	async fork(sessionId: string, entryId: string | null): Promise<string> {
		const hosted = this.hosts.get(sessionId);
		const absSourcePath = hosted?.session.sessionFile ?? SessionManager.findSessionFilePathById(sessionId);
		if (absSourcePath === undefined) throw new Error(`Unknown session: ${sessionId}`);
		// The branch is written where its source lives: forking a conversation held in another
		// workspace must not quietly move it into this one.
		const absTargetCwd = hosted?.absWorkspaceRoot ?? fillSession(absSourcePath).absCwd;
		const id = this.sessions.forkFrom(absSourcePath, absTargetCwd, entryId).sessionId;
		this.current = Promise.resolve(id);
		this.announceHost(id, undefined);
		return id;
	}

	/**
	 * Give a session a name of its own, stored as one `rename` entry (ADR-0002).
	 *
	 * A session this process runs appends through the bag it writes its turns with, and a stored
	 * session appends through the service's `stateOf` — which is deliberately not a fresh replay: the
	 * bag it hands back is the one a previous host of this session wrote, so the rename lands on the
	 * same object the next open will serve. Neither path takes a claim: a rename is a record beside
	 * the conversation, the loop never reads titles, and an entry appended mid-run lands on the file
	 * without disturbing the turn.
	 *
	 * The title arrives already shortened; what reaches the file is what a row shows.
	 */
	async rename(sessionId: string, title: string): Promise<void> {
		const hosted = this.hosts.get(sessionId);
		if (hosted !== undefined) {
			hosted.session.sessionManager.appendRename(hosted.session.sessionState, title);
			return;
		}
		const absPath = SessionManager.findSessionFilePathById(sessionId);
		if (absPath === undefined) throw new Error(`Unknown session: ${sessionId}`);
		this.sessions.appendRename(this.sessions.stateOf(sessionId), title);
	}

	/**
	 * This process's own root changed directory: the renamed workspace. A default, not the workspace —
	 * see {@link absCwd} — so only the paths that were already derived from it are dropped, and nothing
	 * running is touched.
	 */
	setRoot(absCwd: string): void {
		this.absRoot = absCwd;
		this.current = undefined;
	}

	/**
	 * Delete a session: transcript, file, and every trace in this process.
	 *
	 * A session with work in flight refuses rather than deleting under it — a run writing the file,
	 * an approval waiting on a person, a request holding a claim, an open mid-flight — and the
	 * controller turns that refusal into a 409. An idle session closes the way a reaped one does
	 * (observers told, listeners announced, `settle` before `close`), and the slot in `closing` is
	 * held across the whole removal so a claim arriving mid-delete waits and then finds no file
	 * instead of opening one that is about to go away.
	 *
	 * The unnamed landing spot is reset: whatever it named is gone, and the next ask re-resolves
	 * against what remains rather than answering with a session that no longer exists.
	 */
	async remove(sessionId: string): Promise<void> {
		// A session this process created and never spoke in has no file: forgetting the held manager is
		// the whole removal, and the store has nothing to delete for it. An id this process never heard
		// of still goes to the store, so its refusal stays the 404 it always was.
		const held = this.pending.delete(sessionId);
		const onDisk = SessionManager.findSessionFilePathById(sessionId) !== undefined;
		const hosted = this.hosts.get(sessionId);
		if (hosted !== undefined) {
			const snapshot = hosted.session.snapshot;
			if (hosted.claims > 0 || this.opening.has(sessionId) || snapshot.submitting || hosted.session.hasPendingApprovals) {
				throw new Error("这个会话还有运行中的轮次或没答完的审批，等它停下来再删。");
			}
			const closing = (async () => {
				await hosted.session.settle();
				if (this.hosts.get(sessionId) === hosted) this.hosts.delete(sessionId);
				// The same order a reap uses: the observers lose their feeds before the listeners hear
				// about the loss, so a subscriber never reaches for a session that is already gone.
				for (const observer of this.observers.get(sessionId) ?? []) observer(undefined);
				this.announceHost(sessionId, undefined);
				await hosted.session.close();
				// The file removal rides inside the same slot: a claim that waited on `closing` resumes
				// only after the file is gone, so it finds no file instead of reopening one mid-delete.
				// A session that never spoke has no file, and asking for one would be asking for nothing.
				if (onDisk) await this.sessions.remove(sessionId);
				// The live half goes with the host, after the run has settled — deleting the entry
				// earlier would leave a settling turn draining queues nobody holds.
				this.openSessions.delete(sessionId);
			})();
			this.closing.set(sessionId, closing);
			try {
				await closing;
			} finally {
				this.closing.delete(sessionId);
			}
		} else if (onDisk || !held) {
			await this.sessions.remove(sessionId);
		}
		this.current = undefined;
	}

	/**
	 * Stop every run and settle every session before the process exits.
	 *
	 * `close()` stops the run itself, which is what bounds this — a long tool cannot hold shutdown
	 * open. A waiting call is left exactly as it is: the transcript is the only state, so the restart
	 * inherits the question still answerable, not a denial nobody made.
	 */
	async close(): Promise<void> {
		const hosts = [...this.hosts.values()];
		await Promise.all(hosts.map((host) => host.session.close()));
		for (const host of hosts) {
			for (const observer of this.observers.get(host.id) ?? []) observer(undefined);
			this.announceHost(host.id, undefined);
		}
		this.hosts.clear();
		this.pending.clear();
		this.openSessions.clear();
	}

	private hold(host: HostedSession): HostedSession {
		host.claims += 1;
		return host;
	}

	/**
	 * Open a session file this process is not running yet.
	 *
	 * The workspace comes from the transcript's own header rather than from the server's root, because
	 * the sidebar offers every workspace on the machine: a session opened from another group must have
	 * its tools resolve where it was written, and its approvals come from that directory's settings.
	 */
	private async open(id: string): Promise<HostedSession> {
		// The pending bag before the store: a session created a moment ago has no file to find yet,
		// and this is the road its own id takes from the creation to the first message.
		const pending = this.pendingManager(id);
		const state = pending ?? this.sessions.stateOf(id);
		const absWorkspaceRoot = state.absCwd;
		const session = await this.sessionOver(state, absWorkspaceRoot, this.openSessionFor(id, absWorkspaceRoot));
		const host = new HostedSession(session, absWorkspaceRoot);
		this.hosts.set(id, host);
		// Observers first, then the listeners: a subscriber told "a host opened" and reaching for the
		// session must find it already handed over.
		const feeds = feedsOf(host);
		for (const observer of this.observers.get(id) ?? []) observer(feeds);
		this.announceHost(id, host);
		return host;
	}

	/** Tell the process-level listeners that a session appeared, started, or went away. */
	private announceHost(sessionId: string, host: HostedSession | undefined): void {
		for (const listener of this.hostListeners) listener(sessionId, host);
	}

	/**
	 * The options one transcript is described by, whether or not this process runs it.
	 *
	 * One builder for both paths on purpose. The cold read and the live session must resolve the same
	 * workspace, the same settings, and the same pinned model and level, so that a snapshot taken
	 * without assembling is indistinguishable from a snapshot taken after — if these were written out
	 * twice, the difference would show up as a session that changes when you open it.
	 */
	private agentOptions(state: SessionState, absWorkspaceRoot: string): OpenAgentOptions {
		return {
			absWorkspaceRoot,
			sessionManager: this.sessions,
			sessionState: state,
			models: this.models,
			settingsManager: this.settings,
			settingsState: this.settingsStateOf(absWorkspaceRoot),
			...(this.options.model === undefined ? {} : { model: this.options.model }),
			...(this.options.thinkingLevel === undefined ? {} : { thinkingLevel: this.options.thinkingLevel }),
			...(this.options.api === undefined ? {} : { api: this.options.api }),
		};
	}

	private sessionOver(state: SessionState, absWorkspaceRoot: string, openSession: OpenSession): Promise<Agent> {
		return openAgent({ ...this.agentOptions(state, absWorkspaceRoot), openSession });
	}

	/**
	 * The registry entry of one session, built the first time the session is touched.
	 *
	 * The queue modes are the workspace settings' answer at that moment — read by the factory only
	 * when a creation actually happens; a config patch moves them on the queues in place afterwards.
	 * An entry this registry already names is answered with what it holds — which only happens while
	 * a host is open, because the close that removes the host is also what removes the entry — so a
	 * reopen after a reap never inherits a stale run or a drained queue.
	 */
	private openSessionFor(id: string, absWorkspaceRoot: string): OpenSession {
		return this.openSessions.ensure(id, () => {
			const settings = this.settingsStateOf(absWorkspaceRoot);
			return createOpenSession(getSteeringMode(settings), getFollowUpMode(settings));
		});
	}

	private async reap(host: HostedSession): Promise<void> {
		host.reaping = true;
		try {
			// An approval nobody is watching is not an approval nobody will answer: the same window is
			// one switch away. A claim says that somebody *was* looking, which is not the same question
			// as whether anybody will answer, so silence is waited out before it is read as abandonment.
			//
			// Under the end-restart semantics (ADR-0006 §5) the waiting call appears when the run ends
			// at the gate, not while it is in flight, so the run is settled first and the waiting is
			// decided after — a session released mid-run and one released already waiting take the
			// same road here.
			await host.session.settle();
			if (host.session.hasPendingApprovals) {
				const answered = await Promise.race([
					// The answer arrives over REST on a claim of its own; what this wait is for is the
					// moment the call stops dangling, which is the moment it was answered.
					(async () => {
						while (host.session.hasPendingApprovals) await delay(APPROVAL_WATCH_MS);
						return true;
					})(),
					delay(this.approvalGraceMs).then(() => false),
				]);
				if (!answered && host.claims === 0) {
					host.session.denyAllApprovals("No window answered this approval.");
				}
				// A claim arrived during the wait, so the person came back and the approval is still
				// theirs to answer. This reap has nothing left to decide: holding `reaping` — and so
				// the session — for as long as they take to reply would keep the next release from
				// ever reaping it. Letting go here is what lets their next release do that.
				if (!answered && host.claims > 0) return;
			}
			await host.session.settle();
			if (host.claims > 0) return;

			if (this.hosts.get(host.id) === host) this.hosts.delete(host.id);
			// Tell the observers before the listeners: a subscriber dropping its half-finished work needs
			// the feeds to be gone first, and a listener reacting to the loss is the later of the two.
			for (const observer of this.observers.get(host.id) ?? []) observer(undefined);
			this.announceHost(host.id, undefined);
			const closing = host.session.close();
			this.closing.set(host.id, closing);
			try {
				await closing;
			} finally {
				this.closing.delete(host.id);
			}
			// The host is gone, so its live half goes with it: whatever was queued or running dies with
			// the session, which is the same thing a process restart would have done, one host at a time.
			this.openSessions.delete(host.id);
		} finally {
			host.reaping = false;
		}
	}

	/**
	 * The session a connection lands on when it does not name one.
	 *
	 * Resolved once per process, as a promise so two connections arriving together cannot both create
	 * a session. `--session` pins it, and otherwise the caller gets a new one — a launch opens on the
	 * welcome state even in a workspace full of history, and the session a page reload lands on is
	 * that same one because this is memoised. History is the sidebar's business: resuming it is a
	 * click on a row, not something the server guesses.
	 * `newSession()` moves it.
	 */
	private currentId(): Promise<string> {
		this.current ??= this.resolveCurrentId();
		return this.current;
	}

	private async resolveCurrentId(): Promise<string> {
		if (this.options.sessionId !== undefined) return this.options.sessionId;
		return this.createUnpersisted(this.absCwd);
	}

	/**
	 * Create a session and hold it until its first message puts it on disk.
	 *
	 * The held manager is the whole reason a creation can write nothing: the id stays answerable by
	 * {@link open} and {@link has} without a file to look up. What that costs is that the id is
	 * process-local until the first message — which is all a conversation with no message in it is
	 * worth, and it is why the sidebar never shows one.
	 */
	private createUnpersisted(absCwd: string): string {
		const state = createSessionState(absCwd);
		const id = state.sessionId;
		this.pending.set(id, state);
		return id;
	}

	/** The bag behind an id whose file is not written yet, if there is one. */
	private pendingManager(id: string): SessionState | undefined {
		const state = this.pending.get(id);
		if (state === undefined) return undefined;
		const absFile = state.absSessionFile;
		if (absFile !== undefined && existsSync(absFile)) {
			// The first message landed, so the store is the source again and this entry has done its job.
			this.pending.delete(id);
			return undefined;
		}
		return state;
	}
}

/**
 * A live host's own two feeds, wrapped so a subscriber can hold on to the pair.
 *
 * The session is the only thing that publishes events, so this is as deep as the hub reaches —
 * whatever a subscriber builds from the two feeds is its own business. Binding is the subscriber's to
 * undo, because both feeds hand back their own way out.
 */
function feedsOf(host: HostedSession): SessionFeeds {
	return {
		onEvent: (listener) => host.session.onEvent(listener),
		onChange: (listener) => host.session.onChange(listener),
	};
}

/**
 * Wait, without ever being the reason the process stays up.
 *
 * A timer that is holding a session open is a timer that is holding the process open, and this one is
 * waiting on a person: `unref` is what keeps a parked approval from becoming a reason the server
 * cannot exit. Same pattern as the mux's stall timer.
 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref();
	});
}

/**
 * The root a new session lands on, resolved and checked before anything is written.
 *
 * The check is deliberately only "exists and is a directory". Anything narrower — a known-workspace
 * list, for one — would close the one sanctioned road to a first session in a directory the process
 * has never worked in, which is exactly how a new workspace earns its place in the sidebar.
 *
 * Exported because the status a refusal deserves is the controller's decision, not the hub's: the
 * controller runs this check itself so a bad path can be answered with a 400, and `newSession`
 * runs it again so no internal caller can write a session without it.
 */
export async function workspaceRootOrThrow(cwdInput: string): Promise<string> {
	const absRoot = resolve(cwdInput);
	let stats;
	try {
		stats = await stat(absRoot);
	} catch {
		throw new Error(`No such directory: ${absRoot}`);
	}
	if (!stats.isDirectory()) throw new Error(`Not a directory: ${absRoot}`);
	return absRoot;
}

/**
 * The directory a new session will run in, recreated when this machine already has its sessions.
 *
 * A user can rename or delete a project folder behind this process's back. Its transcripts stay in
 * the store, so the group stays listed and the picker can still point at it — and the honest answer
 * then is to put the directory back, empty, because nothing of the user's was ever ours to keep
 * there. A path this machine has no sessions for still refuses: a typo in the picker must not become
 * a folder nobody asked for.
 */
export async function workspaceRootForCreate(cwdInput: string): Promise<string> {
	const absRoot = resolve(cwdInput);
	try {
		return await workspaceRootOrThrow(absRoot);
	} catch (error) {
		if (!existsSync(workspaceDir(absRoot))) throw error;
		await mkdir(absRoot, { recursive: true });
		return absRoot;
	}
}

/**
 * Whether two paths name the same directory, in the spelling a lookup can key on.
 *
 * Resolved the way every stored path is, and case-folded on Windows, because the two ends of a
 * comparison come from different places — a request body, a session header, a settings file — and
 * `C:\Work` and `c:\work` are one directory there. Symlinks are deliberately not followed: the
 * comparison is about which string a store is keyed by, not about where it leads.
 */
export function samePath(a: string, b: string): boolean {
	const left = resolvePath(a);
	const right = resolvePath(b);
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
