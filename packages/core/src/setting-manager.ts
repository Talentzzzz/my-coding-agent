import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	AGENT_HOME,
	mergeSettings,
	projectSettingsPath,
	settingsPath,
	type AppearanceSettings,
	type BashSettings,
	type ModeSettings,
	type RetrySettings,
	type Settings,
} from "./config.ts";
import { type ModelConfig, ModelConfigStore } from "./models.ts";
import type { QueueMode } from "./protocol.ts";

/**
 * 每一次配置读写都要走的那一扇门。
 *
 * 两份设置文件（agent home 的与工作目录自己的）和一份模型文件在这里、且只在这里读取：这个类把
 * 曾经一族文件级函数的东西变成点名工作目录、在需要它的那一行现取答案的方法。什么都不缓存：每个
 * 方法都从其背后的存储构建一份新状态，所以手编文件、另一会话的写入、或修正的模型密钥，就是下一
 * 次调用给出的答案，没有需要失效的东西。
 *
 * manager 是注入的而不是被找到的：hub 在自己的 agent home 之上构造一只，递给编排层与每次装配；
 * smoke 或测试在自己的存储之上构造（{@link SettingManagerOptions.storage}、
 * {@link inMemorySettingManager}），机器自己的文件永远不被碰。
 */
export class SettingManager {
	private readonly home: string;
	private readonly modelStore: ModelConfigStore | undefined;
	private modelRows: readonly ModelConfig[] | undefined;
	private readonly storage: SettingsStorage | undefined;

	constructor(options: SettingManagerOptions = {}) {
		this.home = options.home ?? AGENT_HOME;
		this.storage = options.storage;
		// 递进来的行是这只 manager 一生唯一的目录：`modelsHome` 背后的文件不被读，`replaceModels`
		// 写回行列表本身——这正是驱动自己模型行的 smoke 想要的：任何人的 `models.json` 都不会有东西
		// 落进去。
		this.modelRows = options.models === undefined ? undefined : [...options.models];
		this.modelStore = options.models === undefined ? ModelConfigStore.create(options.modelsHome ?? this.home) : undefined;
	}

	// ---------------------------------------------------------------------------- 读取面

	/**
	 * 每个设置方法共用的唯一读取：工作目录背后的两份文件，合并成一份新状态。
	 *
	 * 调用之间什么都不保留——状态是文件截至本次调用的快照，{@link SettingManager.applySettings} 让
	 * 它写入的文件与状态保持同步。所以同一目录上的两个会话经相同的文件读取，而不是经可能漂移的袋，
	 * 这正是让一次设置编辑抵达一个从未重开的会话的原因。
	 */
	private stateOf(workDirAbsPath: string): SettingsState {
		const storage =
			this.storage ?? new FileSettingsStorage(settingsPath(this.home), projectSettingsPath(workDirAbsPath));
		return settingsStateFromStorage(storage);
	}

	/** 当前生效的全部设置，合并并补默认后的副本：改它不动任何东西。 */
	getSettings(workDirAbsPath: string): Settings {
		return structuredClone(this.stateOf(workDirAbsPath).settings);
	}

	/** 配置的默认模型，即行的名字，没有任何层指名时为 undefined。 */
	getModel(workDirAbsPath: string): string | undefined {
		return this.stateOf(workDirAbsPath).settings.model;
	}

	/**
	 * 全局默认活跃工具集，undefined 表示注册表的全集。
	 *
	 * undefined 自成一个答案而不是空列表，因为「没有字段」与「什么都不活跃」必须保持可区分：前者是
	 * 旧文件的行为，后者是一个什么都调不了的会话。
	 */
	getTools(workDirAbsPath: string): string[] | undefined {
		const tools = this.stateOf(workDirAbsPath).settings.tools;
		return tools === undefined ? undefined : [...tools];
	}

	/** 主题与字号，即窗口该怎样绘制自己。 */
	getAppearance(workDirAbsPath: string): AppearanceSettings {
		return { ...this.stateOf(workDirAbsPath).settings.appearance };
	}

	/**
	 * 侧边栏搁置的目录，按绝对路径。
	 *
	 * 永远是列表，从不是 undefined：每个读者问的都是「这个藏了吗」，从未写过该字段的文件，答案与
	 * 空列表相同。
	 */
	getHiddenDirectories(workDirAbsPath: string): string[] {
		return [...(this.stateOf(workDirAbsPath).settings.hiddenDirectories ?? [])];
	}

	/**
	 * 侧边栏替代文件夹名显示的名字，按绝对路径。
	 *
	 * 空条目在这里被丢弃，而不是在每个读取者处：清空的名字以空字符串存储，键的缺失就表示「用文件夹
	 * 自己的名字」。
	 */
	getDirectoryNames(workDirAbsPath: string): Record<string, string> {
		const names: Record<string, string> = {};
		for (const [dir, name] of Object.entries(this.stateOf(workDirAbsPath).settings.directoryNames ?? {})) {
			if (name.trim().length > 0) names[dir] = name;
		}
		return names;
	}

	/** 运行前必须在 UI 里获得批准的工具，按工具名为键。 */
	getApprovals(workDirAbsPath: string): Record<string, boolean> {
		return { ...this.stateOf(workDirAbsPath).settings.approval };
	}

	/**
	 * 该目录的文件是否闸住这个工具。
	 *
	 * 文件是会话打开时的默认，所以这里回答的是尚未选择的会话：会话自己的答案是
	 * `Agent.getApprovals()`，即这张映射叠上会话记录的选择。审批闸门读的是那一个，从不读这个。
	 */
	isApprovalRequired(workDirAbsPath: string, tool: string): boolean {
		return this.stateOf(workDirAbsPath).settings.approval[tool] === true;
	}

	getSteeringMode(workDirAbsPath: string): QueueMode {
		return this.stateOf(workDirAbsPath).settings.steeringMode;
	}

	getFollowUpMode(workDirAbsPath: string): QueueMode {
		return this.stateOf(workDirAbsPath).settings.followUpMode;
	}

	/** 重试策略，逐字段对应 `retryAssistantCall` 接受的形状。 */
	getRetrySettings(workDirAbsPath: string): RetrySettings {
		return { ...this.stateOf(workDirAbsPath).settings.retry };
	}

	/** `bash` 工具允许一条命令运行多久。 */
	getBashSettings(workDirAbsPath: string): BashSettings {
		return { ...this.stateOf(workDirAbsPath).settings.bash };
	}

	// ---------------------------------------------------------------------------- 写入面

	/**
	 * 对一个目录的设置应用部分变更，返回前写盘。
	 *
	 * 每个字段去往已经写有它的那份文件，让开关落在用户正看着的那个值的来处：指名过 `approval` 任何
	 * 部分的项目文件继续拥有审批集，而从未有层指名过的设置去往全局文件。`scope` 可强制指定目标。
	 * 只有被点名的字段移动、嵌套的做合并，所以改一个工具审批的补丁不碰文件里其他工具的条目。
	 *
	 * 写入只落在文件上、别无他处——没有需要更新的袋，因为没有读者持有袋：这里任何方法的下一次读取
	 * 都看得到变更，该目录上的每个会话也一样。
	 */
	applySettings(workDirAbsPath: string, patch: SettingsPatch, scope?: SettingsScope): void {
		applyPatch(this.stateOf(workDirAbsPath), patch, scope);
	}

	// ---------------------------------------------------------------------------- 模型行

	/**
	 * 本安装运行的模型行，每次调用都从文件读取。
	 *
	 * 读的是一个小文件，所以什么都不缓存、什么都不需要失效：用编辑器加了一行的人，或在设置面板里
	 * 修正了密钥的人，下一次请求就得到答案，无需重启。
	 */
	modelCatalog(): readonly ModelConfig[] {
		return this.modelRows ?? this.modelStore!.list();
	}

	/** 替换全部行。整表写入正是名字与文件不漂移的原因。 */
	replaceModels(models: readonly ModelConfig[]): void {
		if (this.modelRows !== undefined) {
			this.modelRows = [...models];
			return;
		}
		this.modelStore!.replace(models);
	}
}

/** 调用方可提供什么，把 {@link SettingManager} 指到机器自己的文件之外。 */
export interface SettingManagerOptions {
	/**
	 * 全局设置文件读取与写入所在的 agent home。默认用真实的那一个。
	 *
	 * 测试「会*写*设置」的命令的 smoke 不得写机器自己的文件。
	 */
	home?: string;
	/**
	 * 模型行读取与写入所在的 agent home。默认用 {@link home}。
	 *
	 * `home` 为另一个文件准备的同居处：给 manager 递自己模型行的 smoke 不得把它们留在机器的
	 * `models.json` 里。
	 */
	modelsHome?: string;
	/**
	 * 整体取代两份设置文件的存储后端。
	 *
	 * 注入进来，让 manager 永远不挑选自己碰的文件：测试拿内存版，把设置放在别处——数据库、每用户
	 * 存储、沙箱——的宿主换一个对象即可，无需改 manager。与 `models` 一起设置时，manager 一个文件
	 * 都不碰。
	 */
	storage?: SettingsStorage;
	/** 整体取代模型文件的行，给驱动自己目录的 smoke 用。 */
	models?: readonly ModelConfig[];
}

/**
 * 建在从未落笔的设置与模型行之上的 {@link SettingManager}。
 *
 * 调用方递入的一切都算作全局层的文件与全部目录，所以之后的写入保存在内存里，读回来的行为与真的
 * 一样——只是缺了文件。
 */
export function inMemorySettingManager(
	settings: Partial<Settings> = {},
	models?: readonly ModelConfig[],
): SettingManager {
	const storage = new InMemorySettingsStorage();
	storage.write("global", `${JSON.stringify(settings, null, "\t")}\n`);
	return new SettingManager({ storage, models });
}

/**
 * 会话的设置所来自的两份文件。
 *
 * `global` 是这台机器自己在 agent home 之下的文件。`project` 是工作目录的
 * `.my-agent/settings.json`，仓库可以提交它，让 checkout 带上自己的审批与限额。project 逐字段
 * 胜出、嵌套对象做合并——指名了 `approval.write` 的项目保住全局的 `approval.bash` 在旁——所以
 * 两层被读成一个设置对象，而不是在两者之间做选择。
 */
export type SettingsScope = "global" | "project";

/** 一份文件的内容：它实际携带的键，未知的也算。 */
type SettingsLayer = Record<string, unknown>;

/** 设置的部分变更，形状与浏览器发来的 config 补丁一致。 */
export interface SettingsPatch {
	model?: string;
	/** 窗口的「已种下内置默认」标记；见 `Settings.defaultModelSeeded`。 */
	defaultModelSeeded?: boolean;
	/** 全局默认活跃工具集。整份列表，如同会话上的工具集。 */
	tools?: string[];
	/**
	 * 用户的模式，像 `tools` 一样整份发送（ADR-0005）：面板编辑的是一份列表，这里改名的模式与那里
	 * 删除的模式必须同落，要么都不落。
	 */
	modes?: ModeSettings[];
	/**
	 * 侧边栏不列出的目录，按绝对路径。整份列表，像 `tools` 一样：这个设置就是隐藏目录的集合，多藏
	 * 一个目录，就是之前的列表多一条。
	 */
	hiddenDirectories?: string[];
	/**
	 * 侧边栏为目录显示的名字，按绝对路径。
	 *
	 * 补丁携带它变更的条目，空字符串收回一个名字——按键合并的记录没有别的办法说「忘掉这一条」。
	 */
	directoryNames?: Record<string, string>;
	/** 变动过的审批条目，按工具名为键；省略的键保持现行值。 */
	approval?: Record<string, boolean>;
	/** 主题与字号。作为补丁的一部分，让一个字段可以单独挪动。 */
	appearance?: Partial<AppearanceSettings>;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	retry?: Partial<RetrySettings>;
	/** `bash` 工具允许一条命令运行多久。部分字段，让一个超时可以单独挪动。 */
	bash?: Partial<BashSettings>;
}

/**
 * 一个作用域的设置在哪里读写。
 *
 * 注入进来，让 manager 永远不挑选自己碰的文件：真实现为工作目录读写全局与项目路径，测试拿内存
 * 版。把设置放在别处——数据库、每用户存储、沙箱——的宿主换一个对象即可，无需改 manager。
 */
export interface SettingsStorage {
	/** 该作用域当前的文本，那里还没有东西时为 undefined。 */
	read(scope: SettingsScope): string | undefined;
	/** 替换该作用域的文本，目录不存在时创建它。 */
	write(scope: SettingsScope, content: string): void;
	/** 作用域背后的文件，用于错误消息。 */
	path(scope: SettingsScope): string;
}

/** 两份真实文件：`<agent home>/settings.json` 与 `<working directory>/.my-agent/settings.json`。 */
class FileSettingsStorage implements SettingsStorage {
	private readonly absPaths: Record<SettingsScope, string>;

	constructor(globalPath: string, projectPath: string) {
		this.absPaths = { global: globalPath, project: projectPath };
	}

	read(scope: SettingsScope): string | undefined {
		try {
			return readFileSync(this.absPaths[scope], "utf8");
		} catch (error) {
			// 文件缺失是正常的首次运行。其余任何情况——权限、挡在路上的目录——都是真实的失败，不得以
			// 「未配置设置」的形态抵达调用方。
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	write(scope: SettingsScope, content: string): void {
		const absPath = this.absPaths[scope];
		mkdirSync(dirname(absPath), { recursive: true });
		writeFileSync(absPath, content, "utf8");
	}

	path(scope: SettingsScope): string {
		return this.absPaths[scope];
	}
}

/** 没有文件在背后的设置，给测试或内嵌宿主用。 */
class InMemorySettingsStorage implements SettingsStorage {
	private readonly contents: Record<SettingsScope, string | undefined> = { global: undefined, project: undefined };

	read(scope: SettingsScope): string | undefined {
		return this.contents[scope];
	}

	write(scope: SettingsScope, content: string): void {
		this.contents[scope] = content;
	}

	path(scope: SettingsScope): string {
		return `<in-memory ${scope} settings>`;
	}
}

/**
 * 一个工作目录设置的纯数据状态：manager 的读写所操作的东西，仅此而已。
 *
 * 合并视图以 {@link Settings} 形态保存——每个字段都填了默认——而每一层按文件写下的原样保存，
 * 未知键也保留。这个分野正是写入安全的原因：只有补丁点名的字段移动，文件的其余部分——无论是否
 * 手编——原样写回。
 *
 * 状态是一次调用的值，不是常驻视图：{@link SettingManager.stateOf} 现建它，任何地方都不把它持有
 * 过本次调用。
 */
interface SettingsState {
	storage: SettingsStorage;
	layers: Record<SettingsScope, SettingsLayer>;
	/** 每份文件指名的字段，让变更可以写到值已经住着的地方。 */
	declared: Record<SettingsScope, Set<string>>;
	settings: Settings;
}

/**
 * 把 `storage` 背后的两份文件读进一份新的 {@link SettingsState}：把存储后端变成设置操作所操作状态
 * 的唯一入口。
 *
 * 本构建无法解析的文件被拒绝，从不被覆盖。
 */
function settingsStateFromStorage(storage: SettingsStorage): SettingsState {
	const layers: Record<SettingsScope, SettingsLayer> = {
		global: readLayer(storage, "global"),
		project: readLayer(storage, "project"),
	};
	return {
		storage,
		layers,
		declared: {
			global: new Set(Object.keys(layers.global)),
			project: new Set(Object.keys(layers.project)),
		},
		settings: mergeSettings(mergeLayers(layers.global, layers.project)),
	};
}

/**
 * 应用一次部分变更，返回前写盘。
 *
 * 每个字段去往已经写有它的那份文件，让开关落在用户正看着的那个值的来处。变更抵达状态背后的文件、
 * 仅此而已——状态本身被调用方丢弃，文件才是之后每次读取重读的东西。
 */
function applyPatch(s: SettingsState, patch: SettingsPatch, scope?: SettingsScope): void {
	const fields = Object.entries(patch)
		.filter(([, value]) => value !== undefined)
		.map(([field]) => field);
	if (fields.length === 0) return;

	const changes: Record<SettingsScope, SettingsLayer> = { global: {}, project: {} };
	for (const field of fields) {
		const target = scope ?? scopeOf(s, field);
		const layer = s.layers[target];
		const inherited = layer[field];
		const value = (patch as Record<string, unknown>)[field];
		layer[field] = isRecord(inherited) && isRecord(value) ? mergeLayers(inherited, value) : value;
		s.declared[target].add(field);
		changes[target][field] = layer[field];
	}

	for (const target of ["global", "project"] as const) {
		if (Object.keys(changes[target]).length > 0) persist(s, target, changes[target]);
	}
}

/**
 * 把一个作用域变更的字段写到该文件此刻持有的内容之上，然后把结果当作本状态里该层的副本。
 *
 * 写前重读，正是让对同一文件的手编不被这里一次无关的变更回滚的原因：一次模型切换不得弄丢用户在
 * 进程运行期间敲进去的键。
 */
function persist(s: SettingsState, scope: SettingsScope, changes: SettingsLayer): void {
	const merged = mergeLayers(readLayer(s.storage, scope), changes);
	s.storage.write(scope, `${JSON.stringify(merged, null, "\t")}\n`);
	s.layers[scope] = merged;
}

/** 拥有某字段的那份文件，让变更不会去往一个会被覆盖掉值的地方。 */
function scopeOf(s: SettingsState, field: string): SettingsScope {
	return s.declared.project.has(field) ? "project" : "global";
}

/** 一份文件的设置，按它写下的原样。不在的文件是一个空层。 */
function readLayer(storage: SettingsStorage, scope: SettingsScope): SettingsLayer {
	const content = storage.read(scope);
	if (content === undefined) return {};

	// trim 顺带去掉 UTF-8 BOM——Windows 编辑器会写它，而 `JSON.parse` 拒绝它。
	const text = content.trim();
	if (text === "") return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${storage.path(scope)} is not valid JSON: ${(error as Error).message}`);
	}
	if (!isRecord(parsed)) throw new Error(`${storage.path(scope)} must hold a JSON object`);
	return parsed;
}

/** project 逐键、逐嵌套对象地胜过 global。 */
function mergeLayers(base: SettingsLayer, overrides: SettingsLayer): SettingsLayer {
	const merged: SettingsLayer = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) continue;
		const inherited = merged[key];
		merged[key] = isRecord(inherited) && isRecord(value) ? mergeLayers(inherited, value) : value;
	}
	return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
