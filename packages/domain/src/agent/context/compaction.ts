// 压缩的算法半（分层重构 §3）：触发计算、候选选择、token 估算与摘要产出。编排半（触发序列、记账、
// 发事件）留在 `Agent.compactFor`（agent.ts）。对 session 子包零 import（R2）——条目投影经 `project`
// 参数注入，由 Agent 递入 `sessionEntryToContextMessages`；条目与消息词汇住根 types.ts 共享内核。
import { contentText, type Api, type AssistantMessage, type Message, type Model, type SessionEntry } from "../types.ts";
import type { CompactionPreparation, CompactionResult, Summarize } from "./types.ts";

/** 条目投影：一条条目 → 模型看到的消息。调用方注入（`sessionEntryToContextMessages`），包内不认 session。 */
type Project = (entry: SessionEntry) => Message[];

/**
 * 粗略 token 估算：约四个字符一个 token。
 *
 * provider 在每次响应后报告精确 usage，但我们在请求之前就需要一个数字来决定是否压缩，对那个用途
 * 来说，一个刻意悲观的近似就够了。
 */
export function estimateTokens(messages: readonly Message[]): number {
	let characters = 0;
	for (const message of messages) characters += messageCharacters(message);
	return Math.ceil(characters / 4);
}

/**
 * 计算触发条件时从模型窗口扣回的 token 数。
 *
 * 触发条件比较的估算只量对话本身：开头的 system prompt、工具声明、即将生成的回答都对它不可见，
 * 而 provider 三者都算。所以触发点设在窗口之下这么远处，而不是贴着窗口。
 */
const COMPACTION_RESERVE_TOKENS = 33_000;

/**
 * 这个模型上的 session 在下一次请求之前触发压缩的 prompt 大小：`window − 33k`。
 *
 * 拿不出 33k 的窗口改为放弃自己的一半。否则小窗口模型会算出一个非正的触发点，{@link shouldCompact}
 * 把它读作「永不压缩」——这恰恰是保证触发条件要防止的溢出的唯一答案。
 */
export function compactionThresholdFor(contextWindow: number): number {
	if (!(contextWindow > 0)) return 0;
	const reserve = contextWindow > COMPACTION_RESERVE_TOKENS ? COMPACTION_RESERVE_TOKENS : Math.floor(contextWindow / 2);
	return contextWindow - reserve;
}

/** 会话记录大到下一次请求有溢出窗口的风险时为 true。 */
export function shouldCompact(messages: readonly Message[], threshold: number): boolean {
	if (threshold <= 0) return false;
	return estimateTokens(messages) > threshold;
}

/**
 * 决定一次压缩会摘要什么，不调用模型。
 *
 * 没有任何东西被原样保留：每个已结束的 turn 都被折叠，只有进行中的 turn——最新的 turn 起点及其
 * 之后的一切——以消息形式存活，因为那才是下一次请求真正关于的内容。遍历从最新的压缩之后开始，
 * 它的摘要已经代表之前的一切。
 */
export function prepareCompaction(contextEntries: readonly SessionEntry[], project: Project): CompactionPreparation | undefined {
	const last = contextEntries[contextEntries.length - 1];
	// 压缩已经是 context 里最新的东西；它之后没有可以折入的。
	if (last?.type === "compaction") return undefined;

	const boundaryStart = contextEntries[0]?.type === "compaction" ? 1 : 0;
	const previous = boundaryStart === 1 ? contextEntries[0] : undefined;
	const previousSummary = previous?.type === "compaction" ? previous.summary : undefined;

	const cutIndex = findCutPoint(contextEntries, boundaryStart, project);
	const firstKept = cutIndex === undefined ? undefined : contextEntries[cutIndex];
	if (!firstKept) return undefined;

	const messagesToSummarize = contextEntries.slice(boundaryStart, cutIndex).flatMap((entry) => entryMessagesForSummary(entry, project));
	if (messagesToSummarize.length === 0) return undefined;

	return {
		firstKeptEntryId: firstKept.id,
		messagesToSummarize,
		tokensBefore: estimateTokens(contextEntries.flatMap(project)),
		...(previousSummary === undefined ? {} : { previousSummary }),
	};
}

/**
 * 保留的 turn 开始处的条目下标，没有值得压缩的东西时为 undefined。
 *
 * 它是最新的 turn 起点，从最新条目往回走找到：只有 turn 起点是候选，因为在别处切可能把 assistant
 * 消息和回答它的 tool result 拆开——provider 会拒绝 call 缺失的 tool result。落在边界上的切点意味
 * 着之前的一切已经是摘要，与「不压缩」是同一个答案。
 */
function findCutPoint(contextEntries: readonly SessionEntry[], startIndex: number, project: Project): number | undefined {
	for (let index = contextEntries.length - 1; index > startIndex; index--) {
		const entry = contextEntries[index]!;
		if (entry.type === "compaction") continue;
		if (project(entry).some((message) => message.role === "user")) return index;
	}
	return undefined;
}

/** 一条条目为摘要贡献的内容：它的对话部分，prompt 状态和检查点除外。 */
function entryMessagesForSummary(entry: SessionEntry, project: Project): Message[] {
	if (entry.type === "compaction") return [];
	return project(entry).filter((message) => message.role !== "system");
}

/**
 * 压缩会话记录：摘要一切已结束的内容，报告要保留的 turn。
 *
 * 摘要由 session 正在用的同一个模型生成，所以代价是一次请求。这里什么都不写：调用方把结果交给
 * `SessionManager.appendCompaction`，这让盘上的条目成为所发生之事的唯一记录。
 */
export async function compact(
	contextEntries: readonly SessionEntry[],
	project: Project,
	model: Model<Api>,
	summarize: Summarize,
	signal?: AbortSignal,
): Promise<CompactionResult | undefined> {
	const preparation = prepareCompaction(contextEntries, project);
	if (!preparation) return undefined;

	const response = await summarize({
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		prompt: summarizationPrompt(preparation),
		maxTokens: summarizationMaxTokens(model),
		...(signal === undefined ? {} : { signal }),
	});

	const failure = summarizationFailure(response);
	if (failure) throw new Error(failure);
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Summarization attempted to call a tool");
	}

	// 空摘要比不压缩更糟：条目会丢掉它所代表的历史、换回一个空，所以 run 留在它已有的会话记录
	// 上。
	const summary = contentText(response.content);
	if (summary.trim().length === 0) throw new Error("Summarization returned an empty summary");

	return {
		summary,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		summarized: preparation.messagesToSummarize.length,
		usage: response.usage,
	};
}

/**
 * 摘要的预算。
 *
 * pi 为一次响应保留 16384 token，摘要分得其中 80%；模型自己的上限更小时以它为准，因为超过它的
 * 请求会被直接拒绝。
 */
const SUMMARIZATION_RESERVE_TOKENS = 16_384;

function summarizationMaxTokens(model: Model<Api>): number {
	const budget = Math.floor(0.8 * SUMMARIZATION_RESERVE_TOKENS);
	return model.maxTokens > 0 ? Math.min(budget, model.maxTokens) : budget;
}

/**
 * 不能作为检查点信任的响应。
 *
 * `length` 和 `error` 同等重要：文字是不完整的，被截断的摘要无声地丢失它声称代表的历史。abort 是
 * 同一问题的另一面——文字只是 run 结束前流出来的部分——所以同样在这里拒绝而不是写下来。
 */
function summarizationFailure(response: AssistantMessage): string | undefined {
	if (response.stopReason === "error") return `Summarization failed: ${response.errorMessage || "Unknown error"}`;
	if (response.stopReason === "length") return "Summarization failed: generation hit the token cap and the summary is incomplete";
	if (response.stopReason === "aborted") return "Summarization aborted";
	return undefined;
}

function summarizationPrompt(preparation: CompactionPreparation): string {
	const conversation = serializeConversation(preparation.messagesToSummarize);
	let prompt = `<conversation>\n${conversation}\n</conversation>\n\n`;
	if (preparation.previousSummary !== undefined) {
		prompt += `<previous-summary>\n${preparation.previousSummary}\n</previous-summary>\n\n`;
	}
	return prompt + (preparation.previousSummary === undefined ? SUMMARIZATION_PROMPT : UPDATE_SUMMARIZATION_PROMPT);
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** 一条 tool result 在序列化对话中的最大字符数。 */
const TOOL_RESULT_MAX_CHARS = 2_000;

/**
 * 把对话写成文本交给摘要器。
 *
 * 消息刻意是文本而不是活的会话记录：模型必须摘要它被展示的东西，而不是回答它。tool result 被
 * 截短，因为摘要需要的不是它们的完整正文。
 */
function serializeConversation(messages: readonly Message[]): string {
	const parts: string[] = [];

	for (const message of messages) {
		if (message.role === "user") {
			const text = contentText(message.content, "");
			if (text) parts.push(`[User]: ${text}`);
			continue;
		}
		if (message.role === "assistant") {
			const thinking: string[] = [];
			const toolCalls: string[] = [];
			for (const block of message.content) {
				if (block.type === "thinking") thinking.push(block.thinking);
				else if (block.type === "toolCall") {
					const args = Object.entries(block.arguments as Record<string, unknown>)
						.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${args})`);
				}
			}
			if (thinking.length > 0) parts.push(`[Assistant thinking]: ${thinking.join("\n")}`);
			if (message.content.some((block) => block.type === "text")) parts.push(`[Assistant]: ${contentText(message.content)}`);
			if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			continue;
		}
		if (message.role === "toolResult") {
			const text = contentText(message.content, "");
			if (text) parts.push(`[Tool result]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`);
		}
	}

	return parts.join("\n\n");
}

function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

function messageCharacters(message: Message): number {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;

	let total = 0;
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const typed = block as { text?: unknown; thinking?: unknown; arguments?: unknown };
		if (typeof typed.text === "string") total += typed.text.length;
		if (typeof typed.thinking === "string") total += typed.thinking.length;
		if (typed.arguments !== undefined) total += JSON.stringify(typed.arguments).length;
	}
	return total;
}
