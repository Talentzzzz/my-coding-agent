import { join } from "node:path";
// 内容词汇住根 types.ts 共享内核（分层重构 §2.3）；本包对 hooks 与其他子包零 import（R2）。
// 归档的落盘走注入的 ToolResultsRepository 端口（分层重构 §4.3——只写，实例由编排层持有、经参数表
// 递入），本包不再触碰 node:fs。
import type { ToolResultContent } from "../types.ts";
import type { ToolResultsRepository } from "./tool-results-repository.ts";

/**
 * 完整正文离开 context、移入文件的 tool result 大小门槛。
 *
 * 行为良好的工具会自己限流输出（`tools/truncate.ts`，60,000 字符）并尽可能分页，所以超过这条线的
 * result 是一个没被限流的工具的产物。约 20k token：这个大小的一条 result 已占 context window 的
 * 可观份额，比任何单个答案应得的多。刻意高于每个工具自身的预算，所以已被工具限流的 result 永远
 * 碰不到这里。
 */
export const SPILL_RESULT_CHARS = 80_000;

/** 被归档的 result 模型仍能看到的头尾各多少。 */
export const SPILL_KEEP_CHARS = 2_000;

/**
 * 被归档的 result 存放的位置，在工作目录之下：`.my-agent/tool-results/<session id>/`。
 *
 * 目录是 session 自己的项目，所以归档挨着 result 所谈论的文件，离开这个项目的 session 会把归档留在
 * 一个人会去找它的地方。路径的任何部分都不是边界：result 归档在那里只是因为那是对它有用的地方。
 */
const SPILL_DIR_PARTS = [".my-agent", "tool-results"] as const;

/** 一个文件名段，session id、工具名或 call id 都破坏不了它。 */
function safeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** 一条 result 的完整正文该写入的文件，按 session 和 call 命名，视图因此可以日后重建。 */
export function spillPathFor(
	workDirAbsPath: string,
	sessionId: string,
	toolName: string,
	toolCallId: string,
): { absPath: string; relPath: string } {
	const segments = [...SPILL_DIR_PARTS, safeSegment(sessionId), `${safeSegment(toolCallId)}-${safeSegment(toolName)}.txt`];
	return {
		absPath: join(workDirAbsPath, ...segments),
		relPath: segments.join("/"),
	};
}

/** result 的各 text block 的文字，按顺序拼接。图片和其他 block 不在其中。 */
export function spillText(content: ToolResultContent): string {
	return content
		.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** `spillOversizedToolResult` 改为归档而非放行 result 的大小门槛。 */
function oversizedText(content: ToolResultContent): string | undefined {
	let total = 0;
	for (const block of content) {
		if (block.type !== "text") continue;
		total += block.text.length;
	}
	if (total <= SPILL_RESULT_CHARS) return undefined;
	return spillText(content);
}

/**
 * 模型为一条已归档 result 读到的内容：头尾夹着一条指名文件的通知。
 *
 * 非 text 的东西——图片 block——在通知之后原样通过。text 短到头尾会重叠时整体保留：归档里已经
 * 存着它，为了省字符而让视图重复相同文字是荒谬的。
 */
export function spillView(content: ToolResultContent, text: string, relPath: string, keepChars: number): ToolResultContent {
	const notice =
		`\n\n[... the full output was saved to ${relPath}; ` +
		`use the read tool on that file if you need the rest ...]\n\n`;
	if (text.length <= keepChars * 2) {
		return [{ type: "text", text: `${text}${notice}` }, ...content.filter((block) => block.type !== "text")];
	}
	const head = text.slice(0, keepChars);
	const tail = text.slice(text.length - keepChars);
	const omitted = `\n\n[... ${text.length - head.length - tail.length} characters omitted — the full output was saved to ${relPath}; ` +
		`use the read tool on that file if you need the rest ...]\n\n`;
	return [{ type: "text", text: `${head}${omitted}${tail}` }, ...content.filter((block) => block.type !== "text")];
}

/**
 * 归档一条过大的 result，返回模型应看到的视图，否则返回 `undefined`。
 *
 * `undefined` 意味着「不过大」或文件写不出来——调用方回落到 `boundToolContent` 的硬截断，而不是
 * 展示一条指名了不存在文件的通知。路径由 session 和 call id 推导，这让归档在工作目录存在的期间
 * 始终找得到。落盘走注入的 {@link ToolResultsRepository}（只写端口，分层重构 §4.3）。
 */
export function spillOversizedToolResult(
	workDirAbsPath: string,
	sessionId: string,
	toolName: string,
	toolCallId: string,
	content: ToolResultContent,
	toolResults: ToolResultsRepository,
): ToolResultContent | undefined {
	const text = oversizedText(content);
	if (text === undefined) return undefined;

	const { absPath, relPath } = spillPathFor(workDirAbsPath, sessionId, toolName, toolCallId);
	if (!toolResults.writeIfAbsent(absPath, text)) return undefined;
	return spillView(content, text, relPath, SPILL_KEEP_CHARS);
}

/**
 * 把一个工具结果整体归档，并以 `after_tool` 处理器返回的内容作答。
 *
 * 这条接缝现在承载的写侧规则是：**改写即定稿**——账本保存的正是处理器返回的内容，所以要约束一个
 * 结果，全文必须先去别处。这里就是那个别处，一次调用完成：它把结果的文本整体写在工作目录之下
 * （`.my-agent/tool-results/`，与写边界自身兜底相同的路径推导），并以点名该文件的头尾视图作答，
 * 需要其余部分的模型自己去读回来。文件写不下的结果原样返回，而不是「截断+一个不存在的路径」
 * ——写边界仍会约束它。
 *
 * `workDirAbsPath` 由处理器自己提供：hook 事件只点名会话，归档到哪个目录是处理器闭包里的事。
 * 归档端口由编排层递入（构造注入，实例归它持有）。
 *
 * ```ts
 * hooks.on("after_tool", (event) => archiveToolResult(event, workDirAbsPath, toolResults));
 * ```
 */
export function archiveToolResult(
	event: { sessionId: string; toolCallId: string; toolName: string; content: ToolResultContent },
	workDirAbsPath: string,
	toolResults: ToolResultsRepository,
): { content: ToolResultContent } {
	const text = spillText(event.content);
	const { absPath, relPath } = spillPathFor(workDirAbsPath, event.sessionId, event.toolName, event.toolCallId);
	if (!toolResults.writeIfAbsent(absPath, text)) return { content: event.content };
	return { content: spillView(event.content, text, relPath, SPILL_KEEP_CHARS) };
}
