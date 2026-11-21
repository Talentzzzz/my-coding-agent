// 清空的决策半（2026-11-21 自 context 包并入 session 包，ADR-0031）：哪些 result 可清、缓存是否已
// 过期。施加半（一条条目清空之后长什么样）住同包的 view.ts；被清空的 result 的通知文案
// （`clearedToolResultText`）两个半都要用，住根 types.ts 共享内核（§2.3）。
import { clearedToolResultText, type SessionEntry, type ToolResultMessage } from "../types.ts";

/**
 * 重跑会产出相同输出的那些工具。
 *
 * 来自这些工具的 result 是某个活得比对话久的对象的副本：文件仍在盘上可读，命令仍在那里可跑。丢弃
 * 它的代价只是重跑一次，别无其他。
 *
 * 其余的一切无论多旧都保留，这正是列出这些工具、而不是列出要保护的对象的意义：报告、任务状态、
 * 或任何对话自身产出的答案都无法靠再问一次恢复，丢掉它丢掉的是工作而不是 token。
 * 可重跑的工具必须在这里指名；默认没有任何东西可清除。
 */
export const REFETCHABLE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob", "bash", "edit", "write"]);

/**
 * 会话记录保持不动多久之后，认定 provider 的缓存已失效。
 *
 * 被缓存的 prompt 是 provider 一个字都不用重读的。缓存一旦失效，每条此后没人看过的 result 都要全额
 * 付账才能占据窗口，这正是让丢弃它们成为压缩能做的最便宜的事的原因——它连请求都不用发。
 */
const CACHE_EXPIRY_MS = 60 * 60 * 1000;

/** 一次清空后有多少条最新的可重取 result 存活，无论多旧。 */
const KEPT_TOOL_RESULTS = 5;

/**
 * provider 是否很可能已经丢弃了这个会话记录的缓存。
 *
 * 计时用的是最新的 assistant 消息——最后一次 provider 调用——而不是最新的条目：用户刚输入的消息
 * 只有几秒新，它对之前的 prompt 是否仍被缓存什么也说明不了，从它算起这个判定永远不会触发。
 */
export function isCacheProbablyExpired(entries: readonly SessionEntry[], now: number): boolean {
	let lastCall: number | undefined;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const at = Date.parse(entry.timestamp);
		if (Number.isFinite(at)) lastCall = at;
	}
	return lastCall !== undefined && now - lastCall >= CACHE_EXPIRY_MS;
}

/**
 * 一次清空会掏空哪些 result：除最新的 {@link KEPT_TOOL_RESULTS} 条之外的每条可重取 result。
 *
 * 已经带着通知的 result 不再是候选，这使第二次清空成为 no-op，而不是又一条指名同样条目的记录。
 *
 * 答案是条目 id 而不是重写后的会话记录，因为清空是被记录的，不是在这里应用的：调用方写记录，
 * `buildContextEntries` 清空它指名的内容，恢复的进程由此读到同一个视图，不必重新决定任何事。
 */
export function clearableToolResultIds(entries: readonly SessionEntry[]): string[] {
	const candidates: string[] = [];
	for (const entry of entries) {
		if (refetchableToolName(entry) === undefined) continue;
		if (isCleared(entry)) continue;
		candidates.push(entry.id);
	}
	return candidates.slice(0, Math.max(0, candidates.length - KEPT_TOOL_RESULTS));
}

/** result 所回答的工具，当该工具是 run 能重新产出其输出的工具时。 */
function refetchableToolName(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return undefined;
	// 名字随 result 本身携带，所以 call 已被压缩掉的 result 仍可清除；丢了该字段的文件简单地读作
	// 「不是我们认识的工具」，从而被保留。
	const name: unknown = entry.message.toolName;
	return typeof name === "string" && REFETCHABLE_TOOLS.has(name) ? name : undefined;
}

/**
 * 一条 tool result 是否已经读作被清空，从而清空对它无事可做。
 *
 * 这个检查读的是内容而不是任何关于清空的记录，因为这个问题问的是视图已经应用过清空的条目——
 * 也问的是根本不带清空记录的视图。无论是什么掏空了 result，模型读到的都是通知，而按设计一条通知
 * 和另一条无法区分。
 */
export function isClearedToolResult(message: ToolResultMessage): boolean {
	const content = message.content;
	return (
		content.length === 1 &&
		content[0]?.type === "text" &&
		content[0].text === clearedToolResultText(message.toolName)
	);
}

/** 一条条目是否已经读作被清空，从而清空对它无事可做。 */
function isCleared(entry: SessionEntry): boolean {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return false;
	return isClearedToolResult(entry.message);
}
