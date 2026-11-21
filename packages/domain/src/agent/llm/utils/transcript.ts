// 从 pi-ai（0.99.2）vendor 而来。@ts-nocheck 让仓库根目录更严格的配置放过本文件，而进入
// packages/domain 的每次 import 仍然被完整检查。
// @ts-nocheck
import type { Message, SystemMessage, Tool } from "../types.ts";

/**
 * 为 prompt 构建开头的 system 消息。prompt 为空时返回 undefined，空会话记录保持为空。
 *
 * 以它造的东西命名，而不是以它运行的时刻命名：它在每次请求之前运行，而不是每个会话一次，因为
 * prompt 每次都整体重发。工具不经过这里——工具是请求参数，由 `Context.tools` 携带。
 */
export function createSystemMessage(systemPrompt: string | undefined): SystemMessage | undefined {
	if (systemPrompt === undefined || systemPrompt.length === 0) return undefined;
	return { role: "system", content: systemPrompt, timestamp: 0 };
}

/**
 * 开头的 system 消息，若会话记录以它开始——请求不带显式 `Context.system` 时传输读取的回落。
 *
 * 开头消息是 system 消息唯一可能在的地方：更晚的一条在到达传输之前就被丢弃，因为 prompt 每次
 * 请求都整体重建，而不是从对话中间打补丁。
 */
export function getInitialSystemMessage(messages: readonly Message[]): SystemMessage | undefined {
	const first = messages[0];
	return first?.role === "system" ? first : undefined;
}

/** 在做会话记录比较或持久化之前，剥掉工具上的可执行字段和纯展示字段。 */
export function toToolDeclaration(tool: Tool): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)) as Tool["parameters"],
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
	};
}
