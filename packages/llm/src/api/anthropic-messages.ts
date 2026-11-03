// Vendored from @earendil-works/pi-ai (0.99.2). Checked by packages/llm/tsconfig.json under pi's own compiler
// settings; @ts-nocheck keeps the repo root's stricter config from flagging this file,
// while every import into packages/core stays fully checked.
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
	LlmContext,
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
 * Prompt-cache lifetime for this request.
 *
 * pi-ai reads an environment variable here for backward compatibility. This build does not: cache
 * retention is the caller's choice alone (the transcript pins it), so nothing outside the request
 * decides it.
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

/**
 * Convert content blocks to Anthropic API format
 */
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
	// If only text blocks, return as concatenated string for simplicity
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// If we have images, convert to content block array
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

	// If only images (no text), add placeholder text block
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
 * The efforts this wire takes.
 *
 * Four here and three in this app: `medium` is a value the endpoint understands and nothing the app
 * offers, so it never goes out. It stays in the type because the type describes the endpoint.
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
	 * Controls how thinking content is returned in API responses.
	 * - "summarized": Thinking blocks contain summarized thinking text.
	 * - "omitted": Thinking blocks return an empty thinking field; the encrypted
	 *   signature still travels back for multi-turn continuity. Use for faster
	 *   time-to-first-text-token when your UI does not surface thinking.
	 *
	 * Note: Anthropic's API default for Claude Opus 4.7 and Claude Mythos Preview
	 * is "omitted". We default to "summarized" here to keep behavior consistent
	 * with older Claude 4 models. Set this explicitly to "omitted" to opt in.
	 * Default: "summarized" when thinking is on.
	 *
	 * The switch and the strength are not options: they are read off the model
	 * (`Model.thinkingLevel`), so a request cannot carry two answers to how hard
	 * the model was asked to think.
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	/**
	 * Anthropic tool choice behavior. String values map to Anthropic's built-in
	 * choices; `{ type: "tool", name }` forces a specific tool.
	 * Default: omitted (Anthropic default behavior, currently equivalent to auto).
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
 * The key a request authenticates with.
 *
 * The model is read as a fallback, because a model here carries its own key (`Model.apiKey`) rather
 * than being reached through a credential store: the row *is* the endpoint plus the key, so the model
 * that names the endpoint already names the credential. An explicit `options.apiKey` wins over it,
 * which is how the loop hands down the key it took off the model, and it is also how a host with one
 * key for every model it drives overrides a row. An empty string counts as absent, so a row with no
 * key still reaches header-owned auth.
 */
function resolveApiKey(
	model: Model<"anthropic-messages">,
	options?: StreamOptions | SimpleStreamOptions,
): string | undefined {
	return options?.apiKey || model.apiKey || undefined;
}

/**
 * Fail before a request when there is no key to authenticate it with.
 *
 * No key may be supplied in-band by a header instead, which is how a gateway that injects its own
 * credential is reached. The message names the endpoint rather than a provider id: a model here is one
 * endpoint the user typed, and the URL is the only part of that a person can act on.
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
 * The one entry a host calls.
 *
 * Request auth is checked here so a missing key fails synchronously, before a stream exists; once
 * the stream is returned, every failure travels through it as an event. `buildBaseOptions` fits
 * `max_tokens` to what the context leaves.
 */
export const stream: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: LlmContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = resolveApiKey(model, options);
	assertRequestAuth(model, apiKey, options?.headers);
	// Nothing is translated here any more. The thinking level rides on the model, so effort is read
	// where the endpoint lives: one object says both which endpoint answers and how hard it thinks.
	const request: AnthropicOptions = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	};
	const stream = new AssistantMessageEventStream();

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
			const client = createClient(model, apiKey, request.headers, request.fetch);
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
				() => client.beta.messages.create(params, requestOptions).asResponse(),
				{
					maxRetries: request.maxRetries,
					maxRetryDelayMs: request.maxRetryDelayMs,
					signal: request.signal,
				},
			);
			await request.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
			const blocks = output.content as Block[];

			for await (const event of iterateAnthropicEvents(response, request.signal)) {
				await request.onProviderStreamEvent?.(event, model);
				if (event.type === "message_start") {
					output.responseId = event.message.id;
					const responseModel = event.message.model;
					if (responseModel !== model.id) output.responseModel = responseModel;
					// Capture initial token usage from message_start event
					// This ensures we have input token counts even if the stream is aborted early
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
					output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
					output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
					// Anthropic doesn't provide total_tokens, compute from components
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
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						const block: Block = {
							type: "thinking",
							thinking: event.content_block.thinking ?? "",
							thinkingSignature: event.content_block.signature ?? "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "redacted_thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "[Reasoning redacted]",
							thinkingSignature: event.content_block.data,
							redacted: true,
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
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
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
				} else if (event.type === "content_block_delta") {
					if (event.delta.type === "text_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "text") {
							block.text += event.delta.text;
							stream.push({
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
							stream.push({
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
							stream.push({
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
							stream.push({
								type: "text_end",
								contentIndex: index,
								content: block.text,
								partial: output,
							});
						} else if (block.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: index,
								content: block.thinking,
								partial: output,
							});
						} else if (block.type === "toolCall") {
							block.arguments = parseStreamingJson(block.partialJson);
							// Finalize in-place and strip the scratch buffer so replay only
							// carries parsed arguments.
							delete (block as { partialJson?: string }).partialJson;
							stream.push({
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
					// Only update usage fields if present (not null).
					// Preserves input_tokens from message_start when proxies omit it in message_delta.
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
						// Vercel AI Gateway includes the TTL breakdown in deltas, though the SDK only types it on message_start.
						const cacheCreation = (
							event.usage as typeof event.usage & { cache_creation?: { ephemeral_1h_input_tokens?: number } }
						).cache_creation;
						if (cacheCreation?.ephemeral_1h_input_tokens != null) {
							output.usage.cacheWrite1h = cacheCreation.ephemeral_1h_input_tokens;
						}
						// Anthropic reports reasoning tokens as a subset of output tokens.
						const thinkingTokens = event.usage.output_tokens_details?.thinking_tokens;
						if (thinkingTokens != null) {
							output.usage.reasoning = thinkingTokens;
						}
					}
					// Anthropic doesn't provide total_tokens, compute from components
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

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// partialJson is only a streaming scratch buffer; never persist it.
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = request.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
): Anthropic {
	// API key or header-owned auth.
	const defaultHeaders = mergeClientHeaders(
		{
			accept: "application/json",
			"anthropic-dangerous-direct-browser-access": "true",
		},
		model.headers,
		optionsHeaders,
	);
	const client = new Anthropic({
		apiKey: apiKey ?? null,
		authToken: null,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders,
	});

	return client;
}

function getBetaFeatures(
	model: Model<"anthropic-messages">,
	context: LlmContext,
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
	context: LlmContext,
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
		// Add cache control to system prompt
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(initialSystemText),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	// The level the model is asked at. Missing is the same request as "off": nothing was asked for.
	const level: ThinkingLevel = model.thinkingLevel ?? "off";

	// Temperature is incompatible with extended thinking and unsupported on Claude Opus 4.7+.
	if (options?.temperature !== undefined && level === "off" && compat.supportsTemperature) {
		params.temperature = options.temperature;
	}

	const toolCacheControl = compat.supportsCacheControlOnTools ? cacheControl : undefined;
	// Every request carries the complete current list, so a tool switched on mid-session reaches the
	// model on the next one without anything having to be recorded in the transcript.
	const tools = context.tools ?? [];
	if (tools.length > 0) {
		params.tools = convertTools(
			tools,
			compat.supportsEagerToolInputStreaming,
			compat.supportsStrictTools,
			toolCacheControl,
		);
	}

	// Thinking is one switch plus one effort, and both are read off the model — the same object that
	// names the endpoint, so a request cannot say two things about how hard the model was asked to
	// think. The effort is the only strength the request carries: no model is ever handed a
	// `budget_tokens`. A model with no level at all is in the same place as "off", and "off" is a
	// request for the switch to be off rather than a request that says nothing.
	if (level === "off") {
		params.thinking = { type: "disabled" };
	} else {
		// Default to "summarized" so a model whose own default is "omitted" comes back as
		// thinking the transcript can show.
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

// Normalize tool call IDs to match Anthropic's required pattern and length
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

/** Convert a transcript to Anthropic's wire messages. */
function convertMessages(
	transformedMessages: Message[],
	cacheControl?: CacheControlEphemeral,
	allowEmptySignature = false,
): MessageParam[] {
	const params: MessageParam[] = [];

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		// A system message can only be the leading one, and `buildParams` has already lifted it
		// into the request's top-level `system` field before this runs. Anything else is skipped
		// rather than forwarded: Anthropic has no place for it here.
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
					// Redacted thinking: pass the opaque payload back as redacted_thinking
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
					// If thinking signature is missing/empty (e.g., from aborted stream),
					// convert to plain text for Anthropic. Some compatible providers emit
					// and accept empty signatures, so let marked models preserve the block.
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
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint.
			const toolResults: ContentBlockParam[] = [];
			let j = i;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				toolResults.push(convertToolResult(transformedMessages[j] as ToolResultMessage));
				j++;
			}

			// Skip the messages we've already processed.
			i = j - 1;

			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	// Anthropic requires user and assistant messages to strictly alternate, but the transcript
	// can hold adjacent user turns: several steered messages drained at one take point, or a
	// tool-result turn followed by steered text. Fold each run of user messages into one —
	// the content block arrays just concatenate, which is exactly what one user turn with
	// several blocks looks like. Transcript storage keeps the messages separate; this fold
	// lives only on the wire format.
	const mergedParams = mergeAdjacentUserMessages(params);

	// Add cache_control to the last user message to cache conversation history
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
 * Fold each run of adjacent user messages into one. The content block arrays
 * concatenate; a string content is lifted into a text block first so both
 * sides merge uniformly. Assistant messages are left untouched — adjacent
 * assistant turns do not arise from the loop, and merging them would smear
 * distinct turns into one.
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
	context: LlmContext,
): boolean {
	return (context.tools ?? []).length > 0 && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}

// Keywords Anthropic strict tool use rejects with a 400 for the whole request.
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
		case "pause_turn": // Stop is good enough -> resubmit
			return { stopReason: "stop" };
		case "stop_sequence":
			return { stopReason: "stop" }; // We don't supply stop sequences, so this should never happen
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return { stopReason: "error", errorMessage: "Provider stopped with: sensitive" };
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}

/**
 * This module as a `ChatTransport`: the one thing a host hands its requests to.
 *
 * Upstream pi-ai reaches this through `api/anthropic-messages.lazy.ts`, which defers the module load
 * so a host that never sends an Anthropic request never pays for the SDK. This app always does — it
 * speaks nothing else — so the pairing is a plain object and the import above is static.
 */
export const anthropicMessages: ChatTransport = { stream };
