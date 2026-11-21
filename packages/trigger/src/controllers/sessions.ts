// 域词汇经 case 的网关到手（R1：trigger 对 domain 盲），hub 与它的 birth 辅助经 case 的公开面。
import {
	type Agent,
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
	type GlobalSettings,
	type SettingsPatch,
	type GlobalSettingsSnapshot,
	toSessionRef,
	type ModelConfig,
	type DirectoryGroup,
	UnknownSessionError,
} from "@my-agent/case/protocol";
import { dirname, resolve, sep } from "node:path";
import { httpStatus } from "../http/errors.ts";
import { workDirAbsPathForCreate, workDirAbsPathOrThrow, type SessionHub } from "@my-agent/case";

/** 一个目录下存储的会话，从会话文件收窄到 wire 上承载的字段。 */
export async function listSessions(agent: Agent, workDirAbsPath: string): Promise<SessionRef[]> {
	return (await agent.listSessions(workDirAbsPath)).map(toSessionRef);
}

/** 设置面板读取的东西：它可以编辑的值，和它只读展示的值。 */
function settingsOf(settings: GlobalSettings): GlobalSettingsSnapshot {
	return {
		approval: settings.approval,
		bash: settings.bash,
		...(settings.tools === undefined ? {} : { tools: settings.tools }),
		...(settings.modes === undefined ? {} : { modes: settings.modes }),
		...(settings.model === undefined ? {} : { model: settings.model }),
		...(settings.defaultModelSeeded === undefined ? {} : { defaultModelSeeded: settings.defaultModelSeeded }),
	};
}

/**
 * controller 向 transport 报告的事项，因为流归 transport 所有。
 *
 * 这是"请求与流分离"的结果：一次运行的失败已经没有响应可以上报，所以它指名自己所属的会话，在会话自己的流上说出。
 */
export interface SessionListener {
	onRunFailure?(sessionId: string, message: string): void;
	/**
	 * 一个会话出生或 fork 落地：hub 重读它，让侧栏的行在会话存在的那一拍出现。
	 */
	onCreated?(sessionId: string): void;
	/**
	 * 一次存储型改名落地，行的 title 在文件被再读一次之前是过期的。hub 重读该行，普通的 `session_row` 帧把新名字带给每个窗口——与其他任何行变更同一条路，客户端不必为侧栏学第二种消息形状。
	 */
	onRenamed?(sessionId: string): void;
	/** 一个会话被删除。hub 丢掉它的行，transport 告知其客户端。 */
	onRemoved?(sessionId: string): void;
}

/**
 * 会话 controller 向 transport 报告的事项，为每个服务会话的服务器接线一次。
 *
 * 这段 wiring 不是 boot 期的秘密，理由与 {@link muxUpgrade} 相同：自建对象图的 smoke 恰恰需要它。微妙的半截是那行日志——一次运行的失败会在观看该会话的连接上宣布，而空的订阅表意味着这个 frame 根本没有读者，所以日志是"没有人在看的失败"仍然可闻的唯一地方。复制这些日志行的 smoke 是在断言自己的拷贝；经由这里接线，它能证明的事情是：删掉这个 `console.error` 它就会变红。
 *
 * `hub` 是收件人：run 失败的措辞只经 hub 扇出，而 rename 和 delete 首先是*行*事实，其次才是 frame 事实——hub 的行先更新，各自发出的 frame 走的是普通的发布之路。
 */
export function sessionListeners(deps: { sessionHub: SessionHub }): SessionListener {
	const { sessionHub } = deps;
	return {
		onRunFailure: (sessionId, message) => {
			console.error(`会话 ${sessionId} 的运行失败：${message}`);
			sessionHub.publishFailure(sessionId, message);
		},
		onCreated: (sessionId) => {
			void sessionHub.refreshRow(sessionId);
		},
		onRenamed: (sessionId) => {
			void sessionHub.refreshRow(sessionId);
		},
		onRemoved: (sessionId) => {
			sessionHub.forgetRow(sessionId);
		},
	};
}

/**
 * 模型、目录组和存储的设置。
 *
 * 三者都是 orchestrator 拥有之物的只读视图——hub 转发给它的 facade、自己不拥有任何一项（ADR-0012）——而且三者都曾是 socket 推送的帧。改走 HTTP 后由客户端来要，这才让一个没有会话的页面刷新仍然能填满侧栏、设置面板和模型列表。
 */
export class SystemController {
	private readonly sessionHub: SessionHub;
	/**
	 * 命令的后果在其应答之外的去处。
	 */
	private readonly listeners: SessionListener;

	constructor(sessionHub: SessionHub, listeners: SessionListener = {}) {
		this.sessionHub = sessionHub;
		this.listeners = listeners;
	}

	health(): { ok: boolean; workDirAbsPath: string } {
		return { ok: true, workDirAbsPath: this.sessionHub.workDirAbsPath };
	}

	models(): ModelOption[] {
		return listModelOptions(this.sessionHub.userModels);
	}

	/** 本构建注册的每个工具名（ADR-0020）：编排层上的窄读，进程活着就不过期。 */
	toolNames(): string[] {
		return this.sessionHub.agent.toolNames();
	}

	/**
	 * 替换导入的模型。
	 *
	 * 列表整份发送而不是逐行，因为面板编辑的是一份列表，半应用的列表是唯一谁都无法推理的状态——这里删一行、那里加一行必须一起落地，要么都不落。
	 *
	 * 到达时没有 `apiKey` 的行保留其名字下已存储的那一个。这让面板能往返一个从未被告知 key 的模型：客户端把它看得见的每个字段原样回传，它看不见的 key 在往返中完好无损。
	 *
	 * 两行认领同一个名字被直接拒绝，而不是变得唯一。名字在这里是一行的身份——会话记录记录它、config patch 指名它——悄悄加后缀意味着用户看到的行不是其会话在找的行。面板指出撞名的是哪个名字，什么都不写。
	 */
	updateModels(body: Record<string, unknown>): { models: ModelOption[] } {
		const input = body.models;
		if (!Array.isArray(input)) throw httpStatus.badRequest("`models` must be an array");

		const stored = new Map(this.sessionHub.userModels.map((model) => [model.name, model.apiKey]));
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

		this.sessionHub.setModelConfigs(rows);
		return { models: listModelOptions(rows) };
	}

	/** 本机器有会话的每个目录，各带自己的列表，最近在前。行现算（含活字段），不经任何内存。 */
	async directories(): Promise<{ directories: DirectoryGroup[] }> {
		return { directories: await this.sessionHub.groups() };
	}

	settings(): { settings: GlobalSettingsSnapshot } {
		return { settings: settingsOf(this.sessionHub.agent.settings()) };
	}

	/**
	 * 修改默认模型、审批集、bash 超时，或用户的模式。
	 *
	 * 比 {@link SessionController.updateConfig} 更窄，刻意的：这些是窗口自身运行所依赖的默认值，在任何会话存在之前就要读取，所以不能住在会话上。这里的 `approval` 因此是**目录默认值**——从未选择过的会话打开时的基准——不是运行中会话自己的应答，后者作为 config patch 走那个会话。`model` 是*新*会话起步的行；活会话所在的模型是 composer 的，随消息到达服务器而不是走这里。`tools` 是全局默认激活集，整份发送，与会话级端点自己的契约相同——而会话记录的选择仍然压过它，所以这里任何东西都到不了已经选过的会话。`modes` 是预设列表整份发送（ADR-0004）：把它应用到会话上是那个会话自己的两条命令，不是这个 patch。外观与目录视图不在这里——它们随 UI 簇迁往客户端存储（ADR-0029）。
	 */
	updateSettings(body: Record<string, unknown>): { settings: GlobalSettingsSnapshot } {
		const patch = body.patch ?? body;
		if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
			throw httpStatus.badRequest("`patch` must be a JSON object");
		}
		const fields = patch as Record<string, unknown>;

		const next: SettingsPatch = {};

		if (fields.tools !== undefined) {
			if (!Array.isArray(fields.tools) || fields.tools.some((name) => typeof name !== "string")) {
				throw httpStatus.badRequest("`tools` must be an array of tool names");
			}
			next.tools = fields.tools as string[];
		}

		if (fields.modes !== undefined) {
			// 列表整份发送——与导入模型相同的契约，理由也相同：面板编辑的是一份列表，半应用的列表是唯一谁都无法推理的状态。名字是一个模式的身份（ADR-0004），所以空名和撞名——与内置默认或其他行——都被拒绝而不是变得唯一。
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

		if (fields.model !== undefined) {
			if (typeof fields.model !== "string") throw httpStatus.badRequest("`model` must be a string");
			// 不指名任何行的默认值被拒绝而不是存储：`selectModel` 会回退到第一行，这里的拼写错误会表现为一个悄悄不起作用的偏好。行是 orchestrator 的、经 facade 新鲜读取，所以面板加载之后被删掉的行也会被抓到。
			if (this.sessionHub.agent.modelCatalog().find((userModel) => userModel.name === fields.model) === undefined) {
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

		this.sessionHub.agent.applySettings(next);
		return { settings: settingsOf(this.sessionHub.agent.settings()) };
	}

	async sessions(): Promise<{ sessions: SessionRef[] }> {
		return { sessions: await listSessions(this.sessionHub.agent, this.sessionHub.workDirAbsPath) };
	}

	/**
	 * 没有自己的 id 的客户端应当打开的会话——`null` 表示"没有，停在欢迎态"——以及画在旁边的列表。
	 *
	 * 两者一起返回，因为客户端启动时总是同时要两者，而向服务器要 id 正是让 `--session` 在 UI 中可观察的东西：客户端跟随服务器的应答，而不是从存储文件里猜。答案只有两种：钉住的那个，或 `null`——未指名的连接永远不落在任何会话上，启动不选中任何东西，这里也没有任何东西创建会话以供选择。
	 */
	async current(): Promise<{ sessionId: string | null; sessions: SessionRef[] }> {
		const [sessionId, sessions] = await Promise.all([this.sessionHub.currentSessionId(), listSessions(this.sessionHub.agent, this.sessionHub.workDirAbsPath)]);
		return { sessionId, sessions };
	}
}

/**
 * 关于一个会话的一切：读它、改它的配置，以及那些曾是对 socket 消息的一个 `switch` 的各分支的命令。
 *
 * 每个方法都是对 orchestrator 的一次薄调用。只有两个决定住在这里：一个失败作为什么 status，以及命令在会话接受后立即返回——运行本身在事件流上报告，永远不在这个响应上。
 */
export class SessionController {
	private readonly sessionHub: SessionHub;
	private readonly listeners: SessionListener;

	constructor(sessionHub: SessionHub, listeners: SessionListener = {}) {
		this.sessionHub = sessionHub;
		this.listeners = listeners;
	}

	/**
	 * 本进程正在运行、或可以打开的会话的当前状态。
	 *
	 * 本 controller 上唯一*不*改变会话的读取：读会话记录不得拼装会话或淘汰它，所以向 hub 要快照而不是活对象。存在性也不在这里检查：读取指名会话，orchestrator 在无人应答时以 {@link UnknownSessionError} 拒绝——transport 把它变成与命令路径相同的 404。
	 */
	async read(sessionId: string): Promise<{ session: SessionSnapshot }> {
		return { session: await this.sessionHub.snapshotOf(sessionId) };
	}

	/**
	 * 出生证明：让一个会话与它的第一条消息在同一个请求里原子出生（ADR-0021）。
	 *
	 * 返回 id 而不是任何会话对象：会话是两个文件，进程里没有副本（ADR-0013）。客户端接下来发送的 mux `open` 帧。id
	 * 由服务端铸（客户端不指名，避免路径注入与碰撞），两个文件在这一个请求里同时落盘——服务端在第
	 * 一条消息之前完全无状态，不存在「创建了但没说过话」的中间态。
	 *
	 * body 里的 `text` 必填：它就是第一条消息，没有它的出生不成其为出生。`workDirAbsPath` 决定会话
	 * 落在哪，列表为那个目录作答：刚把选择器指向新地方的窗口，应当可以相信自己看到的会话就是创建进
	 * 去的那些。未定义保持服务器自己的 root。`mode` / `model` / `thinkingLevel` 是随第一条消息出发的
	 * 选择——模式指针与模型行在出生写入之前落到快照上，未知名字是 409，对齐既有会话上的同类变更；
	 * `behavior` 随消息携带，出生时不可能有在飞的运行，它只是协议上的随行者。
	 */
	async birth(body: Record<string, unknown> = {}): Promise<{ sessionId: string; sessions: SessionRef[] }> {
		const text = body.text;
		if (typeof text !== "string" || text.trim().length === 0) {
			throw httpStatus.badRequest("`text` must be a non-empty string");
		}
		const workDirAbsPath = body.workDirAbsPath;
		if (workDirAbsPath !== undefined && typeof workDirAbsPath !== "string") {
			throw httpStatus.badRequest("`workDirAbsPath` must be a string");
		}
		const behavior = body.behavior;
		if (behavior !== undefined && behavior !== "steer" && behavior !== "followUp") {
			throw httpStatus.badRequest('`behavior` must be "steer" or "followUp"');
		}
		const mode = body.mode;
		if (mode !== undefined && typeof mode !== "string") {
			throw httpStatus.badRequest("`mode` must be a string");
		}
		const model = body.model;
		if (model !== undefined && typeof model !== "string") {
			throw httpStatus.badRequest("`model` must be a string");
		}
		const thinkingLevel = body.thinkingLevel;
		if (thinkingLevel !== undefined && typeof thinkingLevel !== "string") {
			throw httpStatus.badRequest("`thinkingLevel` must be a string");
		}
		// 在这里解析，让列表指名的目录与 hub 验证并写入的目录是同一个，无论请求以什么写法到达。检查
		// 也在这里跑，因为"坏路径是请求的错"是一个 status 决定，而 status 决定在这里做；hub 重复它，
		// 让任何内部调用者都无法绕过检查写入会话。
		const absRoot = typeof workDirAbsPath === "string" && workDirAbsPath.length > 0 ? resolve(workDirAbsPath) : undefined;
		if (absRoot !== undefined) {
			try {
				// 本机器已经存有会话的目录在消失时被放回来：用户在我们背后重命名了文件夹，而他们看到的组仍是那个路径。
				await workDirAbsPathForCreate(this.sessionHub.agent, absRoot);
			} catch (error) {
				throw httpStatus.badRequest(messageOf(error));
			}
		}
		let sessionId: string;
		try {
			sessionId = await this.sessionHub.birth({
				text,
				...(absRoot === undefined ? {} : { workDirAbsPath: absRoot }),
				...(behavior === undefined ? {} : { behavior }),
				...(mode === undefined ? {} : { mode }),
				...(model === undefined ? {} : { model }),
				...(thinkingLevel === undefined ? {} : { thinkingLevel }),
			});
		} catch (error) {
			// 出生请求自己被会话拒绝——未知模式、未知模型——与既有会话上的同类变更一样是冲突：请求
			// 被理解了，会话不接受这个值。
			throw httpStatus.conflict(messageOf(error));
		}
		this.listeners.onCreated?.(sessionId);
		return { sessionId, sessions: await listSessions(this.sessionHub.agent, absRoot ?? this.sessionHub.workDirAbsPath) };
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
		const sessionId = await this.sessionHub.fork(sourceId, typeof entryId === "string" ? entryId : null);
		this.listeners.onCreated?.(sessionId);
		return { sessionId, sessions: await listSessions(this.sessionHub.agent, this.sessionHub.workDirAbsPath) };
	}

	/**
	 * 给会话一个自己的名字，存为其 `.json` 快照上的 title。
	 *
	 * 派生 title 遵循的缩短规则在这里、在任何东西被写入之前应用——用户的输入在像派生 title 一样被折叠和裁剪之前还不是 title，这样改名的行与派生的行在宽度和形状上无从区分。空名字被拒绝而不是存储：存一个空 title 会悄悄恢复派生 title，那正是*不改名*已经在做的事。没有清除改名；把名字改回去是另一次改名。
	 *
	 * 运行在途也不构成障碍：title 是关于会话的事实而不是关于某条路径的事实，loop 读取的任何东西都不依赖它。
	 */
	async rename(sessionId: string, body: Record<string, unknown>): Promise<{ sessionId: string; title: string }> {
		const title = body.title;
		if (typeof title !== "string") throw httpStatus.badRequest("`title` must be a string");
		const stored = shortenTitle(title);
		if (stored.length === 0) throw httpStatus.badRequest("`title` must be a non-empty string");
		await this.sessionHub.rename(sessionId, stored);
		this.listeners.onRenamed?.(sessionId);
		return { sessionId, title: stored };
	}

	/**
	 * 删除会话：会话记录、文件，以及本进程知道的关于它的每一行。
	 *
	 * 删除改否决式（ADR-0023）后不再有「还在忙」的冲突——hub 的 remove 只同步做存在性校验
	 * （无所指的 id 以 {@link UnknownSessionError} 拒绝，transport 把它变成 404），真正的删除分离
	 * 在后台跑完。listeners 在 202 应答的同一拍就听到：删除可能仍在进行，但侧边栏的状态此刻就该与
	 * 用户的意图一致（spec User Story 3），而不是等一个用户已经不关心的收尾。
	 */
	async remove(sessionId: string): Promise<{ removed: true }> {
		this.sessionHub.remove(sessionId);
		this.listeners.onRemoved?.(sessionId);
		return { removed: true };
	}

	/**
	 * 把会话移到它自己的树上的另一个分支。
	 *
	 * 是命令不是编辑：日志不被重写，只有叶子移动，发两次就是同一移动两次。它以会话的新状态应答，因为整份会话记录变了，而发问的客户端正是看着它的那个。本会话上的*其他*每条流由 transport 从会话自己的 `branch_changed` 发送同一份快照——否则展示旧链的第二个窗口会把下一条 prompt 发到一个它并没有展示的分支上。
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

		const agent = this.sessionHub.agent;
		try {
			agent.branchTo(sessionId, entryId, descend ?? true);
		} catch (error) {
			// 未知 id 的存在性 404 沿命令自己的路径来（getSessionBySessionId → open），不属于冲突；
			// 其余被拒绝的 branchTo——运行在途，或本会话不持有的一个 entry——是冲突而不是坏请求。
			if (error instanceof UnknownSessionError) throw error;
			throw httpStatus.conflict(messageOf(error));
		}
		return { session: agent.snapshot(sessionId) };
	}

	/**
	 * 接受一条 prompt。
	 *
	 * 202 而不是 200，在消息持久化后立即应答：`session.prompt()` 在*运行*结束时 resolve，那是几分钟之后，在这里 await 它会把请求吊住整整一轮，还让 status code 变成谎言。改为启动并观察这次运行，只有启动失败被上报——存在性 404 从本应答出去，其余写在会话自己的流上，因为到那时已经没有响应可以上报了。
	 *
	 * `behavior` 决定运行中发来的 prompt 怎么办——`steer` 在运行中那一轮的下一个 drain 点注入，`followUp` 等这一轮结束。
	 *
	 * `model` 和 `thinkingLevel` 是 composer 自己的选择，它们随消息到达而不是作为独立的配置变更，因为两者在被用来发出一个请求之前都不为真：选模型不是会话记录碰巧遭遇的事，而没有请求以其发出的档位从未生效过。它们与其余字段一起验证，坏的在持久化之前就被拒绝，被拒的选择让会话分毫未动。
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

		const agent = this.sessionHub.agent;
		const selection: ModelSelection = {
			...(model === undefined ? {} : { model }),
			...(thinkingLevel === undefined ? {} : { thinkingLevel }),
		};
		// `prompt()` 在第一个 await 之前持久化消息并把运行标记为 streaming，所以这条应答返回时消息已在盘上、`running` 已为真。
		// 它的 promise 在运行结束时才 resolve——在飞的运行不能在这里等。但无所指的 id 在 prompt
		// 起步的同步链里就被 open 拒绝（startPromptedRun → getSessionBySessionId），这个立即的失败
		// 要让本应答以 404 出去：拒绝的到达隔着一跳内部的 await，一个宏任务轮（setImmediate，让出
		// 全部微任务）足以让它浮出。宏任务轮之后才到的存在性拒绝——与删除撞车时，拒绝可能晚于这一
		// 拍才浮出——已没有应答可浮入，沿失败运行的同一通道上报（onRunFailure），不能存进
		// `startFailure` 就无声丢失。其余一切——排队、运行本身的失败——走流（onRunFailure），
		// 因为 202 早已应答，这是 202 语义的另一半。
		let startFailure: unknown;
		// 宏任务轮过去（404 已应答或应答已成功返回）之后，存在性拒绝不再有浮出的路，改走上报通道。
		let floated = false;
		agent
			.prompt(sessionId, text, { ...(behavior === undefined ? {} : { behavior }), selection })
			.catch((error: unknown) => {
				if (error instanceof UnknownSessionError && !floated) startFailure ??= error;
				else this.onRunFailure(sessionId, messageOf(error));
			});
		await new Promise<void>((done) => setImmediate(done));
		if (startFailure !== undefined) {
			floated = true;
			throw startFailure;
		}
		floated = true;
		return { accepted: true };
	}

	/**
	 * 停止在途的运行。
	 *
	 * 这就是命令是 HTTP 请求而不是事件流上的一帧的原因：停止不属于流，任何持有会话 id 的调用者都能做——另一个 tab、一个脚本、一个 `curl`——流卡住的客户端仍然有出路。
	 *
	 * 无所指的 id 以 {@link UnknownSessionError} 拒绝（`Agent.abort` 自票 03 起对表外 id 抛出）——
	 * 停止一个不存在的东西是一个 404，不再是一次静默的 no-op。
	 */
	async abort(sessionId: string): Promise<{ stopped: true }> {
		await this.sessionHub.agent.abort(sessionId);
		return { stopped: true };
	}

	/**
	 * 修改会话的模式指针、审批增量与队列模式。
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

		const agent = this.sessionHub.agent;
		try {
			agent.applyConfig(sessionId, fields);
		} catch (error) {
			// 未知 id 的存在性 404 沿命令自己的路径来（getSessionBySessionId → open），不属于冲突；
			// 会话不能接受的一个模式名、审批键或队列模式：请求被理解并被拒绝，是冲突而不是坏请求。
			if (error instanceof UnknownSessionError) throw error;
			throw httpStatus.conflict(messageOf(error));
		}
		return { session: agent.snapshot(sessionId) };
	}

	/**
	 * 回答一个审批提示。
	 *
	 * 不再 pending 的提示——已应答、被 abort 拒绝、或服务器重启而消失——是冲突而不是 no-op：请求被理解并被拒绝，这正是 409 所说的。客户端会看到那个错误，这正是要点——一个什么都不回答、也什么都不说的按钮，正是本实现所替代的失败。客户端需要的关于调用*实际*遭遇了什么的答案，来自 baseline 和工具结果，而不是这个 status code，后者只声称"现在没有人在等这个答案"。
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

		const agent = this.sessionHub.agent;
		// 在任何东西被启动之前拒绝：本会话没有在等的一个 id 得到 409，会话听不到这次尝试。
		// 无所指的 id 沿 hasPendingApproval 自己的路径（getSessionBySessionId → open）抛
		// {@link UnknownSessionError}，transport 把它变成 404。
		if (!agent.hasPendingApproval(sessionId, toolCallId)) {
			throw httpStatus.conflict(`${toolCallId} is not a pending approval`);
		}
		void agent.respondApproval(sessionId, toolCallId, approved).catch((error: unknown) => {
			this.onRunFailure(sessionId, messageOf(error));
		});
		return { toolCallId, approved };
	}

	/**
	 * 一次连启动都失败的运行，在流上说出，因为它的请求早已应答完毕。
	 */
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
