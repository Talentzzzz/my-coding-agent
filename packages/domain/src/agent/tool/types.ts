import type { ToolResult } from "../types.ts";

/** 把纯文本包装成 tool result。 */
export function textResult(text: string, details?: unknown): ToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

/** run 已被取消时停止工具的工作，但不把它报告成工具失败。 */
export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Aborted");
}
