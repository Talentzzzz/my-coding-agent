// 截短的决策半（分层重构 §3）：哪些条目合格被截短。施加半（记录施加到条目上长什么样）住 session
// 包的 view.ts——施加归账本视图；政策常量（`ARG_TRIM_TOOLS` / `ARG_TRIM_THRESHOLD_CHARS`）两个半
// 都要用，住根 types.ts 共享内核（§2.3），本包对 session 零 import（R2）。
import { ARG_TRIM_THRESHOLD_CHARS, ARG_TRIM_TOOLS, type SessionEntry } from "../types.ts";

/**
 * 记录的 tool call 参数会被截短的那些条目。
 *
 * 一个 call 只有在它的 result 已在分支上时才合格：还在等 result 的 call 的参数属于进行中的 turn，
 * 在 turn 中途截短它们会让模型看到一条它不记得发过的 call。result 已记录意味着 turn 已结束，参数
 * 不再是任何人的工作集。
 *
 * 答案是条目 id 而不是重写的条目，因为截短是被记录的，不是在这里应用的：调用方写记录，
 * `buildContextEntries` 截短它指名的内容，与清空的做法相同。更早的记录指名过的条目从视图回来时
 * 已经是短的，所以不再是候选，第二遍无事可做。
 */
export function trimmableToolArgEntryIds(entries: readonly SessionEntry[]): string[] {
	const answered = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "toolResult") {
			answered.add(entry.message.toolCallId);
		}
	}

	const candidates: string[] = [];
	for (const entry of entries) {
		if (hasTrimmableArgs(entry, answered)) candidates.push(entry.id);
	}
	return candidates;
}

/** 一条条目是否持有已被回答的可截短 call。 */
function hasTrimmableArgs(entry: SessionEntry, answered: ReadonlySet<string>): boolean {
	if (entry.type !== "message" || entry.message.role !== "assistant") return false;
	return entry.message.content.some((block) => {
		if (block.type !== "toolCall" || !ARG_TRIM_TOOLS.has(block.name)) return false;
		if (!answered.has(block.id)) return false;
		const args = block.arguments;
		if (typeof args !== "object" || args === null || Array.isArray(args)) return false;
		return Object.values(args).some((value) => typeof value === "string" && value.length > ARG_TRIM_THRESHOLD_CHARS);
	});
}
