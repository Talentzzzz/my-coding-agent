import type {
	BashSettings,
	ConfigPatch,
	ModelInput,
	ModelOption,
	ModelSelection,
	PromptBehavior,
	SessionRef,
	SessionSnapshot,
	SettingsSnapshot,
	WorkspaceGroup,
} from "@my-agent/core/protocol";

/** What the settings panel can change. Narrower than the server's own patch, which is the point. */
export interface PanelSettingsPatch {
	/** The row a new session starts on, as `<name>/<wire id>`. */
	model?: string;
	appearance?: { theme?: "system" | "light" | "dark"; fontSize?: number };
	approval?: Record<string, boolean>;
	/** Partial so one timeout can be committed without naming the other. */
	bash?: Partial<BashSettings>;
}

/**
 * The API, as this browser sees it.
 *
 * Every command is one request, which is the point of the transport: the browser is a client of the
 * same HTTP surface a script or `curl` would use, so nothing here is privileged and nothing needs a
 * connection to be open. A session's events arrive on a separate stream (`./client.ts`), because a
 * run outlives the request that started it.
 */
export class SessionApi {
	/**
	 * Accept a prompt.
	 *
	 * Returns as soon as the server has it — the answer arrives on the event stream. `behavior`
	 * applies only mid-run: `steer` interrupts, `followUp` waits for the turn to end.
	 *
	 * `selection` is which model answers and how hard it is asked to think. It rides here rather than
	 * as a config change of its own because neither half is in force until this message is sent with
	 * it, so a composer that moves the seat and never sends moves nothing.
	 */
	async prompt(sessionId: string, text: string, behavior: PromptBehavior | undefined, selection: ModelSelection): Promise<void> {
		await this.post(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { text, behavior, ...selection });
	}

	/** Stop the run in flight. This is a request of its own, unbounded by the event stream. */
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

	/** Start a conversation. It becomes what an unnamed stream lands on, so `follow` it right after. */
	async createSession(): Promise<{ sessionId: string; sessions: SessionRef[] }> {
		return this.send("POST", "/api/sessions", undefined);
	}

	/** Branch a session at one entry, or copy the whole log when the entry is null. */
	async forkSession(sessionId: string, entryId: string | null): Promise<{ sessionId: string; sessions: SessionRef[] }> {
		return this.send("POST", `/api/sessions/${encodeURIComponent(sessionId)}/forks`, { entryId });
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

	async listSessions(): Promise<{ sessions: SessionRef[] }> {
		return this.send("GET", "/api/sessions", undefined);
	}

	/**
	 * Which session a window with no anchor of its own should open.
	 *
	 * The server answers this rather than the client picking from the list, because the choice is the
	 * server's: `--session` pins a conversation, `--continue` resumes one, and a workspace with
	 * history reopens the most recent. A client that chose "the newest file" would silently ignore
	 * all three, and an empty history still answers with a session the server has just created.
	 */
	async currentSession(): Promise<{ sessionId: string; sessions: SessionRef[] }> {
		return this.send("GET", "/api/sessions/current", undefined);
	}

	/** Where this server is rooted, which is the workspace a new session is created in. */
	async health(): Promise<{ ok: boolean; cwd: string; live: string[] }> {
		return this.send("GET", "/api/health", undefined);
	}

	/** Every workspace this machine has sessions for, for the sidebar's groups. */
	async listWorkspaces(): Promise<{ workspaces: WorkspaceGroup[] }> {
		return this.send("GET", "/api/workspaces", undefined);
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

	/**
	 * Read one session without attaching a stream to it.
	 *
	 * This is how a window looks at a conversation: a transcript is a `GET`, and a stream is opened
	 * only for a run. Existence is decided here too — a read of an id that names nothing is a 404 —
	 * which is why nothing else has to ask whether a session is there.
	 */
	async read(sessionId: string): Promise<SessionSnapshot> {
		const body = await this.send<{ session: SessionSnapshot }>("GET", `/api/sessions/${encodeURIComponent(sessionId)}`, undefined);
		return body.session;
	}

	private async post(path: string, body: unknown): Promise<void> {
		await this.send("POST", path, body);
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
