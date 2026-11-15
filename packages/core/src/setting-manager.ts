import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	AGENT_HOME,
	mergeSettings,
	settingsPath,
	type AppearanceSettings,
	type BashSettings,
	type GlobalSettings,
	type ModeSettings,
	type RetrySettings,
} from "./config.ts";
import { type ModelConfig, ModelConfigStore } from "./models.ts";
import type { QueueMode } from "./protocol.ts";

/**
 * 每一次配置读写都要走的那一扇门。
 *
 * global 侧唯一的一份设置文件（`<agent home>/settings.json`，ADR-0019）和一份模型文件在这里、且只在
 * 这里读取。什么都不缓存：每个方法都从其背后的存储构建一份新状态，所以手编文件、另一会话的写入、
 * 或修正的模型密钥，就是下一次调用给出的答案，没有需要失效的东西。
 *
 * manager 是注入的而不是被找到的：hub 在自己的 agent home 之上构造一只，递给编排层与每次装配；
 * smoke 或测试在自己的存储之上构造（{@link SettingManagerOptions.storage}、
 * {@link inMemorySettingManager}），机器自己的文件永远不被碰。
 *
 * 公开面只有四个方法：读（`getSettings`，整份 {@link GlobalSettings}）、写（`applySettings`）、
 * 模型行的读与换。会话侧的选择不住在这里——它们在会话 `.json` 快照的设置半上，组合发生在
 * `resolveSettings`（`packages/core/src/settings.ts`）。
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

	/**
	 * 当前生效的全部设置，合并并补默认后的副本：改它不动任何东西。
	 *
	 * 调用之间什么都不保留——状态是文件截至本次调用的快照。同一进程里的所有会话经相同的文件读取，
	 * 而不是经可能漂移的袋，这正是让一次设置编辑抵达一个从未重开的会话的原因。
	 */
	getSettings(): GlobalSettings {
		return structuredClone(this.stateOf().settings);
	}

	/**
	 * 应用一次部分变更，返回前写盘。
	 *
	 * 只有被点名的字段移动、嵌套的做合并，所以改一个工具审批的补丁不碰文件里其他工具的条目。写入只
	 * 落在文件上、别无他处——没有需要更新的袋，因为没有读者持有袋：这里任何方法的下一次读取都看得到
	 * 变更，每个会话也一样。
	 */
	applySettings(patch: SettingsPatch): void {
		applyPatch(this.stateOf(), patch);
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

	/**
	 * 设置方法共用的唯一读取：背后的文件读进一份新状态。
	 *
	 * 状态是一次调用的值，不是常驻视图——现建它，任何地方都不把它持有过本次调用。
	 */
	private stateOf(): SettingsState {
		const storage = this.storage ?? new FileSettingsStorage(settingsPath(this.home));
		return settingsStateFromStorage(storage);
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
	 * 整体取代设置文件的存储后端。
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
 * 调用方递入的一切都算作 global 侧的文件与全部目录，所以之后的写入保存在内存里，读回来的行为与
 * 真的一样——只是缺了文件。
 */
export function inMemorySettingManager(
	settings: Partial<GlobalSettings> = {},
	models?: readonly ModelConfig[],
): SettingManager {
	const storage = new InMemorySettingsStorage();
	storage.write(`${JSON.stringify(settings, null, "\t")}\n`);
	return new SettingManager({ storage, models });
}

/** 设置的部分变更，形状与浏览器发来的 config 补丁一致。 */
export interface SettingsPatch {
	model?: string;
	/** 窗口的「已种下内置默认」标记；见 `GlobalSettings.defaultModelSeeded`。 */
	defaultModelSeeded?: boolean;
	/** 全局默认活跃工具集。整份列表，如同会话上的工具集。 */
	tools?: string[];
	/**
	 * 用户的模式，像 `tools` 一样整份发送（ADR-0004）：面板编辑的是一份列表，这里改名的模式与那里
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
 * 设置文件在哪里读写。
 *
 * 注入进来，让 manager 永远不挑选自己碰的文件：真实现读写 `<agent home>/settings.json`，测试拿
 * 内存版。把设置放在别处——数据库、每用户存储、沙箱——的宿主换一个对象即可，无需改 manager。
 */
export interface SettingsStorage {
	/** 当前的文本，那里还没有东西时为 undefined。 */
	read(): string | undefined;
	/** 替换文本，目录不存在时创建它。 */
	write(content: string): void;
	/** 背后的文件，用于错误消息。 */
	path(): string;
}

/** 真实文件：`<agent home>/settings.json`。 */
class FileSettingsStorage implements SettingsStorage {
	private readonly absPath: string;

	constructor(absPath: string) {
		this.absPath = absPath;
	}

	read(): string | undefined {
		try {
			return readFileSync(this.absPath, "utf8");
		} catch (error) {
			// 文件缺失是正常的首次运行。其余任何情况——权限、挡在路上的目录——都是真实的失败，不得以
			// 「未配置设置」的形态抵达调用方。
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	write(content: string): void {
		mkdirSync(dirname(this.absPath), { recursive: true });
		writeFileSync(this.absPath, content, "utf8");
	}

	path(): string {
		return this.absPath;
	}
}

/** 没有文件在背后的设置，给测试或内嵌宿主用。 */
class InMemorySettingsStorage implements SettingsStorage {
	private content: string | undefined;

	read(): string | undefined {
		return this.content;
	}

	write(content: string): void {
		this.content = content;
	}

	path(): string {
		return "<in-memory settings>";
	}
}

/**
 * 设置的纯数据状态：manager 的读写所操作的东西，仅此而已。
 *
 * 合并视图以 {@link GlobalSettings} 形态保存——每个字段都填了默认——而文件按写下的原样保存，
 * 未知键也保留。这个分野正是写入安全的原因：只有补丁点名的字段移动，文件的其余部分——无论是否
 * 手编——原样写回。
 */
interface SettingsState {
	storage: SettingsStorage;
	/** 文件的内容，按它写下的原样。 */
	layer: SettingsLayer;
	settings: GlobalSettings;
}

/** 一份文件的内容：它实际携带的键，未知的也算。 */
type SettingsLayer = Record<string, unknown>;

/**
 * 把 `storage` 背后的文件读进一份新的 {@link SettingsState}：把存储后端变成设置操作所操作状态的
 * 唯一入口。
 *
 * 本构建无法解析的文件被拒绝，从不被覆盖。
 */
function settingsStateFromStorage(storage: SettingsStorage): SettingsState {
	const layer = readLayer(storage);
	return { storage, layer, settings: mergeSettings(layer) };
}

/**
 * 应用一次部分变更，返回前写盘。
 *
 * 变更抵达状态背后的文件、仅此而已——状态本身被调用方丢弃，文件才是之后每次读取重读的东西。
 */
function applyPatch(s: SettingsState, patch: SettingsPatch): void {
	const fields = Object.entries(patch)
		.filter(([, value]) => value !== undefined)
		.map(([field]) => field);
	if (fields.length === 0) return;

	const changes: SettingsLayer = {};
	for (const field of fields) {
		const inherited = s.layer[field];
		const value = (patch as Record<string, unknown>)[field];
		s.layer[field] = isRecord(inherited) && isRecord(value) ? mergeLayers(inherited, value) : value;
		changes[field] = s.layer[field];
	}
	persist(s, changes);
}

/**
 * 把变更的字段写到文件此刻持有的内容之上，然后把结果当作本状态里的副本。
 *
 * 写前重读，正是让对同一文件的手编不被这里一次无关的变更回滚的原因：一次模型切换不得弄丢用户在
 * 进程运行期间敲进去的键。
 */
function persist(s: SettingsState, changes: SettingsLayer): void {
	const merged = mergeLayers(readLayer(s.storage), changes);
	s.storage.write(`${JSON.stringify(merged, null, "\t")}\n`);
	s.layer = merged;
}

/** 文件的设置，按它写下的原样。不在的文件是一个空层。 */
function readLayer(storage: SettingsStorage): SettingsLayer {
	const content = storage.read();
	if (content === undefined) return {};

	// trim 顺带去掉 UTF-8 BOM——Windows 编辑器会写它，而 `JSON.parse` 拒绝它。
	const text = content.trim();
	if (text === "") return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${storage.path()} is not valid JSON: ${(error as Error).message}`);
	}
	if (!isRecord(parsed)) throw new Error(`${storage.path()} must hold a JSON object`);
	return parsed;
}

/** 补丁的嵌套对象逐键合并进已有的值，其余字段整体替换。 */
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
