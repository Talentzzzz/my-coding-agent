import type { Message } from "../llm/index.ts";

/**
 * 一个压缩检查点，transcript 携带它的方式。
 *
 * 压缩是顶层 session 条目而不是消息条目，因为这样才找得到：`buildContextEntries` 在分支上找最新的
 * 一个，保留的尾巴从它指名的条目开始。`sessionEntryToContextMessages` 把该条目投影成下面的 user
 * turn——摘要包在表明它是摘要而非用户发言的标签里——这样恢复的 session、活的 session 和 provider
 * 看到的是同一份 transcript。
 */
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

/**
 * user 消息所代表的摘要，普通消息时为 undefined。
 *
 * 压缩检查点在 transcript 里就是一条 user 消息，所以必须区别对待它的调用方——标题派生、分支预览、
 * 窗口的通知渲染——靠标签而不是靠独立的 role 来识别它。
 */
export function compactionSummaryOf(
	message: Message,
): string | undefined {
	if (message.role !== "user") return undefined;
	const first = Array.isArray(message.content) ? message.content[0] : undefined;
	if (first?.type !== "text") return undefined;
	const text = first.text;
	if (!text.startsWith(COMPACTION_SUMMARY_PREFIX) || !text.endsWith(COMPACTION_SUMMARY_SUFFIX)) return undefined;
	return text.slice(COMPACTION_SUMMARY_PREFIX.length, text.length - COMPACTION_SUMMARY_SUFFIX.length);
}
