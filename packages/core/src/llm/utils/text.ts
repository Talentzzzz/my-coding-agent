// 从 pi-ai（0.99.2）vendor 而来。@ts-nocheck 让仓库根目录更严格的配置放过本文件，而进入
// packages/core 的每次 import 仍然被完整检查。
// @ts-nocheck
import type { ImageContent, SystemMessage, TextContent, ThinkingContent, ToolCall } from "../types.ts";

type Content = TextContent | ImageContent | ThinkingContent | ToolCall;

/** 从消息 content 提取并拼接文本。 */
export function contentText(content: string | readonly Content[], separator = "\n"): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(separator);
}

/** 把 system message 渲染成它携带的 prompt 文本。 */
export function getSystemMessageText(message: SystemMessage): string {
	return contentText(message.content);
}
