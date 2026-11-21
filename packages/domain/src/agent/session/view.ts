// 账本视图的施加半（分层重构 §3，自 context 两文件拆来；2026-11-21 决策半自 context 包并入同包，
// ADR-0031）：截短与清空是「记录的施加」——记录指名条目，`buildContextEntries`（session-manager.ts）
// 在这里施加它们，恢复的进程由此读到同一个视图。本文件只回答「一条条目施加之后长什么样」；决策半
// （哪些条目合格）住同包的 trim-tool-call-args.ts / clear-tool-results.ts，两者经账本里的记录说话。
// 政策常量（`ARG_TRIM_TOOLS` 等）与通知文案住根 types.ts 共享内核（§2.3），两个半都从它取。
import { ARG_TRIM_THRESHOLD_CHARS, ARG_TRIM_TOOLS, clearedToolResultText, type SessionEntry } from "../types.ts";

/** 被截短的参数在开头保留多少：足以说明写了什么、写到哪。 */
export const ARG_KEEP_CHARS = 200;

/** 被截短的参数以什么结尾，让切断可见而不是无声。 */
export const ARG_TRIM_MARKER = "... [truncated] ...";

/** 同一条目但记录的 tool call 参数被截短，或条目原样返回。 */
export function trimToolCallArgs(entry: SessionEntry): SessionEntry {
	if (entry.type !== "message" || entry.message.role !== "assistant") return entry;

	let changed = false;
	const content = entry.message.content.map((block) => {
		if (block.type !== "toolCall" || !ARG_TRIM_TOOLS.has(block.name)) return block;
		const args = block.arguments;
		if (typeof args !== "object" || args === null || Array.isArray(args)) return block;

		let argsChanged = false;
		const trimmed: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(args)) {
			if (typeof value === "string" && value.length > ARG_TRIM_THRESHOLD_CHARS) {
				trimmed[key] = `${value.slice(0, ARG_KEEP_CHARS)}${ARG_TRIM_MARKER}`;
				argsChanged = true;
			} else {
				trimmed[key] = value;
			}
		}
		if (!argsChanged) return block;
		changed = true;
		// 保留的值是 call 原有的 JsonObject，被替换的那个是字符串，所以记录整体仍然是 JSON；这个
		// 类型标注只是重申 block 的形状。
		return { ...block, arguments: trimmed as typeof block.arguments };
	});

	return changed ? { ...entry, message: { ...entry.message, content } } : entry;
}

/** 同一条目但 result 正文被替换。图片和其他 block 一起被替换：它们同样是可重取的。 */
export function clearToolResult(entry: SessionEntry): SessionEntry {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return entry;
	return {
		...entry,
		message: { ...entry.message, content: [{ type: "text", text: clearedToolResultText(entry.message.toolName) }] },
	};
}
