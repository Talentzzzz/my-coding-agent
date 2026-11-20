import { homedir } from "node:os";
import { join, resolve } from "node:path";
// 引擎簇的类型与规范化函数随簇搬进 engine-settings.ts（spec §5）；默认值留守本文件的
// DEFAULT_GLOBAL_SETTINGS。环安全：retryOr/numberOr 只在 mergeSettings/bashOr 的调用期执行，
// 本文件不把它们用在模块顶层。
import { numberOr, retryOr, type RetrySettings } from "./engine-settings.ts";
// 类型随簇搬入后，旧读者（setting-manager.ts）仍从本文件点这个名字——type-only 再导出，源头不变地
// 指向 engine-settings.ts。
export type { RetrySettings };
import type { QueueMode } from "./protocol.ts";
// UI 簇的类型与规范化器已随簇搬进 ui-settings.ts（spec §5）。appearanceOr 与
// stringRecordOrUndefined 只在 mergeSettings 调用期触达，而 ui-settings.ts 也只在函数体里引用
// 本文件的 DEFAULT_APPEARANCE 与三个 RANGE 常量——两侧都不在模块顶层取对方的值，环安全。
import { appearanceOr, stringRecordOrUndefined } from "./ui-settings.ts";
import type { AppearanceSettings } from "./ui-settings.ts";
// protocol.ts 与 setting-manager.ts（不随本票改动）仍从这里拿 UI 类型；真实定义在 ui-settings.ts。
export type { AppearanceSettings, DirectoryPaging } from "./ui-settings.ts";

/** 存放会话、设置与已存凭据的目录。 */
export const AGENT_HOME = resolve(process.env.MY_AGENT_HOME ?? join(homedir(), ".my-agent"));

/** 本应用在自己写出的文件与消息里如何自称。 */
export const APP_NAME = "my-agent";

/**
 * 窗口如何绘制自己——类型与规范化器（`appearanceOr`、`clamp*`）已随簇搬进 ui-settings.ts；
 * `DEFAULT_APPEARANCE` 与三个 RANGE 常量按 spec §5 留守在这里。
 */
export const DEFAULT_APPEARANCE: AppearanceSettings = { theme: "dark", fontSize: 15 };

/** 字号控件提供的范围，解析器与客户端共用。 */
export const FONT_SIZE_RANGE = { min: 10, max: 22 } as const;

/**
 * 侧边栏拖动手柄可及的范围，解析器与客户端共用。
 *
 * 这组数字与字号范围放在一起而不是只留在样式表里，因为拖动的两端在客户端都要对它钳制：一个超出
 * 范围的存储偏好会在用户看得见的每次缩放中幸存，并在下次启动时重新生效。
 */
export const SIDEBAR_WIDTH_RANGE = { min: 208, max: 360 } as const;

/**
 * 阅读列宽度可占用的绝对范围，解析器与客户端共用。
 *
 * 布局相对的两端——会话列减去它的 gutter——是客户端的公式，因为它们依赖只有窗口才知道的宽度；
 * 服务端钳制存储偏好用的就是这一对数字，与侧边栏范围的分工相同。
 */
export const CONTENT_WIDTH_RANGE = { min: 600, max: 1280 } as const;

/**
 * `bash` 工具允许一条命令运行多久。
 *
 * 上限保留为设置而不是干脆取消，因为它防的是模型要求无界的运行——但这个数字由用户来改：一个要跑
 * 小时级构建的 checkout，会在自己的设置文件里写一个更高的值。
 */
export interface BashSettings {
	/** 调用未自带 `timeout_ms` 时使用。 */
	defaultTimeoutMs: number;
	/** 任何一条命令的上限，无论调用要求多长。 */
	maxTimeoutMs: number;
}

export const DEFAULT_BASH_SETTINGS: BashSettings = { defaultTimeoutMs: 120_000, maxTimeoutMs: 3_600_000 };

/**
 * 内置默认模式的名字，设置从不存储它。
 *
 * 默认模式*就是*全局默认——默认工具集与默认审批映射，实时读取——所以它没有自己的一行需要与它们
 * 保持同步（ADR-0004）。这个名字是保留名：一个存储模式若占用它，会遮住输入框必须永远能找到的那
 * 个答案。
 */
export const DEFAULT_MODE_NAME = "默认";

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
 * global 侧：`<AGENT_HOME>/settings.json` 补默认后的视图（ADR-0019）。
 *
 * 它持有的是**默认值**与**命名预设**——`modes` 表（模式 → 工具集 + 审批基线）、默认模型、外观、
 * bash、重试——而一个会话自己的选择住在它 `.json` 快照的设置半（`SessionSettings`）上。两者在每次
 * 读取时组合成 `Settings`（`packages/core/src/settings.ts`），组合是派生值，这一侧从不被任何袋持有。
 */
export interface GlobalSettings {
	/**
	 * 新会话打开在哪一行：`name`，或会话记录记录的 `<name>/<model-id>` ref。
	 *
	 * 两种写法都接受，因为设置面板写第一种，修复脚本写第二种。undefined 不是「没有模型」：装配会
	 * 回落到 `DEFAULT_MODEL_NAME`（`packages/core/src/models.ts`），只有连那一行都没有的机器才打开
	 * 在第一行上。
	 */
	model?: string;
	/**
	 * 窗口是否已经种下内置的默认模型行。
	 *
	 * 没有导入任何模型时，客户端会种一行起始行（`packages/web/src/default-model.ts`），用户可以删掉
	 * 它。这个标记让删除成为终局：没有它，下次启动看到空列表又会把行种回来。它是设置而不是浏览器
	 * 自己的存储，因为桌面外壳每次启动都换新端口，而 `localStorage` 按 origin 隔离——这个标记恰恰会
	 * 被它为之存在的重启忘掉。
	 *
	 * 缺失表示「从未种过」，这也是旧设置文件和从未启动过窗口的机器的状态。
	 */
	defaultModelSeeded?: boolean;
	/**
	 * 从未选择过的会话打开时的工具集，也是会话级面板重置到的全局默认。undefined 表示注册表的全集，
	 * 即如今的会话打开时的样子——所以旧设置文件无需迁移，也无需自己的字段。
	 */
	tools?: string[];
	/**
	 * 用户的模式，整体存放，按选择器列出的顺序。缺失表示没有：内置默认模式从不存储，所以旧文件
	 * 已经是一份合法的 modes 文件（ADR-0004）。
	 */
	modes?: ModeSettings[];
	/** 主题与字号，即窗口绘制自己的方式。 */
	appearance: AppearanceSettings;
	/** 运行前必须在 UI 里获得批准的工具，按工具名为键。 */
	approval: Record<string, boolean>;
	/**
	 * 侧边栏不列出的目录，按绝对路径。
	 *
	 * 这份列表只是*视图*决定，别无其他：目录标题上的「删除」把分组从列表移走，让每份会话记录原地
	 * 不动，所以一个目录可以被搁置而不碰磁盘上的任何东西。这正是它作为存储设置而非删除操作存在的
	 * 全部理由——会话仍可按 id 打开，取消隐藏就是清空这份列表。
	 *
	 * 用户藏起第一个目录之前缺失而不是 `[]`，与两个宽度字段遵循同一规则：没人表达过的偏好不落笔。
	 */
	hiddenDirectories?: string[];
	/**
	 * 侧边栏为目录显示的名字，按绝对路径。
	 *
	 * 与 `hiddenDirectories` 完全同类、且出于同样理由的视图决定：磁盘上的文件夹保留文件系统给它起的
	 * 名字，每份会话记录保留其头部记录的 `workDirAbsPath`。所以在这里重命名目录不会让任何会话
	 * 找不到，也不会碰 agent 自己设置之外的任何东西。
	 *
	 * 空字符串是收回一个名字的方式——分组落回文件夹自己的名字——因为按键合并的记录无法用「省略」
	 * 表达「忘掉这一条」。
	 */
	directoryNames?: Record<string, string>;
	/** 一个取走点注入多少条 steer 消息。 */
	steeringMode: QueueMode;
	/** 一个取走点注入多少条 followUp 消息。 */
	followUpMode: QueueMode;
	/** 如何处理一次瞬时的供应商失败。 */
	retry: RetrySettings;
	/** `bash` 工具允许一条命令运行多久。 */
	bash: BashSettings;
}

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
	approval: { read: false, write: true, edit: true, glob: false, grep: false, bash: true },
	appearance: { ...DEFAULT_APPEARANCE },
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	retry: { enabled: true, maxRetries: 3, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 },
	bash: { ...DEFAULT_BASH_SETTINGS },
};

/** 机器级的设置文件，global 侧唯一的一份。`agentDir` 可配置，让测试能指到无害的地方。 */
export function settingsPath(agentDir: string = AGENT_HOME): string {
	return join(agentDir, "settings.json");
}

/**
 * 把一份部分设置对象合并到默认值之上。未知的键被忽略。
 *
 * 这里只做值的规范化；读写文件是 `SettingManager` 的职责（它读写的只有 global 侧这一份文件，
 * `applySettings` 把变更写回），这正是同一套规范化能同时服务文件与内存中变更的原因。
 */
export function mergeSettings(input: unknown): GlobalSettings {
	const record = isRecord(input) ? input : {};
	const approval = isRecord(record.approval) ? record.approval : {};

	const merged: GlobalSettings = {
		approval: { ...DEFAULT_GLOBAL_SETTINGS.approval },
		appearance: appearanceOr(record.appearance),
		steeringMode: queueModeOr(record.steeringMode, DEFAULT_GLOBAL_SETTINGS.steeringMode),
		followUpMode: queueModeOr(record.followUpMode, DEFAULT_GLOBAL_SETTINGS.followUpMode),
		retry: retryOr(record.retry),
		bash: bashOr(record.bash),
	};

	const model = stringOrUndefined(record.model);
	if (model !== undefined) merged.model = model;

	// 两种取值都原样保留：`false` 是手编文件要求重新种回内置行的写法，在这里把它变成缺失会让这个
	// 请求无法表达。
	if (typeof record.defaultModelSeeded === "boolean") merged.defaultModelSeeded = record.defaultModelSeeded;

	const tools = stringListOrUndefined(record.tools);
	if (tools !== undefined) merged.tools = tools;

	const modes = modesOr(record.modes);
	if (modes !== undefined) merged.modes = modes;

	const hiddenDirectories = stringListOrUndefined(record.hiddenDirectories);
	if (hiddenDirectories !== undefined) merged.hiddenDirectories = hiddenDirectories;

	const directoryNames = stringRecordOrUndefined(record.directoryNames);
	if (directoryNames !== undefined) merged.directoryNames = directoryNames;

	for (const [key, value] of Object.entries(approval)) {
		if (typeof value === "boolean") merged.approval[key] = value;
	}
	return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * bash 超时，逐字段落在默认值之上。
 *
 * 高于上限的默认值会被压到上限而不是照办：否则每一次未自带 `timeout_ms` 的调用都注定超时。
 */
function bashOr(value: unknown): BashSettings {
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

/** pi-agent-core 认识的两种队列模式；其他取值保留默认。 */
function queueModeOr(value: unknown, fallback: QueueMode): QueueMode {
	return value === "all" || value === "one-at-a-time" ? value : fallback;
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
 *
 * 工具簇与模式表共用，UI 持有者的读时迁移（hiddenDirectories）也用它。
 */
export function stringListOrUndefined(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
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
 */
function modesOr(value: unknown): ModeSettings[] | undefined {
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
