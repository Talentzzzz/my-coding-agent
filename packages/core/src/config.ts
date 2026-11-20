import { homedir } from "node:os";
import { join, resolve } from "node:path";
// 类型随簇搬进各持有者的文件（设置归属重构 spec §5），config.ts 只留守类型名供 wire 与门面的
// 读模型使用。本文件不再有任何规范化函数——各簇的规范化器随簇住在各持有者文件里，DEFAULT_* 常量
// 留守本文件供它们回落。
import type { RetrySettings } from "./engine-settings.ts";
// RetrySettings 的 re-export：type-only，源头不变地指向 engine-settings.ts。
export type { RetrySettings };
import type { QueueMode } from "./protocol.ts";
// 工具簇的类型随簇搬进了 tools/manager.ts（设置归属重构 §5）；mergeSettings 已随 SettingManager
// 退场，这里不再 import 任何规范化器。
import type { BashSettings, ModeSettings } from "./tools/manager.ts";
// 类型随簇搬走后的 re-export：protocol.ts 与既有 import 路径不变。
export type { BashSettings, ModeSettings };
// UI 簇的类型与规范化器住进 ui-settings.ts（spec §5）。protocol.ts 仍从这里拿 UI 类型；真实定义
// 在 ui-settings.ts。
export type { AppearanceSettings, DirectoryPaging } from "./ui-settings.ts";
import type { AppearanceSettings } from "./ui-settings.ts";

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
 * `bash` 工具的默认超时。类型随簇住进了 tools/manager.ts（设置归属重构 §5）；默认值留守此处，
 * `tools/bash.ts` 的工具行为与 `DEFAULT_GLOBAL_SETTINGS` 都从这份常量取默认。
 */
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
 * global 侧设置面板的读模型：`Agent.settings()` 从五个持有者现读、组装出的这份形状。
 *
 * 真实的家已按设置归属重构（spec §3）分给了五个持有者——行与默认模型在 `models.json`，工具簇在
 * `tools.json`，队列模式在 `sessions.json`，外观与目录视图在 `ui.json`，重试在 `engine.json`——
 * 这个类型只剩**形状**：设置面板的 wire 面（ADR-0012/0019）不因搬家而改口。而一个会话自己的选择
 * 住在它 `.json` 快照的设置半（`SessionSettings`），两者在每次读取时组合成 `Settings`
 * （`packages/core/src/settings.ts`），组合是派生值，这一侧从不被任何袋持有。
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

/**
 * 设置的部分变更，形状与浏览器发来的 config 补丁一致（wire 契约，spec §7）。
 *
 * `SettingManager` 退场后它从 `setting-manager.ts` 迁来本文件——形状一字未动：`Agent.applySettings`
 * 按字段名把它路由到拥有该字段的持有者，每簇独立原子落盘。
 */
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

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
	approval: { read: false, write: true, edit: true, glob: false, grep: false, bash: true },
	appearance: { ...DEFAULT_APPEARANCE },
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	retry: { enabled: true, maxRetries: 3, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 },
	bash: { ...DEFAULT_BASH_SETTINGS },
};

/**
 * 机器级的旧设置文件，`<AGENT_HOME>/settings.json`。`agentDir` 可配置，让测试能指到无害的地方。
 *
 * 设置归属重构（spec §4.2）后它只作迁移源：各持有者首次读取时从这里捡走自己的簇，之后旧文件被
 * 完全忽略——永不删除、永不写入。
 */
export function settingsPath(agentDir: string = AGENT_HOME): string {
	return join(agentDir, "settings.json");
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
