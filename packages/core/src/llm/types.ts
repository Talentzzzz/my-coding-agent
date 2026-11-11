// 从 pi-ai（0.99.2）vendor 而来。@ts-nocheck 让仓库根目录更严格的配置放过本文件，而进入
// packages/core 的每次 import 仍然被完整检查。
// @ts-nocheck
/** 遥测的不透明父 context；遥测不在本裁剪构建的范围之内。 */
export type TelemetryContext = Record<string, unknown>;
import type { BashSettings } from "../config.ts";
import type { AnthropicOptions } from "./api/anthropic-messages.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type { AssistantMessageEventStream } from "./utils/event-stream.ts";

/**
 * 本构建说的唯一 chat 传输。
 *
 * 上游 pi-ai 把它能驱动的每个 API 都列在这里。这份副本只驱动 Anthropic Messages，所以列表只剩下
 * 它——而 `Api` 仍然接受任何字符串，因为模型带着一个 `api` 字段，本文件其余的泛型都是对着这个
 * 开放形状写的。
 */
export type KnownApi = "anthropic-messages";

export type Api = KnownApi | (string & {});

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

export type ToolChoice = "auto" | "none";
/**
 * 一次请求可以要求的强度。
 *
 * 四档，后三档是这条 wire 携带的 effort：以 `high` 被请求的模型想得更用力，请求里没有任何东西说明
 * 那值多少 token。用不同拼法表达 effort 的端点不是本应用建模的东西——level 按它自己的名字发送。
 *
 * `off` 是四档之一，而不是 level 的缺席：它是「什么都没要」的调用方的意思，它产生的请求说的是
 * 「不要思考」，而不是省略这个开关。
 */
export type ThinkingLevel = "off" | "low" | "high" | "max";

export type CacheRetention = "none" | "short" | "long";

/**
 * 一次请求可以为每档 retention 要求的尽力而为的 prompt cache 寿命（秒）。
 * 缺失的档意味着寿命未知；pi 不会预热这样的缓存。
 */
export type ModelPromptCache = Partial<Record<Exclude<CacheRetention, "none">, number>>;

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
	 * 在 AWS Bedrock 上，这些经 Smithy `build` 步骤的 middleware 注入，因此被 SigV4 签名覆盖；
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
// - 接收归一化的 transcript：system prompt 和工具住在开头的 system 消息里，从不在 context 本身上。
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

export interface TextContent {
	type: "text";
	text: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // provider 专属的不透明或序列化的推理回放数据
	/** 为 true 时，thinking 内容被安全过滤器涂黑。不透明的
	 *  加密 payload 存在 `thinkingSignature` 里，以便回传给 API 实现多轮连续性。 */
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string; // base64 编码的图片数据
	mimeType: string; // 例如 "image/jpeg"、"image/png"
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: JsonObject;
	thoughtSignature?: string; // Google 专属：复用 thought context 的不透明签名
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** `cacheWrite` 中以 1h 保留写入的部分。只有 Anthropic 报告这个拆分。 */
	cacheWrite1h?: number;
	/**
	 * 推理/thinking token，当 provider 报告它们时。这是 `output` 的子集：
	 * `output` 已经包含这些 token。暴露推理拆分的 provider 会设为数字（可能为 0）；
	 * 不暴露的 provider 留为 undefined。
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

/** 一个类型化内存值的 JSON 表示。可选的对象属性仍为可选。 */
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
 * system prompt，由请求的开头消息携带。
 *
 * 每个请求一条且始终在最前：本构建没有任何东西会把 system 消息追加到对话中间，传输会丢弃递给它的
 * 任何多余 system 消息。工具不是它的一部分——工具走请求（`Context.tools`），不装在消息里。
 */
export interface SystemMessage {
	role: "system";
	/** prompt 文本。 */
	content: string | TextContent[];
	timestamp: number; // Unix 时间戳，毫秒
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number; // Unix 时间戳，毫秒
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	model: string;
	responseModel?: string; // provider 报告的具体模型，与请求的 `model` 不同时
	responseId?: string; // 上游 API 暴露时的 provider 专属响应/消息标识
	/** agent loop 为这条响应请求的 Pi thinking level。loop 之外和遗留响应时缺席。 */
	thinkingLevel?: ThinkingLevel;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	rawStopReason?: string;
	/**
	 * provider 对模型是否显式结束了 turn 的说明。
	 * 保留用于调试，目前不影响 agent 控制流。
	 */
	endTurn?: boolean;
	timestamp: number; // Unix 时间戳，毫秒
}

/** 一个工具在运行期间发出的另一个 tool call，例如来自 codemode 脚本。 */
export interface NestedToolCallRecord {
	id: string;
	name: string;
	/** 超出大小限制时省略；`argumentsBytes` 随即给出其大小。 */
	arguments?: JsonObject;
	/** 参数以 JSON 计的 UTF-8 大小，省略 `arguments` 时设置。 */
	argumentsBytes?: number;
	/** `unfinished`：调用它的工具结束时这个 call 还在运行。 */
	status: "ok" | "error" | "unfinished";
	durationMs?: number;
	/** 错误文本，已截断。 */
	error?: string;
}

/** 一个工具发出的嵌套 call 的有界记录。不记录 result。 */
export interface NestedToolCalls {
	calls: NestedToolCallRecord[];
	/** 有 call 被丢弃、参数被省略或 call 未结束时为 false。 */
	complete: boolean;
}

export type ToolResultMessage<TDetails = JsonValue> = IsJsonCompatible<TDetails> extends true
	? {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: (TextContent | ImageContent)[];
			details?: JsonRepresentation<TDetails>;
			/** 工具执行自身的 usage，若可用。不计入主 LLM context 账目。 */
			usage?: Usage;
			/** 这个工具对其他工具发起的 call。为 session 记录保留；不发给模型。 */
			nestedCalls?: NestedToolCalls;
			isError: boolean;
			timestamp: number; // Unix 时间戳，毫秒
		}
	: never;

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

import type { Static, TSchema } from "typebox";

/**
 * 一个工具可选的 provider 侧受限采样配置。
 *
 * `json_schema` 值大致对应于 API 中 `strict` 的概念，后者由各 API 以 json-schema 受限采样实现。
 */
export interface ConstrainedSamplingConfig {
	type: "json_schema";
	strict: "prefer" | "require";
}

/**
 * 一个 run 可以怎样执行一条 assistant 消息的 tool call。
 *
 * - "sequential"：每个 tool call 先准备、执行、收尾，然后才开始下一个。
 * - "parallel"：tool call 依次准备，然后允许的工具并发执行。每个工具收尾后按完成顺序发出
 *   `tool_execution_end`，而 tool-result 消息的产物稍后按 assistant 源顺序发出。
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * 工具行动所用的 per-request 值。
 *
 * 工具不绑定目录：它作用于的东西是随调用到达的值，不是实例闭包的东西。{@link workDirAbsPath} 是
 * 相对路径解析的基准、命令启动的地方；`bash` 带着为同一次请求读取的超时。两者都随调用离开，所以
 * 一个实例服务所有 session 和所有目录（ADR-0016）。
 *
 * 它住在这里、在 {@link Tool} 旁边，因为它是 `execute` 签名的一部分：签名的类型不设第二个家，
 * 否则构建会有一个 `Tool` 却有两个来源。传输从不读它、从不构造它——它在自己收到的声明上看见
 * `execute`，却永远无法调用它，所以这个参数是它拿不到的。`tools/manager.ts` re-export 这个名字，
 * 所有既有的 import 路径不变。
 */
export interface ToolRunContext {
	/** 相对路径解析的基准目录，命令启动的地方。没有围栏。 */
	workDirAbsPath: string;
	/** `bash` 的超时；调用方未指名时用默认值。 */
	bash?: BashSettings;
}

/**
 * 唯一的工具类型。
 *
 * 传输读取的声明——name、description、parameters 和可选的受限采样配置——与引擎调用的可执行对应物
 * ——label、参数垫片、输出 schema、`execute`、重放策略、执行模式——是同一个形状，所以一次请求和
 * 一次 run 不可能在「工具是什么」上漂移。传输读声明字段、从不调用 `execute`；引擎调用 `execute`、
 * 从不从 wire 读声明。
 */
export interface Tool<TParameters extends TSchema = TSchema, TDetails = unknown> {
	name: string;
	description: string;
	parameters: TParameters;
	constrainedSampling?: false | ConstrainedSamplingConfig;
	/** 供 UI 展示的人类可读标签。 */
	label: string;
	/**
	 * schema 校验之前对原始 tool call 参数的可选兼容垫片。
	 * 必须返回一个匹配 `TParameters` 的对象。
	 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/**
	 * 成功 result 中 `structuredContent` 的 JSON Schema。声明了它的工具应当始终设置
	 * `structuredContent`。
	 */
	outputSchema?: TSchema;
	/**
	 * 执行这个 tool call。失败时抛异常，或返回 `isError: true` 的 result；不要只在 `content` 里
	 * 描述失败。
	 *
	 * `run` 刻意必填且在第三位：一旦可选或挪到最后，忘了传它的调用方会无声地在实例构建时所对的
	 * 目录里行动——而实例构建时不对应任何目录。每个调用点都说明自己属于哪次 run。
	 */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		run: ToolRunContext,
		signal?: AbortSignal,
		onUpdate?: ToolUpdateCallback<TDetails>,
	) => Promise<ToolResult<TDetails>>;
	/** 持久意图已存在但结果未知的动作的重放策略。 */
	replay?: "never" | "safe";
	/**
	 * 单工具的执行模式覆盖。
	 * - "sequential"：本工具必须与其他 tool call 逐个执行。
	 * - "parallel"：本工具可以与其他 tool call 并发执行。
	 *
	 * 省略时适用默认执行模式。
	 */
	executionMode?: ToolExecutionMode;
}

/** 工具产出的最终或部分 result。 */
export interface ToolResult<T = JsonValue | undefined> {
	/** 返回给模型的文本或图片内容。 */
	content: (TextContent | ImageContent)[];
	/** 供日志或 UI 渲染使用的任意结构化细节。 */
	details: T;
	/**
	 * 匹配工具 `outputSchema` 的机器可读 result，供程序化调用方使用。不发给模型；
	 * `content` 仍是面向模型的 result。
	 */
	structuredContent?: JsonValue;
	/** 最后一次工具执行自身的 usage，若可用。不用于主 LLM context 账目。 */
	usage?: Usage;
	/**
	 * 不抛异常地报告失败。模型看到的 `content` 是一个错误 result，如同抛出的错误，但 `details` 和
	 * `structuredContent` 为 UI 和程序化调用方保留。
	 */
	isError?: boolean;
	/**
	 * 提示 agent 应在当前工具批次之后停止。
	 * 只有批次中每个已收尾的 tool result 都设为 true 时才会提前终止。
	 */
	terminate?: boolean;
}

/**
 * 工具用来流式发送部分执行更新的回调。
 *
 * 回调的作用域是当前的 `execute()` 调用。工具 promise 落定之后的调用被忽略。
 */
export type ToolUpdateCallback<T = unknown> = (partialResult: ToolResult<T>) => void;

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
	/**
	 * 模型是否接受 Anthropic 的 `temperature` 请求字段。
	 * Claude Opus 4.7+ 拒绝非默认的 temperature 值。
	 * 默认：true。
	 */
	supportsTemperature?: boolean;
	/** 是否把空的 thinking 签名按 `signature: ""` 重放，而不是把 thinking 转成文本。默认：false。 */
	allowEmptySignature?: boolean;
	/** provider 是否支持 Anthropic 的严格工具 schema。默认：false；生成的 Anthropic 模型显式启用。 */
	supportsStrictTools?: boolean;
}

export interface ModelCostRates {
	input: number; // 美元/百万 token
	output: number; // 美元/百万 token
	cacheRead: number; // 美元/百万 token
	cacheWrite: number; // 美元/百万 token
}

export interface ModelCostTier extends ModelCostRates {
	/** 总输入 usage 超过这个 token 数的请求使用本档。 */
	inputTokensAbove: number;
}

export interface ModelCost extends ModelCostRates {
	/** 请求级的定价档。最高的匹配输入阈值适用于整个请求。 */
	tiers?: ModelCostTier[];
}

export interface ModelImageResizeOptions {
	maxWidth?: number;
	maxHeight?: number;
	/** 最大 base64 编码 payload 大小（字节）。 */
	maxBytes?: number;
	jpegQuality?: number;
}

export interface ModelImageInputLimits {
	/** 新图片进入对话历史之前应用的缓存安全缩放配置。 */
	resize?: ModelImageResizeOptions;
	/** 一条 provider 消息接受的最大图片数。 */
	maxPerMessage?: number;
	/** 一次 provider 请求接受的最大图片数。 */
	maxPerRequest?: number;
}

export interface ModelInputLimits {
	/** 序列化后的 provider 请求最大大小（字节）。 */
	maxRequestBytes?: number;
	images?: ModelImageInputLimits;
}

/**
 * Chat 模型：可与 `stream()` 等一起使用。
 *
 * 上游把它声明为 interface。这里是一个 class（见 `./model.ts`），让模型能自己发送请求而不是被递给
 * 别的什么东西去发；形状相同，这正是下面每个签名对着它写而无需改动的原因。
 */
import type { Model } from "./model.ts";

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
