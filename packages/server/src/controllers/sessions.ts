import {
	type Agent,
	clampContentWidth,
	clampFontSize,
	clampSidebarWidth,
	clampDirectoryPaging,
	coerceModelConfig,
	type ConfigPatch,
	DEFAULT_MODE_NAME,
	listModelOptions,
	type ModeSettings,
	shortenTitle,
	type ModelOption,
	type ModelSelection,
	resolvePath,
	type SessionRef,
	type SessionSnapshot,
	type Settings,
	type SettingsPatch,
	type SettingsSnapshot,
	toSessionRef,
	type ModelConfig,
	type DirectoryGroup,
	type DirectoryPaging,
	UnknownSessionError,
} from "@my-agent/core";
import { dirname, resolve, sep } from "node:path";
import { httpStatus } from "../http/errors.ts";
import { samePath, workDirAbsPathForCreate, workDirAbsPathOrThrow, type SessionHub } from "../hub.ts";

/** 一个目录下存储的会话，从会话文件收窄到 wire 上承载的字段。 */
export async function listSessions(agent: Agent, workDirAbsPath: string): Promise<SessionRef[]> {
	return (await agent.listSessions(workDirAbsPath)).map(toSessionRef);
}

/** 设置面板读取的东西：它可以编辑的值，和它只读展示的值。 */
function settingsOf(settings: Settings): SettingsSnapshot {
	const hidden = settings.hiddenDirectories ?? [];
	const names: Record<string, string> = {};
	for (const [dir, name] of Object.entries(settings.directoryNames ?? {})) {
		if (name.trim().length > 0) names[dir] = name;
	}
	return {
		appearance: settings.appearance,
		approval: settings.approval,
		bash: settings.bash,
		...(settings.tools === undefined ? {} : { tools: settings.tools }),
		...(settings.modes === undefined ? {} : { modes: settings.modes }),
		...(hidden.length === 0 ? {} : { hiddenDirectories: hidden }),
		...(Object.keys(names).length === 0 ? {} : { directoryNames: names }),
		...(settings.model === undefined ? {} : { model: settings.model }),
		...(settings.defaultModelSeeded === undefined ? {} : { defaultModelSeeded: settings.defaultModelSeeded }),
	};
}

/**
 * controller 向 transport 报告的事项，因为流归 transport 所有。
 *
 * 两者都是"请求与流分离"的结果：一次运行的失败已经没有响应可以上报，而审批的答案必须到达观看该会话的每条流，不只是给出答案的那个客户端。因此两者都指名自己所属的会话：答案键控到给出它的会话上，另一个会话恰好也在等的 `toolCallId` 是那个会话的问题，不是这个答案的。
 */
export interface SessionListener {
	onRunFailure?(sessionId: string, message: string): void;
	onApproval?(sessionId: string, toolCallId: string, approved: boolean): void;
	/**
	 * 一次存储型改名落地，行的 title 在文件被再读一次之前是过期的。projection 重读该行，普通的 `session_row` 帧把新名字带给每个窗口——与其他任何行变更同一条路，客户端不必为侧栏学第二种消息形状。
	 */
	onRenamed?(sessionId: string): void;
	/** 一个会话被删除。projection 丢掉它的行，transport 告知其客户端。 */
	onRemoved?(sessionId: string): void;
	/**
	 * 一个目录进入或离开机器的列表：被放到一边，或被领回。
	 *
	 * 没有行变更，所以不存在能承载这件事的 `session_row` 帧：动的是组列表本身，transport 以重发行列表所来自的 overview 来应答。什么都不被告知的窗口会继续画一个服务器已经不列的组——这正是「删除」承诺绝不发生的事。
	 */
	onDirectoryListingChanged?(): void;
}

/**
 * 模型、目录组和存储的设置。
 *
 * 三者都是 orchestrator 拥有之物的只读视图——hub 转发给它的 facade、自己不拥有任何一项（ADR-0017）——而且三者都曾是 socket 推送的帧。改走 HTTP 后由客户端来要，这才让一个没有会话的页面刷新仍然能填满侧栏、设置面板和模型列表。
 */
export class SystemController {
	private readonly hub: SessionHub;
	/**
	 * 命令的后果在其应答之外的去处。
	 *
	 * 目录改名是这里唯一一个后果超出自身响应的东西：组的每一行同时移动，而 projection 是行的唯一写入者，所以要告知调用者而不是让它猜。可选的理由与 {@link SessionController} 上相同：只要 HTTP surface 的 smoke 根本不接 transport。
	 */
	private readonly listeners: SessionListener;

	constructor(hub: SessionHub, listeners: SessionListener = {}) {
		this.hub = hub;
		this.listeners = listeners;
	}

	health(): { ok: boolean; workDirAbsPath: string; live: readonly string[] } {
		return { ok: true, workDirAbsPath: this.hub.workDirAbsPath, live: this.hub.live };
	}

	models(): ModelOption[] {
		return listModelOptions(this.hub.userModels);
	}

	/**
	 * 替换导入的模型。
	 *
	 * 列表整份发送而不是逐行，因为面板编辑的是一份列表，半应用的列表是唯一谁都无法推理的状态——这里删一行、那里加一行必须一起落地，要么都不落。
	 *
	 * 到达时没有 `apiKey` 的行保留其名字下已存储的那一个。这让面板能往返一个从未被告知 key 的模型：客户端把它看得见的每个字段原样回传，它看不见的 key 在往返中完好无损。
	 *
	 * 两行认领同一个名字被直接拒绝，而不是变得唯一。名字在这里是一行的身份——transcript 记录它、config patch 指名它——悄悄加后缀意味着用户看到的行不是其会话在找的行。面板指出撞名的是哪个名字，什么都不写。
	 */
	updateModels(body: Record<string, unknown>): { models: ModelOption[] } {
		const input = body.models;
		if (!Array.isArray(input)) throw httpStatus.badRequest("`models` must be an array");

		const stored = new Map(this.hub.userModels.map((model) => [model.name, model.apiKey]));
		const rows: ModelConfig[] = [];
		for (const entry of input) {
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
				throw httpStatus.badRequest("Every model must be a JSON object");
			}
			const record = entry as Record<string, unknown>;
			const name = typeof record.name === "string" ? record.name.trim() : undefined;
			const carried = name === undefined ? undefined : stored.get(name);
			const candidate = record.apiKey === undefined && carried !== undefined ? { ...record, apiKey: carried } : record;

			const model = coerceModelConfig(candidate);
			if (model === undefined) {
				throw httpStatus.badRequest("Every model needs a `id` and a `baseUrl`, and a name of its own");
			}
			if (rows.some((row) => row.name === model.name)) {
				throw httpStatus.badRequest(`The name "${model.name}" is already in use`);
			}
			rows.push(model);
		}

		this.hub.setModelConfigs(rows);
		return { models: listModelOptions(rows) };
	}

	/** 本机器有会话的每个目录，各带自己的列表，最近在前。 */
	async directories(): Promise<{ directories: DirectoryGroup[] }> {
		return { directories: (await this.hub.agent.listDirectories()).filter((group) => this.hub.listsDirectory(group.workDirAbsPath)) };
	}

	/**
	 * 给目录一个本窗口显示时替代文件夹名的名字。
	 *
	 * 一个视图决定，且刻意是本应用提供的唯一一种改名：目录由其 transcript 记录的目录本身标识，所以"重命名那个目录"会是一次*移动*。它得重写每个 header，用户在我们背后重命名文件夹的那一刻就会坏掉，而且会把一个破坏性操作藏在一个看起来像标签的菜单项后面。用户在这里输入的东西只进 settings、别无去处；文件夹保留文件系统给它的名字，每个会话保留其 header 持有的 `workDirAbsPath`。
	 *
	 * 空名字收回自定义名字，标题重新戴上文件夹自己的名字。
	 */
	async renameDirectory(body: Record<string, unknown>): Promise<{ workDirAbsPath: string; name: string; settings: SettingsSnapshot }> {
		const workDirAbsPath = body.workDirAbsPath;
		const name = body.name;
		if (typeof workDirAbsPath !== "string" || workDirAbsPath.trim().length === 0) {
			throw httpStatus.badRequest("`workDirAbsPath` must be a directory path");
		}
		if (typeof name !== "string") throw httpStatus.badRequest("`name` must be a string");

		const absSource = resolve(workDirAbsPath);
		// 与列表相同的检查：本机器没有会话的路径不是目录，给它起名只会存下一个永远不会被画出来的标签。
		const groups = await this.hub.agent.listDirectories();
		if (!groups.some((group) => samePath(group.workDirAbsPath, absSource))) {
			throw httpStatus.notFound(`Unknown directory: ${absSource}`);
		}

		this.hub.agent.applySettings(this.hub.workDirAbsPath, { directoryNames: { [absSource]: name.trim() } });
		return { workDirAbsPath: absSource, name: name.trim(), settings: settingsOf(this.hub.agent.settings(this.hub.workDirAbsPath)) };
	}

	/**
	 * 把目录从列表移除，磁盘上什么都不碰。
	 *
	 * 存储的列表整份发送，与客户端自己的 `hidden` 列表读取方式一致，字段走普通的 settings 之路——所以「删除」是一个视图决定，重载后依然成立，transcript 与其命名的目录都没有被移动。
	 *
	 * 有两件事是告知而不是返回的，因为它们是第二个窗口没有在问的事实：列表本身随应答一起回去了，而其他每个窗口会以一份新 overview 听到同样的消息——见 {@link SessionListener.onDirectoryListingChanged}。重新加回目录是在其中创建一个新会话，那是 {@link SessionController.create} 那一半。
	 */
	hideDirectory(body: Record<string, unknown>): Promise<{ settings: SettingsSnapshot; directories: DirectoryGroup[] }> {
		const workDirAbsPath = body.workDirAbsPath;
		if (typeof workDirAbsPath !== "string" || workDirAbsPath.trim().length === 0) {
			throw httpStatus.badRequest("`workDirAbsPath` must be a directory path");
		}

		const hidden = this.hub.agent.hiddenDirectories(this.hub.workDirAbsPath);
		if (!hidden.some((path) => samePath(path, workDirAbsPath))) {
			this.hub.agent.applySettings(this.hub.workDirAbsPath, { hiddenDirectories: [...hidden, resolve(workDirAbsPath)] });
			this.listeners.onDirectoryListingChanged?.();
		}

		// 列表随应答一起回去，因为这个移除是一个*存储的*事实而不是一帧：本命令走 REST，而窗口画的行来自通道。自己应用猜测的客户端会成为服务器拥有的列表的第二个写者。
		return this.listing();
	}

	/** 可见的列表，按 hub 的规则过滤后的样子。 */
	private async listing(): Promise<{ settings: SettingsSnapshot; directories: DirectoryGroup[] }> {
		return {
			settings: settingsOf(this.hub.agent.settings(this.hub.workDirAbsPath)),
			directories: (await this.hub.agent.listDirectories()).filter((group) => this.hub.listsDirectory(group.workDirAbsPath)),
		};
	}

	settings(): { settings: SettingsSnapshot } {
		return { settings: settingsOf(this.hub.agent.settings(this.hub.workDirAbsPath)) };
	}

	/**
	 * 修改默认模型、主题、字号、审批集、bash 超时，或用户的模式。
	 *
	 * 比 {@link SessionController.updateConfig} 更窄，刻意的：这些是窗口自身运行所依赖的默认值，在任何会话存在之前就要读取，所以不能住在会话上。这里的 `approval` 因此是**目录默认值**——从未选择过的会话打开时的基准——不是运行中会话自己的应答，后者作为 config patch 走那个会话。`model` 是*新*会话起步的行；活会话所在的模型是 composer 的，随消息到达服务器而不是走这里。`tools` 是全局默认激活集，整份发送，与会话级端点自己的契约相同——而会话记录的选择仍然压过它，所以这里任何东西都到不了已经选过的会话。`modes` 是预设列表整份发送（ADR-0005）：把它应用到会话上是那个会话自己的两条命令，不是这个 patch。
	 */
	updateSettings(body: Record<string, unknown>): { settings: SettingsSnapshot } {
		const patch = body.patch ?? body;
		if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
			throw httpStatus.badRequest("`patch` must be a JSON object");
		}
		const fields = patch as Record<string, unknown>;

		const workDirAbsPath = this.hub.workDirAbsPath;
		const next: SettingsPatch = {};

		if (fields.tools !== undefined) {
			if (!Array.isArray(fields.tools) || fields.tools.some((name) => typeof name !== "string")) {
				throw httpStatus.badRequest("`tools` must be an array of tool names");
			}
			next.tools = fields.tools as string[];
		}

		if (fields.modes !== undefined) {
			// 列表整份发送——与导入模型相同的契约，理由也相同：面板编辑的是一份列表，半应用的列表是唯一谁都无法推理的状态。名字是一个模式的身份（ADR-0005），所以空名和撞名——与内置默认或其他行——都被拒绝而不是变得唯一。
			if (!Array.isArray(fields.modes)) throw httpStatus.badRequest("`modes` 必须是模式对象数组");
			const modes: ModeSettings[] = [];
			for (const entry of fields.modes) {
				if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
					throw httpStatus.badRequest("每个模式必须是一个 JSON 对象");
				}
				const record = entry as Record<string, unknown>;
				const name = typeof record.name === "string" ? record.name.trim() : "";
				if (name.length === 0) throw httpStatus.badRequest("每个模式都要有自己的名字");
				if (name === DEFAULT_MODE_NAME) {
					throw httpStatus.badRequest(`「${DEFAULT_MODE_NAME}」是内置默认模式的名字，不能另用`);
				}
				if (modes.some((mode) => mode.name === name)) {
					throw httpStatus.badRequest(`模式名「${name}」已经在用`);
				}
				if (!Array.isArray(record.tools) || record.tools.some((tool) => typeof tool !== "string")) {
					throw httpStatus.badRequest(`模式「${name}」的 \`tools\` 必须是工具名数组`);
				}
				if (typeof record.approval !== "object" || record.approval === null || Array.isArray(record.approval)) {
					throw httpStatus.badRequest(`模式「${name}」的 \`approval\` 必须是布尔映射`);
				}
				const approval: Record<string, boolean> = {};
				for (const [tool, value] of Object.entries(record.approval as Record<string, unknown>)) {
					if (typeof value !== "boolean") {
						throw httpStatus.badRequest(`模式「${name}」的 \`approval.${tool}\` 必须是布尔值`);
					}
					approval[tool] = value;
				}
				modes.push({ name, tools: record.tools as string[], approval: approval as ModeSettings["approval"] });
			}
			next.modes = modes;
		}

		if (fields.hiddenDirectories !== undefined) {
			if (!Array.isArray(fields.hiddenDirectories) || fields.hiddenDirectories.some((path) => typeof path !== "string")) {
				throw httpStatus.badRequest("`hiddenDirectories` must be an array of directory paths");
			}
			// 空是一种选择而不是缺席——"什么都不隐藏"——所以按原样存储，与空工具集遵循同一条规则。
			next.hiddenDirectories = fields.hiddenDirectories as string[];
		}

		if (fields.directoryNames !== undefined) {
			const names = fields.directoryNames;
			if (typeof names !== "object" || names === null || Array.isArray(names)) {
				throw httpStatus.badRequest("`directoryNames` must be an object of directory paths to names");
			}
			for (const [workDirAbsPath, name] of Object.entries(names as Record<string, unknown>)) {
				if (typeof name !== "string") {
					throw httpStatus.badRequest(`\`directoryNames.${workDirAbsPath}\` must be a string`);
				}
			}
			// 以变更了的 entry 发送，由设置写入者按键合并。空字符串是收回一个名字的方式，所以存储而不是在这里丢弃。
			next.directoryNames = names as Record<string, string>;
		}

		if (fields.model !== undefined) {
			if (typeof fields.model !== "string") throw httpStatus.badRequest("`model` must be a string");
			// 不指名任何行的默认值被拒绝而不是存储：`selectModel` 会回退到第一行，这里的拼写错误会表现为一个悄悄不起作用的偏好。行是 orchestrator 的、经 facade 新鲜读取，所以面板加载之后被删掉的行也会被抓到。
			if (this.hub.agent.modelCatalog().find((userModel) => userModel.name === fields.model) === undefined) {
				throw httpStatus.conflict(`Unknown model: ${fields.model}`);
			}
			next.model = fields.model;
		}

		if (fields.defaultModelSeeded !== undefined) {
			// 一个标记，不是偏好：客户端在植入内置默认行之后写一次，只有它的真假影响下次启动的播种决定。
			if (typeof fields.defaultModelSeeded !== "boolean") {
				throw httpStatus.badRequest("`defaultModelSeeded` must be a boolean");
			}
			next.defaultModelSeeded = fields.defaultModelSeeded;
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
				// 两个拖拽把手的宽度。各自在进入时经过自己的 clamp，所以绝对范围在这里被强制执行，与手改文件的处理完全一致——不是数字的值 clamp 成 undefined，即丢弃字段而不是存储它。
				...(appearance.sidebarWidth === undefined
					? {}
					: { sidebarWidth: clampSidebarWidth(appearance.sidebarWidth) }),
				...(appearance.contentWidth === undefined
					? {}
					: { contentWidth: clampContentWidth(appearance.contentWidth) }),
				// 侧栏按目录的翻页状态，同样逐 entry 归一化：entry 不是 record 的目录被丢弃而不是存储。整个字段不是 record——或 record 里已没有目录——就 clamp 成 undefined，把 `undefined` 展开进对象字面量正是让这个字段完全不出现在 patch 里的方式，于是什么都不存、什么都不造。
				...(appearance.directories === undefined
					? {}
					: { directories: clampDirectoryPaging(appearance.directories) }),
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

		this.hub.agent.applySettings(workDirAbsPath, next);
		return { settings: settingsOf(this.hub.agent.settings(workDirAbsPath)) };
	}

	async sessions(): Promise<{ sessions: SessionRef[] }> {
		return { sessions: await listSessions(this.hub.agent, this.hub.workDirAbsPath) };
	}

	/**
	 * 没有自己的 id 的客户端应当打开的会话——`null` 表示"没有，停在欢迎态"——以及画在旁边的列表。
	 *
	 * 两者一起返回，因为客户端启动时总是同时要两者，而向服务器要 id 正是让 `--session` 在 UI 中可观察的东西：客户端跟随服务器的应答，而不是从存储文件里猜。没有固定值时，答案是本进程最后创建的，或 `null`——启动什么都不选，这里也没有任何东西创建会话以供选择。
	 */
	async current(): Promise<{ sessionId: string | null; sessions: SessionRef[] }> {
		const [sessionId, sessions] = await Promise.all([this.hub.currentSessionId(), listSessions(this.hub.agent, this.hub.workDirAbsPath)]);
		return { sessionId, sessions };
	}
}

/**
 * 关于一个会话的一切：读它、改它的配置，以及那些曾是对 socket 消息的一个 `switch` 的各分支的命令。
 *
 * 每个方法都是对 orchestrator 的一次薄调用，处在它从 hub 拿到的 hold 之下。只有两个决定住在这里：一个失败作为什么 status，以及命令在会话接受后立即返回——运行本身在事件流上报告，永远不在这个响应上。
 */
export class SessionController {
	private readonly hub: SessionHub;
	private readonly listeners: SessionListener;

	constructor(hub: SessionHub, listeners: SessionListener = {}) {
		this.hub = hub;
		this.listeners = listeners;
	}

	/**
	 * 本进程正在运行、或可以打开的会话的当前状态。
	 *
	 * 本 controller 上唯一*不*经过 {@link holding} 的读取：读 transcript 不得拼装会话、hold 它、或淘汰它，所以向 hub 要快照而不是活对象。这里其他每个方法都在变更、或必须对着正在运行的会话执行，那些都保留自己的 hold。
	 *
	 * 存在性也不在这里检查：读取指名会话，orchestrator 在无人应答时以 {@link UnknownSessionError} 拒绝——transport 把它变成与旧预检查相同的 404。
	 */
	async read(sessionId: string): Promise<{ session: SessionSnapshot }> {
		return { session: await this.hub.snapshotOf(sessionId) };
	}

	/**
	 * 开始一个会话，并让它成为下一个未指名流的落点。
	 *
	 * 返回 id 而不是被 hold 的会话，让挂上恰好发生在一个地方：客户端接下来发送的 mux `open` 帧。创建会话会写它的 JSONL header，所以创建后从未打开的会话仍可按 id 找到——也仍可订阅，因为订阅读的是 transcript 而不是运行它。
	 *
	 * body 里的 `workDirAbsPath` 决定会话落在哪，列表为那个目录作答：刚把选择器指向新地方的窗口，应当可以相信自己看到的会话就是创建进去的那些。未定义保持服务器自己的 root，这正是无 body 的 `POST` 一直的含义。
	 */
	async create(body: Record<string, unknown> = {}): Promise<{ sessionId: string; sessions: SessionRef[] }> {
		const workDirAbsPath = body.workDirAbsPath;
		if (workDirAbsPath !== undefined && typeof workDirAbsPath !== "string") {
			throw httpStatus.badRequest("`workDirAbsPath` must be a string");
		}
		// 在这里解析，让列表指名的目录与 hub 验证并写入的目录是同一个，无论请求以什么写法到达。检查也在这里跑，因为"坏路径是请求的错"是一个 status 决定，而 status 决定在这里做；hub 重复它，让任何内部调用者都无法绕过检查写入会话。
		const absRoot = typeof workDirAbsPath === "string" && workDirAbsPath.length > 0 ? resolve(workDirAbsPath) : undefined;
		if (absRoot !== undefined) {
			try {
				// 本机器已经存有会话的目录在消失时被放回来：用户在我们背后重命名了文件夹，而他们看到的组仍是那个路径。
				await workDirAbsPathForCreate(this.hub.agent, absRoot);
			} catch (error) {
				throw httpStatus.badRequest(messageOf(error));
			}
		}
		const sessionId = await this.hub.newSession(absRoot);
		this.restoreDirectory(absRoot ?? this.hub.workDirAbsPath);
		return { sessionId, sessions: await listSessions(this.hub.agent, absRoot ?? this.hub.workDirAbsPath) };
	}

	/**
	 * 在一个被放到一边的目录里创建的新会话把它领回列表。
	 *
	 * 与 `SystemController.hideDirectory` 成对，是对「删除」这个单向门的回答：transcript 和目录从未被碰过，它还在那里可用——而回到它那里正是用户想要它重新出现在列表上的表示。写入 hub 可见性规则经 facade 读取的 settings 状态，下一次列表与下一帧 overview 因此已经一致。
	 */
	private restoreDirectory(workDirAbsPath: string): void {
		const hidden = this.hub.agent.hiddenDirectories(this.hub.workDirAbsPath);
		const kept = hidden.filter((path) => !samePath(path, workDirAbsPath));
		if (kept.length === hidden.length) return;
		this.hub.agent.applySettings(this.hub.workDirAbsPath, { hiddenDirectories: kept });
		this.listeners.onDirectoryListingChanged?.();
	}

	/**
	 * 在一个 entry 处分支会话。
	 *
	 * entry id 来自请求 body 而不是 query，因为它就是 fork *本身*：分支的落点，或不传则复制整份日志。源会话只被读——在其上的一轮活运行继续跑、继续写。
	 */
	async fork(sourceId: string, body: Record<string, unknown>): Promise<{ sessionId: string; sessions: SessionRef[] }> {
		const entryId = body.entryId;
		if (entryId !== undefined && entryId !== null && typeof entryId !== "string") {
			throw httpStatus.badRequest("`entryId` must be a string or null");
		}
		const sessionId = await this.hub.fork(sourceId, typeof entryId === "string" ? entryId : null);
		return { sessionId, sessions: await listSessions(this.hub.agent, this.hub.workDirAbsPath) };
	}

	/**
	 * 给会话一个自己的名字，存为其 `.json` 快照上的 title。
	 *
	 * 派生 title 遵循的缩短规则在这里、在任何东西被写入之前应用——用户的输入在像派生 title 一样被折叠和裁剪之前还不是 title，这样改名的行与派生的行在宽度和形状上无从区分。空名字被拒绝而不是存储：存一个空 title 会悄悄恢复派生 title，那正是*不改名*已经在做的事。没有清除改名；把名字改回去是另一次改名。
	 *
	 * 不占 hold，运行在途也不构成障碍：title 是关于会话的事实而不是关于某条路径的事实，loop 读取的任何东西都不依赖它。
	 */
	async rename(sessionId: string, body: Record<string, unknown>): Promise<{ sessionId: string; title: string }> {
		const title = body.title;
		if (typeof title !== "string") throw httpStatus.badRequest("`title` must be a string");
		const stored = shortenTitle(title);
		if (stored.length === 0) throw httpStatus.badRequest("`title` must be a non-empty string");
		await this.hub.rename(sessionId, stored);
		this.listeners.onRenamed?.(sessionId);
		return { sessionId, title: stored };
	}

	/**
	 * 删除会话：transcript、文件，以及本进程知道的关于它的每一行。
	 *
	 * 忙碌的会话是冲突而不是坏请求——请求被理解了，横在它与删除之间的是一次要等的运行或一个要答的审批，这正是 409 存在要指名的情形。listeners 在文件消失*之后*才听到，于是告知窗口的那一帧永远不会先于它所报告的事实。
	 */
	async remove(sessionId: string): Promise<{ removed: true }> {
		try {
			await this.hub.remove(sessionId);
		} catch (error) {
			// 不存在的会话是命令本身以 404 拒绝的那一个；hub 在这条路上抛的其他一切都属于"还在忙"，那是冲突。
			if (error instanceof UnknownSessionError) throw error;
			throw httpStatus.conflict(messageOf(error));
		}
		this.listeners.onRemoved?.(sessionId);
		return { removed: true };
	}

	/**
	 * 把会话移到它自己的树上的另一个分支。
	 *
	 * 是命令不是编辑：日志不被重写，只有叶子移动，发两次就是同一移动两次。它以会话的新状态应答，因为整份 transcript 变了，而发问的客户端正是看着它的那个。本会话上的*其他*每条流由 transport 从会话自己的 `branch_changed` 发送同一份快照——否则展示旧链的第二个窗口会把下一条 prompt 发到一个它并没有展示的分支上。
	 *
	 * entry id 来自请求 body 而不是 query，理由与 fork 相同：它就是命令*本身*。`descend` 在同一个手势的两端之间选择——落在替代分支的最新 tip 上，这是在分支之间切换的含义——或落在 entry 本身，让下一条 prompt 在那里开启一个新的替代分支。
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

		return this.holding(sessionId, (session) => {
			try {
				session.branchTo(sessionId, entryId, descend ?? true);
			} catch (error) {
				// 运行在途，或本会话不持有的一个 entry：被理解并被拒绝，是冲突而不是坏请求。
				throw httpStatus.conflict(messageOf(error));
			}
			return { session: session.snapshot(sessionId) };
		});
	}

	/**
	 * 接受一条 prompt。
	 *
	 * 202 而不是 200，在消息持久化后立即应答：`session.prompt()` 在*运行*结束时 resolve，那是几分钟之后，在这里 await 它会把请求——连同它的 hold——吊住整整一轮，还让 status code 变成谎言。改为启动并观察这次运行，只有启动失败被上报，且写在会话自己的流上，因为到那时已经没有响应可以上报了。
	 *
	 * `behavior` 决定运行中发来的 prompt 怎么办——`steer` 在运行中那一轮的下一个 drain 点注入，`followUp` 等这一轮结束。
	 *
	 * `model` 和 `thinkingLevel` 是 composer 自己的选择，它们随消息到达而不是作为独立的配置变更，因为两者在被用来发出一个请求之前都不为真：选模型不是 transcript 碰巧遭遇的事，而没有请求以其发出的档位从未生效过。它们与其余字段一起验证，坏的在持久化之前就被拒绝，被拒的选择让会话分毫未动。
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

		return this.holding(sessionId, (session) => {
			const selection: ModelSelection = {
				...(model === undefined ? {} : { model }),
				...(thinkingLevel === undefined ? {} : { thinkingLevel }),
			};
			// `prompt()` 在第一个 await 之前持久化消息并把运行标记为 streaming，所以这条应答返回时消息已在盘上、`submitting` 已为真。
			void session
				.prompt(sessionId, text, { ...(behavior === undefined ? {} : { behavior }), selection })
				.catch((error: unknown) => {
					this.onRunFailure(sessionId, messageOf(error));
				});
			return { accepted: true };
		});
	}

	/**
	 * 停止在途的运行。
	 *
	 * 这就是命令是 HTTP 请求而不是事件流上的一帧的原因：停止不属于流，任何持有会话 id 的调用者都能做——另一个 tab、一个脚本、一个 `curl`——流卡住的客户端仍然有出路。
	 */
	async abort(sessionId: string): Promise<{ stopped: true }> {
		return this.holding(sessionId, async (session) => {
			await session.abort(sessionId);
			return { stopped: true };
		});
	}

	/**
	 * 修改哪些工具要审批，以及队列模式。
	 *
	 * 是 patch，所以字段相互独立：客户端只发变动了的，被拒的值不碰会话的其他设置。
	 *
	 * 模型和思考档位不在这里。两者都是 composer 的，随它们所属的消息走（`prompt`），因为没有以其发出请求的选择不是会话所处的状态。
	 */
	async updateConfig(sessionId: string, body: Record<string, unknown>): Promise<{ session: SessionSnapshot }> {
		const patch = body.patch ?? body;
		if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
			throw httpStatus.badRequest("`patch` must be a JSON object");
		}
		const fields = patch as ConfigPatch;

		return this.holding(sessionId, (session) => {
			try {
				session.applyConfig(sessionId, fields);
			} catch (error) {
				// 会话不能接受的一个审批键或队列模式：请求被理解并被拒绝，是冲突而不是坏请求。
				throw httpStatus.conflict(messageOf(error));
			}
			return { session: session.snapshot(sessionId) };
		});
	}

	/**
	 * 整体替换激活的工具集。
	 *
	 * 替换而不是 patch 是会话自己的契约：未知的名字会抛出并让集合分毫未动，所以客户端永远不会落进一个半应用的集合。
	 */
	async updateTools(sessionId: string, body: Record<string, unknown>): Promise<{ session: SessionSnapshot }> {
		const names = body.names;
		if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
			throw httpStatus.badRequest("`names` must be an array of tool names");
		}
		const active = names as string[];

		return this.holding(sessionId, (session) => {
			try {
				session.setActiveTools(sessionId, active);
			} catch (error) {
				throw httpStatus.conflict(messageOf(error));
			}
			return { session: session.snapshot(sessionId) };
		});
	}

	/**
	 * 回答一个审批提示。
	 *
	 * 不再 pending 的提示——已应答、被 abort 拒绝、或服务器重启而消失——是冲突而不是 no-op：请求被理解并被拒绝，这正是 409 所说的。客户端会看到那个错误，这正是要点——一个什么都不回答、也什么都不说的按钮，正是本实现所替代的失败。客户端需要的关于调用*实际*遭遇了什么的答案，来自 baseline 和工具结果，而不是这个 status code，后者只声称"现在没有人在等这个答案"。
	 *
	 * 下面的顺序是承重的。只读检查在前，因为只有可应答的请求才能被记录；`onApproval` 在 `respondApproval` 之前，因为答案必须在恢复运行关闭调用之前被记住——上报定案的那一帧，是在调用离开快照时由会话自己的变更通知构建的。
	 *
	 * `respondApproval` 启动的运行不被 await，与 prompt 的运行不被 await 完全一致：202 语义——答案被接受，它启动的运行在流上报告自己。
	 */
	async approve(
		sessionId: string,
		toolCallId: string,
		body: Record<string, unknown>,
	): Promise<{ toolCallId: string; approved: boolean }> {
		const approved = body.approved;
		if (typeof approved !== "boolean") throw httpStatus.badRequest("`approved` must be a boolean");

		return this.holding(sessionId, (session) => {
			// 在任何东西被记录之前拒绝：本会话没有在等的一个 id 得到 409，answers 表和会话都不会听到这个尝试。
			if (!session.hasPendingApproval(sessionId, toolCallId)) {
				throw httpStatus.conflict(`${toolCallId} is not a pending approval`);
			}
			this.listeners.onApproval?.(sessionId, toolCallId, approved);
			void session.respondApproval(sessionId, toolCallId, approved).catch((error: unknown) => {
				this.onRunFailure(sessionId, messageOf(error));
			});
			return { toolCallId, approved };
		});
	}

	/**
	 * 对一个会话执行操作，同时拿住让它保持打开的那个 hold。
	 *
	 * hold 由 hub 计数；执行命令的 orchestrator 是进程自己的，每次调用都指名它作用的会话，所以请求需要 hub 的只是 hold、再无其他。在一次读写期间拿住、用完立刻交还，让生命周期只有一条规则：有人 hold 时会话开着，最后一个 hold 放开就关。
	 *
	 * 不存在的会话是 404，而 hold 正是说这件事的：`hold` 打开 transcript，什么都不指名的 id 在那里以 {@link UnknownSessionError} 拒绝，transport 负责映射。hub 抛的其他东西——解析不了的 transcript 文件、拼装不了的会话——是本服务器自己的问题，对它说"not found"会让调用者去找一个其实完全正确的 id 里的拼写错误。
	 */
	private async holding<T>(sessionId: string, use: (agent: Agent) => T | Promise<T>): Promise<T> {
		const host = await this.hub.hold(sessionId);
		try {
			return await use(this.hub.agent);
		} finally {
			this.hub.release(host);
		}
	}

	/** 一次连启动都失败的运行，在流上说出，因为它的请求早已应答完毕。 */
	private onRunFailure(sessionId: string, message: string): void {
		this.listeners.onRunFailure?.(sessionId, message);
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 一个目录键是否住在被移动的目录之下。
 *
 * 严格在下、不包括相等：*就是*被移动目录的那个键被重新键控而不是丢弃，本函数回答的是其余键据以过滤的问题——被改名目录之内的嵌套目录现在指名一个不存在的目录，所以它的 entry 连同它持有的一切被忘记。
 *
 * 以 {@link samePath} 比较的方式 resolve 并做大小写折叠，让同一比较的两个方向在 Windows 上不会对"在下"是什么产生分歧。
 */
function underPath(workDirAbsPath: string, dirInput: string): boolean {
	const absDir = resolvePath(dirInput);
	const key = process.platform === "win32" ? absDir.toLowerCase() : absDir;
	const absTarget = resolvePath(workDirAbsPath);
	const candidate = process.platform === "win32" ? absTarget.toLowerCase() : absTarget;
	return candidate.startsWith(key.endsWith(sep) ? key : key + sep);
}
