// 从 pi-ai（0.99.2）vendor 而来，按本仓库裁剪——裁掉了什么、为什么见 `transformMessages`。
// 从上游重新 vendor 意味着重新应用这些裁剪。
// @ts-nocheck 让仓库根目录更严格的配置放过本文件，而进入 packages/core 的每次 import 仍然被
// 完整检查。
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
 * 让一份存储的会话记录可以经 `anthropic-messages` 重放。
 *
 * session 文件是 append-only 日志，所以它带着两样 wire 会拒绝的东西：以 `error`/`aborted` 结束的
 * assistant turn，以及没有任何东西回答的 tool call。两者在这里都属正常——run 在 call 和 result
 * 之间被杀、分支移到某个 call 上、导入的历史——而 Anthropic 拒绝半个 turn 或缺 `tool_result` 的
 * `tool_use`，所以两者都不发送。
 *
 * 相对上游的裁剪，因为本应用只驱动这一个 API、每个模型行都走它：
 *
 * - tool call id 归一化连同保持被重写 call 与其 result 同步的账本一起删除。它服务于那些铸造
 *   Anthropic 的 `^[a-zA-Z0-9_-]{1,64}$` 所拒绝的 id 的 provider；这条 wire 铸的是 `toolu_…`，
 *   而仍然传入 normalizer 的那四个 vendor API 从不被路由。`_normalizeToolCallId` 保留只是让它们的
 *   调用点读起来仍如原样。
 * - provider 专属的元数据字段 `thoughtSignature` 不再为跨模型重放而修剪。这条 wire 不产出它，
 *   所以没有东西可修剪。
 * - 对话中段的 system 消息不再被扣住等它的 tool result 到齐。它在这里不可能落进一个 tool turn：
 *   每个请求都被重建为一条开头的 system 消息加上非 system 消息，如 `Agent.prepareRequest` 所述。
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	_normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// 归一化无类型调用方（自定义工具、手搭的历史、旧 session 文件）传来的 null/undefined content，
	// 让下游代码可以依赖类型契约。
	const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
	const transformed = downgradeUnsupportedImages(normalizedMessages, model);

	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();

	/** 回答每一个仍在等待的 call。 */
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
			// 无论这个 turn 说什么，它都结束了前一个，所以先收掉前一个。
			closePendingToolCalls();

			// 一条 error/aborted 的 assistant 消息是一个不完整的 turn：内容残缺，还可能带着从未
			// 运行的 tool call。重放它只会换来一次 API 错误，所以模型改为从最后一个有效状态重试。
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") continue;

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
			// 新的 user turn 打断 tool 流。
			closePendingToolCalls();
			result.push(msg);
		} else {
			// 开头的 system 消息就是 system prompt，保持第一：调用方用 `getInitialSystemMessage`
			// 读它、用 `slice(1)` 丢掉它。
			result.push(msg);
		}
	}

	// 以未决 tool call 结尾的对话在此刻得到它们的 result。
	closePendingToolCalls();

	return result;
}
