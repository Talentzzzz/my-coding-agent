// 引擎的契约：一次运行发布什么，以及运行侧 hook 以什么形状作答。这些类型曾住在 `packages/loop`；
// 引擎现在住在 `agent.ts`，而它跨过该文件边界递出的形状——给 hooks、给会话自己的订阅者——就住
// 这里，归拢成一个模块。工具与工具结果是 `Tool` 与 `ToolResult`，定义在传输层旁边的 `llm/types.ts`，
// 由请求与运行共用。wire 类型是 `protocol.ts` 的事，留在那里；`QueueMode` 是共享的，
// `protocol.ts` 转发本模块这份定义，而不是再声明一份。
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	ImageContent,
	JsonValue,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResult,
	ToolResultMessage,
	Usage,
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
 * `beforeToolCall` 返回的结果。
 *
 * 返回 `{ block: true }` 会阻止工具执行，运行改为发出一个错误工具结果；`reason` 成为该错误结果里
 * 显示的文本，省略时使用默认的阻止消息。
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
	/**
	 * 提示 agent 在此调用被阻止时于当前工具批结束后停止。只有批中每个定稿的工具结果都设为 true，
	 * 提前终止才会发生。
	 */
	terminate?: boolean;
	/**
	 * 在此调用处结束运行且不为它写结果：调用在 transcript 里保持悬空，宿主稍后把答案交给恢复运行
	 * （`RunRecoveryOptions`）来续上。批中其余调用随之悬空，运行不再发供应商请求就结束，此调用也不
	 * 发任何 `tool_execution_*` 事件。
	 *
	 * 这是结束重启式审批闸门的答案（ADR-0006 §5）：等人不是一次运行能做到的事，所以运行结束、答案
	 * 从运行之外抵达。`block` 与 `suspend` 互斥——同时设置两者按 suspend 处理。
	 */
	suspend?: boolean;
}

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
 * `afterToolCall` 返回的部分覆盖。
 *
 * 合并语义逐字段：
 * - `content`：提供时整体替换工具结果的 content 数组
 * - `details`：提供时整体替换工具结果的 details
 * - `isError`：提供时替换工具结果的错误标记
 * - `usage`：提供时替换工具结果的 usage
 * - `terminate`：提供时替换提前终止提示
 * - `structuredContent`：提供时替换结构化内容。提供 `content` 而不提供它时，结构化内容被丢弃，
 *   因为它可能已与 content 不再匹配；要保留就随 `content` 一起返回。
 *
 * 其余省略的字段保留原执行结果中的值。
 * `content`、`details`、`usage` 没有深合并。
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	structuredContent?: JsonValue;
	isError?: boolean;
	/** 最终那次工具执行自身的 usage（若有）。不计入主 LLM 上下文核算。 */
	usage?: Usage;
	/**
	 * 提示 agent 在当前工具批结束后停止。只有批中每个定稿的工具结果都设为 true，提前终止才会发生。
	 */
	terminate?: boolean;
}

/** 传给 `beforeToolCall` 的上下文。 */
export interface BeforeToolCallContext {
	/** 请求该工具调用的 assistant 消息。 */
	assistantMessage: AssistantMessage;
	/** `assistantMessage.content` 里原始的 tool call 块。 */
	toolCall: ToolCall;
	/** 按目标工具 schema 校验过的参数。 */
	args: unknown;
	/** 准备此工具调用时的当前 agent 上下文。 */
	context: Context;
}

/** 传给 `afterToolCall` 的上下文。 */
export interface AfterToolCallContext {
	/** 请求该工具调用的 assistant 消息。 */
	assistantMessage: AssistantMessage;
	/** `assistantMessage.content` 里原始的 tool call 块。 */
	toolCall: ToolCall;
	/** 按目标工具 schema 校验过的参数。 */
	args: unknown;
	/** 尚未应用任何 `afterToolCall` 覆盖的已执行结果。 */
	result: ToolResult<unknown>;
	/** 该已执行结果当前是否按错误处理。 */
	isError: boolean;
	/** 定稿此工具调用时的当前 agent 上下文。 */
	context: Context;
}

/**
 * 一次运行经过的两个工具调用接缝，以引擎的视角。
 *
 * 运行按次安装它们——会话的 hooks 需要这一次运行自己的瞬态——并把这对交给文件级的批处理机件；
 * 这是引擎仍以参数收取而非从编排层读取的唯一东西：那些 helper 在任何实例之外运行。
 */
export interface ToolCallHooks {
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

/**
 * 正在构建的供应商请求的替换性运行时状态。
 *
 * `Agent.prepareRequest` 的答案：下一个请求所用的 context 与 model，从那一刻的账本重建而来，
 * 而不是从上一轮带来。
 */
export interface AgentRequestUpdate {
	/** 下一个供应商请求用的 context。 */
	context?: Context;
	/** 下一个供应商请求用的 model，带着它被要求的思考档位。 */
	model?: Model;
	/**
	 * 本次请求为之构建的工具——派生时会话处于活跃状态的名字，作为引擎带着跨过这次请求的一份成员
	 * 判断。
	 *
	 * 不是 `Context` 的一部分：context 携带的是传输层声明用的实例，这是执行链判断调用所依据的名单，
	 * 且随 update 的其余部分一并替换，让两次请求之间变动的集合把名单一起带走。
	 */
	activeNames?: ReadonlySet<string>;
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
