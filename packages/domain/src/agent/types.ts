// 引擎的契约：一次运行发布什么，以及恢复遍以什么形状作答。这些类型曾住在 `packages/loop`；引擎随
// ADR-0016 并回编排层，而运行递给会话自己的订阅者的形状就住这里，归拢成一个模块。hooks 三动词的
// 事件与答案就用 `HookMap` 的派生类型；工具与工具结果是 `Tool` 与 `ToolResult`，定义在传输层旁边
// 的 `llm/types.ts`，由请求与运行共用。wire 信封是 `@my-agent/case` 的 `protocol.ts` 的事（原
// `core/src/protocol.ts` 已解散）；`QueueMode` 是共享的，wire 面经网关转发本模块这份定义，而不是
// 再声明一份。
//
// 设置的形状与默认值也住在这里（文末一节，原是独立的 `config.ts`）。这对加载方向是件好事：本模块
// 对外递类型与少量政策常量（`APPROVAL_TOOLS` 一类，业务模块零依赖），运行期是一个不依赖任何业务
// 模块的叶子——各持有者从它回落常量，编排层装配各持有者，箭头仍然只朝一个方向流。
import type {
	AssistantMessageEvent,
	Context,
	Message,
	Model,
	ToolCall,
	ToolResult,
	ToolResultMessage,
} from "./llm/index.ts";

// 本模块曾以 `Agent` 前缀定义的那些名字，转发出去让它继续为此作答：定义住在传输层旁边的
// `llm/types.ts`。
export type { Context, Tool, ToolExecutionMode, ToolResult, ToolUpdateCallback } from "./llm/index.ts";

/**
 * 控制运行到达队列取走点时注入多少条排队的用户消息。
 *
 * - "all"：在该点取走并注入所有排队消息。
 * - "one-at-a-time"：只取走并注入最旧的一条，其余留在队列里等之后的取走点。
 */
export type QueueMode = "all" | "one-at-a-time";

/**
 * 一个被恢复的工具调用续跑时所用的答案。
 *
 * 它是审批流在调用悬空期间记录下的东西：grant 让调用走运行的正常路径重跑（包括闸门），deny 用
 * `reason` 关闭调用——答案没带 reason 时，用「用户拒绝了它」那句话。
 */
export interface ToolCallAnswer {
	approved: boolean;
	/** deny 时：合成出的工具结果所携带的那句话。 */
	reason?: string;
}

/**
 * 一次运行如何恢复上一次运行留下的未答工具调用。
 *
 * 每次运行在第一个请求之前扫描上下文里的悬空调用（没有工具结果消息回答的 `toolCall` 块），因为
 * 携带悬空调用的供应商请求是非法的。每个调用的去向是固定的：{@link RunRecoveryOptions.answers} 里
 * 的答案用它自己关闭调用——grant 重跑该调用、deny 合成其结果——而没有答案点名的调用，在
 * {@link RunRecoveryOptions.enablePendingToolRecovery} 允许时用合成的错误结果关闭。
 */
export interface RunRecoveryOptions {
	/** 审批流记录的答案，按 tool call id 为键。 */
	answers?: Record<string, ToolCallAnswer>;
	/**
	 * 用合成的错误结果关闭没有答案点名的悬空调用，让运行的第一个请求对供应商合法。默认 true。
	 * 关掉它的宿主自己接管这些调用：运行原样发送未答调用，供应商怎么裁决随它。
	 */
	enablePendingToolRecovery?: boolean;
}

/**
 * 正在构建的供应商请求的替换性运行时状态。
 *
 * `prepareRequest` 的答案：下一个请求所用的 context 与 model，从那一刻的账本重建而来，而不是从
 * 上一轮带来。声明的工具数组骑在 context 上（元素是表自己的实例，ADR-0011），执行链对着它按名
 * 解析——「模型被告知什么与它可以运行什么」从同一个对象作答（ADR-0016）。
 */
export interface AgentRequestUpdate {
	/** 下一个供应商请求用的 context。 */
	context?: Context;
	/** 下一个供应商请求用的 model，带着它被要求的思考档位。 */
	model?: Model;
}

/** hooks 运行完毕后一次工具调用的最终结果。 */
export interface ToolCallOutcome {
	toolCall: ToolCall;
	result: ToolResult<unknown>;
	isError: boolean;
}

/**
 * 一次运行为 UI 更新发出的事件。
 *
 * `agent_end` 是一次运行发出的最后一个事件，但在会话为响应它所做的一切——落盘、fanout——落定
 * 之前，运行不算空闲。会话在那之后才空闲。
 */
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: Message[] }
	// 轮次生命周期——一轮是一次 assistant 响应加上随之的工具调用/结果
	| { type: "turn_start" }
	| { type: "turn_end"; message: Message; toolResults: ToolResultMessage[] }
	// 消息生命周期——system、user、assistant、toolResult 消息都会发出
	| { type: "message_start"; message: Message }
	// 只在流式期间为 assistant 消息发出
	| { type: "message_update"; message: Message; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: Message }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };

// ============================================================================
// 设置的形状与默认值
//
// 原是独立的 `config.ts`（设置归属重构 ADR-0028 的留守文件），曾短暂住过编排层（agent.ts），现
// 归拢到本模块——放这里而不是编排层，正是为了不留加载环。所有权仍然分属三个持有者——行、默认
// 模型与重试在 `models.json`，工具簇在 `tools.json`，队列模式在 `sessions.json`
// ——这里只留守两样：各持有者回落用的默认值，与 wire 和门面读模型需要的类型名。各簇的规范化器
// 仍随簇住在各持有者文件里，本节没有任何规范化函数。
// ============================================================================

import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { BashSettings, ModeSettings } from "./tool/manager.ts";

/** 存放会话、设置与已存凭据的目录。 */
export const AGENT_HOME = resolvePath(process.env.MY_AGENT_HOME ?? join(homedir(), ".my-agent"));

/** 本应用在自己写出的文件与消息里如何自称。 */
export const APP_NAME = "my-agent";

/**
 * `bash` 工具的默认超时。类型随簇住进了 tools/manager.ts（设置归属重构 §5）；工具行为与
 * {@link DEFAULT_GLOBAL_SETTINGS} 都从这份常量取默认。
 */
export const DEFAULT_BASH_SETTINGS: BashSettings = { defaultTimeoutMs: 120_000, maxTimeoutMs: 3_600_000 };

/**
 * 供应商调用失败时的重试策略。
 *
 * 类型留守本模块（本仓库的运行期叶子——它对外只递类型，编译期即抹掉 import），所有权随模型簇
 * 归 `ModelManager`（ADR-0028 修正，2026-11-20）：`models.json` 的 `retry` 键，持有者自己的
 * 规范化器（`retryOr`）住在 `model-manager.ts` 里，本节没有逻辑。
 */
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	/** 每次尝试的延迟为 `baseDelayMs * 2^(attempt-1)`。 */
	baseDelayMs: number;
	/** 单次计算出的延迟的上限。 */
	maxAgentDelayMs: number;
}

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
 * 真实的家已按设置归属重构（spec §3）分给三个持有者——行、默认模型与重试在 `models.json`，工具簇在
 * `tools.json`，队列模式在 `sessions.json`；UI 簇（外观、目录视图）已迁往
 * 客户端自己的存储（ADR-0029）——这个类型只剩**形状**：设置面板的 wire 面（ADR-0012/0019）不因
 * 搬家而改口。而一个会话自己的选择
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
	/** 运行前必须在 UI 里获得批准的工具，按工具名为键。 */
	approval: Record<string, boolean>;
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
 * 设置归属重构（ADR-0028）后它从退场的 `setting-manager.ts` 迁来——形状一字未动：`Agent.applySettings`
 * 按字段名把它路由到拥有该字段的持有者，每簇独立原子落盘。
 */
export interface SettingsPatch {
	model?: string;
	/** 窗口的「已种下内置默认」标记；见 {@link GlobalSettings.defaultModelSeeded}。 */
	defaultModelSeeded?: boolean;
	/** 全局默认活跃工具集。整份列表，如同会话上的工具集。 */
	tools?: string[];
	/**
	 * 用户的模式，像 `tools` 一样整份发送（ADR-0004）：面板编辑的是一份列表，这里改名的模式与那里
	 * 删除的模式必须同落，要么都不落。
	 */
	modes?: ModeSettings[];
	/** 变动过的审批条目，按工具名为键；省略的键保持现行值。 */
	approval?: Record<string, boolean>;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	retry?: Partial<RetrySettings>;
	/** `bash` 工具允许一条命令运行多久。部分字段，让一个超时可以单独挪动。 */
	bash?: Partial<BashSettings>;
}

/** 设置面板读与写的东西。 */
export interface GlobalSettingsSnapshot {
	/** 全局默认活跃工具集；缺失表示本构建认识的所有工具。 */
	tools?: string[];
	/**
	 * 用户的模式，整体存放，按选择器列出的顺序；缺失表示没有定义过。
	 *
	 * 内置默认模式有意不在其中：它是实时读取的全局默认（ADR-0004），客户端用 `tools` 与 `approval`
	 * 拼出它，而不是期望有一行。
	 */
	modes?: ModeSettings[];
	approval: Record<string, boolean>;
	/** `bash` 工具允许一条命令运行多久。 */
	bash: BashSettings;
	model?: string;
	/** 窗口是否已种下内置默认行；见 `Settings.defaultModelSeeded`。 */
	defaultModelSeeded?: boolean;
}

/**
 * 不带消息地对会话所持之物做的变更：模式指针、会话的审批增量与两个队列模式。
 *
 * 模型与思考档位有意缺席。两者都在输入框里选择、都随属于它们的消息抵达（ModelSelection），
 * 因为记录一个没有请求真正用过它的选择，等于在会话记录里放一条从未生效的决定。
 */
export type ConfigPatch = {
	/**
	 * 会话要指向的模式：settings `modes` 表里的一个名字；`null` 即指回内置「默认」（指针缺席）。
	 * 省略的键保持现行值。指向不存在的预设会被拒绝——说出来，而不是按默认悄悄跑。
	 */
	mode?: string | null;
	/**
	 * 会话自己的审批增量，按工具名为键：会话在个别工具上的明确决定（grant 的「不再问」、补丁写下
	 * 的键），叠在模式解析出的审批基线之上；省略的键保持现行值。
	 */
	approval?: Record<string, boolean>;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
};

/**
 * 窗口设置提供审批开关的工具，按提供的顺序。
 *
 * 审批映射本身以工具名为键，不绑定这份列表：设置文件或会话快照可以点名任何工具，报告哪些工具被
 * 闸的读取者遍历的是映射而不是它。这份列表只是窗口的默认 offerings——本构建出厂的配置，不是
 * 映射能装什么的限制。
 */
export const APPROVAL_TOOLS: readonly string[] = ["read", "write", "edit", "glob", "grep", "bash"];

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
	approval: { read: false, write: true, edit: true, glob: false, grep: false, bash: true },
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
 * 工具簇与模式表共用。
 */
export function stringListOrUndefined(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

// 工具簇的类型（`BashSettings` / `ModeSettings`）随簇住在 tool/manager.ts（设置归属重构 §5）；
// 这里只转发类型名，让 wire 网关与既有 import 路径继续经本模块拿到它们。
export type { BashSettings, ModeSettings } from "./tool/manager.ts";
