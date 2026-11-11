import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type Agent,
	type AgentSessionEvent,
	type ChatTransport,
	createSessionAgent,
	type ModelConfig,
	resolvePath,
	type SessionSnapshot,
} from "@my-agent/core";

export interface HubOptions {
	/** The directory the process was started in; new sessions take it as their working directory. */
	workDirAbsPath: string;
	/** Session every connection lands on when it does not name one. */
	sessionId?: string;
	/**
	 * The agent home the global settings are read from and written to. Defaults to the real one.
	 *
	 * A pass-through of `BootOptions`, for the same reason: a smoke that exercises a command which
	 * *writes* settings must not write the machine's own file. Nothing in production sets it, and a
	 * host that kept settings elsewhere would supply a storage backend rather than this path.
	 */
	settingsHome?: string;
	/**
	 * The agent home the imported model rows are read from and written to. Defaults to the real one.
	 *
	 * The same pass-through as {@link settingsHome}, for the sibling file: a smoke that hands the hub
	 * rows of its own — a scripted transport answers them, no provider key involved — must not leave
	 * them in the machine's `models.json`, and must not depend on what the person running it happens
	 * to have configured there.
	 */
	modelsHome?: string;
	/**
	 * The transport every session this hub opens talks to.
	 *
	 * Omitted in the real process, where it means Anthropic Messages. A smoke passes a scripted
	 * transport so a live session's rows can be driven with no provider key — without it the only
	 * events a session ever publishes are the ones that need no model at all.
	 */
	api?: ChatTransport;
}

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
 * One conversation this process keeps open, plus how many holds are on it.
 *
 * The count is what makes holding work: a request that goes away must not stop a turn another
 * request is watching, and the last one to go must not leave the session running forever.
 *
 * Nothing else is on it. The session itself is the process's one orchestrator (ADR-0017) — a
 * method names the id and fetches whatever it needs — and its live half is the state that
 * orchestrator's table holds for the id (ADR-0011). What is left is the one thing neither of
 * those can answer: who is holding this session open right now. That is a transport-layer
 * question (ADR-0001), so its counter lives with the transport layer rather than on core state
 * it would never read.
 *
 * A host is also the gap between the two questions "is the session held" and "is it running": the
 * orchestrator's table answers the first from the moment the id exists, while the host exists only
 * while a hold has opened the session — so `hosts` is always a subset of the table, and the table
 * is only ever cleared once the host it belongs to is gone.
 */
export class HostedSession {
	readonly id: string;
	/**
	 * Set while the hub is deciding whether a session nobody holds can be closed.
	 *
	 * The hold count itself is the orchestrator's (ADR-0011: the table's residency, not a
	 * connection's interest) — this object only carries the ids the hub routes feeds for.
	 */
	reaping = false;

	constructor(sessionId: string) {
		this.id = sessionId;
	}
}

/**
 * Told when this process gains or loses a session: one created, one forked, one opened, one closed.
 *
 * A different question from {@link SessionHub.observe}, and the two are kept apart on purpose. This
 * one answers "what does this process know about", so it fires with no connection involved at all;
 * `observe` answers "who is watching this session right now", and is the mirror the eviction edge
 * reads. A reader that wanted the first and subscribed to the second would find itself never called
 * for a session nobody was watching — which is precisely the case it exists to notice.
 */
export type HostListener = (sessionId: string, host: HostedSession | undefined) => void;

/**
 * The sessions this process owns, keyed by session id.
 *
 * One agent loop per session id, however many browsers are watching it. That is the whole point:
 * deciding per stream meant two tabs on one session built two loops over one JSONL file and appended
 * to it independently. The file is still the durable copy; this table is who is holding a session open.
 *
 * The loop itself is not per session: one orchestrator serves every id (ADR-0017). What is per
 * session is the hold — a transport-layer fact about who is using it right now, counted by the
 * orchestrator because it is what keeps that session's state in its table — and the state the
 * orchestrator's table holds the live half in. Everything else here is a singleton.
 */
export class SessionHub {
	/**
	 * The directory this process was started in.
	 *
	 * It is a default, not the directory a session works in: new sessions take it as their workDirAbsPath,
	 * and the settings panel is scoped to it. A session's own directory comes from its header, which
	 * may name any directory on the machine — the orchestrator's table holds it, and the hub never
	 * needs it: the fork's source-path resolution lives inside the facade (ADR-0017).
	 *
	 * Nothing moves it after construction, which is why a folder the user renamed behind this
	 * process's back is not followed: a default that guessed at a new name would put the next new
	 * session somewhere nobody asked for.
	 */
	private absRoot: string;

	/** The current default directory. */
	get workDirAbsPath(): string {
		return this.absRoot;
	}
	private readonly options: HubOptions;
	private readonly hosts = new Map<string, HostedSession>();
	/**
	 * The one orchestrator every conversation this process runs goes through, and the only consumer
	 * of the process's managers (ADR-0017): the settings door, the model rows, the tool table, and
	 * the session store all live behind its facade, so a session assembled here, an edit to a model
	 * row, and a settings write all reach the same objects it reads. Built once, because it holds no
	 * session: a method names the id and resolves what it needs from the state in its own table —
	 * the durable half, the settings, the live half (ADR-0011). A session's state enters that table
	 * the moment its id exists — creation assembles and adopts it, and a disk-backed one is adopted
	 * at its first open — and leaves it through the orchestrator's own `evict` / `drop`, because the
	 * table has one deleter.
	 *
	 * It reads the model rows through the facade rather than a copy, which is why a key corrected in
	 * the settings panel is the key the next message of an already-open session sends.
	 */
	readonly agent: Agent;
	/** Opens in flight, so two callers cannot build two sessions over one id. */
	private readonly opening = new Map<string, Promise<HostedSession>>();
	/** Closes in flight, so a new caller cannot open a file that is still being written. */
	private readonly closing = new Map<string, Promise<void>>();
	/**
	 * Who is watching each session, by id — the mirror a subscription's coming and going is written
	 * through.
	 *
	 * Never a count and never a reason to keep a session alive: watching a session does not keep it
	 * running, and running it does not mean anyone is watching. Two things read this table and
	 * nothing else — routing, and the eviction edge that fires when the last watcher of a session
	 * leaves (issue 04 §3).
	 */
	private readonly observers = new Map<string, Set<SessionObserver>>();
	/**
	 * Who is still waiting for a run's result on each session, by id — the send reference's
	 * server-side signal (issue 13), reported by the mux's `wait` / `unwait` frames.
	 *
	 * A subscription's twin in shape and its opposite in meaning: watching is open-ended (a pane
	 * stays as long as the window looks), a wait is bounded (a send lives exactly as long as the run
	 * it started, and the client releases it when the run's last word arrives). Like `observers` it
	 * is never a count and never a reason to keep a session *running* — it takes no hold, and a
	 * host that loses its holds reaps with waits standing. Its one reader is the eviction judgment:
	 * the criteria refuse a session somebody is still waiting on, because eviction between the run's
	 * end and the client's release would be exactly the silent tear the send reference exists to
	 * prevent. The client's copy of "the run is over" is a frame behind the server's own — this
	 * table is where the difference is paid for rather than argued away.
	 */
	private readonly waiting = new Map<string, Set<() => void>>();
	/** The process-level listeners, told about every session this process gains or loses. */
	private readonly hostListeners = new Set<HostListener>();
	/**
	 * What an unnamed landing answers with ({@link currentSessionId}): the last explicitly created
	 * session, or nothing yet — `undefined` is the welcome state's server-side half. Nothing here
	 * creates a session; the only writers are the explicit creations (`newSession`, a fork), and
	 * history is the sidebar's business: resuming it is a click on a row, not something the server
	 * guesses.
	 */
	private current?: Promise<string>;

	constructor(options: HubOptions) {
		this.options = options;
		this.absRoot = options.workDirAbsPath;
		// One construction line, and the managers are the orchestrator's own (ADR-0017): the homes
		// are all this hub contributes — a smoke's in-memory gate or rows are seeded onto the files
		// behind them before this runs, and nothing else about the graph is this hub's to decide.
		this.agent = createSessionAgent({
			...(options.settingsHome === undefined ? {} : { settingsHome: options.settingsHome }),
			...(options.modelsHome === undefined ? {} : { modelsHome: options.modelsHome }),
			...(options.api === undefined ? {} : { api: options.api }),
		});
	}

	/** The models the user has entered, in the order they appear in the settings panel. */
	get userModels(): readonly ModelConfig[] {
		return this.agent.modelCatalog();
	}

	/**
	 * Replace the stored models.
	 *
	 * Nothing has to be brought in line afterwards: sessions read the catalog through
	 * {@link settings} on every request and re-derive the model from the row it names, so the next
	 * message already uses the new rows — a key corrected in the panel is the key that message sends,
	 * and so is an endpoint, a window, or a wire id, including from a window that has been open the
	 * whole time.
	 */
	setModelConfigs(models: readonly ModelConfig[]): void {
		this.agent.replaceModels(models);
	}

	/**
	 * Whether this process's listings still name a directory: one the user put aside is left out.
	 *
	 * One home for one rule, because there are two roads by which a window learns the machine's
	 * directories — the REST listing and the channel's overview — and two filters would be two answers
	 * the first time either side changed. The list itself is a settings fact, read through the same
	 * fresh read the command writing it goes through, so a hide is visible to both roads on the next
	 * look.
	 *
	 * A hub with no root answers "everything is listed". That is not a production state — `HubOptions`
	 * requires `workDirAbsPath` and `bootServer` always passes it — but `scripts/smoke-approval.ts` builds one
	 * without it on purpose (`docs/notes.md` §一 pins that construction, and the section mounts its own
	 * session and asks the directory nothing). The filter's whole job is to leave a group out, and
	 * nothing has been left out.
	 */
	listsDirectory(workDirAbsPath: string): boolean {
		if (typeof this.absRoot !== "string") return true;
		return !this.agent.hiddenDirectories(this.absRoot).some((path) => samePath(path, workDirAbsPath));
	}

	/** Session ids this process is running right now. */
	get live(): readonly string[] {
		return [...this.hosts.keys()];
	}

	/**
	 * The session's current state, read from its files, plus this hub's one eviction pass.
	 *
	 * Reading assembles nothing (ADR-0019): the orchestrator's `snapshotOf` opens a bag, answers from
	 * it, and drops it, so the table is exactly as it was before the read. What the read is still good
	 * for is a chance to look at the table: it is one of the moments somebody is paying attention to
	 * this id, so the eviction ask rides here rather than in the orchestrator — "is anyone reading" is
	 * this hub's own table (`observers` / `waiting`), and the orchestrator would have to be told about
	 * subscriptions to answer it. What it does know is whether a run is in flight, an approval is
	 * parked, or a bag is not on disk yet, and `evict` re-checks those itself.
	 *
	 * A host standing is a different matter and is left alone: reap is what ends a hosted session,
	 * and it waits on the run behind it — a read must not be the thing that settles somebody's turn.
	 */
	async snapshotOf(id: string): Promise<SessionSnapshot> {
		const snapshot = await this.agent.snapshotOf(id);
		// Not while a host is standing (that is reap's road, and reap waits on the run), and not
		// while an open is mid-flight: its hold is taken inside `open` a tick before the host lands
		// in the table, and this pass running in that gap would drop the state out from under it.
		if (!this.hosts.has(id) && !this.opening.has(id) && !this.closing.has(id)) this.tryEvict(id);
		return snapshot;
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
		return this.agent.snapshot(host.id);
	}

	/**
	 * The id a connection lands on when it does not name one, or `null` for "nothing to land on".
	 *
	 * A client asks for this instead of choosing for itself, because the policy belongs to the
	 * server: `--session` pins one, and otherwise the answer is whatever this process last created
	 * or was told to point at — or `null`, meaning the window stays on its welcome state with
	 * nothing selected. Nothing here creates a session: startup selects nothing, and a client that
	 * picked "the newest file" would silently ignore the pin and show a different conversation from
	 * the one the server is serving.
	 */
	currentSessionId(): Promise<string | null> {
		if (this.options.sessionId !== undefined) return Promise.resolve(this.options.sessionId);
		if (this.current === undefined) return Promise.resolve(null);
		return this.current;
	}

	/**
	 * Hold a session for one connection, opening it if this process does not run it yet.
	 *
	 * Every path out of here either returns a session already in the map or waits for one being
	 * opened or closed on the same id, so two loops can never end up on one transcript.
	 */
	async hold(sessionId: string): Promise<HostedSession> {
		const id = sessionId;

		const existing = this.hosts.get(id);
		if (existing) return this.count(existing);

		const closing = this.closing.get(id);
		if (closing) await closing;

		const reopened = this.hosts.get(id);
		if (reopened) return this.count(reopened);

		const opening = this.opening.get(id);
		if (opening) return this.count(await opening);

		const started = this.open(id);
		this.opening.set(id, started);
		try {
			// The opener's hold was taken inside `open`, before the feeds were wired; counting it
			// here as well would make the first caller two holders.
			return await started;
		} finally {
			this.opening.delete(id);
		}
	}

	/**
	 * Give up one connection's hold.
	 *
	 * Deliberately neither aborts nor closes here: a turn in flight keeps running and keeps
	 * persisting, so refreshing, closing a tab, or switching sessions cannot truncate a transcript.
	 * Once the last hold is gone the session is closed after its run settles; the orchestrator's
	 * state follows its own criteria at the reap's tail — a parked approval, an unborn file, or a
	 * caller still waiting for the run's result (issue 13) keeps it, an idle session loses it. The
	 * JSONL file remains, and the next connection to ask for this id gets an equivalent session.
	 */
	release(host: HostedSession): void {
		this.agent.release(host.id);
		if (this.agent.holdsOf(host.id) > 0 || host.reaping) return;
		void this.reap(host);
	}

	/**
	 * Watch one session's events and state, whether or not this process is running it yet.
	 *
	 * Returns the way to stop watching. The observation is keyed by id and re-bound whenever a host
	 * for that id appears, so "look at an idle session, then send it a message" keeps working: the
	 * moment the message assembles a host, the same observer is attached to it.
	 *
	 * Attaching is not holding it open, and it does not assemble anything either (ADR-0019): the
	 * baseline a watch is owed is one replay of the files. What the entry still buys is the eviction
	 * judgment — a state that exists *for some other reason* (a run, a queue, a bag not yet on disk)
	 * is not torn down while somebody can see it, and this set is the hub's own half of that
	 * question. It is also what keeps a session with no file yet alive, since there the state is the
	 * session.
	 */
	observe(sessionId: string, observer: SessionObserver): () => void {
		const watching = this.observers.get(sessionId) ?? new Set<SessionObserver>();
		if (!this.observers.has(sessionId)) this.observers.set(sessionId, watching);
		watching.add(observer);

		const host = this.hosts.get(sessionId);
		observer(host === undefined ? undefined : this.feedsOf(host));

		return () => {
			watching.delete(observer);
			if (watching.size === 0) {
				this.observers.delete(sessionId);
				// The last watcher leaving is one of eviction's edges (issue 04 §3): an obstacle just
				// fell, so the criteria get their one try — funnelled through `tryEvict`, which
				// re-checks the whole set rather than only the edge that fired.
				this.tryEvict(sessionId);
			}
		};
	}

	/**
	 * Note that this caller is waiting for a run's result on a session, until it says stop.
	 *
	 * The send reference's server-side half (issue 13). It takes no hold — a hold says somebody is
	 * *changing* the session, and the wait says only that the answer still has somewhere to land —
	 * and it keeps nothing running: a host whose holds are gone reaps with waits standing, because
	 * the result the waiter is owed was already published to the stream when the run ended. What the
	 * wait buys is the window between that publication and the client's own release: eviction is
	 * refused there, so a pane coming back inside the window finds the session still held rather
	 * than silently rebuilt from disk mid-gesture.
	 *
	 * Keyed and shaped like {@link observe} on purpose — one entry per waiting caller, the return
	 * value the way to stop — so the mux can hold one of these per reported `wait` frame and let
	 * connection teardown release them the way it releases subscriptions. Idempotent per caller:
	 * a reconnect's replay re-reports waits, and reporting twice is one entry.
	 */
	awaitResult(sessionId: string): () => void {
		const waiting = this.waiting.get(sessionId) ?? new Set<() => void>();
		if (!this.waiting.has(sessionId)) this.waiting.set(sessionId, waiting);
		const stop = (): void => {
			waiting.delete(stop);
			if (waiting.size === 0) {
				this.waiting.delete(sessionId);
				// The last waiter being answered is one of eviction's edges (issue 04 §3, with the
				// wait added by 13): another obstacle just fell, and the same funnel that serves the
				// watchers' departure serves this one.
				this.tryEvict(sessionId);
			}
		};
		waiting.add(stop);
		return stop;
	}

	/**
	 * One eviction try: the funnel every edge goes through, and the one place the hub-side criteria
	 * are re-checked whole.
	 *
	 * An edge is an obstacle falling — the last watcher leaving, the last waiter answered — and the
	 * rule (issue 04 §3) is that the fall triggers one attempt in which *every* condition is read
	 * again, not just the one that moved: state changes are asynchronous with the delete points, so
	 * another obstacle may have risen in the meantime. `observers` and `waiting` are read here
	 * because they are the hub's own halves of the judgment; the orchestrator re-checks its three
	 * (a run in flight, a parked approval, a file not yet born) inside `evict` and refuses the lossy
	 * ones. A host still standing means somebody still holds the session — the deletion cannot be
	 * asked for directly (the table is only ever cleared once the host is gone), so the host's own
	 * road out, the reap, is walked: it settles, closes, and ends on the same judgment, now with the
	 * waits inside it.
	 */
	private tryEvict(sessionId: string): void {
		if (this.observers.has(sessionId)) return;
		if (this.waiting.has(sessionId)) return;
		const held = this.hosts.get(sessionId);
		if (held === undefined) this.agent.evict(sessionId);
		else if (!held.reaping) void this.reap(held);
	}

	/**
	 * Whether anyone is watching a session right now.
	 *
	 * An emptiness question rather than a count, and deliberately not one: the only reader is the
	 * eviction edge that wants to know when a session stopped being watched, and handing it a
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
	 * Returns an id rather than a held session so that holding happens in exactly one place:
	 * the caller attaches through {@link hold}, which is the only thing that takes a hold.
	 *
	 * `workDirAbsPath` decides where the session lands. Undefined is the server's own root; a path is accepted
	 * when it exists and is a directory, and nothing more — a first session in a directory nobody has
	 * worked in is the one way a new directory enters the known list, and the header's workDir is the
	 * tools' default rather than the process's, so no known-directory check belongs here.
	 */
	async newSession(workDirAbsPath?: string): Promise<string> {
		const absRoot = await workDirAbsPathForCreate(this.agent, workDirAbsPath ?? this.workDirAbsPath);
		const id = await this.agent.create(absRoot);
		this.current = Promise.resolve(id);
		this.announceHost(id, undefined);
		return id;
	}

	/**
	 * Branch a session at one entry and return the new session's id.
	 *
	 * Like {@link newSession} this returns an id rather than a held session: the caller attaches
	 * through {@link hold}, so registration and hold counting stay in one place. A fork belongs
	 * here and not in `Connection` because the new session has to outlive the connection that asked
	 * for it — the same reason every other session does.
	 *
	 * The source is only read. Its file is untouched, its own `leafId` does not move, and a session
	 * this process is running is forked from the file it is writing, so no hold is disturbed and a
	 * live turn keeps whatever it was writing.
	 *
	 * The registry gains nothing here either: a fork nobody holds has no live half to keep — no
	 * queue has drained, no run is in flight — so its first touch is its first hold, and that is
	 * what assembles its state through {@link open}. The orchestrator's table gains nothing with it:
	 * the facade's `forkFrom` writes the two files and adopts nothing (ADR-0017). States leave that
	 * table only through the orchestrator's own close and evict, never through this hub's hand.
	 */
	async fork(sessionId: string, entryId: string | null): Promise<string> {
		// The source is only located and read — the held bag's own file, or the facade's disk scan — and
		// both roads are one facade call. The fork's two sides are one read of a source path and one
		// pair of writes, and the file is the authority every entry has already landed on.
		const id = this.agent.forkFrom(sessionId, entryId);
		this.current = Promise.resolve(id);
		this.announceHost(id, undefined);
		return id;
	}

	/**
	 * Give a session a name of its own, stored as the title on its `.json` snapshot.
	 *
	 * The held and the cold road are one facade call, and the safety argument travels with it: a
	 * held session writes through its own bag, a cold write is one synchronous block, and neither
	 * takes a hold — a title is a fact about the session rather than about one way through it, the
	 * engine never reads titles, and a rewrite of the snapshot mid-run lands without disturbing the
	 * turn. An id that names nothing refuses inside the facade, which is the 404 it always was.
	 *
	 * The title arrives already shortened; what reaches the file is what a row shows.
	 */
	async rename(sessionId: string, title: string): Promise<void> {
		this.agent.setTitle(sessionId, title);
	}

	/**
	 * This process's own root changed directory: the renamed folder. A default, not the directory a
	 * see {@link workDirAbsPath} — so only the paths that were already derived from it are dropped, and nothing
	 * running is touched.
	 */
	setRoot(workDirAbsPath: string): void {
		this.absRoot = workDirAbsPath;
		this.current = undefined;
	}

	/**
	 * Delete a session: transcript, file, and every trace in this process.
	 *
	 * A session with work in flight refuses rather than deleting under it — a run writing the file,
	 * an approval waiting on a person, a request holding on, an open mid-flight — and the
	 * controller turns that refusal into a 409. An idle session closes the way a reaped one does
	 * (observers told, listeners announced, `settle` before `close`), and the slot in `closing` is
	 * held across the whole removal so a hold arriving mid-delete waits and then finds no file
	 * instead of opening one that is about to go away.
	 *
	 * The unnamed landing spot is reset: whatever it named is gone, and the next ask re-resolves
	 * against what remains rather than answering with a session that no longer exists.
	 */
	async remove(sessionId: string): Promise<void> {
		// The data half is the orchestrator's: whether a file exists, and the state in its table, are
		// one call (`Agent.remove`) and this method never asks which of the two it is deleting. What
		// stays here is the hub's own bookkeeping — hosts, observers, and the `closing` slot; the
		// holds are the orchestrator's, and it is asked whether any are still standing.
		const hosted = this.hosts.get(sessionId);
		if (hosted !== undefined) {
			if (this.agent.holdsOf(sessionId) > 0 || this.opening.has(sessionId) || this.agent.isSubmitting(sessionId) || this.agent.hasPendingApprovals(sessionId)) {
				throw new Error("这个会话还有运行中的轮次或没答完的审批，等它停下来再删。");
			}
			const closing = (async () => {
				await this.agent.settle(sessionId);
				if (this.hosts.get(sessionId) === hosted) this.hosts.delete(sessionId);
				// The same order a reap uses: the observers lose their feeds before the listeners hear
				// about the loss, so a subscriber never reaches for a session that is already gone.
				for (const observer of this.observers.get(sessionId) ?? []) observer(undefined);
				this.announceHost(sessionId, undefined);
				// The observers just told may tear their subscriptions down on the spot, and the last one
				// out fires the eviction edge — which finds no host and drops the state first. Close is
				// answered immediately for an id the table no longer holds.
				await this.agent.close(sessionId);
				// Files and held state go together, inside the same slot: a hold that waited on
				// `closing` resumes only after the files are gone, so it finds no file instead of
				// reopening one mid-delete. A session that never spoke has no file, and that is the
				// orchestrator's case to decide, not this method's.
				await this.agent.remove(sessionId);
			})();
			this.closing.set(sessionId, closing);
			try {
				await closing;
			} finally {
				this.closing.delete(sessionId);
			}
		} else {
			// No host: nothing of this process's is running it, so the orchestrator's one delete is the
			// whole removal. An id that names nothing refuses there, and that refusal is the 404.
			await this.agent.remove(sessionId);
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
		await Promise.all(hosts.map((host) => this.agent.close(host.id)));
		// The hosts leave the map before the observers are told. A subscription that ends on the news
		// fires the eviction edge, and the edge must find no host — otherwise it would walk a reap of
		// its own against a hub that is already shutting down.
		for (const host of hosts) if (this.hosts.get(host.id) === host) this.hosts.delete(host.id);
		for (const host of hosts) {
			for (const observer of this.observers.get(host.id) ?? []) observer(undefined);
			this.announceHost(host.id, undefined);
		}
		this.hosts.clear();
		// The orchestrator's state table is not swept here: it lives on the orchestrator, and the
		// process that closes the hub takes the orchestrator with it. A table-clear on a live hub
		// would be a second writer reaching past the orchestrator that owns the states.
	}

	/** Count one holder in, the way `release` counts it out. */
	private async count(host: HostedSession): Promise<HostedSession> {
		await this.agent.hold(host.id);
		return host;
	}

	/**
	 * Open a session file this process is not running yet.
	 *
	 * The working directory comes from the transcript's own header rather than from the server's root, because
	 * the sidebar offers every directory on the machine: a session opened from another group must have
	 * its tools resolve where it was written, and its approvals come from that directory's settings.
	 *
	 * The hold this takes is the first one: it is what brings the session's state into the
	 * orchestrator's table, which the feeds below are then wired against. The hub never asks whether
	 * the state was already there — {@link Agent.hold} answers for both roads (ADR-0011).
	 */
	private async open(id: string): Promise<HostedSession> {
		await this.agent.hold(id);
		const host = new HostedSession(id);
		this.hosts.set(id, host);
		// Observers first, then the listeners: a subscriber told "a host opened" and reaching for the
		// session must find it already handed over.
		const feeds = this.feedsOf(host);
		for (const observer of this.observers.get(id) ?? []) observer(feeds);
		this.announceHost(id, host);
		return host;
	}

	/**
	 * A live host's own two feeds, wrapped so a subscriber can hold on to the pair.
	 *
	 * The orchestrator is the only thing that publishes events, so this is as deep as the hub reaches —
	 * whatever a subscriber builds from the two feeds is its own business. Binding is the subscriber's
	 * to undo, because both feeds hand back their own way out.
	 */
	private feedsOf(host: HostedSession): SessionFeeds {
		return {
			onEvent: (listener) => this.agent.onEvent(host.id, listener),
			onChange: (listener) => this.agent.onChange(host.id, listener),
		};
	}

	/** Tell the process-level listeners that a session appeared, started, or went away. */
	private announceHost(sessionId: string, host: HostedSession | undefined): void {
		for (const listener of this.hostListeners) listener(sessionId, host);
	}

	private async reap(host: HostedSession): Promise<void> {
		host.reaping = true;
		try {
			// A run released mid-flight keeps running and keeps persisting, so the settle here is what
			// lets a turn finish before anything is torn down. Under the end-restart semantics
			// (ADR-0006 §5) a run parked at the approval gate has already ended — the run is not what
			// the settle waits on there — and the question it left is not this reap's to answer: the
			// host closes, the orchestrator's state stays (a parked approval refuses eviction, and
			// with it the queues a recovery run must drain), and the answer arrives over REST to
			// whichever hold reopens the session. No window answers and no process reaps it: the
			// question hangs until the next run's recovery machine closes it or the process exits.
			await this.agent.settle(host.id);
			if (this.agent.holdsOf(host.id) > 0) return;

			if (this.hosts.get(host.id) === host) this.hosts.delete(host.id);
			// Tell the observers before the listeners: a subscriber dropping its half-finished work needs
			// the feeds to be gone first, and a listener reacting to the loss is the later of the two.
			for (const observer of this.observers.get(host.id) ?? []) observer(undefined);
			this.announceHost(host.id, undefined);
			// The observers just told may tear their subscriptions down on the spot, and the last one
			// out fires the eviction edge — which now finds no host in the way and may have dropped the
			// state already. Close answers immediately for an id the table no longer holds, so the tail
			// runs whatever the edge did: an edge that got there first did the same work this would
			// have, only sooner.
			{
				const closing = this.agent.close(host.id);
				this.closing.set(host.id, closing);
				try {
					await closing;
				} finally {
					this.closing.delete(host.id);
				}
				// The host is gone, so its live half goes with it: whatever was queued or running dies
				// with the session, which is the same thing a process restart would have done, one host
				// at a time. This delete point reads the hub's own halves of the judgment whole rather
				// than arguing its preconditions (issue 04 §3): the holders were answered at the settle
				// gate above, the watchers read here even though the notification above emptied them —
				// the reading is what makes that a rule — and the wait is the hub's fourth criterion
				// (issue 13): a caller still waiting for the run's result keeps the state in the table,
				// and the wait's release is the edge that evicts it once the last one has been answered.
				// Evict answers `false` for a state the edge already dropped, so the delete needs no
				// membership branch of its own.
				if (!this.observers.has(host.id) && !this.waiting.has(host.id)) this.agent.evict(host.id);
			}
		} finally {
			host.reaping = false;
		}
	}

}

/**
 * The root a new session lands on, resolved and checked before anything is written.
 *
 * The check is deliberately only "exists and is a directory". Anything narrower — a known-directory
 * list, for one — would close the one sanctioned road to a first session in a directory the process
 * has never worked in, which is exactly how a new directory earns its place in the sidebar.
 *
 * Exported because the status a refusal deserves is the controller's decision, not the hub's: the
 * controller runs this check itself so a bad path can be answered with a 400, and `newSession`
 * runs it again so no internal caller can write a session without it.
 */
export async function workDirAbsPathOrThrow(workDirInput: string): Promise<string> {
	const absRoot = resolve(workDirInput);
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
export async function workDirAbsPathForCreate(agent: Agent, workDirInput: string): Promise<string> {
	const absRoot = resolve(workDirInput);
	try {
		return await workDirAbsPathOrThrow(absRoot);
	} catch (error) {
		if (!agent.hasSessionsFor(absRoot)) throw error;
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
