import {
	type Agent,
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
	 * expected to set it. It is deliberately not `RELEASE_GRACE_MS`: that one is how long an ended
	 * response outlives a browser's automatic reconnect, and "how long will a person take to come back
	 * to a question" is a different question with a different answer.
	 */
	approvalGraceMs?: number;
}

/** How long an unanswered approval is given before the last claim's departure is read as abandonment. */
const DEFAULT_APPROVAL_GRACE_MS = 10 * 60_000;

/**
 * One conversation this process keeps open, plus how many claims are on it.
 *
 * The count is what makes ownership work: a stream that goes away must not stop a turn another
 * stream — or a request — is watching, and the last claim to go must not leave the session running
 * forever.
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
	/** Callers currently holding this session open: one per event stream, plus requests in flight. */
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
	 * Start a conversation and make it what an unnamed connection lands on next.
	 *
	 * Returns an id rather than a claimed session so that claiming happens in exactly one place:
	 * the caller attaches through {@link claim}, which is the only thing that counts claims.
	 */
	async newSession(): Promise<string> {
		const id = SessionManager.create(this.cwd).getSessionId();
		this.current = Promise.resolve(id);
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
		return host;
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
 * Wait, without ever being the reason the process stays up.
 *
 * A timer that is holding a session open is a timer that is holding the process open, and this one is
 * waiting on a person: `unref` is what keeps a parked approval from becoming a reason the server
 * cannot exit. Same pattern as the stream registry's reconnect grace.
 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref();
	});
}
