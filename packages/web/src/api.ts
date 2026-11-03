import type {
	BashSettings,
	ConfigPatch,
	ModeSettings,
	ModelInput,
	ModelOption,
	ModelSelection,
	PromptBehavior,
	SessionSnapshot,
	SettingsSnapshot,
	DirectoryGroup,
	DirectoryPaging,
} from "@my-agent/core/protocol";

/** What the settings panel can change. Narrower than the server's own patch, which is the point. */
export interface PanelSettingsPatch {
	/** The row a new session starts on, as `<name>/<wire id>`. */
	model?: string;
	/** The window's "already planted the built-in default" marker; see `Settings.defaultModelSeeded`. */
	defaultModelSeeded?: boolean;
	/** The global default active tool set, sent whole like the session-level endpoint's own. */
	tools?: string[];
	/**
	 * The user's modes, sent whole like `tools` (ADR-0005): the panel edits a list, and a half-applied
	 * list is the one state nobody can reason about.
	 */
	modes?: ModeSettings[];
	/**
	 * Directories the sidebar does not list, by absolute path, sent whole like `tools`.
	 *
	 * The panel has no control for this and probably never will: it is the shape 「删除」 on a directory
	 * heading goes through, and hiding a directory from a settings list would be a second door to the
	 * one act that needs the group in front of you to mean anything.
	 */
	hiddenDirectories?: string[];
	appearance?: {
		theme?: "system" | "light" | "dark";
		fontSize?: number;
		sidebarWidth?: number;
		contentWidth?: number;
		/** The sidebar's per-directory paging state, sent whole like every other appearance field. */
		directories?: Record<string, DirectoryPaging>;
	};
	approval?: Record<string, boolean>;
	/** Partial so one timeout can be committed without naming the other. */
	bash?: Partial<BashSettings>;
}

/**
 * The API, as this browser sees it.
 *
 * Every command is one request, which is the point of the transport: the browser is a client of the
 * same HTTP surface a script or `curl` would use, so nothing here is privileged and nothing needs a
 * connection to be open. What arrives the other way — a run's events, a changed sidebar row — does not
 * come from here; it comes on one resident channel (`./client.ts`), because a run outlives the request
 * that started it and a list of sessions changes whether or not anyone asked.
 *
 * That split is why this file has no notion of a connection at all. It can fail while the channel is
 * perfectly healthy, and the window reports those two things separately rather than letting one stand
 * in for the other.
 *
 * One read is deliberately missing: `GET /api/sessions/{id}` still exists for scripts and diagnostics,
 * but a window no longer opens a session with it. It opens one with an `open` frame and draws the
 * baseline that answers (ADR-0010), so there is one baseline on screen instead of a read's copy racing
 * the channel's.
 */
export class SessionApi {
	/**
	 * Accept a prompt.
	 *
	 * Returns as soon as the server has it — the answer arrives on the channel. `behavior`
	 * applies only mid-run: `steer` interrupts, `followUp` waits for the turn to end.
	 *
	 * `selection` is which model answers and how hard it is asked to think. It rides here rather than
	 * as a config change of its own because neither half is in force until this message is sent with
	 * it, so a composer that moves the seat and never sends moves nothing.
	 */
	async prompt(sessionId: string, text: string, behavior: PromptBehavior | undefined, selection: ModelSelection): Promise<void> {
		await this.post(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { text, behavior, ...selection });
	}

	/**
	 * Stop the run in flight. A request of its own, and not a frame on the channel: a client that
	 * cannot send on the channel still has to be able to stop something.
	 */
	async abort(sessionId: string): Promise<void> {
		await this.post(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, {});
	}

	async setConfig(sessionId: string, patch: ConfigPatch): Promise<void> {
		await this.send("PATCH", `/api/sessions/${encodeURIComponent(sessionId)}`, { patch });
	}

	/** Replace the active tool set; the session refuses a name it does not know and changes nothing. */
	async setTools(sessionId: string, names: string[]): Promise<void> {
		await this.send("PUT", `/api/sessions/${encodeURIComponent(sessionId)}/tools`, { names });
	}

	async approve(sessionId: string, toolCallId: string, approved: boolean): Promise<void> {
		await this.post(
			`/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(toolCallId)}`,
			{ approved },
		);
	}

	/**
	 * Start a conversation.
	 *
	 * `workDirAbsPath` is where the new session lands: the directory picker's own choice, made with the request
	 * and never a server-side "current directory". Undefined is the server's root, which is what a
	 * bodyless create has always meant.
	 *
	 * The answer names the new session so the window can point itself at it. The listing that comes
	 * with it is deliberately not exposed: the sidebar's rows have one writer at a time, and while the
	 * channel is up that writer is the channel — see {@link sessionId}.
	 */
	async createSession(workDirAbsPath?: string): Promise<{ sessionId: string }> {
		return this.sessionId("POST", "/api/sessions", workDirAbsPath === undefined ? undefined : { workDirAbsPath });
	}

	/** Branch a session at one entry, or copy the whole log when the entry is null. */
	async forkSession(sessionId: string, entryId: string | null): Promise<{ sessionId: string }> {
		return this.sessionId("POST", `/api/sessions/${encodeURIComponent(sessionId)}/forks`, { entryId });
	}

	/**
	 * Give a session a name of its own.
	 *
	 * The answer only says the entry landed: the row a sidebar draws takes the new name when the
	 * connection's `session_row` frame carries it, which is the same road every other row fact takes.
	 */
	async renameSession(sessionId: string, title: string): Promise<{ sessionId: string; title: string }> {
		return this.send("POST", `/api/sessions/${encodeURIComponent(sessionId)}/title`, { title });
	}

	/**
	 * Delete the session whole — transcript, file, everything.
	 *
	 * This answer says the server did it; the row a sidebar draws leaves on the connection's
	 * `session_gone` frame rather than on anything returned here, so the list never learns about a
	 * removal through two roads.
	 */
	async deleteSession(sessionId: string): Promise<void> {
		await this.send("DELETE", `/api/sessions/${encodeURIComponent(sessionId)}`, undefined);
	}

	/**
	 * Move this session onto another branch of its own tree, and answer with what it looks like now.
	 *
	 * `descend` is the whole difference between the two gestures a window offers: choosing an existing
	 * alternative lands on where it stopped, while rewinding to a message lands on the message itself,
	 * so the next prompt starts a new alternative from there.
	 */
	async branchSession(sessionId: string, entryId: string, descend: boolean): Promise<{ session: SessionSnapshot }> {
		return this.send("POST", `/api/sessions/${encodeURIComponent(sessionId)}/branch`, { entryId, descend });
	}

	/**
	 * Which session a window with no anchor of its own should open.
	 *
	 * The server answers this rather than the client picking from the list, because the choice is the
	 * server's: `--session` pins a conversation, and otherwise a new session is created — a launch
	 * lands on the welcome state, not on whatever was last spoken in. A client that chose "the newest
	 * file" would silently ignore the pin, and an empty history still answers with a session the
	 * server has just created.
	 *
	 * The listing that comes back with it is left unread. The sidebar's rows come from the channel
	 * whenever it is up, and this endpoint's copy is the fallback for when it is not — taking it
	 * unconditionally would mean two writers for one table.
	 */
	async currentSession(): Promise<{ sessionId: string }> {
		return this.sessionId("GET", "/api/sessions/current", undefined);
	}

	/**
	 * Where this server is rooted, and what it currently has running.
	 *
	 * The whole response is typed, `live` included, even though this client reads only `workDirAbsPath`. Declaring
	 * a narrower shape would make this file describe something other than the endpoint — and the next
	 * reader who wants `live` would find a type that insists it does not exist.
	 */
	async health(): Promise<{ ok: boolean; workDirAbsPath: string; live: string[] }> {
		return this.send("GET", "/api/health", undefined);
	}

	/** Every directory this machine has sessions for, for the sidebar's groups. */
	async listDirectories(): Promise<{ directories: DirectoryGroup[] }> {
		return this.send("GET", "/api/directories", undefined);
	}

	/**
	 * Give a directory a name the sidebar shows, touching nothing on disk.
	 *
	 * `workDirAbsPath` names the group and `name` is the label — they are not two paths: the folder keeps the name
	 * the file system gave it, and this is a view the settings remember. An empty name takes the
	 * custom one back, and the heading falls to the folder's own name again.
	 *
	 * The answer carries the settings snapshot because that is where the label lives: the window
	 * applies it and repaints the heading, and no row moved, so there is no `session_row` frame on its
	 * way to disagree with.
	 */
	async renameDirectory(workDirAbsPath: string, name: string): Promise<{ workDirAbsPath: string; name: string; settings: SettingsSnapshot }> {
		return this.send("POST", "/api/directories/rename", { workDirAbsPath, name });
	}

	/**
	 * Take a directory out of the list, touching nothing on disk.
	 *
	 * The whole stored list and the visible listing come back because this is the one directory
	 * command that does not ride the channel: nothing about a hidden directory is a row fact, so the
	 * endpoint answers with what the sidebar should now draw — and the client applies it rather than
	 * guessing, which would be a second writer for a list the server owns.
	 */
	async hideDirectory(workDirAbsPath: string): Promise<{ settings: SettingsSnapshot; directories: DirectoryGroup[] }> {
		return this.send("POST", "/api/directories/hide", { workDirAbsPath });
	}

	async listModels(): Promise<{ models: ModelOption[] }> {
		return this.send("GET", "/api/models", undefined);
	}

	/**
	 * Replace the imported models.
	 *
	 * The list is sent whole: the panel edits a list, and a row removed here and another added there
	 * have to land together. A row whose `apiKey` is omitted keeps the stored one, which is what lets
	 * the panel save an edit to a row it was never shown the key for.
	 */
	async updateModels(models: ModelInput[]): Promise<{ models: ModelOption[] }> {
		return this.send("PUT", "/api/models", { models });
	}

	async getSettings(): Promise<{ settings: SettingsSnapshot }> {
		return this.send("GET", "/api/settings", undefined);
	}

	async updateSettings(patch: PanelSettingsPatch): Promise<{ settings: SettingsSnapshot }> {
		return this.send("PATCH", "/api/settings", { patch });
	}

	private async post(path: string, body: unknown): Promise<void> {
		await this.send("POST", path, body);
	}

	/**
	 * One of the three endpoints that answer with a session id plus a whole session listing, narrowed
	 * to the id.
	 *
	 * The narrowing is the point rather than an accident of typing: every one of them carries a listing
	 * this client has no business applying, because the sidebar's rows are written by the channel while
	 * it is up and by {@link listDirectories} while it is not. Returning the full body would invite the
	 * second writer, and a second writer is a row that says a working session is idle.
	 *
	 * The wire shape is still declared in full at the call to `send`, so this stays a narrowing rather
	 * than a second, smaller claim about what the server sends.
	 */
	private async sessionId(method: string, path: string, body: unknown): Promise<{ sessionId: string }> {
		const answer = await this.send<{ sessionId: string }>(method, path, body);
		return { sessionId: answer.sessionId };
	}

	private async send<T>(method: string, path: string, body: unknown): Promise<T> {
		const init: RequestInit = { method, headers: { accept: "application/json" } };
		if (body !== undefined) {
			init.headers = { ...init.headers, "content-type": "application/json" };
			init.body = JSON.stringify(body);
		}

		const response = await fetch(path, init);
		const text = await response.text();
		const payload = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
		if (!response.ok) throw new ApiError(response.status, errorMessage(payload) ?? `${method} ${path} 请求失败：HTTP ${response.status}`);
		return payload as T;
	}
}

/** A refused request, with the status that says why in the terms HTTP already has. */
export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

function errorMessage(payload: unknown): string | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const message = (payload as { error?: unknown }).error;
	return typeof message === "string" ? message : undefined;
}
