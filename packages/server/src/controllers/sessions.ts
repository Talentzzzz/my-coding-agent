import {
	type Agent,
	clampContentWidth,
	clampFontSize,
	clampSidebarWidth,
	clampWorkspacePaging,
	coerceModel,
	type ConfigPatch,
	listModelOptions,
	SessionManager,
	shortenTitle,
	type ModelOption,
	type ModelSelection,
	resolveModelRef,
	type SessionRef,
	type SessionSnapshot,
	type SettingsPatch,
	type SettingsSnapshot,
	SettingsManager,
	toSessionRef,
	type UserModel,
	type WorkspaceGroup,
} from "@my-agent/core";
import { resolve } from "node:path";
import { httpStatus } from "../http/errors.ts";
import { workspaceRootOrThrow, type SessionHub } from "../hub.ts";

/** The stored sessions for a workspace, narrowed from the session files to what the wire carries. */
export async function listSessions(workspaceRoot: string): Promise<SessionRef[]> {
	return (await SessionManager.list(workspaceRoot)).map(toSessionRef);
}

/** What the settings panel reads: the values it can edit, and the ones it shows read-only. */
function settingsOf(manager: SettingsManager): SettingsSnapshot {
	const settings = manager.getSettings();
	return {
		appearance: manager.getAppearance(),
		approval: manager.getApprovals(),
		bash: manager.getBashSettings(),
		...(settings.tools === undefined ? {} : { tools: settings.tools }),
		...(settings.model === undefined ? {} : { model: settings.model }),
	};
}

/**
 * What a controller tells the transport about, because the transport owns the streams.
 *
 * Both are consequences of the split between a request and a stream: a run's failure has no response
 * left to be reported on, and an answer to an approval has to reach every stream watching the
 * session, not only the client that gave it. Both therefore name the session they belong to: the
 * answer is keyed to the session it was given on, and a `toolCallId` another session happens to also
 * wait on is that session's question, not this answer's.
 */
export interface SessionListener {
	onRunFailure?(sessionId: string, message: string): void;
	onApproval?(sessionId: string, toolCallId: string, approved: boolean): void;
	/**
	 * A stored rename landed, and the row's title is stale until the file is read once more. The
	 * projection re-reads the row and the ordinary `session_row` frame carries the new name to every
	 * window — the same road any other row change takes, so no client learns a second shape of news.
	 */
	onRenamed?(sessionId: string): void;
	/** A session was deleted. The projection drops its row, and the transport tells its clients. */
	onRemoved?(sessionId: string): void;
}

/**
 * The models, the workspace groups, and the stored settings.
 *
 * All three are read-only views of something the hub already owns, and all three used to be frames a
 * socket pushed. Over HTTP the client asks for them, which is what lets a page reload with no session
 * and still fill its sidebar, its settings panel, and its model list.
 */
export class SystemController {
	private readonly hub: SessionHub;

	constructor(hub: SessionHub) {
		this.hub = hub;
	}

	health(): { ok: boolean; cwd: string; live: readonly string[] } {
		return { ok: true, cwd: this.hub.cwd, live: this.hub.live };
	}

	models(): ModelOption[] {
		return listModelOptions(this.hub.userModels);
	}

	/**
	 * Replace the imported models.
	 *
	 * The list is sent whole rather than row by row, because the panel edits a list and a half-applied
	 * list is the one state nobody can reason about — a row deleted here and added there must land
	 * together or not at all.
	 *
	 * A row that arrives without an `apiKey` keeps the one already stored under its name. That is what
	 * lets the panel round-trip a model it was never sent the key for: the client echoes the row back
	 * with every field it can see, and the key it cannot see survives the round trip untouched.
	 *
	 * A name that two rows claim is refused outright rather than made unique. A name is a row's
	 * identity here — transcripts record it and config patches name it — so quietly suffixing one would
	 * mean the row the user is looking at is not the row their sessions are looking for. The panel says
	 * which name collided, and nothing is written.
	 */
	updateModels(body: Record<string, unknown>): { models: ModelOption[] } {
		const input = body.models;
		if (!Array.isArray(input)) throw httpStatus.badRequest("`models` must be an array");

		const stored = new Map(this.hub.userModels.map((model) => [model.name, model.apiKey]));
		const rows: UserModel[] = [];
		for (const entry of input) {
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
				throw httpStatus.badRequest("Every model must be a JSON object");
			}
			const record = entry as Record<string, unknown>;
			const name = typeof record.name === "string" ? record.name.trim() : undefined;
			const carried = name === undefined ? undefined : stored.get(name);
			const candidate = record.apiKey === undefined && carried !== undefined ? { ...record, apiKey: carried } : record;

			const model = coerceModel(candidate);
			if (model === undefined) {
				throw httpStatus.badRequest("Every model needs a `modelId` and a `baseUrl`, and a name of its own");
			}
			if (rows.some((row) => row.name === model.name)) {
				throw httpStatus.badRequest(`The name "${model.name}" is already in use`);
			}
			rows.push(model);
		}

		this.hub.setUserModels(rows);
		return { models: listModelOptions(rows) };
	}

	/** Every workspace this machine has sessions for, each with its own list, most recent first. */
	async workspaces(): Promise<{ workspaces: WorkspaceGroup[] }> {
		return { workspaces: await SessionManager.listWorkspaces() };
	}

	settings(): { settings: SettingsSnapshot } {
		return { settings: settingsOf(this.hub.settingsFor(this.hub.cwd)) };
	}

	/**
	 * Change the default model, the theme, the font size, the approval set, or the bash timeouts.
	 *
	 * Narrower than {@link SessionController.updateConfig} on purpose: these are the defaults the window
	 * itself runs on, and they are read before any session exists, so they cannot live on a session.
	 * `approval` here is therefore the **workspace default** — what a session that never chose opens on
	 * — not a running session's own answer, which travels as a config patch on that session. `model` is
	 * the row a *new* session starts on; the model a live session is on is the composer's, and reaches
	 * the server with the message rather than here. `tools` is the global default active set, whole,
	 * like the session-level endpoint's own contract — and a session's recorded choice still wins over
	 * it, so nothing here reaches a session that already chose.
	 */
	updateSettings(body: Record<string, unknown>): { settings: SettingsSnapshot } {
		const patch = body.patch ?? body;
		if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
			throw httpStatus.badRequest("`patch` must be a JSON object");
		}
		const fields = patch as Record<string, unknown>;

		const manager = this.hub.settingsFor(this.hub.cwd);
		const next: SettingsPatch = {};

		if (fields.tools !== undefined) {
			if (!Array.isArray(fields.tools) || fields.tools.some((name) => typeof name !== "string")) {
				throw httpStatus.badRequest("`tools` must be an array of tool names");
			}
			next.tools = fields.tools as string[];
		}

		if (fields.model !== undefined) {
			if (typeof fields.model !== "string") throw httpStatus.badRequest("`model` must be a string");
			// A default that names no row is refused rather than stored: `selectModel` would fall back to
			// the first row, so a typo here would look like a preference that quietly did nothing. The
			// rows are the hub's, read fresh, so a row deleted since the panel loaded is caught too.
			if (resolveModelRef(this.hub.models.list(), fields.model) === undefined) {
				throw httpStatus.conflict(`Unknown model: ${fields.model}`);
			}
			next.model = fields.model;
		}

		if (fields.appearance !== undefined) {
			if (typeof fields.appearance !== "object" || fields.appearance === null || Array.isArray(fields.appearance)) {
				throw httpStatus.badRequest("`appearance` must be a JSON object");
			}
			const appearance = fields.appearance as Record<string, unknown>;
			const theme = appearance.theme;
			if (theme !== undefined && theme !== "system" && theme !== "light" && theme !== "dark") {
				throw httpStatus.badRequest('`appearance.theme` must be "system", "light", or "dark"');
			}
			next.appearance = {
				...(theme === undefined ? {} : { theme }),
				...(appearance.fontSize === undefined ? {} : { fontSize: clampFontSize(appearance.fontSize) }),
				// The two drag handles' widths. Each passes through its own clamp on the way in, so the
				// absolute range is enforced here exactly as a hand-edited file would be — and a value
				// that is not a number clamps to undefined, which drops the field rather than storing it.
				...(appearance.sidebarWidth === undefined
					? {}
					: { sidebarWidth: clampSidebarWidth(appearance.sidebarWidth) }),
				...(appearance.contentWidth === undefined
					? {}
					: { contentWidth: clampContentWidth(appearance.contentWidth) }),
				// The sidebar's per-workspace paging state, normalized entry by entry the same way: a
				// workspace whose entry is not a record is dropped, not stored. A field that is not a
				// record at all — or a record with no workspace left in it — clamps to undefined, and
				// spreading `undefined` into the object literal is what leaves the field out of the
				// patch entirely, so nothing is stored and nothing is manufactured.
				...(appearance.workspaces === undefined
					? {}
					: { workspaces: clampWorkspacePaging(appearance.workspaces) }),
			};
		}

		if (fields.approval !== undefined) {
			if (typeof fields.approval !== "object" || fields.approval === null || Array.isArray(fields.approval)) {
				throw httpStatus.badRequest("`approval` must be a JSON object");
			}
			const approval: Record<string, boolean> = {};
			for (const [tool, value] of Object.entries(fields.approval as Record<string, unknown>)) {
				if (typeof value !== "boolean") throw httpStatus.badRequest(`\`approval.${tool}\` must be a boolean`);
				approval[tool] = value;
			}
			next.approval = approval as SettingsPatch["approval"];
		}

		if (fields.bash !== undefined) {
			if (typeof fields.bash !== "object" || fields.bash === null || Array.isArray(fields.bash)) {
				throw httpStatus.badRequest("`bash` must be a JSON object");
			}
			const bash: Partial<Record<"defaultTimeoutMs" | "maxTimeoutMs", number>> = {};
			for (const key of ["defaultTimeoutMs", "maxTimeoutMs"] as const) {
				const value = (fields.bash as Record<string, unknown>)[key];
				if (value === undefined) continue;
				if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
					throw httpStatus.badRequest(`\`bash.${key}\` must be a positive integer of milliseconds`);
				}
				bash[key] = value;
			}
			next.bash = bash;
		}

		manager.applySettings(next);
		return { settings: settingsOf(manager) };
	}

	async sessions(): Promise<{ sessions: SessionRef[] }> {
		return { sessions: await listSessions(this.hub.cwd) };
	}

	/**
	 * The session a client with no id of its own should open, and the list to draw beside it.
	 *
	 * Both come back together because a client always wants both at boot, and asking the server for
	 * the id is what makes `--session` and `--continue` observable in the UI: the client follows the
	 * server's answer instead of guessing from the stored files.
	 */
	async current(): Promise<{ sessionId: string; sessions: SessionRef[] }> {
		const [sessionId, sessions] = await Promise.all([this.hub.currentSessionId(), listSessions(this.hub.cwd)]);
		return { sessionId, sessions };
	}
}

/**
 * Everything about one session: reading it, changing its configuration, and the commands that each
 * used to be a branch of one `switch` over a message the socket carried.
 *
 * Each method is a thin call onto the session the hub holds. Only two decisions live here: what a
 * failure means as a status, and that a command returns as soon as the session has accepted it — the
 * run itself is reported on the event stream, never on this response.
 */
export class SessionController {
	private readonly hub: SessionHub;
	private readonly listeners: SessionListener;

	constructor(hub: SessionHub, listeners: SessionListener = {}) {
		this.hub = hub;
		this.listeners = listeners;
	}

	/**
	 * The current state of a session this process is running, or can open.
	 *
	 * The one read on this controller that does *not* go through {@link claiming}: reading a
	 * transcript must not assemble a session, hold it open, or evict it, so it asks the hub for a
	 * snapshot rather than for the live object. Every other method here mutates, or has to run against
	 * the session that is running, and those keep their claim.
	 *
	 * Existence is still checked against the hub, which covers the sessions on disk too — a read of an
	 * id that names nothing is a 404, exactly as it was when the claim was what discovered that.
	 */
	async read(sessionId: string): Promise<{ session: SessionSnapshot }> {
		if (!this.hub.has(sessionId)) throw httpStatus.notFound(`Unknown session: ${sessionId}`);
		return { session: await this.hub.snapshotOf(sessionId) };
	}

	/**
	 * Start a conversation and make it what an unnamed stream lands on next.
	 *
	 * Returns an id rather than a claimed session, so attaching happens in exactly one place: the mux
	 * `open` frame the client sends next. Creating a session writes its JSONL header, so a session
	 * that is created and never opened is still findable by id — and still subscribable, since
	 * subscribing reads the transcript rather than running it.
	 *
	 * `cwd` in the body decides where the session lands, and the listing answers for that directory:
	 * a window that just pointed the picker somewhere new should be able to trust that the sessions it
	 * is shown are the ones it created into. Undefined stays the server's own root, which is what a
	 * bodyless `POST` has always meant.
	 */
	async create(body: Record<string, unknown> = {}): Promise<{ sessionId: string; sessions: SessionRef[] }> {
		const cwd = body.cwd;
		if (cwd !== undefined && typeof cwd !== "string") {
			throw httpStatus.badRequest("`cwd` must be a string");
		}
		// Resolved here so the listing names the same directory the hub validated and wrote into,
		// whatever spelling the request arrived with. The check runs here too, because "a bad path is
		// the request's fault" is a status decision and this is where those are made; the hub repeats
		// it so no internal caller can write a session without it.
		const root = typeof cwd === "string" && cwd.length > 0 ? resolve(cwd) : undefined;
		if (root !== undefined) {
			try {
				await workspaceRootOrThrow(root);
			} catch (error) {
				throw httpStatus.badRequest(messageOf(error));
			}
		}
		const sessionId = await this.hub.newSession(root);
		return { sessionId, sessions: await listSessions(root ?? this.hub.cwd) };
	}

	/**
	 * Branch a session at one entry.
	 *
	 * The entry id comes from the request body rather than a query, because it is what the fork *is*:
	 * the entry to branch at, or none at all to copy the whole log. The source is only read — a live
	 * turn on it keeps running and keeps writing.
	 */
	async fork(sourceId: string, body: Record<string, unknown>): Promise<{ sessionId: string; sessions: SessionRef[] }> {
		const entryId = body.entryId;
		if (entryId !== undefined && entryId !== null && typeof entryId !== "string") {
			throw httpStatus.badRequest("`entryId` must be a string or null");
		}
		const sessionId = await this.hub.fork(sourceId, typeof entryId === "string" ? entryId : null);
		return { sessionId, sessions: await listSessions(this.hub.cwd) };
	}

	/**
	 * Give the session a name of its own, stored as one `rename` entry (ADR-0002).
	 *
	 * The store's own shortening rule is applied here, before anything is written — a user's typing is
	 * not a title until it has been collapsed and cut the same way a derived one is, so a renamed row
	 * and a derived row are indistinguishable in width and shape. An empty name is refused rather than
	 * stored: an entry whose title is nothing would silently restore the derived title, which is what
	 * *not renaming* already does. There is no clear-rename; changing the name back is another rename.
	 *
	 * No claim is taken and a run in flight is no obstacle: the entry lands beside the conversation,
	 * and nothing the loop reads depends on a title.
	 */
	async rename(sessionId: string, body: Record<string, unknown>): Promise<{ sessionId: string; title: string }> {
		const title = body.title;
		if (typeof title !== "string") throw httpStatus.badRequest("`title` must be a string");
		const stored = shortenTitle(title);
		if (stored.length === 0) throw httpStatus.badRequest("`title` must be a non-empty string");
		if (!this.hub.has(sessionId)) throw httpStatus.notFound(`Unknown session: ${sessionId}`);
		await this.hub.rename(sessionId, stored);
		this.listeners.onRenamed?.(sessionId);
		return { sessionId, title: stored };
	}

	/**
	 * Delete the session: transcript, file, and every row this process knows about it.
	 *
	 * A busy session is a conflict rather than a bad request — the request was understood, and what
	 * stands between it and the delete is a run to wait out or an approval to answer, which is the
	 * situation 409 exists to name. The listeners hear *after* the file is gone, so the frame that
	 * tells the windows never precedes the fact it reports.
	 */
	async remove(sessionId: string): Promise<{ removed: true }> {
		if (!this.hub.has(sessionId)) throw httpStatus.notFound(`Unknown session: ${sessionId}`);
		try {
			await this.hub.remove(sessionId);
		} catch (error) {
			throw httpStatus.conflict(messageOf(error));
		}
		this.listeners.onRemoved?.(sessionId);
		return { removed: true };
	}

	/**
	 * Move the conversation onto another branch of its own tree.
	 *
	 * A command, not an edit: the store is not rewritten, only the leaf moves, and sending it twice is
	 * the same move twice. It answers with the session's new state because the whole transcript changed
	 * and the client that asked is the one looking at it. Every *other* stream on this session is sent
	 * the same snapshot by the transport, from the session's own `branch_changed` — a second window
	 * showing the old chain would otherwise send its next prompt to a branch it was not displaying.
	 *
	 * The entry id comes from the request body rather than a query, for the same reason a fork's does:
	 * it is what the command *is*. `descend` picks between the two ends of one gesture — land on the
	 * alternative's newest tip, which is what switching between branches means, or on the entry itself,
	 * so that the next prompt starts a new alternative there.
	 */
	async branch(sessionId: string, body: Record<string, unknown>): Promise<{ session: SessionSnapshot }> {
		const entryId = body.entryId;
		if (typeof entryId !== "string" || entryId.length === 0) {
			throw httpStatus.badRequest("`entryId` must be a non-empty string");
		}
		const descend = body.descend;
		if (descend !== undefined && typeof descend !== "boolean") {
			throw httpStatus.badRequest("`descend` must be a boolean");
		}

		return this.claiming(sessionId, (session) => {
			try {
				session.branchTo(entryId, descend ?? true);
			} catch (error) {
				// A run in flight, or an entry this session does not hold: understood and refused, which
				// is a conflict rather than a bad request.
				throw httpStatus.conflict(messageOf(error));
			}
			return { session: session.snapshot };
		});
	}

	/**
	 * Accept a prompt.
	 *
	 * 202, not 200, and answered as soon as the message is persisted: `session.prompt()` resolves when
	 * the *run* ends, which is minutes later, so awaiting it here would hold the request — and its
	 * claim — for the whole turn and make the status code a lie. The run is started and watched
	 * instead, and only a failure to start is reported, on the session's own stream, because by then
	 * there is no response left to report it on.
	 *
	 * `behavior` decides what a prompt sent mid-run does — `steer` is injected at the running turn's
	 * next drain point, `followUp` waits for the turn to end.
	 *
	 * `model` and `thinkingLevel` are the composer's own choice, and they arrive here rather than as a
	 * config change of their own because neither is true until a request is made with it: choosing a
	 * model is not something the transcript happened to, and a level no request was asked at was never
	 * in force. They are validated with the rest of the message so a bad one is refused before anything
	 * is persisted, and a rejected selection leaves the session exactly as it was.
	 */
	async prompt(sessionId: string, body: Record<string, unknown>): Promise<{ accepted: true }> {
		const text = body.text;
		if (typeof text !== "string" || text.trim().length === 0) {
			throw httpStatus.badRequest("`text` must be a non-empty string");
		}
		const behavior = body.behavior;
		if (behavior !== undefined && behavior !== "steer" && behavior !== "followUp") {
			throw httpStatus.badRequest('`behavior` must be "steer" or "followUp"');
		}
		const model = body.model;
		if (model !== undefined && typeof model !== "string") {
			throw httpStatus.badRequest("`model` must be a string");
		}
		const thinkingLevel = body.thinkingLevel;
		if (thinkingLevel !== undefined && typeof thinkingLevel !== "string") {
			throw httpStatus.badRequest("`thinkingLevel` must be a string");
		}

		return this.claiming(sessionId, (session) => {
			const selection: ModelSelection = {
				...(model === undefined ? {} : { model }),
				...(thinkingLevel === undefined ? {} : { thinkingLevel }),
			};
			// `prompt()` persists the message and marks the run as streaming before its first await, so
			// the message is on disk and `submitting` is true by the time this answers.
			void session
				.prompt(text, { ...(behavior === undefined ? {} : { behavior }), selection })
				.catch((error: unknown) => {
					this.onRunFailure(sessionId, messageOf(error));
				});
			return { accepted: true };
		});
	}

	/**
	 * Stop the run in flight.
	 *
	 * This is why a command is an HTTP request rather than a frame on the event stream: stopping is
	 * not part of the stream, so any caller holding a session id can do it — another tab, a script, a
	 * `curl` — and a client whose stream is stuck still has a way out.
	 */
	async abort(sessionId: string): Promise<{ stopped: true }> {
		return this.claiming(sessionId, async (session) => {
			await session.abort();
			return { stopped: true };
		});
	}

	/**
	 * Change which tools ask for approval, and the queue modes.
	 *
	 * A patch, so the fields are independent: the client sends only what moved, and a rejected value
	 * leaves the session's other settings alone.
	 *
	 * The model and the thinking level are not here. Both are the composer's, and both travel with the
	 * message they belong to (`prompt`), because a choice no request was made with is not a state the
	 * session is in.
	 */
	async updateConfig(sessionId: string, body: Record<string, unknown>): Promise<{ session: SessionSnapshot }> {
		const patch = body.patch ?? body;
		if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
			throw httpStatus.badRequest("`patch` must be a JSON object");
		}
		const fields = patch as ConfigPatch;

		return this.claiming(sessionId, (session) => {
			try {
				session.applyConfig(fields);
			} catch (error) {
				// An approval key or a queue mode the session cannot take: the request was understood and
				// refused, which is a conflict rather than a bad request.
				throw httpStatus.conflict(messageOf(error));
			}
			return { session: session.snapshot };
		});
	}

	/**
	 * Replace the active tool set.
	 *
	 * Replacing rather than patching is the session's own contract: an unknown name throws and leaves
	 * the set exactly as it was, so a client can never end up with a half-applied set.
	 */
	async updateTools(sessionId: string, body: Record<string, unknown>): Promise<{ session: SessionSnapshot }> {
		const names = body.names;
		if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
			throw httpStatus.badRequest("`names` must be an array of tool names");
		}
		const active = names as string[];

		return this.claiming(sessionId, (session) => {
			try {
				session.setActiveTools(active);
			} catch (error) {
				throw httpStatus.conflict(messageOf(error));
			}
			return { session: session.snapshot };
		});
	}

	/**
	 * Answer one approval prompt.
	 *
	 * A prompt that is no longer pending — already answered, denied by an abort, or gone because the
	 * server restarted — is a conflict rather than a no-op: the request was understood and refused,
	 * which is what 409 says. The client sees that error, and that is the point — a button that
	 * answers nothing and says so to no one is the failure this replaces. The answer the client needs
	 * about what *did* happen to the call comes from the baseline and the tool result, not from this
	 * status code, which claims only "nobody is waiting for this answer now".
	 *
	 * The order below is load-bearing. The read-only check comes first because only an answerable
	 * request may be recorded; `onApproval` comes before `approve` because answering publishes the
	 * change, and the frame that reports the answer is built from the session's own change
	 * notification — which therefore runs before this method gets control back.
	 */
	async approve(
		sessionId: string,
		toolCallId: string,
		body: Record<string, unknown>,
	): Promise<{ toolCallId: string; approved: boolean }> {
		const approved = body.approved;
		if (typeof approved !== "boolean") throw httpStatus.badRequest("`approved` must be a boolean");

		return this.claiming(sessionId, (session) => {
			// Refused before anything is recorded: an id this session is not waiting on gets a 409, and
			// neither the answer table nor the session hears about the attempt.
			if (!session.hasPendingApproval(toolCallId)) {
				throw httpStatus.conflict(`${toolCallId} is not a pending approval`);
			}
			this.listeners.onApproval?.(sessionId, toolCallId, approved);
			session.approve(toolCallId, approved);
			return { toolCallId, approved };
		});
	}

	/**
	 * Run something against a session while holding the one claim it needs to stay open.
	 *
	 * The hub hands out claims, not sessions, so a request that is not an event stream claims for the
	 * length of one read or write and gives the claim straight back. That keeps one rule for
	 * lifetime: a session is open while anything holds a claim on it, and closed once the last claim
	 * has let go.
	 *
	 * A session that does not exist is a 404. Anything else the hub throws — a transcript file it
	 * cannot parse, a session it cannot assemble — is this server's problem, and saying "not found"
	 * about it would send the caller looking for a typo in an id that is perfectly good.
	 */
	private async claiming<T>(sessionId: string, use: (session: Agent) => T | Promise<T>): Promise<T> {
		if (!this.hub.has(sessionId)) throw httpStatus.notFound(`Unknown session: ${sessionId}`);

		const host = await this.hub.claim(sessionId);
		try {
			return await use(host.session);
		} finally {
			this.hub.release(host);
		}
	}

	/** A run that could not even start, said on the stream because its request is long answered. */
	private onRunFailure(sessionId: string, message: string): void {
		this.listeners.onRunFailure?.(sessionId, message);
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
