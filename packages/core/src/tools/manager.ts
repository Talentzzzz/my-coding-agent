// 本构建的工具侧：一张它认识的每个工具的表，以及一个 session 可以调用其中哪些的纯数据选择
// （ADR-0011）。
//
// 表是常驻的，选择不是。表里放的是纯行为——六个与目录无关的实例，加上测试注册的任何东西——所以
// 持有它们的代价是进程生命周期的常量，而不是一个 session 的状态。调用所需、且会随请求变化的一切
// （工作目录、`bash` 超时）随 `execute` 的 `run` 到达，这正是让一个实例服务所有 session 的原因。

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Tool, ToolResult, ToolRunContext, ToolUpdateCallback } from "../llm/index.ts";
// 类型方向：types.ts 从这里 import BashSettings/ModeSettings 的类型名（设置归属重构 §5 随簇搬迁），
// 但那一条是 type import，编译期即抹掉——运行期 types.ts 是不依赖业务模块的叶子，无加载环。
import { AGENT_HOME, DEFAULT_BASH_SETTINGS, DEFAULT_GLOBAL_SETTINGS, DEFAULT_MODE_NAME, settingsPath } from "../types.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createGlobTool } from "./glob.ts";
import { createGrepTool } from "./grep.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

/**
 * 工具行动所用的 per-request 值，从 wire 类型 re-export。
 *
 * 它是 `execute` 的第三个参数，所以它的家在 `Tool` 旁边（ADR-0010 §2）：这个 re-export 让所有既有
 * 的 import 路径——`tools/index.ts`、`agent.ts`、smoke 测试——继续指向同一个名字。
 */
export type { ToolRunContext };

// ---------------------------------------------------------------------------- 工具簇设置

/**
 * `bash` 工具允许一条命令运行多久。
 *
 * 上限保留为设置而不是干脆取消，因为它防的是模型要求无界的运行——但这个数字由用户来改：一个要跑
 * 小时级构建的 checkout，会在自己的设置文件里写一个更高的值。类型随簇住进持有者（设置归属重构 §3
 * 「bash 归工具」）；默认值 {@link DEFAULT_BASH_SETTINGS} 由 types.ts 持有。
 */
export interface BashSettings {
	/** 调用未自带 `timeout_ms` 时使用。 */
	defaultTimeoutMs: number;
	/** 任何一条命令的上限，无论调用要求多长。 */
	maxTimeoutMs: number;
}

/**
 * 一个模式：工具与审批的命名预设，在应用级设置里编辑，整体应用到会话上。
 *
 * 两半都整体传输，与记录在会话快照上的选择遵循同一份契约（`.json` 快照的活跃集与审批映射）：
 * 模式是一个决定，所以应用它时不得与该会话之前持有的东西合并。名字是模式的身份——输入框靠把值与
 * 这份列表匹配来命名活跃模式，这就是重名被拒绝而不是被改成唯一名的原因。
 */
export interface ModeSettings {
	name: string;
	/** 模式应用的整体活跃工具集。空列表也是一个选择：什么都不活跃。 */
	tools: string[];
	/** 按工具名的逐工具审批；会话将其作为一个补丁整体应用。 */
	approval: Record<string, boolean>;
}

/**
 * 工具簇设置补默认后的视图：`<agent home>/tools.json` 每次现读的产物。
 *
 * `tools` 与 `modes` 可选——缺失表示「全部工具」与「没有用户模式」，是文件的真实状态而不是要补的
 * 缺口；`approval` 与 `bash` 永远整份给出，与它们在旧全局设置里的形状一致。
 */
export interface ToolDefaults {
	/**
	 * 全局默认活跃工具集。undefined 表示注册表的全集，即如今的会话打开时的样子——所以旧设置文件
	 * 无需迁移，也无需自己的字段。
	 */
	tools?: string[];
	/** 用户的模式，整体存放，按选择器列出的顺序。undefined 表示没有：内置默认模式从不存储（ADR-0004）。 */
	modes?: ModeSettings[];
	/** 运行前必须在 UI 里获得批准的工具，按工具名为键。 */
	approval: Record<string, boolean>;
	/** `bash` 工具允许一条命令运行多久。 */
	bash: BashSettings;
}

/** 工具簇的部分变更：{@link ToolDefaults} 各字段的可选子集，只动被点名的。 */
export interface ToolDefaultsPatch {
	/** 全局默认活跃工具集。整份列表，如同会话上的工具集。 */
	tools?: string[];
	/**
	 * 用户的模式，像 `tools` 一样整份发送（ADR-0004）：面板编辑的是一份列表，这里改名的模式与那里
	 * 删除的模式必须同落，要么都不落。
	 */
	modes?: ModeSettings[];
	/** 变动过的审批条目，按工具名为键；省略的键保持现行值。 */
	approval?: Record<string, boolean>;
	/** `bash` 工具允许一条命令运行多久。部分字段，让一个超时可以单独挪动。 */
	bash?: Partial<BashSettings>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * 工具名列表，字段缺失或不是数组时为 undefined。
 *
 * 文件是手编的，所以不是非空字符串的条目被丢弃而不是拒绝——一行坏数据不该连累整个字段。空列表
 * 会被*保留*：缺失的字段表示「全部工具」（旧文件的行为），而显式空列表是一个选择——「什么都不
 * 活跃」——把一个选择悄悄改写成它的反面，是设置读取者唯一不可做的事。
 */
function stringListOrUndefined(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

/**
 * bash 超时，逐字段落在默认值之上。
 *
 * 高于上限的默认值会被压到上限而不是照办：否则每一次未自带 `timeout_ms` 的调用都注定超时。
 * 默认值留守 types.ts 的 DEFAULT_BASH_SETTINGS（设置归属重构 §5 的随簇搬迁）。
 */
export function bashOr(value: unknown): BashSettings {
	const record = isRecord(value) ? value : {};
	const maxTimeoutMs = numberOr(record.maxTimeoutMs, DEFAULT_BASH_SETTINGS.maxTimeoutMs);
	return {
		defaultTimeoutMs: Math.min(
			numberOr(record.defaultTimeoutMs, DEFAULT_BASH_SETTINGS.defaultTimeoutMs),
			maxTimeoutMs,
		),
		maxTimeoutMs,
	};
}

/**
 * 用户的模式，逐条目处理，undefined 表示「从未写过」。
 *
 * 文件是手编的，其他列表字段的宽容同样适用这里：不是 record、没有自己的名字、或把非字符串当作
 * 工具名的条目自己被丢弃——一个坏模式不该连累其他模式的位置。重名保留第一次出现的，因为名字是
 * 输入框匹配的身份，两行同答一个名字会让匹配变成掷硬币。空列表会被*保留*：删光所有模式的用户
 * 做了一个选择，缺失字段必须与它保持可区分。
 *
 * 模式的审批映射在标准默认值之上规范化而不是被采信：UI 总是写全每个键，缺键即手编，而它回落到的
 * 答案正是全新会话打开时的那张映射。
 *
 * **簇间耦合（spec §11.4）**：这里的缺键回落读的是 `types.ts` 的 `DEFAULT_GLOBAL_SETTINGS.approval`
 * ——全局审批默认住在同一份工具簇里（`tools.json` 的 `approval`），两个簇同住一个持有者正是为了让
 * 这条线可见。将来把 `approval` 挪出工具簇会踩断模式规范化，届时这一段必须跟着走。
 */
export function modesOr(value: unknown): ModeSettings[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: ModeSettings[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const name = stringOrUndefined(entry.name);
		if (name === undefined) continue;
		if (out.some((mode) => mode.name === name)) continue;
		const tools = stringListOrUndefined(entry.tools);
		if (tools === undefined) continue;
		const approvalRecord = isRecord(entry.approval) ? entry.approval : {};
		const approval = { ...DEFAULT_GLOBAL_SETTINGS.approval };
		for (const [key, value] of Object.entries(approvalRecord)) {
			if (typeof value === "boolean") approval[key] = value;
		}
		out.push({ name, tools, approval });
	}
	return out;
}

// ---------------------------------------------------------------------------- 状态

/**
 * 一个 session 所处的工具选择，纯数据：session 的 `.json` 快照记录的内容。
 *
 * `activeToolNames` 是模型可以调用的；`approvalOverride` 是 session 自己的审批表叠在全局默认之上，
 * session 从未选择、跟随全局时为 undefined。名字可以包含本构建已不认识的工具——记录的集合在 fill
 * 和装配时收窄，从不把收窄后的存回去，所以降级再升级仍能保住选择。
 */
export interface ToolState {
	activeToolNames: string[];
	approvalOverride?: Record<string, boolean>;
}

/** 内置默认模式的名字，由设置配置持有（ADR-0004）。 */
export { DEFAULT_MODE_NAME };

/**
 * 一次 fill 所依据的 context：种子要对照的设置。
 *
 * `globalTools` 是全局默认的工具集，按设置文件的拼写，未指名时是全集；`known` 是本构建实际能构建
 * 的，不在其内的名字被丢弃而不是被抛错——手改的设置文件不欠 catalog 任何顺序和任何成员资格。
 * 默认视图的审批一半不需要输入：它是「跟随全局审批」，读者通过合并活设置来实现。
 */
export interface ToolFillContext {
	modes: readonly ModeSettings[];
	globalTools: readonly string[];
	known: readonly string[];
}

/** 丢掉本构建不认识的名字，保留种子指名的顺序。 */
export function narrowToKnown(names: readonly string[], known: readonly string[]): string[] {
	return names.filter((name) => known.includes(name));
}

/**
 * 把一个模式种子填成完整的 {@link ToolState}。
 *
 * 产物是真相，种子只是指针：未知的模式名抛异常，因为被要求在一个没人定义过的模式里运行的 session
 * 没有任何配置可回落，必须说出来，而不是按调用方没打算要的配置跑起来。缺失或「默认」的种子就是
 * 内置默认模式——全局默认的活视图，全套工具加全局审批——不读任何存储的模式条目，因为这个模式
 * 从不落盘：它回答的就是设置文件本身，设置一改就是这个模式变了。
 *
 * 默认视图让 `approvalOverride` 保持 undefined 而不是把全局表拷进来：拷贝会把审批冻结在 fill 时刻，
 * 而 undefined 意味着「session 从未选择」，每个读者都对照活设置合并。与之相反，具名模式的审批表
 * *就是*一个选择，整体携带。
 */
export function fillTools(modeName: string | undefined, context: ToolFillContext): ToolState {
	if (modeName === undefined || modeName === DEFAULT_MODE_NAME) {
		return { activeToolNames: narrowToKnown(context.globalTools, context.known) };
	}

	const mode = context.modes.find((candidate) => candidate.name === modeName);
	if (mode === undefined) throw new Error(`Unknown mode: ${modeName}`);
	return {
		activeToolNames: narrowToKnown(mode.tools, context.known),
		approvalOverride: { ...mode.approval },
	};
}

// ---------------------------------------------------------------------------- 表

/**
 * 六个内置工具，按提供给模型的顺序。零参工厂：一个工具不闭包任何东西，所以表可以把产物持有到
 * 进程结束。
 */
const builtIns: readonly (() => Tool<any>)[] = [
	() => createReadTool(),
	() => createWriteTool(),
	() => createEditTool(),
	() => createGlobTool(),
	() => createGrepTool(),
	() => createBashTool(),
];

/**
 * 一个进程认识的工具：持有每个实例的 `Map<name, Tool>`，加上注册进来的。
 *
 * 只有结构——什么存在于此，不是什么被选择。选择是从账本每次读取时推导的 {@link ToolState}
 * （`session/tool-config.ts` 的 `toolStateOf`），所以这张表从不回答「这个 session 可以调用它吗」：
 * 引擎对照它推导的名字回答这个问题。一个注册工具是否被提供是同一个问题，在同一个地方回答。
 *
 * 这个类还拥有的是调用本身：{@link ToolManager.execute} 解析一个名字并转发给它指名的实例，所以
 * 手里有一个名字加上本次调用的 `run` 值的调用方，运行一个工具不需要别的。行为留在实例上，校验、
 * 闸门、事件和结果写回留在引擎里。
 *
 * 在实例表之上，这个类还是工具簇设置的持有者（设置归属重构 §5）：默认工具集、模式表、审批与 bash
 * 超时住在 `<agent home>/tools.json`，经 {@link ToolManager.toolDefaults} 与
 * {@link ToolManager.applyToolDefaults} 每次现读——表是结构，设置是选择，两个半边在此同住。
 */
export class ToolManager {
	/** 本进程认识的每个工具，按提供给模型的顺序。从不替换。 */
	private readonly all = new Map<string, Tool<any>>();

	/** 工具簇设置文件所在的 agent home。 */
	private readonly home: string;

	constructor(options: ToolManagerOptions = {}) {
		this.home = options.home ?? AGENT_HOME;
	}

	/**
	 * 这张表持有的每个工具的名字：六个内置，然后是注册的。
	 *
	 * 是读出来的，不是记住的——key 就是表自己的，所以之后注册的名字在下一次读取就会出现，不需要
	 * 失效任何东西。
	 */
	names(): string[] {
		this.ensureFilled();
		return [...this.all.keys()];
	}

	/**
	 * 按名字取一个工具，本构建没有它时为 undefined。
	 *
	 * 每次都是同一个对象：表填充一次、条目从不替换，所以在 `prepareRequest` 持有实例的 run 和
	 * 在批次中途查找它的 run 看到的是同一个工具。
	 */
	get(name: string): Tool<any> | undefined {
		this.ensureFilled();
		return this.all.get(name);
	}

	/**
	 * 运行一次工具调用：查工具并转发，带上本次调用自己的 run 值。
	 *
	 * 它不决定这次调用是否被允许，也不做校验：这里出现未知名字是上游的 bug——引擎在请求调用之前
	 * 就解析并闸门过名字——所以它抛异常，而不是合成一个模型能看到的第二个 result。
	 */
	async execute(
		name: string,
		toolCallId: string,
		params: unknown,
		run: ToolRunContext,
		signal?: AbortSignal,
		onUpdate?: ToolUpdateCallback<any>,
	): Promise<ToolResult<any>> {
		const tool = this.get(name);
		if (tool === undefined) throw new Error(`Tool not found: ${name}`);
		return tool.execute(toolCallId, params as never, run, signal, onUpdate);
	}

	/**
	 * 把一个工具放进表。它加入；是否被提供是选择的事，不是这里的事。
	 *
	 * fill 先发生，所以与内置工具撞名的名字被拒绝注册的同一规则拒绝——而且之后的 fill 永远无法
	 * 盖过刚注册的东西。只接受新名字：没有 unregister、没有 replace、没有第二张表。
	 */
	register(tool: Tool<any>): void {
		this.ensureFilled();
		if (this.all.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
		this.all.set(tool.name, tool);
	}

	/**
	 * 把六个内置工具填进表，一次。
	 *
	 * 在第一次触碰时而不是构造函数里，因为一个装配了 session 但从不运行工具的进程不应该为六个
	 * 实例付代价——而且 fill 必须发生在任何回答「什么存在」的读取之前，也就是这里的每个公开方法。
	 * 六个一次填齐而不是按名逐个填，是这张表成为「什么存在」的唯一答案的原因：按名逐个填需要在
	 * 旁边再放一份静态名字清单，两份清单会不一致。
	 *
	 * 非空的表就是已填充的表：`register` 写之前先 fill，所以没有六个先就位、就不可能有东西进来。
	 */
	private ensureFilled(): void {
		if (this.all.size > 0) return;
		for (const create of builtIns) {
			const tool = create();
			this.all.set(tool.name, tool);
		}
	}

	// ---------------------------------------------------------------------------- 工具簇设置

	/**
	 * 工具簇设置补默认后的视图，每次调用都从 `tools.json` 现读（ADR-0013 的既定模式）。
	 *
	 * 首次读取执行一次性迁移（{@link ToolManager.migrateToolCluster}）：自己的文件尚不存在而旧
	 * `settings.json` 存在时，从旧文件捡走工具簇——此后旧文件被完全忽略；旧文件本身永不删除、
	 * 永不写入。
	 */
	toolDefaults(): ToolDefaults {
		return this.toolState().view;
	}

	/**
	 * 应用一次工具簇的部分变更，返回前写盘。
	 *
	 * 只有被点名的字段移动：`tools` 与 `modes` 整份列表替换（模式是一个决定，ADR-0004），`approval`
	 * 与 `bash` 嵌套逐键合并——改一个工具审批的补丁不碰文件里其他工具的条目。写前重读文件，进程外
	 * 的手编不被这里一次无关的变更回滚；文件的其余部分——无论是否手编——原样写回。
	 */
	applyToolDefaults(patch: ToolDefaultsPatch): void {
		const fields = Object.entries(patch)
			.filter(([, value]) => value !== undefined)
			.map(([field]) => field);
		if (fields.length === 0) return;

		const path = this.toolSettingsPath();
		const { layer } = this.toolState();
		const changes: ToolsLayer = {};
		for (const field of fields) {
			const value = (patch as Record<string, unknown>)[field];
			const inherited = layer[field];
			layer[field] = isRecord(inherited) && isRecord(value) ? mergeLayers(inherited, value) : value;
			changes[field] = layer[field];
		}
		// 写前重读：一次审批的变更不得弄丢用户在进程运行期间敲进文件的键。
		writeLayer(path, mergeLayers(readLayer(path) ?? {}, changes));
	}

	/** 工具簇设置文件：`<agent home>/tools.json`。 */
	private toolSettingsPath(): string {
		return join(this.home, "tools.json");
	}

	/**
	 * `tools.json` 的一次现读：文件按写下的原样（层），加上补默认后的视图。
	 *
	 * 层是一次写入所操作的全部事实——未知键也在其中；视图是消费者拿到的答案。文件不在时先走一次
	 * 迁移。
	 */
	private toolState(): { layer: ToolsLayer; view: ToolDefaults } {
		const path = this.toolSettingsPath();
		const layer = readLayer(path);
		if (layer !== undefined) return { layer, view: viewOf(layer) };
		return this.migrateToolCluster(path);
	}

	/**
	 * 读时迁移（spec §4.2）：`tools.json` 不存在而旧 `settings.json` 存在时，用各自的规范化函数从
	 * 旧文件捡走工具簇，把补默认后的视图原子落盘——**簇字段全缺省也写出文件**，把「迁移过」变成
	 * 磁盘事实，避免旧文件在每次首读时复活。旧文件永不删除、永不写入；两边都缺时不落任何笔。
	 */
	private migrateToolCluster(path: string): { layer: ToolsLayer; view: ToolDefaults } {
		const legacy = readLayer(settingsPath(this.home));
		if (legacy === undefined) return { layer: {}, view: viewOf({}) };

		const layer: ToolsLayer = {
			approval: approvalOr(legacy.approval),
			bash: bashOr(legacy.bash),
		};
		const tools = stringListOrUndefined(legacy.tools);
		if (tools !== undefined) layer.tools = tools;
		const modes = modesOr(legacy.modes);
		if (modes !== undefined) layer.modes = modes;

		const view = viewOf(layer);
		writeLayer(path, layer);
		return { layer, view };
	}
}

/** 调用方可指明工具簇设置住在哪个 home，把 {@link ToolManager} 指到机器自己的文件之外。 */
export interface ToolManagerOptions {
	/**
	 * 工具簇设置文件（`tools.json`）读取与写入所在的 agent home。默认用真实的那一个。
	 *
	 * 测试「会*写*设置」的命令的 smoke 不得写机器自己的文件。
	 */
	home?: string;
}

/** 一个进程认识的表。零参构建：内置工具就是本构建的常量；`options` 只指工具簇设置的 home。 */
export function createToolManager(options: ToolManagerOptions = {}): ToolManager {
	return new ToolManager(options);
}

// ---------------------------------------------------------------------------- tools.json 读写

/** 一份文件的内容：它实际携带的键，未知的也算。 */
type ToolsLayer = Record<string, unknown>;

/**
 * 文件按它写下的原样读成一层；不在的文件为 undefined。
 *
 * 本构建无法解析的文件被拒绝，从不被覆盖。
 */
function readLayer(absPath: string): ToolsLayer | undefined {
	let content: string;
	try {
		content = readFileSync(absPath, "utf8");
	} catch (error) {
		// 文件缺失是正常的首次运行。其余任何情况——权限、挡在路上的目录——都是真实的失败，不得以
		// 「未配置设置」的形态抵达调用方。
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}

	// trim 顺带去掉 UTF-8 BOM——Windows 编辑器会写它，而 `JSON.parse` 拒绝它。
	const text = content.trim();
	if (text === "") return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${absPath} is not valid JSON: ${(error as Error).message}`);
	}
	if (!isRecord(parsed)) throw new Error(`${absPath} must hold a JSON object`);
	return parsed;
}

/**
 * 一层写到它自己的文件上，目录不存在时创建它。
 *
 * 经同目录 temp + rename 落盘（temp 名带 pid，防多进程撞名）：读者要么看到旧内容要么看到完整的
 * 新内容，绝不会看到写到一半的——与其余四个持有者的写路径同形。
 */
function writeLayer(absPath: string, layer: ToolsLayer): void {
	mkdirSync(dirname(absPath), { recursive: true });
	const absTemp = `${absPath}.${process.pid}.tmp`;
	const fd = openSync(absTemp, "wx");
	try {
		writeFileSync(fd, `${JSON.stringify(layer, null, "\t")}\n`);
	} finally {
		closeSync(fd);
	}
	renameSync(absTemp, absPath);
}

/** 补丁的嵌套对象逐键合并进已有的值，其余字段整体替换。 */
function mergeLayers(base: ToolsLayer, overrides: ToolsLayer): ToolsLayer {
	const merged: ToolsLayer = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) continue;
		const inherited = merged[key];
		merged[key] = isRecord(inherited) && isRecord(value) ? mergeLayers(inherited, value) : value;
	}
	return merged;
}

/** 审批表：标准默认值之上保留文件里的布尔条目。 */
function approvalOr(value: unknown): Record<string, boolean> {
	const record = isRecord(value) ? value : {};
	const approval = { ...DEFAULT_GLOBAL_SETTINGS.approval };
	for (const [key, entry] of Object.entries(record)) {
		if (typeof entry === "boolean") approval[key] = entry;
	}
	return approval;
}

/** 工具簇一层补默认后的视图：approval 与 bash 永远整份，tools 与 modes 只在文件真的写了时给出。 */
function viewOf(layer: ToolsLayer): ToolDefaults {
	const view: ToolDefaults = {
		approval: approvalOr(layer.approval),
		bash: bashOr(layer.bash),
	};
	const tools = stringListOrUndefined(layer.tools);
	if (tools !== undefined) view.tools = tools;
	const modes = modesOr(layer.modes);
	if (modes !== undefined) view.modes = modes;
	return view;
}
