import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ChatTransport } from "@my-agent/ai";
import {
	type Agent,
	type AgentSessionEvent,
	type ModelSource,
	openAgent,
	readSessionSnapshot,
	type OpenAgentOptions,
	type SessionSnapshot,
	SessionManager,
	SettingsManager,
	type UserModel,
	UserModelStore,
} from "@my-agent/core";

export interface HubOptions {
	/** The directory the process was started in; new sessions take it as their workspace. */
	cwd: string;
	model?: string;
	thinkingLevel?: string;
	/** Session every connection lands on when it does not name one. */
	sessionId?: string;
	/** Start from the newest stored session for this workspace instead of a new one. */
	continueSession?: boolean;
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
 * The workspace is per session rather than per process. A sidebar that lists every workspace this
 * machine has used can open any of them, and the tools of the session that opens must resolve inside
 * the directory its own transcript was written in — which is what the header of its file records.
 */
export class HostedSession {
	readonly id: string;
	readonly session: Agent;
	/** The directory this session's tools may touch. */
	readonly workspaceRoot: string;
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

	constructor(session: Agent, workspaceRoot: string) {
		this.session = session;
		this.id = session.id;
		this.workspaceRoot = workspaceRoot;
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
	 * It is a default, not the workspace: new sessions take it as their cwd, and the default listing
	 * and settings are scoped to it. A session's actual workspace comes from its own header — see
	 * {@link HostedSession.workspaceRoot} — which may name any directory on the machine.
	 */
	readonly cwd: string;
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
	private readonly modelStore: UserModelStore;
	/** How long a parked approval is waited out before it is denied. See {@link HubOptions.approvalGraceMs}. */
	private readonly approvalGraceMs: number;
	/** One settings manager per workspace, so two sessions over one directory share a single view. */
	private readonly settingsManagers = new Map<string, SettingsManager>();
	private readonly hosts = new Map<string, HostedSession>();
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
	private current?: Promise<string>;

	constructor(options: HubOptions) {
		this.options = options;
		this.cwd = options.cwd;
		this.modelStore = UserModelStore.create();
		this.approvalGraceMs = options.approvalGraceMs ?? DEFAULT_APPROVAL_GRACE_MS;
	}

	/** The models the user has entered, in the order they appear in the settings panel. */
	get userModels(): UserModel[] {
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
	setUserModels(models: readonly UserModel[]): void {
		this.modelStore.replace(models);
	}

	/** The settings of one workspace, built once and shared by every session over it. */
	settingsFor(workspaceRoot: string): SettingsManager {
		const existing = this.settingsManagers.get(workspaceRoot);
		if (existing) return existing;
		const created = SettingsManager.create(workspaceRoot);
		this.settingsManagers.set(workspaceRoot, created);
		return created;
	}

	get continueSession(): boolean {
		return this.options.continueSession ?? false;
	}

	/**
	 * Whether this id names a session at all: one this process is running, or one on disk.
	 *
	 * The search covers every workspace, not just the server's own: a client lists all of them and can
	 * ask for any of them, and answering "no such session" for a row the same server just listed would
	 * be the one contradiction a client cannot recover from.
	 */
	has(id: string): boolean {
		return this.hosts.has(id) || SessionManager.findAnywhere(id) !== undefined;
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

		const path = SessionManager.findAnywhere(id);
		if (path === undefined) throw new Error(`Unknown session: ${id}`);
		const manager = SessionManager.open(path);
		return readSessionSnapshot(this.agentOptions(manager, manager.getCwd()));
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
		const entry = host.session.sessionManager.getEntry(entryId);
		return entry?.type === "message" ? entry.message.timestamp : undefined;
	}

	/**
	 * The id a connection lands on when it does not name one.
	 *
	 * A client asks for this instead of choosing for itself, because the policy belongs to the
	 * server: `--session` pins one, `--continue` resumes the newest, and otherwise the first caller
	 * creates a session. A client that picked "the newest file" would silently ignore the pin and
	 * show a different conversation from the one the server is serving.
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
	 * `cwd` decides where the session lands. Undefined is the server's own root; a path is accepted
	 * when it exists and is a directory, and nothing more — a first session in a directory nobody has
	 * worked in is the one way a new workspace enters the known list, and the workspace root is the
	 * tools' fence rather than the process's, so no known-workspace check belongs here.
	 */
	async newSession(cwd?: string): Promise<string> {
		const root = await workspaceRootOrThrow(cwd ?? this.cwd);
		const id = SessionManager.create(root).getSessionId();
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
	 */
	async fork(sessionId: string, entryId: string | null): Promise<string> {
		const hosted = this.hosts.get(sessionId);
		const sourcePath = hosted?.session.sessionFile ?? SessionManager.findAnywhere(sessionId);
		if (sourcePath === undefined) throw new Error(`Unknown session: ${sessionId}`);
		// The branch is written where its source lives: forking a conversation held in another
		// workspace must not quietly move it into this one.
		const targetCwd = hosted?.workspaceRoot ?? SessionManager.open(sourcePath).getCwd();
		const id = SessionManager.forkFrom(sourcePath, targetCwd, entryId).getSessionId();
		this.current = Promise.resolve(id);
		this.announceHost(id, undefined);
		return id;
	}

	/**
	 * Stop every run and settle every session before the process exits.
	 *
	 * Aborting first is what bounds this: `close()` waits for the run to finish, so without the abort
	 * a long tool would hold shutdown open. Closing the sessions themselves is the caller's job only
	 * in the sense of ordering — whoever owns the transports ends them first, so the claims they hold
	 * are gone by the time this runs.
	 */
	async close(): Promise<void> {
		const hosts = [...this.hosts.values()];
		await Promise.all(hosts.map((host) => host.session.abort()));
		await Promise.all(hosts.map((host) => host.session.close()));
		for (const host of hosts) {
			for (const observer of this.observers.get(host.id) ?? []) observer(undefined);
			this.announceHost(host.id, undefined);
		}
		this.hosts.clear();
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
		const path = SessionManager.findAnywhere(id);
		if (path === undefined) throw new Error(`Unknown session: ${id}`);
		const manager = SessionManager.open(path);
		const workspaceRoot = manager.getCwd();
		const session = await this.sessionOver(manager, workspaceRoot);
		const host = new HostedSession(session, workspaceRoot);
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
	private agentOptions(sessionManager: SessionManager, workspaceRoot: string): OpenAgentOptions {
		return {
			workspaceRoot,
			sessionManager,
			models: this.models,
			settingsManager: this.settingsFor(workspaceRoot),
			...(this.options.model === undefined ? {} : { model: this.options.model }),
			...(this.options.thinkingLevel === undefined ? {} : { thinkingLevel: this.options.thinkingLevel }),
			...(this.options.api === undefined ? {} : { api: this.options.api }),
		};
	}

	private sessionOver(sessionManager: SessionManager, workspaceRoot: string): Promise<Agent> {
		return openAgent(this.agentOptions(sessionManager, workspaceRoot));
	}

	private async reap(host: HostedSession): Promise<void> {
		host.reaping = true;
		try {
			// An approval nobody is watching is not an approval nobody will answer: the same window is
			// one switch away. A claim says that somebody *was* looking, which is not the same question
			// as whether anybody will answer, so silence is waited out before it is read as abandonment.
			if (host.session.hasPendingApprovals) {
				const settled = await Promise.race([
					host.session.settle().then(() => true),
					delay(this.approvalGraceMs).then(() => false),
				]);
				if (!settled && host.claims === 0) {
					host.session.denyAllApprovals("No window answered this approval.");
				}
				// A claim arrived during the wait, so the person came back and the approval is still
				// theirs to answer. This reap has nothing left to decide: waiting on a run parked at a
				// prompt would hold `reaping` — and so the session — for as long as they take to reply.
				// Letting go here is what lets their next release reap it properly.
				if (!settled && host.claims > 0) return;
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
		} finally {
			host.reaping = false;
		}
	}

	/**
	 * The session a connection lands on when it does not name one.
	 *
	 * Resolved once per process, as a promise so two connections arriving together cannot both create
	 * a session. `--session` pins it, `--continue` resumes the newest stored session, and otherwise
	 * the newest is resumed when there is one — a window reopened on a workspace should show the
	 * conversation that was just happening, and only an empty history creates a session.
	 * `newSession()` moves it.
	 */
	private currentId(): Promise<string> {
		this.current ??= this.resolveCurrentId();
		return this.current;
	}

	private async resolveCurrentId(): Promise<string> {
		if (this.options.sessionId !== undefined) return this.options.sessionId;
		if (this.continueSession || (await SessionManager.list(this.cwd)).length > 0) {
			return SessionManager.continueRecent(this.cwd).getSessionId();
		}
		return SessionManager.create(this.cwd).getSessionId();
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
export async function workspaceRootOrThrow(cwd: string): Promise<string> {
	const root = resolve(cwd);
	let stats;
	try {
		stats = await stat(root);
	} catch {
		throw new Error(`No such directory: ${root}`);
	}
	if (!stats.isDirectory()) throw new Error(`Not a directory: ${root}`);
	return root;
}
