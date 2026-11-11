import type { SessionEntry } from "../session/session-manager.ts";

/**
 * 记录参数庞大、事后无人再读的那些工具。
 *
 * `write` 和 `edit` 携带变更的完整正文——`content` 里是整个文件，`old_string` / `new_string` 里是
 * 整个区域。call 一旦跑过，那份正文就被存了两遍：一遍在参数里，一遍在盘上的文件里。参数是每次
 * 请求都发给模型的东西，模型可能想从中找回的——路径、变更的形状——截短后依然存活；正文本身归
 * 文件保管。工具必须在这里指名，如同 `pruning.ts`：默认没有任何东西可截短。
 */
export const ARG_TRIM_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

/** 超过这个长度的字符串参数是正文而不是引用，是截短的候选。 */
export const ARG_TRIM_THRESHOLD_CHARS = 2_000;

/** 被截短的参数在开头保留多少：足以说明写了什么、写到哪。 */
export const ARG_KEEP_CHARS = 200;

/** 被截短的参数以什么结尾，让切断可见而不是无声。 */
export const ARG_TRIM_MARKER = "... [truncated] ...";

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
