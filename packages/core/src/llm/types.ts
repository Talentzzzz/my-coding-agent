// Vendored from @earendil-works/pi-ai (0.99.2). @ts-nocheck keeps the repo root's stricter config
// from flagging this file, while every import into packages/core stays fully checked.
// @ts-nocheck
/** Opaque parent context for telemetry; telemetry is out of scope in this vendored build. */
export type TelemetryContext = Record<string, unknown>;
import type { BashSettings } from "../config.ts";
import type { AnthropicOptions } from "./api/anthropic-messages.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type { AssistantMessageEventStream } from "./utils/event-stream.ts";

/**
 * The one chat transport this build speaks.
 *
 * Upstream pi-ai lists every API it can drive here. This copy drives Anthropic Messages and nothing
 * else, so the list is down to it — while `Api` still admits any string, because a model carries an
 * `api` field and the rest of the file's generics are written against that open shape.
 */
export type KnownApi = "anthropic-messages";

export type Api = KnownApi | (string & {});

/**
 * The model types this build never drives.
 *
 * Upstream pi-ai also carries image-generation and structured-classifier transports, and these three
 * pairs of names are the whole of what survives of them: the type-level spine that `ModelTypeMap`
 * below is written against. No implementation, option type, or result type is kept — the vendored
 * build speaks Anthropic Messages and nothing else.
 */
export type KnownImageApi = "openrouter-images";
export type ImageApi = KnownImageApi | (string & {});
export type KnownClassifierApi = "typesafe-system-one" | "cloudflare-workers-ai-system-one" | "llama-cpp-classify";
export type ClassifierApi = KnownClassifierApi | (string & {});

export type ToolChoice = "auto" | "none";
/**
 * The strengths a request can be asked at.
 *
 * Four, and the last three are the efforts this wire carries: a model asked at `high` thinks harder,
 * and nothing in the request says how many tokens that is worth. An endpoint that spells an effort
 * differently is not something the app models — a level is sent as its own name.
 *
 * `off` is one of the four rather than the absence of a level: it is what a caller that asked for
 * nothing means, and the request it produces says "do not think" rather than omitting the switch.
 */
export type ThinkingLevel = "off" | "low" | "high" | "max";

// Base options all providers share
export type CacheRetention = "none" | "short" | "long";

/**
 * Best-effort prompt cache lifetime in seconds for each retention tier a request can ask for.
 * A missing tier means the lifetime is unknown; pi does not warm such caches.
 */
export type ModelPromptCache = Partial<Record<Exclude<CacheRetention, "none">, number>>;

export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

/** Provider-scoped environment overrides. Values take precedence over process.env. */
export type ProviderEnv = Record<string, string>;
export type ProviderHeaders = Record<string, string | null>;
export type FetchFunction = typeof globalThis.fetch;

export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

/** Authentication, HTTP transport, and lifecycle callbacks shared by provider requests. */
export interface ProviderRequestOptions<TModel = Model<Api>> {
	signal?: AbortSignal;
	/** Explicit parent context for telemetry produced by this logical request. */
	telemetryContext?: TelemetryContext;
	apiKey?: string;
	/**
	 * Optional fetch implementation for provider HTTP requests.
	 * Defaults to `globalThis.fetch`. Provider adapters that cannot inject a custom implementation may reject it.
	 * This does not affect WebSocket transports.
	 */
	fetch?: FetchFunction;
	/**
	 * Provider-scoped environment values. These take precedence over process.env for
	 * provider configuration such as regional settings, endpoint placeholders, and
	 * proxy variables.
	 */
	env?: ProviderEnv;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * Return undefined to keep the payload unchanged.
	 */
	onPayload?: (payload: unknown, model: TModel) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * Optional callback invoked after an HTTP response is received.
	 */
	onResponse?: (response: ProviderResponse, model: TModel) => void | Promise<void>;
	/**
	 * Optional custom HTTP headers to include in API requests.
	 * Merged with provider defaults; caller values override default headers.
	 * On AWS Bedrock these are injected via a Smithy `build`-step middleware so
	 * they are covered by SigV4 signing; reserved headers (`x-amz-*`,
	 * `authorization`, `host`) are silently ignored to preserve SigV4 / bearer auth.
	 * A null value suppresses a provider/API default header with the same name.
	 */
	headers?: ProviderHeaders;
	/**
	 * HTTP request timeout in milliseconds for providers/SDKs that support it.
	 * For example, the Anthropic SDK client defaults to 10 minutes.
	 */
	timeoutMs?: number;
	/**
	 * Maximum retry attempts for providers/SDKs that support client-side retries.
	 * For example, the Anthropic SDK client defaults to 2.
	 */
	maxRetries?: number;
	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	maxRetryDelayMs?: number;
}

export interface StreamOptions extends ProviderRequestOptions<Model<Api>> {
	/**
	 * Optional callback invoked after an HTTP response is received and before
	 * its body stream is consumed.
	 */
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	/**
	 * Optional observer for each parsed provider stream event before Pi normalization.
	 * Event data is adapter-owned and must be treated as read-only.
	 * Adapter support is explicit; unsupported adapters do not invoke it.
	 */
	onProviderStreamEvent?: (data: unknown, model: Model<Api>) => void | Promise<void>;
	temperature?: number;
	/**
	 * Arbitrary sampling parameters merged into the request body as-is, after the named request
	 * fields, so keys here override them. Lets a compatible server receive parameters pi does not
	 * model, e.g. `top_p`, `top_k`, `min_p`, `repetition_penalty`. Merged over `Model.samplingParams`
	 * per key. Adapters that do not model these parameters ignore it.
	 */
	samplingParams?: Record<string, unknown>;
	maxTokens?: number;
	/**
	 * Preferred transport for providers that support multiple transports.
	 * Providers that do not support this option ignore it.
	 */
	transport?: Transport;
	/**
	 * Prompt cache retention preference. Providers map this to their supported values.
	 * Default: "short".
	 */
	cacheRetention?: CacheRetention;
	/**
	 * WebSocket connect timeout in milliseconds for providers that support
	 * WebSocket transports. This covers the connection/open handshake only;
	 * stream idleness after connection uses timeoutMs.
	 */
	websocketConnectTimeoutMs?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
	 */
	metadata?: Record<string, unknown>;
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

/**
 * Maps known APIs to their full provider-specific stream option types.
 * Type-only imports from API implementation modules are erased at emit, so
 * this is tree-shake safe. One entry, because one API implementation survives here.
 */
export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
}

/**
 * Full stream options for an API. The known API resolves to its concrete option
 * type; custom API strings fall back to the generic shape.
 */
export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
	? ApiOptionsMap[TApi]
	: StreamOptions & Record<string, unknown>;

/**
 * The uniform stream contract of an API implementation module: every module
 * under `src/api/` exports one `stream`. A host hands one of these to whatever
 * sends its requests. This is the untyped dispatch shape; per-API option typing
 * lives on the implementation module itself and reaches it through `ApiStreamOptions`.
 */
export interface ChatTransport {
	stream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

// Unified options passed to stream(). The thinking level is deliberately
// not among them: it rides on the model, so one object says which endpoint answers and how hard it is
// asked to think, and the wire has no second place to read a strength from.
export interface SimpleStreamOptions extends StreamOptions {
	/** Provider-neutral tool selection for simple requests. When omitted, adapters use provider-specific behavior. */
	toolChoice?: ToolChoice;
}

// Generic StreamFunction with typed options.
//
// Contract:
// - Receives a normalized transcript: the system prompt and tools live in the
//   leading system message, never on the context itself.
// - Must return an AssistantMessageEventStream.
// - A transport's stream() may throw synchronously when request auth is
//   missing. Once a stream is returned, request/model/runtime failures should
//   be encoded in that stream.
// - Error termination must produce an AssistantMessage with stopReason
//   "error" or "aborted" and errorMessage, emitted via the stream protocol.
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: Context,
	options?: TOptions,
) => AssistantMessageEventStream;

export interface TextContent {
	type: "text";
	text: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // Provider-specific opaque or serialized reasoning replay data
	/** When true, the thinking content was redacted by safety filters. The opaque
	 *  encrypted payload is stored in `thinkingSignature` so it can be passed back
	 *  to the API for multi-turn continuity. */
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string; // base64 encoded image data
	mimeType: string; // e.g., "image/jpeg", "image/png"
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: JsonObject;
	thoughtSignature?: string; // Google-specific: opaque signature for reusing thought context
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Subset of `cacheWrite` written with 1h retention. Only Anthropic reports this split. */
	cacheWrite1h?: number;
	/**
	 * Reasoning/thinking tokens, when the provider reports them. This is a subset of
	 * `output`: `output` already includes these tokens. Set to a number (possibly 0) by
	 * providers that expose a reasoning breakdown; left undefined by providers that don't.
	 */
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsExactlyJsonValue<T> = [T] extends [JsonValue] ? ([JsonValue] extends [T] ? true : false) : false;
type IsJsonProperty<T> = IsAny<T> extends true
	? false
	: unknown extends T
		? false
		: [Exclude<T, undefined>] extends [never]
			? true
			: IsJsonCompatible<Exclude<T, undefined>>;
type InvalidJsonKeys<T extends object> = {
	[TKey in keyof T]-?: TKey extends string | number ? (IsJsonProperty<T[TKey]> extends true ? never : TKey) : TKey;
}[keyof T];
type IsJsonCompatible<T> = IsAny<T> extends true
	? false
	: unknown extends T
		? false
		: IsExactlyJsonValue<T> extends true
			? true
			: T extends null | boolean | number | string
				? true
				: T extends undefined
					? false
					: T extends readonly (infer TItem)[]
						? IsJsonCompatible<TItem>
						: T extends (...args: never[]) => unknown
							? false
							: T extends object
								? [InvalidJsonKeys<T>] extends [never]
									? true
									: false
								: false;

/** The JSON representation of a typed in-memory value. Optional object properties remain optional. */
export type JsonRepresentation<T> = IsAny<T> extends true
	? JsonValue
	: unknown extends T
		? JsonValue
		: [T] extends [JsonValue]
			? T
			: T extends readonly unknown[]
				? { [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
				: T extends object
					? { [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
					: never;

/**
 * The system prompt, carried by the leading message of a request.
 *
 * One per request and always first: nothing in this build appends a system message to the
 * middle of a conversation, and a transport drops any it is handed. Tools are not part of it —
 * they travel on the request (`Context.tools`), not inside a message.
 */
export interface SystemMessage {
	role: "system";
	/** The prompt text. */
	content: string | TextContent[];
	timestamp: number; // Unix timestamp in milliseconds
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number; // Unix timestamp in milliseconds
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	model: string;
	responseModel?: string; // Concrete model reported by the provider when different from the requested `model`
	responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
	/** Pi thinking level the agent loop requested for this response. Absent outside the agent loop and for legacy responses. */
	thinkingLevel?: ThinkingLevel;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	rawStopReason?: string;
	/**
	 * Provider indication of whether the model explicitly ended its turn.
	 * Preserved for debugging and does not currently affect agent control flow.
	 */
	endTurn?: boolean;
	timestamp: number; // Unix timestamp in milliseconds
}

/** A tool call that another tool made while it ran, for example from a codemode script. */
export interface NestedToolCallRecord {
	id: string;
	name: string;
	/** Omitted when over the size limits; `argumentsBytes` then gives their size. */
	arguments?: JsonObject;
	/** UTF-8 size of the arguments as JSON, set when `arguments` is omitted. */
	argumentsBytes?: number;
	/** `unfinished`: the call was still running when the calling tool finished. */
	status: "ok" | "error" | "unfinished";
	durationMs?: number;
	/** Error text, truncated. */
	error?: string;
}

/** Bounded record of the nested calls a tool made. Results are not recorded. */
export interface NestedToolCalls {
	calls: NestedToolCallRecord[];
	/** False when calls were dropped, arguments omitted, or calls had not finished. */
	complete: boolean;
}

export type ToolResultMessage<TDetails = JsonValue> = IsJsonCompatible<TDetails> extends true
	? {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: (TextContent | ImageContent)[]; // Supports text and images
			details?: JsonRepresentation<TDetails>;
			/** Usage from the tool execution itself, if available. Not part of main LLM context accounting. */
			usage?: Usage;
			/** Calls this tool made to other tools. Kept for the session record; not sent to the model. */
			nestedCalls?: NestedToolCalls;
			isError: boolean;
			timestamp: number; // Unix timestamp in milliseconds
		}
	: never;

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

import type { Static, TSchema } from "typebox";

/**
 * Optional provider-side constrained sampling config for a tool.
 *
 * The `json_schema` value roughly maps to the concept of `strict` in APIs which is
 * implemented as json-schema constrained sampling by APIs.
 */
export interface ConstrainedSamplingConfig {
	type: "json_schema";
	strict: "prefer" | "require";
}

/**
 * How a run may execute the tool calls of one assistant message.
 *
 * - "sequential": each tool call is prepared, executed, and finalized before the next one starts.
 * - "parallel": tool calls are prepared sequentially, then allowed tools execute concurrently.
 *   `tool_execution_end` is emitted in tool completion order after each tool is finalized,
 *   while tool-result message artifacts are emitted later in assistant source order.
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * The per-request values a tool acts with.
 *
 * A tool is directory-free: what it acts on is a value that arrives with the call, not something the
 * instance closes over. {@link workDirAbsPath} is the base relative paths resolve against and where a
 * command starts; `bash` carries the timeouts read for the same request. Both leave with the call, so
 * one instance serves every session and every directory (ADR-0016).
 *
 * It lives here, beside {@link Tool}, because it is part of `execute`'s signature: a signature's type
 * does not get a second home, or the build would have one `Tool` with two sources. A transport never
 * reads it and never constructs one — it sees `execute` on the declaration it is handed and can never
 * call it, so this argument is one it cannot obtain. `tools/manager.ts` re-exports the name, so every
 * existing import path is unchanged.
 */
export interface ToolRunContext {
	/** The directory relative paths resolve against, and where a command starts. No fence. */
	workDirAbsPath: string;
	/** The `bash` timeouts; the defaults when the caller names none. */
	bash?: BashSettings;
}

/**
 * The one tool type.
 *
 * The declaration a transport reads — name, description, parameters, and the optional
 * constrained-sampling config — and the executable counterpart the engine calls — label, argument
 * shim, output schema, `execute`, replay policy, execution mode — are one shape, so a request and a
 * run cannot drift about what a tool is. A transport reads the declaration fields and never calls
 * `execute`; the engine calls `execute` and never reads a declaration from the wire.
 */
export interface Tool<TParameters extends TSchema = TSchema, TDetails = unknown> {
	name: string;
	description: string;
	parameters: TParameters;
	constrainedSampling?: false | ConstrainedSamplingConfig;
	/** Human-readable label for UI display. */
	label: string;
	/**
	 * Optional compatibility shim for raw tool-call arguments before schema validation.
	 * Must return an object that matches `TParameters`.
	 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/**
	 * JSON Schema of `structuredContent` in successful results. Tools that declare it should always
	 * set `structuredContent`.
	 */
	outputSchema?: TSchema;
	/**
	 * Execute the tool call. Throw on failure, or return a result with `isError: true`; do not only
	 * describe the failure in `content`.
	 *
	 * `run` is required and third on purpose: made optional, or moved to the end, a caller that
	 * forgot it would silently act in whatever directory the instance was built against — and the
	 * instance is built against none. Every call site says which run it belongs to.
	 */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		run: ToolRunContext,
		signal?: AbortSignal,
		onUpdate?: ToolUpdateCallback<TDetails>,
	) => Promise<ToolResult<TDetails>>;
	/** Recovery policy for an effect whose durable intent exists but whose outcome is unknown. */
	replay?: "never" | "safe";
	/**
	 * Per-tool execution mode override.
	 * - "sequential": this tool must execute one at a time with other tool calls.
	 * - "parallel": this tool can execute concurrently with other tool calls.
	 *
	 * If omitted, the default execution mode applies.
	 */
	executionMode?: ToolExecutionMode;
}

/** Final or partial result produced by a tool. */
export interface ToolResult<T = JsonValue | undefined> {
	/** Text or image content returned to the model. */
	content: (TextContent | ImageContent)[];
	/** Arbitrary structured details for logs or UI rendering. */
	details: T;
	/**
	 * Machine-readable result matching the tool's `outputSchema`, for programmatic callers. Not sent
	 * to the model; `content` remains the model-facing result.
	 */
	structuredContent?: JsonValue;
	/** Usage from the final tool execution itself, if available. Not used for main LLM context accounting. */
	usage?: Usage;
	/**
	 * Report a failure without throwing. The model sees `content` as an error result, like a thrown
	 * error, but `details` and `structuredContent` are kept for the UI and programmatic callers.
	 */
	isError?: boolean;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/**
 * Callback used by tools to stream partial execution updates.
 *
 * The callback is scoped to the current `execute()` invocation. Calls made after
 * the tool promise settles are ignored.
 */
export type ToolUpdateCallback<T = unknown> = (partialResult: ToolResult<T>) => void;

/**
 * The context one request is made with: the conversation messages, the system prompt as an explicit
 * leading message, and the tools the request carries. A transport reads the declaration fields of
 * each tool and calls nothing on them; the engine passes the same executable shapes.
 */
export interface Context {
	messages: Message[];
	system?: SystemMessage;
	/** The tools this request carries. An empty array is legal; omitting the field is not. */
	tools: Tool[];
}

/**
 * Event protocol for AssistantMessageEventStream.
 *
 * Successful streams emit `start` before partial updates and terminate with
 * `done`. A stream may terminate directly with `error` when request setup fails
 * before generation starts; after `start`, failures also terminate with `error`.
 * Direct `stream()` calls throw synchronously when request auth is missing.
 * Updates and `done` must never appear before `start`.
 *
 * `partial` is the shared live response-so-far helper, not an event-time
 * snapshot. Text and thinking blocks are empty when their `*_start` event is
 * emitted and grow only through their corresponding `*_delta` events until the
 * authoritative `*_end`. Redacted thinking may be complete at start and emit no
 * deltas. Tool-call arguments at `toolcall_start` are provider-specific;
 * `toolcall_delta` carries subsequent JSON updates.
 */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			message: AssistantMessage;
	  }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/** Compatibility settings for Anthropic Messages-compatible APIs. */
export interface AnthropicMessagesCompat {
	/**
	 * Whether the provider accepts per-tool `eager_input_streaming`.
	 * When false, the Anthropic provider omits `tools[].eager_input_streaming`
	 * and sends the legacy `fine-grained-tool-streaming-2025-05-14` beta header
	 * for tool-enabled requests.
	 * Default: true.
	 */
	supportsEagerToolInputStreaming?: boolean;
	/** Whether the provider supports Anthropic long cache retention (`cache_control.ttl: "1h"`). Default: true. */
	supportsLongCacheRetention?: boolean;
	/**
	 * Whether the provider supports Anthropic-style `cache_control` markers on
	 * tool definitions. When false, `cache_control` is omitted from tool params.
	 * Some Anthropic-compatible providers (e.g., Fireworks) do not support this
	 * field on tools and may reject or ignore it.
	 * Default: true.
	 */
	supportsCacheControlOnTools?: boolean;
	/**
	 * Whether the model accepts the Anthropic `temperature` request field.
	 * Claude Opus 4.7+ rejects non-default temperature values.
	 * Default: true.
	 */
	supportsTemperature?: boolean;
	/** Whether to replay empty thinking signatures as `signature: ""` instead of converting thinking to text. Default: false. */
	allowEmptySignature?: boolean;
	/** Whether the provider supports Anthropic strict tool schemas. Default: false; generated Anthropic models enable it explicitly. */
	supportsStrictTools?: boolean;
}

export interface ModelCostRates {
	input: number; // $/million tokens
	output: number; // $/million tokens
	cacheRead: number; // $/million tokens
	cacheWrite: number; // $/million tokens
}

export interface ModelCostTier extends ModelCostRates {
	/** Use this tier for requests whose total input usage exceeds this token count. */
	inputTokensAbove: number;
}

export interface ModelCost extends ModelCostRates {
	/** Request-wide pricing tiers. The highest matching input threshold applies to the full request. */
	tiers?: ModelCostTier[];
}

export interface ModelImageResizeOptions {
	maxWidth?: number;
	maxHeight?: number;
	/** Maximum base64-encoded payload size in bytes. */
	maxBytes?: number;
	jpegQuality?: number;
}

export interface ModelImageInputLimits {
	/** Cache-safe resize profile applied before a new image enters conversation history. */
	resize?: ModelImageResizeOptions;
	/** Maximum images accepted in one provider message. */
	maxPerMessage?: number;
	/** Maximum images accepted across one provider request. */
	maxPerRequest?: number;
}

export interface ModelInputLimits {
	/** Maximum serialized provider request size in bytes. */
	maxRequestBytes?: number;
	images?: ModelImageInputLimits;
}

/**
 * Chat model: usable with `stream()` and friends.
 *
 * Upstream declares this as an interface. Here it is a class (see `./model.ts`) so a model can send
 * a request instead of being handed to something else that does; the shape is the same, which is what
 * keeps every signature below written against it unchanged.
 */
import type { Model } from "./model.ts";

/**
 * Image-generation model: usable with `generateImages()` only.
 *
 * The catalog fields are spelled out rather than inherited from a shared base interface: this build
 * has neither an image nor a classifier transport, so these two shapes never meet `Model` anywhere,
 * and a common ancestor would be a type that existed only to be declared once.
 */
export interface ImageModel<TApi extends ImageApi> {
	type: "image";
	id: string;
	name: string;
	api: TApi;
	baseUrl: string;
	/** The key this model is reached with; carried here because there is no credential store. */
	apiKey?: string;
	input: ("text" | "image")[];
	/** Provider input limits and cache-safe preprocessing metadata. */
	inputLimits?: ModelInputLimits;
	cost: ModelCost;
	headers?: Record<string, string>;
	/** Output modalities. Always includes `"image"`; `"text"` means the model can also return text blocks. */
	output: ("text" | "image")[];
}

/** Structured classifier model: usable with `classify()` only. */
export interface ClassifierModel<TApi extends ClassifierApi> {
	type: "classifier";
	id: string;
	name: string;
	api: TApi;
	baseUrl: string;
	/** The key this model is reached with; carried here because there is no credential store. */
	apiKey?: string;
	input: ("text" | "image")[];
	/** Provider input limits and cache-safe preprocessing metadata. */
	inputLimits?: ModelInputLimits;
	cost: ModelCost;
	headers?: Record<string, string>;
	contextWindow: number;
}

/**
 * Model shape for each model type.
 *
 * The image and classifier entries name types with no implementation behind them here; they are kept
 * only so this map stays the shape upstream's per-type dispatch was written against. Nothing in this
 * build produces one.
 */
export interface ModelTypeMap {
	chat: Model<Api>;
	image: ImageModel<ImageApi>;
	classifier: ClassifierModel<ClassifierApi>;
}

/** What a catalog entry is for. Decides which `Models` operation accepts it. */
export type ModelType = keyof ModelTypeMap;

/** Anything a catalog can list. */
export type AnyModel = ModelTypeMap[ModelType];
