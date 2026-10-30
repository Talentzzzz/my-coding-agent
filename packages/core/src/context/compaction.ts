import { type Api, type AssistantMessage, contentText, type Message, type Model, type Usage } from "@my-agent/llm";
import { sessionEntryToContextMessages, type SessionEntry } from "../session/session-manager.ts";

/**
 * Rough token estimate: about four characters per token.
 *
 * The provider reports exact usage after each response, but we need a number before the request to
 * decide whether to compact, and an approximation that is deliberately pessimistic is fine for that.
 */
export function estimateTokens(messages: readonly Message[]): number {
	let characters = 0;
	for (const message of messages) characters += messageCharacters(message);
	return Math.ceil(characters / 4);
}

/**
 * Tokens held back from the model's window when the trigger is computed.
 *
 * The estimate the trigger compares measures the conversation and nothing else: the leading system
 * prompt, the tool declarations, and the response about to be generated are all invisible to it, while
 * the provider counts all three. So the trigger sits this far below the window rather than at it.
 */
const COMPACTION_RESERVE_TOKENS = 33_000;

/**
 * The prompt size at which a session over this model compacts before its next request: `window − 33k`.
 *
 * A window that cannot give up 33k gives up half of itself instead. Without that a small-window model
 * would compute a non-positive trigger, which {@link shouldCompact} reads as "never compact" — the one
 * answer that guarantees the overflow the trigger exists to prevent.
 */
export function compactionThresholdFor(contextWindow: number): number {
	if (!(contextWindow > 0)) return 0;
	const reserve = contextWindow > COMPACTION_RESERVE_TOKENS ? COMPACTION_RESERVE_TOKENS : Math.floor(contextWindow / 2);
	return contextWindow - reserve;
}

/** What one compaction produced, ready to be written with `appendCompaction`. */
export interface CompactionResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** How many messages the summary now stands for. */
	summarized: number;
	usage?: Usage;
}

/** True when the transcript is large enough that the next request risks overflowing the window. */
export function shouldCompact(messages: readonly Message[], threshold: number): boolean {
	if (threshold <= 0) return false;
	return estimateTokens(messages) > threshold;
}

export interface CompactionPreparation {
	firstKeptEntryId: string;
	/** The messages being replaced by the summary, in order. */
	messagesToSummarize: Message[];
	tokensBefore: number;
	/** The summary a previous compaction wrote, when this one refines it rather than starting over. */
	previousSummary?: string;
}

/**
 * Decide what a compaction would summarize, without calling a model.
 *
 * Nothing is kept verbatim: every turn that has finished is folded, and only the turn in flight — the
 * newest turn start and everything after it — survives as messages, because that is what the next
 * request is actually about. The walk starts after the newest compaction, whose summary already stands
 * for everything before it.
 */
export function prepareCompaction(contextEntries: readonly SessionEntry[]): CompactionPreparation | undefined {
	const last = contextEntries[contextEntries.length - 1];
	// A compaction is already the newest thing in context; there is nothing after it to fold in.
	if (last?.type === "compaction") return undefined;

	const boundaryStart = contextEntries[0]?.type === "compaction" ? 1 : 0;
	const previous = boundaryStart === 1 ? contextEntries[0] : undefined;
	const previousSummary = previous?.type === "compaction" ? previous.summary : undefined;

	const cutIndex = findCutPoint(contextEntries, boundaryStart);
	const firstKept = cutIndex === undefined ? undefined : contextEntries[cutIndex];
	if (!firstKept) return undefined;

	const messagesToSummarize = contextEntries.slice(boundaryStart, cutIndex).flatMap(entryMessagesForSummary);
	if (messagesToSummarize.length === 0) return undefined;

	return {
		firstKeptEntryId: firstKept.id,
		messagesToSummarize,
		tokensBefore: estimateTokens(contextEntries.flatMap(sessionEntryToContextMessages)),
		...(previousSummary === undefined ? {} : { previousSummary }),
	};
}

/**
 * The entry index the kept turn starts at, or undefined when there is nothing worth compacting.
 *
 * It is the newest turn start, found by walking back from the newest entry: only a turn start is a
 * candidate, because cutting anywhere else could strand an assistant message from the tool results that
 * answer it — a provider rejects a tool result whose call is missing. A cut that would land on the
 * boundary means everything before it is already a summary, which is the same answer as "no compaction".
 */
function findCutPoint(contextEntries: readonly SessionEntry[], startIndex: number): number | undefined {
	for (let index = contextEntries.length - 1; index > startIndex; index--) {
		const entry = contextEntries[index]!;
		if (entry.type === "compaction") continue;
		if (sessionEntryToContextMessages(entry).some((message) => message.role === "user")) return index;
	}
	return undefined;
}

/** What one entry contributes to a summary: its conversation, with prompt state and checkpoints left out. */
function entryMessagesForSummary(entry: SessionEntry): Message[] {
	if (entry.type === "compaction") return [];
	return sessionEntryToContextMessages(entry).filter((message) => message.role !== "system");
}

/** A completion the session knows how to make; compaction supplies the prompt, not the plumbing. */
export interface SummarizeRequest {
	systemPrompt: string;
	prompt: string;
	maxTokens: number;
	signal?: AbortSignal;
}

export type Summarize = (request: SummarizeRequest) => Promise<AssistantMessage>;

/**
 * Compact the transcript: summarize everything that has finished and report the turn to keep.
 *
 * The summary is generated by the same model the session is using, so it costs one request. Nothing is
 * written here: the caller hands the result to `SessionManager.appendCompaction`, which is what makes
 * the on-disk entry the single record of what happened.
 */
export async function compact(
	contextEntries: readonly SessionEntry[],
	model: Model<Api>,
	complete: Summarize,
	signal?: AbortSignal,
): Promise<CompactionResult | undefined> {
	const preparation = prepareCompaction(contextEntries);
	if (!preparation) return undefined;

	const response = await complete({
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

	// An empty summary is worse than no compaction: the entry would drop the history it stands for and
	// replace it with nothing, so the run is left on the transcript it already had instead.
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
 * The summary budget.
 *
 * pi reserves 16384 tokens for a response and gives the summary 80% of that; the model's own cap wins
 * when it is smaller, because a request over it is rejected outright.
 */
const SUMMARIZATION_RESERVE_TOKENS = 16_384;

function summarizationMaxTokens(model: Model<Api>): number {
	const budget = Math.floor(0.8 * SUMMARIZATION_RESERVE_TOKENS);
	return model.maxTokens > 0 ? Math.min(budget, model.maxTokens) : budget;
}

/**
 * A response that cannot be trusted as a checkpoint.
 *
 * `length` matters as much as `error`: the text is partial, and a truncated summary silently loses the
 * history it claims to stand for. An abort is the same problem from the other side — the text is
 * whatever had streamed before the run ended — so it is refused here too rather than written down.
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

/** Maximum characters of one tool result in a serialized conversation. */
const TOOL_RESULT_MAX_CHARS = 2_000;

/**
 * Write the conversation out as text for the summarizer.
 *
 * The messages are text rather than a live transcript on purpose: the model must summarize what it is
 * shown, not answer it. Tool results are cut down because their full text is not what a summary needs.
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
