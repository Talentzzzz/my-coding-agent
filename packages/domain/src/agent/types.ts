// 共享内核（分层重构 §2.3）：四子包（context / llm / session / tool）被彼此消费的定义独占性地
// 住在这里——消息与 tool result 的词汇、`Tool` 与 `ToolRunContext`、模型事实族、会话条目族，以及
// 无自然属主的政策常量（`ARG_TRIM_TOOLS` 一族）。子包只准 import 本模块、node 内建与外部依赖
// （守卫 R2），互不 import；根允许保留对子包的 type-only 边（`AssistantMessageEvent` / `Context` /
// `Model` 自 llm、`BashSettings` / `ModeSettings` 自 tool）。
//
// 引擎的契约也住在这里：一次运行发布什么，以及恢复遍以什么形状作答。这些类型曾住在 `packages/loop`；
// 引擎随 ADR-0016 并回编排层，而运行递给会话自己的订阅者的形状就住这里，归拢成一个模块。hooks 三动词
// 的事件与答案就用 `HookMap` 的派生类型。wire 信封是 `@my-agent/case` 的 `protocol.ts` 的事（原
// `core/src/protocol.ts` 已解散）；`QueueMode` 是共享的，wire 面经网关转发本模块这份定义，而不是
// 再声明一份。
//
// 设置的形状与默认值也住在这里（文末一节，原是独立的 `config.ts`）。这对加载方向是件好事：本模块
// 对外递类型与少量政策常量（`APPROVAL_TOOLS` 一类，业务模块零依赖），运行期是一个不依赖任何业务
// 模块的叶子——各持有者从它回落常量，编排层装配各持有者，箭头仍然只朝一个方向流。
import type { AssistantMessageEvent, Context } from "./llm/types.ts";
import type { Model } from "./llm/model.ts";
import type { Static, TSchema } from "typebox";

// session 子包要引用在飞的模型类型（`Live.model`、快照的已解析模型）而不得 import llm 子包（R2）——
// 类型经这里转发，定义仍独占在 `llm/model.ts`。
export type { Model };

// ============================================================================
// 消息与内容块词汇（自 llm/types.ts 收编——被 session / context / tool 消费，§2.3）
// ============================================================================

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

// ============================================================================
// 模型事实族（自 llm/types.ts 收编——模型行的公开事实，§2.3）
// ============================================================================

/**
 * 本构建说的唯一 chat 传输的 API 名。
 *
 * 上游 pi-ai 把它能驱动的每个 API 都列在它的类型里。这份副本只驱动 Anthropic Messages，所以列表只剩
 * 它——而 `Api` 仍然接受任何字符串，因为模型带着一个 `api` 字段，其余的泛型都是对着这个开放形状写的。
 */
export type KnownApi = "anthropic-messages";

export type Api = KnownApi | (string & {});

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

// ============================================================================
// 工具（自 llm/types.ts 收编——传输读它的一半声明，引擎用另一半执行，ADR-0010）
// ============================================================================

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
 * 一个实例服务所有 session 和所有目录（ADR-0011）。
 *
 * 它住在 {@link Tool} 旁边，因为它是 `execute` 签名的一部分：签名的类型不设第二个家，
 * 否则构建会有一个 `Tool` 却有两个来源。传输从不读它、从不构造它——它在自己收到的声明上看见
 * `execute`，却永远无法调用它，所以这个参数是它拿不到的。`tool/manager.ts` re-export 这个名字，
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

/** 工具结果如何携带内容：按顺序排列的文本与图片块（原 hooks.ts 的派生别名，随共享内核入住）。 */
export type ToolResultContent = ToolResult<unknown>["content"];

/** 从消息 content 提取并拼接文本（自 llm/utils/text.ts 收编——context 与 llm 两处消费）。 */
export function contentText(content: string | readonly (TextContent | ImageContent | ThinkingContent | ToolCall)[], separator = "\n"): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(separator);
}

// ============================================================================
// 政策词汇（根自定义——无自然属主、被多个子包消费，§2.3）
// ============================================================================

/**
 * 记录参数庞大、事后无人再读的那些工具。
 *
 * `write` 和 `edit` 携带变更的完整正文——`content` 里是整个文件，`old_string` / `new_string` 里是
 * 整个区域。call 一旦跑过，那份正文就被存了两遍：一遍在参数里，一遍在盘上的文件里。参数是每次
 * 请求都发给模型的东西，模型可能想从中找回的——路径、变更的形状——截短后依然存活；正文本身归
 * 文件保管。工具必须在这里指名：默认没有任何东西可截短。
 */
export const ARG_TRIM_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

/** 超过这个长度的字符串参数是正文而不是引用，是截短的候选。 */
export const ARG_TRIM_THRESHOLD_CHARS = 2_000;

/**
 * 被清空的 result 用来替代工具输出的内容。
 *
 * 刻意简短：一次清空批量清掉 result，一条长篇大论自我解释的通知会花掉它刚腾出来的一大块。但它仍
 * 得说明*为什么*文字没了，因为读到一条没有解释的空 result 的模型会重跑工具去弄清发生了什么。
 */
export function clearedToolResultText(toolName: string): string {
	return `[cleared after an hour idle — run ${toolName} again if you need this]`;
}

/** tool call 的简短人类可读摘要，供审批 prompt 和会话记录用。 */
export function describeToolCall(name: string, args: unknown): string {
	const record = isRecord(args) ? args : {};
	switch (name) {
		case "read":
		case "write":
		case "edit":
		case "glob":
		case "grep":
			return `${name} ${stringField(record, "path") ?? stringField(record, "pattern") ?? ""}`.trim();
		case "bash": {
			const command = stringField(record, "command") ?? "";
			return command.length > 160 ? `${command.slice(0, 157)}...` : command;
		}
		default:
			return name;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

const MAX_UUID_V7_TIMESTAMP = 0xffffffffffff;
const MAX_SEQUENCE = (1n << 41n) - 1n;

let lastOrdinaryTimestamp = -1;
let sequence: bigint | undefined;

/** 生成按时间排序的 UUIDv7（自 llm/utils/uuid.ts 收编——session 的条目 id 经它出生，R2 下子包只准读本模块）。调用方提供的时间戳被保留，用于 follower id。 */
export function uuidv7(timestampMs?: number): string {
	const requestedTimestamp = timestampMs ?? Date.now();
	if (!Number.isInteger(requestedTimestamp) || requestedTimestamp < 0 || requestedTimestamp > MAX_UUID_V7_TIMESTAMP) {
		throw new RangeError(`UUIDv7 timestamp must be an integer between 0 and ${MAX_UUID_V7_TIMESTAMP}`);
	}

	const effectiveTimestamp =
		timestampMs === undefined ? Math.max(requestedTimestamp, lastOrdinaryTimestamp) : timestampMs;
	if (timestampMs === undefined) lastOrdinaryTimestamp = effectiveTimestamp;

	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	if (sequence === undefined) {
		sequence =
			(BigInt(bytes[1]!) << 32n) |
			(BigInt(bytes[2]!) << 24n) |
			(BigInt(bytes[3]!) << 16n) |
			(BigInt(bytes[4]!) << 8n) |
			BigInt(bytes[5]!);
	} else {
		if (sequence === MAX_SEQUENCE) throw new RangeError("UUIDv7 generator sequence exhausted");
		sequence++;
	}

	const timestamp = BigInt(effectiveTimestamp);
	for (let index = 5; index >= 0; index--) {
		bytes[index] = Number(timestamp >> BigInt((5 - index) * 8)) & 0xff;
	}
	bytes[6] = 0x70 | Number((sequence >> 37n) & 0x0fn);
	bytes[7] = Number((sequence >> 29n) & 0xffn);
	bytes[8] = 0x80 | Number((sequence >> 23n) & 0x3fn);
	bytes[9] = Number((sequence >> 15n) & 0xffn);
	bytes[10] = Number((sequence >> 7n) & 0xffn);
	bytes[11] = Number((sequence & 0x7fn) << 1n) | (bytes[11]! & 0x01);

	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

// ============================================================================
// 会话条目族（自 session/ledger.ts 收编——context 的压缩算法要摸 entry 而不得 import session，§2.3）
// ============================================================================

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface MessageEntry extends SessionEntryBase {
	type: "message";
	message: Message;
}

export interface CompactionEntry extends SessionEntryBase {
	type: "compaction";
	summary: string;
	/** 模型仍然看得见的第一条条目；它之前的一切都折进了 `summary`。 */
	firstKeptEntryId: string;
	tokensBefore: number;
	/** 生成摘要那次调用的 usage，若可知。 */
	usage?: Usage;
}

/**
 * 本构建从视图中清出的 tool result 的记录。
 *
 * result 留在文件里——这个格式从不重写一行——所以记录只指名它们，由 `buildContextEntries`
 * （session-manager.ts）应用。形状与压缩相同：一条改变更早条目含义而不改变其本身的条目，这让文件保持完整记录、会话记录
 * 保持它的一个视图。
 */
export interface ClearToolResultEntry extends SessionEntryBase {
	type: "clear_tool_result";
	/** 本记录清空其 result 的条目：仍在文件里，不再在视图里。 */
	clearedEntryIds: string[];
	/** 清空前的预估 prompt 大小，让记录说明自己值多少。 */
	tokensBefore: number;
}

/**
 * 本构建在视图中截短 tool call 参数的记录。
 *
 * 与 clear 相同的决策形状：参数在文件里保持完整——这个格式从不重写一行——记录指名其记录参数被
 * 截短的消息条目，由 `buildContextEntries`（session-manager.ts）应用。`write` 或 `edit` 携带的重正文活在它们改的
 * 文件里；视图只保留足以说明写了什么、写到哪的部分。
 */
export interface TrimToolCallArgEntry extends SessionEntryBase {
	type: "trim_tool_call_arg";
	/** 本记录截短其记录参数的消息条目。 */
	trimmedEntryIds: string[];
	/** 截短前的预估 prompt 大小，让记录说明自己值多少。 */
	tokensBefore: number;
}

/**
 * 对话移动位置的记录：`SessionManager.branch` 或 `SessionManager.resetLeaf`（都在 session-manager.ts）
 * 把叶子留在
 * 哪里，位置真的移动时才写入。
 *
 * 追加本身就推进叶子、不需要记录——文件最后一条就是位置——所以这个条目是唯一的例外，它让一次
 * 移动活得比创建它的进程更久。和每条状态条目一样，它不是会话记录：它不产生任何消息，新读者
 * 重放它来把叶子放回对话去过的位置。
 */
export interface LeafEntry extends SessionEntryBase {
	type: "leaf";
	/** 对话移动到的位置：一个条目 id，null 表示「第一条之前」。 */
	leafId: string | null;
}

/**
 * 不拥有消息条目的模型开销记录：本会话记录里引擎从未挂到 assistant 消息上的 usage。
 *
 * 这个种类存在的意义，是让没有自己消息的开销有地方落脚——会话记录属于另一个文件的 run、为压缩
 * 写的摘要——`operation` 按读者会问的方式指名这笔开销。usage 条目是钱，不是对话：它不产生任何消息，
 * 并且按文件顺序跨所有分支计数，因为在被放弃的树路径上烧掉的 token 同样烧掉了。未知的 `operation`
 * 按普通 usage 读取而不是拒绝——与文件对未知种类的前向兼容规则相同。
 */
export interface UsageEntry extends SessionEntryBase {
	type: "usage";
	/** 开销归因于什么，按写入方命名。 */
	operation: string;
	/** 开销运行的模型行，按其名字。 */
	model: string;
	usage: Usage;
}

/**
 * 一行条目可能的六种类型。
 *
 * session 曾记录的其余一切——名字、模型和 thinking level、工具选择——都是*当前值*，放在这条流
 * 旁边的 `.json` 快照里；遗留的 `tool_result_view` 种类整体废除，因为本构建不再写它，v≤4 文件被
 * 删除而不是重放。剩下的恰好是会话记录无法原地重写的种类：对话本身、两条视图收缩记录、
 * 检查点、叶子位置、无归属的开销。
 */
export type SessionEntry =
	| MessageEntry
	| CompactionEntry
	| ClearToolResultEntry
	| TrimToolCallArgEntry
	| LeafEntry
	| UsageEntry;

/**
 * 一份会话记录的全部条目，按各自的 id 建键。
 *
 * 条目只带 `parentId`，所以沿树的每次上溯——`buildSessionPath`（session-manager.ts）、分支预览、调用方指名的
 * id——都是按 id 查找。这个 map 就是那次查找，也是 `generateId` 无冲突的原因。迭代顺序即文件
 * 顺序：按序重放 JSONL 填充，再按同样顺序追加，所以「最后一行胜出」不需要排序。
 */
export type SessionEntryMapById = Map<string, SessionEntry>;

// ============================================================================
// 引擎的契约
// ============================================================================

/**
 * 控制运行到达队列取走点时注入多少条排队的用户消息。
 *
 * - "all"：在该点取走并注入所有排队消息。
 * - "one-at-a-time"：只取走并注入最旧的一条，其余留在队列里等之后的取走点。
 */
export type QueueMode = "all" | "one-at-a-time";

/**
 * 一个被恢复的工具调用续跑时所用的答案。
 *
 * 它是审批流在调用悬空期间记录下的东西：grant 让调用走运行的正常路径重跑（包括闸门），deny 用
 * `reason` 关闭调用——答案没带 reason 时，用「用户拒绝了它」那句话。
 */
export interface ToolCallAnswer {
	approved: boolean;
	/** deny 时：合成出的工具结果所携带的那句话。 */
	reason?: string;
}

/**
 * 一次运行如何恢复上一次运行留下的未答工具调用。
 *
 * 每次运行在第一个请求之前扫描上下文里的悬空调用（没有工具结果消息回答的 `toolCall` 块），因为
 * 携带悬空调用的供应商请求是非法的。每个调用的去向是固定的：{@link RunRecoveryOptions.answers} 里
 * 的答案用它自己关闭调用——grant 重跑该调用、deny 合成其结果——而没有答案点名的调用，在
 * {@link RunRecoveryOptions.enablePendingToolRecovery} 允许时用合成的错误结果关闭。
 */
export interface RunRecoveryOptions {
	/** 审批流记录的答案，按 tool call id 为键。 */
	answers?: Record<string, ToolCallAnswer>;
	/**
	 * 用合成的错误结果关闭没有答案点名的悬空调用，让运行的第一个请求对供应商合法。默认 true。
	 * 关掉它的宿主自己接管这些调用：运行原样发送未答调用，供应商怎么裁决随它。
	 */
	enablePendingToolRecovery?: boolean;
}

/**
 * 正在构建的供应商请求的替换性运行时状态。
 *
 * `prepareRequest` 的答案：下一个请求所用的 context 与 model，从那一刻的账本重建而来，而不是从
 * 上一轮带来。声明的工具数组骑在 context 上（元素是表自己的实例，ADR-0011），执行链对着它按名
 * 解析——「模型被告知什么与它可以运行什么」从同一个对象作答（ADR-0016）。
 */
export interface AgentRequestUpdate {
	/** 下一个供应商请求用的 context。 */
	context?: Context;
	/** 下一个供应商请求用的 model，带着它被要求的思考档位。 */
	model?: Model;
}

/** hooks 运行完毕后一次工具调用的最终结果。 */
export interface ToolCallOutcome {
	toolCall: ToolCall;
	result: ToolResult<unknown>;
	isError: boolean;
}

/**
 * 一次运行为 UI 更新发出的事件。
 *
 * `agent_end` 是一次运行发出的最后一个事件，但在会话为响应它所做的一切——落盘、fanout——落定
 * 之前，运行不算空闲。会话在那之后才空闲。
 */
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: Message[] }
	// 轮次生命周期——一轮是一次 assistant 响应加上随之的工具调用/结果
	| { type: "turn_start" }
	| { type: "turn_end"; message: Message; toolResults: ToolResultMessage[] }
	// 消息生命周期——system、user、assistant、toolResult 消息都会发出
	| { type: "message_start"; message: Message }
	// 只在流式期间为 assistant 消息发出
	| { type: "message_update"; message: Message; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: Message }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };

// ============================================================================
// 设置的形状与默认值
//
// 原是独立的 `config.ts`（设置归属重构 ADR-0028 的留守文件），曾短暂住过编排层（agent.ts），现
// 归拢到本模块——放这里而不是编排层，正是为了不留加载环。所有权仍然分属三个持有者——行、默认
// 模型与重试在 `models.json`，工具簇在 `tools.json`，队列模式在 `sessions.json`
// ——这里只留守两样：各持有者回落用的默认值，与 wire 和门面读模型需要的类型名。各簇的规范化器
// 仍随簇住在各持有者文件里，本节没有任何规范化函数。
// ============================================================================

import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolve } from "node:path";
import type { BashSettings, ModeSettings } from "./tool/manager.ts";

// ----------------------------------------------------------------------------
// 路径语义（自 session/paths.ts 迁入，分层重构 §2.3）
//
// session 包与 agent 根都消费的两件路径语义（session-manager 的文件键、袋构造的 workDir 解析），
// 子包只准 import 根 types.ts（守卫 R2），所以只能住这里；`AGENT_HOME` 迁往组合根（app）之后，
// 这两个函数是 types.ts 里仅存的路径语义。
// ----------------------------------------------------------------------------

/** 把 Git Bash、MSYS、Cygwin 和 WSL 的盘符路径转换成原生 Windows API 接受的形式。 */
function normalizeWindowsShellPath(pathInput: string): string {
	if (!pathInput.startsWith("/") || pathInput.startsWith("//") || pathInput.includes("\\")) return pathInput;
	const match = pathInput.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return pathInput;
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${match[1]!.toUpperCase()}:\\${suffix ?? ""}`;
}

/** 展开开头的 `~` 并规范化 shell 风格的盘符路径，其余不动。 */
export function normalizePath(pathInput: string): string {
	let normalized = pathInput;
	if (process.platform === "win32") normalized = normalizeWindowsShellPath(normalized);

	const home = homedir();
	if (normalized === "~") return home;
	if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		return join(home, normalized.slice(2));
	}
	return normalized;
}

/** 展开开头的 `~`、规范化 shell 风格的盘符路径，相对路径按 `baseDirInput` 解析为绝对路径。 */
export function resolvePath(pathInput: string, baseDirInput: string = process.cwd()): string {
	const normalized = normalizePath(pathInput);
	const base = normalizePath(baseDirInput);
	return isAbsolute(normalized) ? nodeResolve(normalized) : nodeResolve(base, normalized);
}

/**
 * `bash` 工具的默认超时。类型随簇住进了 tools/manager.ts（设置归属重构 §5）；工具行为与
 * {@link DEFAULT_GLOBAL_SETTINGS} 都从这份常量取默认。
 */
export const DEFAULT_BASH_SETTINGS: BashSettings = { defaultTimeoutMs: 120_000, maxTimeoutMs: 3_600_000 };

/**
 * 供应商调用失败时的重试策略。
 *
 * 类型留守本模块（本仓库的运行期叶子——它对外只递类型，编译期即抹掉 import），所有权随模型簇
 * 归 `ModelManager`（ADR-0028 修正，2026-11-20）：`models.json` 的 `retry` 键，持有者自己的
 * 规范化器（`retryOr`）住在 `model-manager.ts` 里，本节没有逻辑。
 */
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	/** 每次尝试的延迟为 `baseDelayMs * 2^(attempt-1)`。 */
	baseDelayMs: number;
	/** 单次计算出的延迟的上限。 */
	maxAgentDelayMs: number;
}

/**
 * 内置默认模式的名字，设置从不存储它。
 *
 * 默认模式*就是*全局默认——默认工具集与默认审批映射，实时读取——所以它没有自己的一行需要与它们
 * 保持同步（ADR-0004）。这个名字是保留名：一个存储模式若占用它，会遮住输入框必须永远能找到的那
 * 个答案。
 */
export const DEFAULT_MODE_NAME = "默认";

/**
 * global 侧设置面板的读模型：`Agent.settings()` 从三个持有者现读、组装出的这份形状。
 *
 * 真实的家已按设置归属重构（spec §3）分给三个持有者——行、默认模型与重试在 `models.json`，工具簇在
 * `tools.json`，队列模式在 `sessions.json`；UI 簇（外观、目录视图）已迁往
 * 客户端自己的存储（ADR-0029）——这个类型只剩**形状**：设置面板的 wire 面（ADR-0012/0019）不因
 * 搬家而改口。而一个会话自己的选择
 * 住在它 `.json` 快照的设置半（`SessionSettings`），两者在每次读取时组合成 `Settings`
 * （`packages/domain/src/agent/settings.ts`），组合是派生值，这一侧从不被任何袋持有。
 */
export interface GlobalSettings {
	/**
	 * 新会话打开在哪一行：`name`，或会话记录记录的 `<name>/<model-id>` ref。
	 *
	 * 两种写法都接受，因为设置面板写第一种，修复脚本写第二种。undefined 不是「没有模型」：装配会
	 * 回落到 `DEFAULT_MODEL_NAME`（`packages/domain/src/agent/llm/model-manager.ts`），只有连那一行都没有的机器才打开
	 * 在第一行上。
	 */
	model?: string;
	/**
	 * 窗口是否已经种下内置的默认模型行。
	 *
	 * 没有导入任何模型时，客户端会种一行起始行（`packages/web/src/default-model.ts`），用户可以删掉
	 * 它。这个标记让删除成为终局：没有它，下次启动看到空列表又会把行种回来。它是设置而不是浏览器
	 * 自己的存储，因为桌面外壳每次启动都换新端口，而 `localStorage` 按 origin 隔离——这个标记恰恰会
	 * 被它为之存在的重启忘掉。
	 *
	 * 缺失表示「从未种过」，这也是旧设置文件和从未启动过窗口的机器的状态。
	 */
	defaultModelSeeded?: boolean;
	/**
	 * 从未选择过的会话打开时的工具集，也是会话级面板重置到的全局默认。undefined 表示注册表的全集，
	 * 即如今的会话打开时的样子——所以旧设置文件无需迁移，也无需自己的字段。
	 */
	tools?: string[];
	/**
	 * 用户的模式，整体存放，按选择器列出的顺序。缺失表示没有：内置默认模式从不存储，所以旧文件
	 * 已经是一份合法的 modes 文件（ADR-0004）。
	 */
	modes?: ModeSettings[];
	/** 运行前必须在 UI 里获得批准的工具，按工具名为键。 */
	approval: Record<string, boolean>;
	/** 一个取走点注入多少条 steer 消息。 */
	steeringMode: QueueMode;
	/** 一个取走点注入多少条 followUp 消息。 */
	followUpMode: QueueMode;
	/** 如何处理一次瞬时的供应商失败。 */
	retry: RetrySettings;
	/** `bash` 工具允许一条命令运行多久。 */
	bash: BashSettings;
}

/**
 * 设置的部分变更，形状与浏览器发来的 config 补丁一致（wire 契约，spec §7）。
 *
 * 设置归属重构（ADR-0028）后它从退场的 `setting-manager.ts` 迁来——形状一字未动：`Agent.applySettings`
 * 按字段名把它路由到拥有该字段的持有者，每簇独立原子落盘。
 */
export interface SettingsPatch {
	model?: string;
	/** 窗口的「已种下内置默认」标记；见 {@link GlobalSettings.defaultModelSeeded}。 */
	defaultModelSeeded?: boolean;
	/** 全局默认活跃工具集。整份列表，如同会话上的工具集。 */
	tools?: string[];
	/**
	 * 用户的模式，像 `tools` 一样整份发送（ADR-0004）：面板编辑的是一份列表，这里改名的模式与那里
	 * 删除的模式必须同落，要么都不落。
	 */
	modes?: ModeSettings[];
	/** 变动过的审批条目，按工具名为键；省略的键保持现行值。 */
	approval?: Record<string, boolean>;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	retry?: Partial<RetrySettings>;
	/** `bash` 工具允许一条命令运行多久。部分字段，让一个超时可以单独挪动。 */
	bash?: Partial<BashSettings>;
}

/** 设置面板读与写的东西。 */
export interface GlobalSettingsSnapshot {
	/** 全局默认活跃工具集；缺失表示本构建认识的所有工具。 */
	tools?: string[];
	/**
	 * 用户的模式，整体存放，按选择器列出的顺序；缺失表示没有定义过。
	 *
	 * 内置默认模式有意不在其中：它是实时读取的全局默认（ADR-0004），客户端用 `tools` 与 `approval`
	 * 拼出它，而不是期望有一行。
	 */
	modes?: ModeSettings[];
	approval: Record<string, boolean>;
	/** `bash` 工具允许一条命令运行多久。 */
	bash: BashSettings;
	model?: string;
	/** 窗口是否已种下内置默认行；见 `Settings.defaultModelSeeded`。 */
	defaultModelSeeded?: boolean;
}

/**
 * 不带消息地对会话所持之物做的变更：模式指针、会话的审批增量与两个队列模式。
 *
 * 模型与思考档位有意缺席。两者都在输入框里选择、都随属于它们的消息抵达（ModelSelection），
 * 因为记录一个没有请求真正用过它的选择，等于在会话记录里放一条从未生效的决定。
 */
export type ConfigPatch = {
	/**
	 * 会话要指向的模式：settings `modes` 表里的一个名字；`null` 即指回内置「默认」（指针缺席）。
	 * 省略的键保持现行值。指向不存在的预设会被拒绝——说出来，而不是按默认悄悄跑。
	 */
	mode?: string | null;
	/**
	 * 会话自己的审批增量，按工具名为键：会话在个别工具上的明确决定（grant 的「不再问」、补丁写下
	 * 的键），叠在模式解析出的审批基线之上；省略的键保持现行值。
	 */
	approval?: Record<string, boolean>;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
};

/**
 * 窗口设置提供审批开关的工具，按提供的顺序。
 *
 * 审批映射本身以工具名为键，不绑定这份列表：设置文件或会话快照可以点名任何工具，报告哪些工具被
 * 闸的读取者遍历的是映射而不是它。这份列表只是窗口的默认 offerings——本构建出厂的配置，不是
 * 映射能装什么的限制。
 */
export const APPROVAL_TOOLS: readonly string[] = ["read", "write", "edit", "glob", "grep", "bash"];

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
	approval: { read: false, write: true, edit: true, glob: false, grep: false, bash: true },
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	retry: { enabled: true, maxRetries: 3, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 },
	bash: { ...DEFAULT_BASH_SETTINGS },
};

/**
 * 工具名列表，字段缺失或不是数组时为 undefined。
 *
 * 文件是手编的，所以不是非空字符串的条目被丢弃而不是拒绝——一行坏数据不该连累整个字段。空列表
 * 会被*保留*：缺失的字段表示「全部工具」（旧文件的行为），而显式空列表是一个选择——「什么都不
 * 活跃」——把一个选择悄悄改写成它的反面，是设置读取者唯一不可做的事。
 *
 * 工具簇与模式表共用。
 */
export function stringListOrUndefined(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

// 工具簇的类型（`BashSettings` / `ModeSettings`）随簇住在 tool/manager.ts（设置归属重构 §5）；
// 这里只转发类型名，让 wire 网关与既有 import 路径继续经本模块拿到它们。
export type { BashSettings, ModeSettings } from "./tool/manager.ts";
