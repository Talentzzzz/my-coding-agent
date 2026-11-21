import type {
	BashSettings,
	ConfigPatch,
	ModeSettings,
	ModelInput,
	ModelOption,
	ModelSelection,
	PromptBehavior,
	SessionSnapshot,
	GlobalSettingsSnapshot,
	DirectoryGroup,
} from "@my-agent/case/protocol";

/** 设置面板能改的东西。比服务端自己的补丁窄，这正是目的。 */
export interface PanelSettingsPatch {
	/** 新会话起始的行，格式为 `<name>/<wire id>`。 */
	model?: string;
	/** 窗口"已种下内置默认"的标记；见 `Settings.defaultModelSeeded`。 */
	defaultModelSeeded?: boolean;
	/** 全局默认活跃工具集，像会话级端点自己的那样整体发送。 */
	tools?: string[];
	/**
	 * 用户的模式，像 `tools` 一样整体发送（ADR-0004）：面板编辑的是一个列表，半应用状态的列表
	 * 是谁也无法推理的唯一状态。
	 */
	modes?: ModeSettings[];
	approval?: Record<string, boolean>;
	/** Partial 是为了让一个超时可以单独提交而不必指名另一个。 */
	bash?: Partial<BashSettings>;
}

/**
 * 这个浏览器眼中的 API。
 *
 * 每条命令一个请求，这正是传输的意义：浏览器是与脚本或 `curl` 使用的同一个 HTTP 表面的客户端，
 * 所以这里没有任何特权，也没有任何东西需要打开连接。反向到达的东西 —— 一次运行的事件、变更的
 * 侧栏行 —— 不来自这里；它们来自一条常驻通道（`./client.ts`），因为一次运行的寿命超过启动它的
 * 请求，而会话列表无论有没有人问都会变化。
 *
 * 这个拆分就是本文件完全没有连接概念的原因。它可以在通道完全健康时失败，窗口把这两件事分别上报
 * 而不是让一个代替另一个。
 *
 * 一个读取被刻意省略：`GET /api/sessions/{id}` 仍为脚本和诊断而存在，但窗口不再用它打开会话。
 * 它用一个 `open` 帧打开会话并绘制应答的基线（ADR-0009），于是屏幕上只有一份基线，而不是一次
 * 读取的副本与通道的赛跑。
 */
export class SessionApi {
	/**
	 * 接受一条提示。
	 *
	 * 服务端一拿到就返回 —— 答案经通道到达。`behavior` 只在运行中途生效：`steer` 打断，
	 * `followUp` 等回合结束。
	 *
	 * `selection` 是哪个模型应答、要求它多用力思考。它随这条消息而不是作为独立的配置变更走，
	 * 因为两半都要到这条消息带着它们发出时才生效，所以只移动席位却从不发送的 composer 什么都没
	 * 移动。
	 */
	async prompt(sessionId: string, text: string, behavior: PromptBehavior | undefined, selection: ModelSelection): Promise<void> {
		await this.post(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { text, behavior, ...selection });
	}

	/**
	 * 停止进行中的运行。一个自己的请求，不是通道上的帧：无法在通道上发送的客户端，仍然必须能够
	 * 停止某个东西。
	 */
	async abort(sessionId: string): Promise<void> {
		await this.post(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, {});
	}

	async setConfig(sessionId: string, patch: ConfigPatch): Promise<void> {
		await this.send("PATCH", `/api/sessions/${encodeURIComponent(sessionId)}`, { patch });
	}

	async approve(sessionId: string, toolCallId: string, approved: boolean): Promise<void> {
		await this.post(
			`/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(toolCallId)}`,
			{ approved },
		);
	}

	/**
	 * 出生证明：会话与它的第一条消息在同一个请求里诞生（ADR-0021）。
	 *
	 * `text` 必填 —— 没有第一条消息的会话不存在。`workDirAbsPath` 是新会话落地的目录：目录选择器
	 * 自己的选择，随请求做出，绝不是服务端的"当前目录"。undefined 是服务端的根。`mode` / `model` /
	 * `thinkingLevel` 是随这条消息出发的选择 —— 模式指针与模型行在出生写入之前落到快照上；
	 * `behavior` 随消息携带，出生时不可能有在飞的运行。
	 *
	 * 答案指名新会话，让窗口把自己指过去。随之而来的列表被刻意不暴露：侧栏的行同一时刻只有一个
	 * 写入者，通道可用时那个写入者是通道 —— 见 {@link sessionId}。
	 */
	async createSession(input: {
		text: string;
		workDirAbsPath?: string;
		behavior?: PromptBehavior;
		mode?: string;
		model?: string;
		thinkingLevel?: string;
	}): Promise<{ sessionId: string }> {
		return this.sessionId("POST", "/api/sessions", input);
	}

	/** 在某个条目处分出会话分支，条目为 null 时复制整份日志。 */
	async forkSession(sessionId: string, entryId: string | null): Promise<{ sessionId: string }> {
		return this.sessionId("POST", `/api/sessions/${encodeURIComponent(sessionId)}/forks`, { entryId });
	}

	/**
	 * 给会话一个自己的名字。
	 *
	 * 答案只说条目已落地：侧栏画的行等到连接的 `session_row` 帧携带新名时才变，那是所有其他行事实
	 * 走的同一条路。
	 */
	async renameSession(sessionId: string, title: string): Promise<{ sessionId: string; title: string }> {
		return this.send("POST", `/api/sessions/${encodeURIComponent(sessionId)}/title`, { title });
	}

	/**
	 * 整个删除会话 —— 会话记录、文件、一切。
	 *
	 * 这个答案说明服务端做了；侧栏画的行随连接的 `session_gone` 帧离开，而不是随这里返回的任何
	 * 东西，所以列表永远不会通过两条路得知一次删除。
	 */
	async deleteSession(sessionId: string): Promise<void> {
		await this.send("DELETE", `/api/sessions/${encodeURIComponent(sessionId)}`, undefined);
	}

	/**
	 * 把这个会话移到它自己树上的另一个分支，并以它现在的样子作答。
	 *
	 * `descend` 是窗口提供的两种手势之间的全部差别：选择一个已存在的备选项落在它停下的地方，而
	 * 回退到一条消息落在消息本身上，于是下一个提示从那里开启新的备选项。
	 */
	async branchSession(sessionId: string, entryId: string, descend: boolean): Promise<{ session: SessionSnapshot }> {
		return this.send("POST", `/api/sessions/${encodeURIComponent(sessionId)}/branch`, { entryId, descend });
	}

	/**
	 * 一个没有自己锚点的窗口应该打开哪个会话 —— `null` 表示"没有，停在欢迎状态"。
	 *
	 * 服务端应答这个而不是客户端从列表里挑，因为选择是服务端的：`--session` 钉住一段对话，否则
	 * 答案是服务端最后创建的会话，或 `null` —— 启动不选择任何东西，服务端也绝不会为了填这个答案
	 * 而创建会话。自己挑"最新文件"的客户端会默默忽略钉住的会话。
	 *
	 * 随之返回的列表留着不读。侧栏的行在通道可用时来自通道，这个端点的副本只是通道不可用时的
	 * 兜底 —— 无条件采用它意味着一张表两个写入者。
	 */
	async currentSession(): Promise<{ sessionId: string | null }> {
		const answer = await this.send<{ sessionId: string | null }>("GET", "/api/sessions/current", undefined);
		return { sessionId: answer.sessionId };
	}

	/**
	 * 这个服务端根在何处，以及它此刻握着哪些会话。
	 *
	 * 整个响应都有类型，`held` 包括在内，即使这个客户端只读 `workDirAbsPath`。声明一个更窄的形状
	 * 会让本文件描述的不是那个端点 —— 下一个想要 `held` 的读者会发现一个坚称它不存在的类型。
	 */
	async health(): Promise<{ ok: boolean; workDirAbsPath: string; held: string[] }> {
		return this.send("GET", "/api/health", undefined);
	}

	/** 这台机器有会话的每个目录，供侧栏的分组。 */
	async listDirectories(): Promise<{ directories: DirectoryGroup[] }> {
		return this.send("GET", "/api/directories", undefined);
	}

	async listModels(): Promise<{ models: ModelOption[] }> {
		return this.send("GET", "/api/models", undefined);
	}

	/**
	 * 替换已导入的模型。
	 *
	 * 列表整体发送：面板编辑的是一个列表，这里删一行、那里加一行的两处变更必须一起落地。
	 * `apiKey` 省略的行保留已存的那个，这让面板可以保存一行它从未见过密钥的编辑。
	 */
	async updateModels(models: ModelInput[]): Promise<{ models: ModelOption[] }> {
		return this.send("PUT", "/api/models", { models });
	}

	async getSettings(): Promise<{ settings: GlobalSettingsSnapshot }> {
		return this.send("GET", "/api/settings", undefined);
	}

	/** 本构建注册的工具名清单（ADR-0020）：进程活着就不过期，启动时取一次。 */
	async toolNames(): Promise<{ tools: string[] }> {
		return this.send("GET", "/api/tools", undefined);
	}

	async updateSettings(patch: PanelSettingsPatch): Promise<{ settings: GlobalSettingsSnapshot }> {
		return this.send("PATCH", "/api/settings", { patch });
	}

	private async post(path: string, body: unknown): Promise<void> {
		await this.send("POST", path, body);
	}

	/**
	 * 以会话 id 加完整会话列表作答的三个端点之一，收窄到 id。
	 *
	 * 收窄是目的而不是类型的意外：它们每一个都携带一份本客户端无权应用的列表，因为侧栏的行在通道
	 * 可用时由通道写、不可用时由 {@link listDirectories} 写。返回完整 body 会招来第二个写入者，而
	 * 第二个写入者就是一行说一个正在工作的会话空闲的行。
	 *
	 * wire 形状仍然在调用 `send` 时完整声明，所以这保持为一次收窄，而不是关于服务端发送什么的
	 * 第二个更小的断言。
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

/** 一次被拒绝的请求，带着以 HTTP 本就有的措辞说出原因的状态码。 */
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
