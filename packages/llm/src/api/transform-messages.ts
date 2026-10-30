// Vendored from @earendil-works/pi-ai (0.99.2). Trimmed for this repo — see `transformMessages`
// for what came out and why. Re-vendoring from upstream means reapplying that trim.
// Checked by packages/llm/tsconfig.json under pi's own compiler settings; @ts-nocheck keeps the
// workspace's stricter root config from flagging this file, while every import into packages/core
// stays fully checked.
// @ts-nocheck
import type { Model } from "../model.ts";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

/**
 * Make a stored transcript replayable over `anthropic-messages`.
 *
 * A session file is an append-only log, so it carries two things the wire rejects: an assistant
 * turn that ended in `error`/`aborted`, and a tool call nothing answered. Both are normal here — a
 * run killed between the call and its results, a branch moved onto a call, an imported history —
 * and Anthropic refuses a half turn or a `tool_use` without its `tool_result`, so neither is sent.
 *
 * Trimmed against upstream, because this app drives the one API and every model row goes over it:
 *
 * - Tool-call id normalization is gone, with the ledger that kept rewritten calls and their results
 *   in sync. It existed for providers that mint ids Anthropic's `^[a-zA-Z0-9_-]{1,64}$` rejects;
 *   this wire mints `toolu_…`, and the four vendor APIs that still pass a normalizer are never
 *   routed. `_normalizeToolCallId` is kept only so their call sites still read as written.
 * - The provider-owned metadata field `thoughtSignature` is no longer pruned
 *   for cross-model replay. It is not produced over this wire, so there is nothing to prune.
 * - A mid-conversation system message is no longer held back until its tool results arrive. It
 *   cannot land inside a tool turn here: every request is rebuilt as one leading system message
 *   plus the non-system messages, as `Agent.prepareRequest` documents.
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	_normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// Normalize null/undefined content from untyped callers (custom tools, hand-built
	// histories, old session files) so downstream code can rely on the type contract.
	const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
	const transformed = downgradeUnsupportedImages(normalizedMessages, model);

	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();

	/** Answer every call still waiting. */
	const closePendingToolCalls = () => {
		if (pendingToolCalls.length === 0) return;
		for (const tc of pendingToolCalls) {
			if (existingToolResultIds.has(tc.id)) continue;
			result.push({
				role: "toolResult",
				toolCallId: tc.id,
				toolName: tc.name,
				content: [{ type: "text", text: "No result provided" }],
				isError: true,
				timestamp: Date.now(),
			} as ToolResultMessage);
		}
		pendingToolCalls = [];
		existingToolResultIds = new Set();
	};

	for (const msg of transformed) {
		if (msg.role === "assistant") {
			// Whatever this turn says, it ends the one before it, so close that one first.
			closePendingToolCalls();

			// An errored or aborted assistant message is an incomplete turn: partial content, and
			// possibly tool calls that never ran. Replaying it can only earn an API error, so the
			// model retries from the last valid state instead.
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") continue;

			// Track the calls this turn is now waiting on.
			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "user") {
			// A new user turn interrupts tool flow.
			closePendingToolCalls();
			result.push(msg);
		} else {
			// The leading system message is the system prompt and stays first: the caller reads it
			// with `getInitialSystemMessage` and drops it with `slice(1)`.
			result.push(msg);
		}
	}

	// A conversation that ends on unresolved tool calls gets their results now.
	closePendingToolCalls();

	return result;
}
