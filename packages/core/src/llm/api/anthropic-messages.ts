// 从 pi-ai（0.99.2）vendor 而来。@ts-nocheck 让仓库根目录更严格的配置放过本文件，而进入
// packages/core 的每次 import 仍然被完整检查。
// @ts-nocheck
import Anthropic from "@anthropic-ai/sdk";
import type {
	BetaStopReason,
	BetaTool,
	BetaCacheControlEphemeral as CacheControlEphemeral,
	BetaContentBlockParam as ContentBlockParam,
	MessageCreateParamsStreaming,
	BetaMessageParam as MessageParam,
	BetaRawMessageStreamEvent as RawMessageStreamEvent,
	BetaRefusalStopDetails as RefusalStopDetails,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { Model } from "../model.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	ChatTransport,
	ImageContent,
	Message,
	ThinkingLevel,
	ProviderHeaders,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	Context,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText } from "../utils/text.ts";
import { getInitialSystemMessage } from "../utils/transcript.ts";

import {
	getJsonSchemaToolParameters,
	resolveJsonSchemaStrictSampling,
	type UnsupportedStrictSchemaKeywordCheck,
} from "./constrained-sampling.ts";
import { buildBaseOptions } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

/**
 * 本次请求的 prompt-cache 寿命。
 *
 * pi-ai 在这里读一个环境变量做向后兼容。本构建不这样做：cache retention 只由调用方决定
 * （会话记录把它钉死），所以请求之外的任何东西都不能决定它。
 */
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	return cacheRetention ?? "short";
}

function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
	const retention = resolveCacheRetention(cacheRetention);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// 只有 text block 时拼成字符串返回，图省事且对端点等价。
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

/**
 * 这条 wire 接受的 effort。
 *
 * 这里四个、本应用三个：`medium` 是端点认识但应用不提供的值，所以从不发出。它留在类型里是因为
 * 类型描述的是端点。
 */
export type AnthropicEffort = "low" | "medium" | "high" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";

function getAnthropicCompat(model: Model<"anthropic-messages">) {
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? true,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
		supportsStrictTools: model.compat?.supportsStrictTools ?? false,
	};
}

export interface AnthropicOptions extends StreamOptions {
	/**
	 * 控制思考内容在 API 响应中的返回方式。
	 * - "summarized"：thinking block 带摘要后的思考文本。
	 * - "omitted"：thinking block 返回空 thinking 字段；加密签名仍会传回以维持多轮连续性。
	 *   当 UI 不展示 thinking 时用它换取更快的首文本 token。
	 *
	 * 注意：Anthropic 对 Claude Opus 4.7 和 Claude Mythos Preview 的 API 默认是 "omitted"。这里
	 * 默认 "summarized" 以保持与旧 Claude 4 模型一致的行为。要改用就显式设为 "omitted"。
	 * 默认：thinking 开启时为 "summarized"。
	 *
	 * 这个开关和强度都不是选项：它们从模型读取（`Model.thinkingLevel`），所以一次请求不可能对
	 * 「模型被要求多用力想」携带两个答案。
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	/**
	 * Anthropic 的 tool choice 行为。字符串值映射到 Anthropic 内置选择；`{ type: "tool", name }`
	 * 强制指定某个工具。
	 * 默认：省略（Anthropic 默认行为，当前等价于 auto）。
	 */
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
}

function mergeHeaders(...headerSources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	const merged: ProviderHeaders = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

function mergeClientHeaders(...headerSources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	return mergeHeaders({ "User-Agent": getPiUserAgent() }, ...headerSources);
}

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

/**
 * 请求用来认证的 key。
 *
 * 模型作为回落被读取，因为这里的模型自带 key（`Model.apiKey`）而不经由凭据 store：一行*就是*
 * 端点加 key，指名端点的模型已经指名了凭据。显式的 `options.apiKey` 盖过它——这是 loop 把从模型
 * 上取下的 key 传下来的方式，也是持有每模型同一把 key 的 host 覆盖某一行的方式。空字符串算缺席，
 * 所以没有 key 的行仍能到达 header 式认证。
 */
function resolveApiKey(
	model: Model<"anthropic-messages">,
	options?: StreamOptions | SimpleStreamOptions,
): string | undefined {
	return options?.apiKey || model.apiKey || undefined;
}

/**
 * 没有 key 可认证时在请求之前失败。
 *
 * key 也可能由 header 在带内提供，这是到达自行注入凭据的网关的方式。错误消息指名端点而不是
 * provider id：这里的模型是用户输入的一个端点，URL 是人唯一能对它采取行动的部分。
 */
function assertRequestAuth(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
	headers: ProviderHeaders | undefined,
): void {
	if (apiKey) return;
	if (
		hasHeader(headers, "authorization") ||
		hasHeader(headers, "x-api-key") ||
		hasHeader(headers, "cf-aig-authorization")
	) {
		return;
	}
	throw new Error(`No API key for ${model.baseUrl}`);
}

interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	if (!state.event && state.data.length === 0) {
		return null;
	}

	const event: ServerSentEvent = {
		event: state.event,
		data: state.data.join("\n"),
		raw: [...state.raw],
	};
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}

function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	if (line === "") {
		return flushSseEvent(state);
	}

	state.raw.push(line);
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

function nextLineBreakIndex(text: string): number {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) {
		return newlineIndex;
	}
	if (newlineIndex === -1) {
		return carriageReturnIndex;
	}
	return Math.min(carriageReturnIndex, newlineIndex);
}

function consumeLine(text: string): { line: string; rest: string } | null {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) {
		return null;
	}

	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		nextIndex += 1;
	}

	return {
		line: text.slice(0, lineBreakIndex),
		rest: text.slice(nextIndex),
	};
}

async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			let consumed = consumeLine(buffer);
			while (consumed) {
				buffer = consumed.rest;
				const event = decodeSseLine(consumed.line, state);
				if (event) {
					yield event;
				}
				consumed = consumeLine(buffer);
			}
		}

		buffer += decoder.decode();
		let consumed = consumeLine(buffer);
		while (consumed) {
			buffer = consumed.rest;
			const event = decodeSseLine(consumed.line, state);
			if (event) {
				yield event;
			}
			consumed = consumeLine(buffer);
		}

		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) {
				yield event;
			}
		}

		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) {
			yield trailingEvent;
		}
	} finally {
		reader.releaseLock();
	}
}

async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
	if (!response.body) {
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	let sawMessageStart = false;
	let sawMessageEnd = false;

	for await (const sse of iterateSseMessages(response.body, signal)) {
		if (sse.event === "error") {
			throw new Error(sse.data);
		}

		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		try {
			const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
			if (event.type === "message_start") {
				sawMessageStart = true;
			} else if (event.type === "message_stop") {
				sawMessageEnd = true;
			}
			yield event;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
			);
		}
	}

	if (sawMessageStart && !sawMessageEnd) {
		throw new Error("Anthropic stream ended before message_stop");
	}
}

/**
 * host 调用的唯一入口。
 *
 * 请求认证在这里检查，让缺 key 在流存在之前同步失败；流一旦返回，所有失败都作为事件经它传递。
 * `buildBaseOptions` 把 `max_tokens` 收窄到 context 剩下的空间。
 */
export const stream: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = resolveApiKey(model, options);
	assertRequestAuth(model, apiKey, options?.headers);
	// 这里不再做任何翻译。thinking level 搭在模型上，effort 就在端点所在的地方读取：一个对象同时
	// 说明哪个端点回答、它多用力地想。
	const request: AnthropicOptions = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	};
	const assistantMessageEventStream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const anthropic = createClient(model, apiKey, request.headers, request.fetch);
			let params = buildParams(model, context, request);
			const nextParams = await request.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = { ...(nextParams as MessageCreateParamsStreaming), stream: true };
			}
			const requestOptions = {
				...(request.signal ? { signal: request.signal } : {}),
				...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}),
				maxRetries: 0,
			};
			const response = await retryProviderRequest(
				() => anthropic.beta.messages.create(params, requestOptions).asResponse(),
				{
					maxRetries: request.maxRetries,
					maxRetryDelayMs: request.maxRetryDelayMs,
					signal: request.signal,
				},
			);
			await request.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			assistantMessageEventStream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
			const blocks = output.content as Block[];

			for await (const event of iterateAnthropicEvents(response, request.signal)) {
				await request.onProviderStreamEvent?.(event, model);
				if (event.type === "message_start") {
					output.responseId = event.message.id;
					const responseModel = event.message.model;
					if (responseModel !== model.id) output.responseModel = responseModel;
					// 从 message_start 事件捕获初始 token usage：这样即使流被提前 abort，输入 token
					// 计数也已经到手。
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
					output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
					output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
					// Anthropic 不提供 total_tokens，从各分量计算。
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						const block: Block = {
							type: "text",
							text: event.content_block.text ?? "",
							index: event.index,
						};
						output.content.push(block);
						assistantMessageEventStream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						const block: Block = {
							type: "thinking",
							thinking: event.content_block.thinking ?? "",
							thinkingSignature: event.content_block.signature ?? "",
							index: event.index,
						};
						output.content.push(block);
						assistantMessageEventStream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "redacted_thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "[Reasoning redacted]",
							thinkingSignature: event.content_block.data,
							redacted: true,
							index: event.index,
						};
						output.content.push(block);
						assistantMessageEventStream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						const block: Block = {
							type: "toolCall",
							id: event.content_block.id,
							name: event.content_block.name,
							arguments: (event.content_block.input as Record<string, any>) ?? {},
							partialJson: "",
							index: event.index,
						};
						output.content.push(block);
						assistantMessageEventStream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
				} else if (event.type === "content_block_delta") {
					if (event.delta.type === "text_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "text") {
							block.text += event.delta.text;
							assistantMessageEventStream.push({
								type: "text_delta",
								contentIndex: index,
								delta: event.delta.text,
								partial: output,
							});
						}
					} else if (event.delta.type === "thinking_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinking += event.delta.thinking;
							assistantMessageEventStream.push({
								type: "thinking_delta",
								contentIndex: index,
								delta: event.delta.thinking,
								partial: output,
							});
						}
					} else if (event.delta.type === "input_json_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "toolCall") {
							block.partialJson += event.delta.partial_json;
							block.arguments = parseStreamingJson(block.partialJson);
							assistantMessageEventStream.push({
								type: "toolcall_delta",
								contentIndex: index,
								delta: event.delta.partial_json,
								partial: output,
							});
						}
					} else if (event.delta.type === "signature_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinkingSignature = block.thinkingSignature || "";
							block.thinkingSignature += event.delta.signature;
						}
					}
				} else if (event.type === "content_block_stop") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (block) {
						delete (block as any).index;
						if (block.type === "text") {
							assistantMessageEventStream.push({
								type: "text_end",
								contentIndex: index,
								content: block.text,
								partial: output,
							});
						} else if (block.type === "thinking") {
							assistantMessageEventStream.push({
								type: "thinking_end",
								contentIndex: index,
								content: block.thinking,
								partial: output,
							});
						} else if (block.type === "toolCall") {
							block.arguments = parseStreamingJson(block.partialJson);
							// 原地收尾并剥掉暂存缓冲，让重放只携带已解析的参数。
							delete (block as { partialJson?: string }).partialJson;
							assistantMessageEventStream.push({
								type: "toolcall_end",
								contentIndex: index,
								toolCall: block,
								partial: output,
							});
						}
					}
				} else if (event.type === "message_delta") {
					if (event.delta.stop_reason) {
						output.rawStopReason = event.delta.stop_reason;
						const stopReasonResult = mapStopReason(event.delta.stop_reason, event.delta.stop_details);
						output.stopReason = stopReasonResult.stopReason;
						if (stopReasonResult.errorMessage) {
							output.errorMessage = stopReasonResult.errorMessage;
						}
					}
					// 只在字段存在（非 null）时更新 usage：代理在 message_delta 里省略 input_tokens
					// 时，保住 message_start 报的那份。
					if (event.usage) {
						if (event.usage.input_tokens != null) {
							output.usage.input = event.usage.input_tokens;
						}
						if (event.usage.output_tokens != null) {
							output.usage.output = event.usage.output_tokens;
						}
						if (event.usage.cache_read_input_tokens != null) {
							output.usage.cacheRead = event.usage.cache_read_input_tokens;
						}
						if (event.usage.cache_creation_input_tokens != null) {
							output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
						}
						// Vercel AI Gateway 会在 delta 里带 TTL 拆分，虽然 SDK 只在 message_start 上
						// 类型化了它。
						const cacheCreation = (
							event.usage as typeof event.usage & { cache_creation?: { ephemeral_1h_input_tokens?: number } }
						).cache_creation;
						if (cacheCreation?.ephemeral_1h_input_tokens != null) {
							output.usage.cacheWrite1h = cacheCreation.ephemeral_1h_input_tokens;
						}
						// Anthropic 把推理 token 报告为 output token 的子集。
						const thinkingTokens = event.usage.output_tokens_details?.thinking_tokens;
						if (thinkingTokens != null) {
							output.usage.reasoning = thinkingTokens;
						}
					}
					// Anthropic 不提供 total_tokens，从各分量计算。
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
				}
			}

			if (request.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("Anthropic stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			assistantMessageEventStream.push({ type: "done", reason: output.stopReason, message: output });
			assistantMessageEventStream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// partialJson 只是流式期间的暂存缓冲；绝不持久化它。
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = request.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			assistantMessageEventStream.push({ type: "error", reason: output.stopReason, error: output });
			assistantMessageEventStream.end();
		}
	})();

	return assistantMessageEventStream;
};

function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
): Anthropic {
	const defaultHeaders = mergeClientHeaders(
		{
			accept: "application/json",
			"anthropic-dangerous-direct-browser-access": "true",
		},
		model.headers,
		optionsHeaders,
	);
	const anthropic = new Anthropic({
		apiKey: apiKey ?? null,
		authToken: null,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders,
	});

	return anthropic;
}

function getBetaFeatures(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): NonNullable<MessageCreateParamsStreaming["betas"]> {
	let configuredFeatures: string | null | undefined;
	for (const headers of [model.headers, options?.headers]) {
		for (const [name, value] of Object.entries(headers ?? {})) {
			if (name.toLowerCase() === "anthropic-beta") configuredFeatures = value;
		}
	}
	if (configuredFeatures === null) return [];
	if (configuredFeatures !== undefined) {
		return [
			...new Set(
				configuredFeatures
					.split(",")
					.map((feature) => feature.trim())
					.filter((feature) => feature.length > 0),
			),
		];
	}

	const features: NonNullable<MessageCreateParamsStreaming["betas"]> = [];
	if (shouldUseFineGrainedToolStreamingBeta(model, context)) features.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	return [...new Set(features)];
}

function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): MessageCreateParamsStreaming {
	const { cacheControl } = getCacheControl(model, options?.cacheRetention, options?.env);
	const compat = getAnthropicCompat(model);
	const initialSystemMessage = context.system ?? getInitialSystemMessage(context.messages);
	const initialSystemText = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	const conversationMessages = initialSystemMessage ? transformedMessages.slice(1) : transformedMessages;
	const messages = convertMessages(conversationMessages, cacheControl, compat.allowEmptySignature);
	const betaFeatures = getBetaFeatures(model, context, options);
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages,
		max_tokens: options?.maxTokens ?? model.maxTokens,
		stream: true,
		...(betaFeatures.length > 0 ? { betas: betaFeatures } : {}),
	};

	if (initialSystemText) {
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(initialSystemText),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	// 模型被请求的 level。缺席与 "off" 是同一个请求：没有要求任何东西。
	const level: ThinkingLevel = model.thinkingLevel ?? "off";

	// temperature 与 extended thinking 不兼容，且 Claude Opus 4.7+ 不支持。
	if (options?.temperature !== undefined && level === "off" && compat.supportsTemperature) {
		params.temperature = options.temperature;
	}

	const toolCacheControl = compat.supportsCacheControlOnTools ? cacheControl : undefined;
	// 每次请求都携带完整的当前工具列表，所以 session 中途开启的工具在下一次请求就到达模型，
	// 不需要在会话记录里记录任何东西。
	const tools = context.tools;
	if (tools.length > 0) {
		params.tools = convertTools(
			tools,
			compat.supportsEagerToolInputStreaming,
			compat.supportsStrictTools,
			toolCacheControl,
		);
	}

	// thinking 是一个开关加一个强度，两者都从模型读取——与指名端点的是同一个对象，所以一次请求
	// 不可能对「模型被要求多用力想」说两件事。effort 是请求携带的唯一强度：没有任何模型会被递一个
	// `budget_tokens`。完全没有 level 的模型与 "off" 在同一个位置，而 "off" 是一个要求关闭开关的
	// 请求，不是一个什么都不说的请求。
	if (level === "off") {
		params.thinking = { type: "disabled" };
	} else {
		// 默认 "summarized"，让自身默认 "omitted" 的模型也返回会话记录能展示的思考。
		const display: AnthropicThinkingDisplay = options?.thinkingDisplay ?? "summarized";
		params.thinking = { type: "adaptive", display };
		params.output_config = { effort: level };
	}

	if (options?.metadata) {
		const userId = options.metadata.user_id;
		if (typeof userId === "string") {
			params.metadata = { user_id: userId };
		}
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	return params;
}

// 把 tool call id 归一化到 Anthropic 要求的模式和长度（`^[a-zA-Z0-9_-]{1,64}$`）。
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertToolResult(msg: ToolResultMessage): ContentBlockParam {
	return {
		type: "tool_result",
		tool_use_id: msg.toolCallId,
		content: convertContentBlocks(msg.content),
		is_error: msg.isError,
	};
}

/** 把一份会话记录转换为 Anthropic 的 wire 消息。 */
function convertMessages(
	transformedMessages: Message[],
	cacheControl?: CacheControlEphemeral,
	allowEmptySignature = false,
): MessageParam[] {
	const params: MessageParam[] = [];

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		// system 消息只能是开头那条，且 `buildParams` 在这里运行之前已经把它提升为请求顶层的
		// `system` 字段。其余的原地跳过而不是转发：Anthropic 在这里没有放它的位置。
		if (msg.role === "system") {
			continue;
		}
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return {
							type: "image",
							source: {
								type: "base64",
								media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
								data: item.data,
							},
						};
					}
				});
				const filteredBlocks = blocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					// 被涂黑的思考：把不透明 payload 按.redacted_thinking 原样传回。
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature!,
						});
						continue;
					}
					const thinkingSignature = block.thinkingSignature;
					const hasThinkingSignature = !!thinkingSignature && thinkingSignature.trim().length > 0;
					if (block.thinking.trim().length === 0 && !hasThinkingSignature) continue;
					// thinking 签名缺失或为空时（例如来自被 abort 的流），转成纯文本发给 Anthropic。
					// 一些兼容 provider 会发出并接受空签名，所以被标记的模型保留该 block。
					if (!hasThinkingSignature) {
						blocks.push(
							allowEmptySignature
								? {
										type: "thinking",
										thinking: sanitizeSurrogates(block.thinking),
										signature: "",
									}
								: {
										type: "text",
										text: sanitizeSurrogates(block.thinking),
									},
						);
					} else {
						blocks.push({
							type: "thinking",
							thinking: sanitizeSurrogates(block.thinking),
							signature: thinkingSignature,
						});
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: block.name,
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			// 收集所有连续的 toolResult 消息，z.ai 的 Anthropic 端点需要。
			const toolResults: ContentBlockParam[] = [];
			let j = i;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				toolResults.push(convertToolResult(transformedMessages[j] as ToolResultMessage));
				j++;
			}

			i = j - 1;

			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	// Anthropic 要求 user 和 assistant 消息严格交替，但会话记录可以装着相邻的 user turn：在
	// 一个取走点排空的多条 steering 消息，或一个 tool-result turn 后面跟着 steering 文本。把每一段
	// 连续的 user 消息折成一条——content block 数组直接拼接，这正是带多个 block 的一个 user turn
	// 的样子。会话记录存储保持消息各自独立；这个折叠只存在于 wire 格式上。
	const mergedParams = mergeAdjacentUserMessages(params);

	// 给最后一条 user 消息加 cache_control，缓存对话历史。
	if (cacheControl && mergedParams.length > 0) {
		const lastMessage = mergedParams[mergedParams.length - 1];
		if (lastMessage.role === "user") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")
				) {
					(lastBlock as any).cache_control = cacheControl;
				}
			} else if (typeof lastMessage.content === "string") {
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return mergedParams;
}

/**
 * 把每一段相邻的 user 消息折成一条。content block 数组直接拼接；字符串 content 先提升为 text
 * block，两侧才统一合并。assistant 消息不动——循环里不会产生相邻的 assistant turn，合并它们会把
 * 不同的 turn 糊成一团。
 */
function mergeAdjacentUserMessages(params: MessageParam[]): MessageParam[] {
	const merged: MessageParam[] = [];
	for (const param of params) {
		const last = merged[merged.length - 1];
		if (last?.role === "user" && param.role === "user") {
			const lastBlocks = Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }];
			const paramBlocks = Array.isArray(param.content)
				? param.content
				: [{ type: "text", text: param.content }];
			last.content = [...lastBlocks, ...paramBlocks];
			continue;
		}
		merged.push(param);
	}
	return merged;
}

function shouldUseFineGrainedToolStreamingBeta(
	model: Model<"anthropic-messages">,
	context: Context,
): boolean {
	return context.tools.length > 0 && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}

// Anthropic 严格工具模式会用 400 拒绝整个请求的关键字。
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations
const ANTHROPIC_STRICT_UNSUPPORTED_KEYWORDS = new Set([
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"maxItems",
	"uniqueItems",
	"minContains",
	"maxContains",
	"minProperties",
	"maxProperties",
]);
const ANTHROPIC_STRICT_STRING_FORMATS = new Set([
	"date-time",
	"time",
	"date",
	"duration",
	"email",
	"hostname",
	"uri",
	"ipv4",
	"ipv6",
	"uuid",
]);

const isAnthropicStrictUnsupportedKeyword: UnsupportedStrictSchemaKeywordCheck = (key, value) => {
	if (ANTHROPIC_STRICT_UNSUPPORTED_KEYWORDS.has(key)) return true;
	if (key === "minItems") return value !== 0 && value !== 1;
	if (key === "format") return typeof value !== "string" || !ANTHROPIC_STRICT_STRING_FORMATS.has(value);
	return false;
};

function convertTools(
	tools: Tool[],
	supportsEagerToolInputStreaming: boolean,
	supportsStrictTools: boolean,
	cacheControl?: CacheControlEphemeral,
): BetaTool[] {
	if (!tools) return [];

	return tools.map((tool, index) => {
		const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictTools, isAnthropicStrictUnsupportedKeyword);
		const parameters = getJsonSchemaToolParameters(tool, strict);
		const schema = parameters as { properties?: unknown; required?: string[] };
		const legacyInputSchema = {
			type: "object" as const,
			properties: schema.properties ?? {},
			required: schema.required ?? [],
		};
		const inputSchema =
			strict === true
				? {
						...(parameters as Record<string, unknown>),
						...legacyInputSchema,
					}
				: legacyInputSchema;

		return {
			name: tool.name,
			description: tool.description,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			...(strict === true ? { strict: true } : {}),
			input_schema: inputSchema,
			...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
		};
	});
}

function mapStopReason(
	reason: BetaStopReason | string,
	stopDetails?: RefusalStopDetails | null,
): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case "end_turn":
			return { stopReason: "stop" };
		case "max_tokens":
			return { stopReason: "length" };
		case "tool_use":
			return { stopReason: "toolUse" };
		case "refusal":
			return {
				stopReason: "error",
				errorMessage: stopDetails?.explanation || `The model refused to complete the request`,
			};
		case "pause_turn": // stop 就够了——重发即可
			return { stopReason: "stop" };
		case "stop_sequence":
			return { stopReason: "stop" }; // 我们不提供 stop sequence，这本不该发生
		case "sensitive": // 被安全过滤器标记的内容（SDK 类型里还没有）
			return { stopReason: "error", errorMessage: "Provider stopped with: sensitive" };
		default:
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}

/**
 * 本模块作为一个 `ChatTransport`：host 把请求交给的唯一东西。
 *
 * 上游 pi-ai 经 `api/anthropic-messages.lazy.ts` 到达这里，它推迟模块加载，让从不发送 Anthropic
 * 请求的 host 不用为 SDK 付代价。本应用总是会发——它不说别的协议——所以配对就是一个普通对象，
 * 上面的 import 是静态的。
 */
export const anthropicMessages: ChatTransport = { stream };
