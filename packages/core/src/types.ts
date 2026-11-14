// 引擎的契约：一次运行发布什么，以及恢复遍以什么形状作答。这些类型曾住在 `packages/loop`；引擎随
// ADR-0016 并回编排层，而运行递给会话自己的订阅者的形状就住这里，归拢成一个模块。hooks 三动词的
// 事件与答案就用 `HookMap` 的派生类型；工具与工具结果是 `Tool` 与 `ToolResult`，定义在传输层旁边
// 的 `llm/types.ts`，由请求与运行共用。wire 类型是 `protocol.ts` 的事，留在那里；`QueueMode` 是共享
// 的，`protocol.ts` 转发本模块这份定义，而不是再声明一份。
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
