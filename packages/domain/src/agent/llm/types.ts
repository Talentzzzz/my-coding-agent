// 从 pi-ai（0.99.2）vendor 而来。@ts-nocheck 让仓库根目录更严格的配置放过本文件，而进入
// packages/core 的每次 import 仍然被完整检查。
//
// 分层重构步 4（§2.3）之后本文件只装传输机械：`Context`、`ChatTransport`、流选项族、事件协议与
// 模型分发形状。消息词汇、`Tool`、模型事实族被其他子包消费，已收编进 agent 根 `types.ts`（共享
// 内核，守卫 R2）——下面的转发块让本包内部的既有 import 面（`./types.ts` / `../types.ts`）原样
// 工作，名字与根内核是同一批符号。
// @ts-nocheck
/** 遥测的不透明父 context；遥测不在本裁剪构建的范围之内。 */
export type TelemetryContext = Record<string, unknown>;

// —— 共享内核转发（定义独占在 ../types.ts，这里只递名字给传输机械的既有 import 面）——
export type {
	Api,
	AssistantMessage,
	CacheRetention,
	ConstrainedSamplingConfig,
	ImageContent,
	ToolExecutionMode,
	JsonValue,
	KnownApi,
	Message,
	ModelCost,
	ModelCostRates,
	ModelCostTier,
	ModelImageInputLimits,
	ModelImageResizeOptions,
	ModelInputLimits,
	ModelPromptCache,
	NestedToolCallRecord,
	NestedToolCalls,
	StopReason,
	SystemMessage,
	TextContent,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolCall,
	ToolResult,
	ToolResultMessage,
	ToolRunContext,
	ToolUpdateCallback,
	Usage,
	UserMessage,
} from "../types.ts";

import type { AnthropicOptions } from "./api/anthropic-messages.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";
// 上面的转发块不把名字带进本模块作用域；本文件自己的类型（`Context` / `AssistantMessageEvent` /
// `ImageModel` 一族）引用内核词汇，从这里显式取。
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Message,
	ModelCost,
	ModelInputLimits,
	StopReason,
	SystemMessage,
	Tool,
	ToolCall,
} from "../types.ts";

export type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

/** provider 范围的环境变量覆盖。这些值优先于 process.env。 */
export type ProviderEnv = Record<string, string>;
export type ProviderHeaders = Record<string, string | null>;
export type FetchFunction = typeof globalThis.fetch;

export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

/** provider 请求共享的认证、HTTP 传输和生命周期回调。 */
export interface ProviderRequestOptions<TModel = Model<Api>> {
	signal?: AbortSignal;
	/** 本逻辑请求产生的遥测的显式父 context。 */
	telemetryContext?: TelemetryContext;
	apiKey?: string;
	/**
	 * provider HTTP 请求的可选 fetch 实现。
	 * 默认为 `globalThis.fetch`。无法注入自定义实现的 provider 适配器可以拒绝它。
	 * 这不影响 WebSocket 传输。
	 */
	fetch?: FetchFunction;
	/**
	 * provider 范围的环境变量值。对区域设置、端点占位符、代理变量等 provider 配置，
	 * 这些值优先于 process.env。
	 */
	env?: ProviderEnv;
	/**
	 * 发送前检查或替换 provider payload 的可选回调。
	 * 返回 undefined 表示保持 payload 不变。
	 */
	onPayload?: (payload: unknown, model: TModel) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * 收到 HTTP 响应后调用的可选回调。
	 */
	onResponse?: (response: ProviderResponse, model: TModel) => void | Promise<void>;
	/**
	 * 要包含在 API 请求中的可选自定义 HTTP header。
	 * 与 provider 默认值合并；调用方的值覆盖默认 header。
	 * 在 AWS Bedrock 上，这些经 Smithy `build` 步骤的 middleware 注入，会被 SigV4 签名覆盖；
	 * 保留 header（`x-amz-*`、`authorization`、`host`）被静默忽略，以保全 SigV4 / bearer 认证。
	 * null 值压制 provider/API 中同名的默认 header。
	 */
	headers?: ProviderHeaders;
	/**
	 * 支持它的 provider/SDK 的 HTTP 请求超时（毫秒）。
	 * 例如 Anthropic SDK 客户端默认 10 分钟。
	 */
	timeoutMs?: number;
	/**
	 * 支持客户端重试的 provider/SDK 的最大重试次数。
	 * 例如 Anthropic SDK 客户端默认 2。
	 */
	maxRetries?: number;
	/**
	 * 服务器要求长等待时，重试等待的最大延迟（毫秒）。
	 * 服务器要求的延迟超过这个值时，请求立即失败，错误中带上被要求的延迟，让更高层的重试逻辑
	 * 在用户可见的情况下处理。
	 * 默认：60000（60 秒）。设为 0 表示关闭上限。
	 */
	maxRetryDelayMs?: number;
}

export interface StreamOptions extends ProviderRequestOptions<Model<Api>> {
	/**
	 * 收到 HTTP 响应之后、消费其 body 流之前调用的可选回调。
	 */
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	/**
	 * 在 Pi 归一化之前观察每个已解析 provider 流事件的可选观察者。
	 * 事件数据归适配器所有，必须当作只读。
	 * 适配器支持是显式的；不支持的适配器不会调用它。
	 */
	onProviderStreamEvent?: (data: unknown, model: Model<Api>) => void | Promise<void>;
	temperature?: number;
	/**
	 * 原样合并进请求体的任意采样参数，合并在具名请求字段之后，所以这里的 key 盖过它们。让兼容的
	 * 服务器收到 pi 没有建模的参数，例如 `top_p`、`top_k`、`min_p`、`repetition_penalty`。按 key
	 * 合并到 `Model.samplingParams` 之上。不建模这些参数的适配器忽略它。
	 */
	samplingParams?: Record<string, unknown>;
	maxTokens?: number;
	/**
	 * 支持多种传输的 provider 的首选传输。
	 * 不支持这个选项的 provider 忽略它。
	 */
	transport?: Transport;
	/**
	 * prompt cache 保留偏好。provider 把它映射到自己支持的值。
	 * 默认："short"。
	 */
	cacheRetention?: CacheRetention;
	/**
	 * 支持 WebSocket 传输的 provider 的 WebSocket 连接超时（毫秒）。
	 * 只覆盖连接/打开握手；连接建立之后的流空闲用 timeoutMs。
	 */
	websocketConnectTimeoutMs?: number;
	/**
	 * 要包含在 API 请求中的可选元数据。
	 * provider 提取自己理解的字段、忽略其余。
	 * 例如 Anthropic 用 `user_id` 做滥用追踪和限流。
	 */
	metadata?: Record<string, unknown>;
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

/**
 * 把已知的 API 映射到它们完整的 provider 专属流选项类型。
 * 从 API 实现模块的类型-only import 会在产出时擦除，所以这是 tree-shake 安全的。
 * 只有一个条目，因为这里只活下来一个 API 实现。
 */
export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
}

/**
 * 一个 API 的完整流选项。已知 API 解析到它具体的选项类型；自定义 API 字符串回落到通用形状。
 */
export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
	? ApiOptionsMap[TApi]
	: StreamOptions & Record<string, unknown>;

/**
 * 一个 API 实现模块的统一流契约：`src/api/` 下的每个模块都导出一个 `stream`。host 把其中之一交给
 * 发送请求的东西。这是无类型的分发形状；每个 API 的选项类型定义在实现模块自身上，经
 * `ApiStreamOptions` 到达它。
 */
export interface ChatTransport {
	stream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

// 传给 stream() 的统一选项。thinking level 刻意不在其中：它搭在模型上，这样一个对象同时说明哪个
// 端点回答、被要求多用力地想，wire 上没有第二个可以读取强度的地方。
export interface SimpleStreamOptions extends StreamOptions {
	/** 简单请求的 provider 中立工具选择。省略时适配器按 provider 专属行为行事。 */
	toolChoice?: ToolChoice;
}

// 带类型化选项的通用 StreamFunction。
//
// 契约：
// - 接收归一化的会话记录：system prompt 和工具住在开头的 system 消息里，从不在 context 本身上。
// - 必须返回一个 AssistantMessageEventStream。
// - 传输的 stream() 在请求缺认证时可以同步抛出。一旦流被返回，请求/模型/运行时失败应编码进
//   那个流。
// - 错误终止必须产生一个 stopReason 为 "error" 或 "aborted" 并带 errorMessage 的 AssistantMessage，
//   经流协议发出。
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: Context,
	options?: TOptions,
) => AssistantMessageEventStream;

export type ToolChoice = "auto" | "none";

/**
 * 一次请求所带的 context：对话消息、作为显式开头消息的 system prompt、以及请求携带的工具。
 * 传输读取每个工具的声明字段、不在它们上面调用任何东西；引擎传递同样的可执行形状。
 */
export interface Context {
	messages: Message[];
	system?: SystemMessage;
	/** 本次请求携带的工具。空数组合法；省略字段不合法。 */
	tools: Tool[];
}

/**
 * AssistantMessageEventStream 的事件协议。
 *
 * 成功的流先发 `start` 再发部分更新，并以 `done` 终止。请求装配在生成开始之前失败时，流可以直接以
 * `error` 终止；`start` 之后，失败同样以 `error` 终止。直接调用 `stream()` 在请求缺认证时同步抛出。
 * 更新和 `done` 绝不出现在 `start` 之前。
 *
 * `partial` 是共享的「目前为止的响应」活助手，不是事件时刻的快照。text 和 thinking block 在各自的
 * `*_start` 事件发出时为空，只随对应的 `*_delta` 事件增长，直到权威的 `*_end`。被涂黑的 thinking
 * 可能在开始时就完整，不发任何 delta。`toolcall_start` 时的 tool call 参数因 provider 而异；
 * `toolcall_delta` 携带后续的 JSON 更新。
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

/**
 * 本构建从不驱动的模型类型。
 *
 * 上游 pi-ai 还携带图像生成和结构化分类器的传输，这三对名字是它们幸存的全部：下面 `ModelTypeMap`
 * 所对着写的类型级骨架。没有实现、选项类型或结果类型被保留——本裁剪构建只说 Anthropic Messages。
 */
export type KnownImageApi = "openrouter-images";
export type ImageApi = KnownImageApi | (string & {});
export type KnownClassifierApi = "typesafe-system-one" | "cloudflare-workers-ai-system-one" | "llama-cpp-classify";
export type ClassifierApi = KnownClassifierApi | (string & {});

/** Anthropic Messages 兼容 API 的兼容性设置。 */
export interface AnthropicMessagesCompat {
	/**
	 * provider 是否接受 per-tool 的 `eager_input_streaming`。
	 * 为 false 时，Anthropic provider 省略 `tools[].eager_input_streaming`，对启用工具的请求发送
	 * 旧版 `fine-grained-tool-streaming-2025-05-14` beta header。
	 * 默认：true。
	 */
	supportsEagerToolInputStreaming?: boolean;
	/** provider 是否支持 Anthropic 的长缓存保留（`cache_control.ttl: "1h"`）。默认：true。 */
	supportsLongCacheRetention?: boolean;
	/**
	 * provider 是否支持工具定义上的 Anthropic 风格 `cache_control` 标记。为 false 时，
	 * `cache_control` 从工具参数中省略。一些 Anthropic 兼容 provider（如 Fireworks）不支持工具上的
	 * 这个字段，可能拒绝或忽略它。
	 * 默认：true。
	 */
	supportsCacheControlOnTools?: boolean;
	/** 是否把空的 thinking 签名按 `signature: ""` 重放，而不是把 thinking 转成文本。默认：false。 */
	allowEmptySignature?: boolean;
	/** provider 是否支持 Anthropic 的严格工具 schema。默认：false；生成的 Anthropic 模型显式启用。 */
	supportsStrictTools?: boolean;
}

/**
 * 图像生成模型：只能与 `generateImages()` 一起使用。
 *
 * catalog 字段逐个写出而不是从一个共享的基 interface 继承：本构建既没有图像传输也没有分类器
 * 传输，这两个形状在任何地方都不会遇到 `Model`，一个共同祖先将是只为声明一次而存在的类型。
 */
export interface ImageModel<TApi extends ImageApi> {
	type: "image";
	id: string;
	name: string;
	api: TApi;
	baseUrl: string;
	/** 到达这个模型用的 key；因为没有凭据 store，所以带在这里。 */
	apiKey?: string;
	input: ("text" | "image")[];
	/** provider 的输入限制和缓存安全的预处理元数据。 */
	inputLimits?: ModelInputLimits;
	cost: ModelCost;
	headers?: Record<string, string>;
	/** 输出模态。始终包含 `"image"`；`"text"` 表示模型也能返回文本 block。 */
	output: ("text" | "image")[];
}

/** 结构化分类器模型：只能与 `classify()` 一起使用。 */
export interface ClassifierModel<TApi extends ClassifierApi> {
	type: "classifier";
	id: string;
	name: string;
	api: TApi;
	baseUrl: string;
	/** 到达这个模型用的 key；因为没有凭据 store，所以带在这里。 */
	apiKey?: string;
	input: ("text" | "image")[];
	/** provider 的输入限制和缓存安全的预处理元数据。 */
	inputLimits?: ModelInputLimits;
	cost: ModelCost;
	headers?: Record<string, string>;
	contextWindow: number;
}

/**
 * 每种模型类型的模型形状。
 *
 * image 和 classifier 条目指名的类型在这里没有任何实现支撑；保留它们只是为了让这个 map 保持上游
 * 按类型分发所对着写的形状。本构建没有任何东西产出其一。
 */
export interface ModelTypeMap {
	chat: Model<Api>;
	image: ImageModel<ImageApi>;
	classifier: ClassifierModel<ClassifierApi>;
}

/** 一个 catalog 条目是干什么用的。决定哪个 `Models` 操作接受它。 */
export type ModelType = keyof ModelTypeMap;

/** 任何 catalog 能列出的东西。 */
export type AnyModel = ModelTypeMap[ModelType];

/**
 * Chat 模型：可与 `stream()` 等一起使用。
 *
 * 上游把它声明为 interface。这里是一个 class（见 `./model.ts`），让模型能自己发送请求而不是被递给
 * 别的什么东西去发；形状相同，这正是上面每个签名对着它写而无需改动的原因。
 */
import type { Model } from "./model.ts";
