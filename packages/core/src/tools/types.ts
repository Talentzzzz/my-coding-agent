import type { AgentToolResult } from "@my-agent/loop";

/** Wrap plain text as a tool result. */
export function textResult(text: string, details?: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

/** Stop a tool's work when the run was cancelled, without reporting it as a tool failure. */
export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Aborted");
}
