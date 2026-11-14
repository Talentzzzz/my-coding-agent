// smoke 驱动的剧本化 transport：一个从队列里作答而不是从网络作答的 `ChatTransport`，因此流式、
// 队列、steering、重试与 compaction 都能在没有 provider key 的前提下测到。各 smoke 使用：
// `node scripts/smoke-session.ts`。
//
// 它住在 scripts/ 而不是 `packages/core/src/llm` 下那份 vendored transport 里，因为它是本应用
// 的测试替身，不是别人的。
// pi-ai 自带一个 faux provider，但它建立在本应用已不再有的 provider registry 之上——它把自己
// 注册进一个 `Models` 集合，而那正是被移除的那层间接。剩下要 fake 的是一台 transport，所以
// 这个替身就是一个带两个方法的对象。
import {
	createAssistantMessageEventStream,
	getSystemMessageText,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type ChatTransport,
	type Context,
	type ImageContent,
	type Message,
	type Model,
	type ThinkingLevel,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
	type ToolResultMessage,
	type Usage,
} from "@my-agent/core";

const DEFAULT_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEFAULT_MIN_TOKEN_SIZE = 3;
const DEFAULT_MAX_TOKEN_SIZE = 5;

export type FakeContentBlock = TextContent | ThinkingContent | ToolCall;

export function fakeText(text: string): TextContent {
	return { type: "text", text };
}

export function fakeThinking(thinking: string): ThinkingContent {
	return { type: "thinking", thinking };
}

export function fakeToolCall(name: string, arguments_: ToolCall["arguments"], options: { id?: string } = {}): ToolCall {
	return { type: "toolCall", id: options.id ?? randomId("tool"), name, arguments: arguments_ };
}

function normalizeContent(content: string | FakeContentBlock | FakeContentBlock[]): FakeContentBlock[] {
	if (typeof content === "string") return [fakeText(content)];
	return Array.isArray(content) ? content : [content];
}

/**
 * 一份剧本化的回答。
 *
 * 这里写的 `api` 与 `model` 是占位符：每份回答都会被重新盖上请求所用模型自己的戳，剧本步骤
 * 无须知道自己在替哪一行作答。
 */
export function fakeAssistantMessage(
	content: string | FakeContentBlock | FakeContentBlock[],
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		responseId?: string;
		timestamp?: number;
		thinkingLevel?: ThinkingLevel;
	} = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: normalizeContent(content),
		api: "anthropic-messages",
		model: "fake",
		usage: DEFAULT_USAGE,
		stopReason: options.stopReason ?? "stop",
		...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
		...(options.responseId === undefined ? {} : { responseId: options.responseId }),
		timestamp: options.timestamp ?? nextStamp(),
	};
}

export interface FakeState {
	callCount: number;
	/** 每个请求携带的 key，按调用顺序，从请求所用模型上读取。 */
	apiKeys: (string | undefined)[];
	/**
	 * 每个请求携带的 thinking 等级，按调用顺序，从同一模型上读取。
	 *
	 * `"off"` 代表一个根本没指名等级的模型，两者是同一个请求：什么都没要求。等级骑在模型上
	 * 而不是 options 里，所以这是检查能看到"一个请求本来会被要求在什么等级上"的唯一地方。
	 */
	thinkingLevels: ThinkingLevel[];
}

export type FakeResponseFactory = (
	context: Context,
	options: SimpleStreamOptions | undefined,
	fakeState: FakeState,
	model: Model<string>,
) => AssistantMessage | Promise<AssistantMessage>;

export type FakeResponseStep = AssistantMessage | FakeResponseFactory;

export interface FakeTransportOptions {
	/** 延迟每个 chunk 以模拟慢回答；不设即"microtask 队列能跑多快就多快"。 */
	tokensPerSecond?: number;
	/** delta 被切成的 chunk 大小，让流式可见而不是一大口推出来。 */
	tokenSize?: { min?: number; max?: number };
}

export interface FakeTransport {
	/** 交给 `openAgent({ api })`。 */
	api: ChatTransport;
	fakeState: FakeState;
	setResponses(responses: FakeResponseStep[]): void;
	appendResponses(responses: FakeResponseStep[]): void;
	getPendingResponseCount(): number;
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function randomId(prefix: string): string {
	return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

// 剧本化的回答都读本模块自己的时钟，同一毫秒内构建的两条消息会带同一个戳——窗口按
// `role:timestamp` 折叠会话条目，共享的戳会让它把一条消息折进另一条（16；07 拍截图时
// 撞上过）。所以这个戳是替身自己的序列：单调递增，就像 session 的 `nextStamp`。
let lastStamp = 0;

function nextStamp(): number {
	lastStamp = Math.max(Date.now(), lastStamp + 1);
	return lastStamp;
}

function contentToText(content: string | Array<TextContent | ImageContent>): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => (block.type === "text" ? block.text : `[image:${block.mimeType}:${block.data.length}]`))
		.join("\n");
}

function assistantContentToText(content: Array<TextContent | ThinkingContent | ToolCall>): string {
	return content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "thinking") return block.thinking;
			return `${block.name}:${JSON.stringify(block.arguments)}`;
		})
		.join("\n");
}

function toolResultToText(message: ToolResultMessage): string {
	return [message.toolName, ...message.content.map((block) => contentToText([block]))].join("\n");
}

function messageToText(message: Message): string {
	if (message.role === "system") return getSystemMessageText(message);
	if (message.role === "user") return contentToText(message.content);
	if (message.role === "assistant") return assistantContentToText(message.content);
	return toolResultToText(message);
}

function serializeContext(context: Context): string {
	const tools = context.tools.map((tool) => `tool:${JSON.stringify(tool)}`);
	const messages = context.messages.map((message) => `${message.role}:${messageToText(message)}`);
	return [...tools, ...messages].join("\n\n");
}

/**
 * 为回答填一个 token 数。
 *
 * 缓存读与缓存写保持为零：这个替身从队列作答而不是从 provider 作答，没有 prompt-cache 身份
 * 可以用来模拟。
 */
function withUsageEstimate(message: AssistantMessage, context: Context): AssistantMessage {
	const input = estimateTokens(serializeContext(context));
	const outputTokens = estimateTokens(assistantContentToText(message.content));

	return {
		...message,
		usage: {
			input,
			output: outputTokens,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + outputTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function splitStringByTokenSize(text: string, minTokenSize: number, maxTokenSize: number): string[] {
	const chunks: string[] = [];
	let index = 0;
	while (index < text.length) {
		const tokenSize = minTokenSize + Math.floor(Math.random() * (maxTokenSize - minTokenSize + 1));
		const charSize = Math.max(1, tokenSize * 4);
		chunks.push(text.slice(index, index + charSize));
		index += charSize;
	}
	return chunks.length > 0 ? chunks : [""];
}

/** 把一份剧本化回答重新盖成*这个*请求的回答的戳，无论哪一行问的。 */
function cloneMessage(message: AssistantMessage, model: Model<string>): AssistantMessage {
	const cloned = structuredClone(message);
	return {
		...cloned,
		api: model.api,
		model: model.id,
		timestamp: cloned.timestamp ?? nextStamp(),
		usage: cloned.usage ?? DEFAULT_USAGE,
	};
}

function createErrorMessage(error: unknown, model: Model<string>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		model: model.id,
		usage: DEFAULT_USAGE,
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: nextStamp(),
	};
}

function createAbortedMessage(partial: AssistantMessage): AssistantMessage {
	return { ...partial, stopReason: "aborted", errorMessage: "Request was aborted", timestamp: nextStamp() };
}

function scheduleChunk(chunk: string, tokensPerSecond: number | undefined): Promise<void> {
	if (!tokensPerSecond || tokensPerSecond <= 0) return new Promise((resolve) => queueMicrotask(resolve));
	const delayMs = (estimateTokens(chunk) / tokensPerSecond) * 1000;
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** 把一份回答按真实 transport 发送的 delta 事件播完，全程尊重 `signal`。 */
async function streamWithDeltas(
	stream: AssistantMessageEventStream,
	message: AssistantMessage,
	minTokenSize: number,
	maxTokenSize: number,
	tokensPerSecond: number | undefined,
	signal: AbortSignal | undefined,
): Promise<void> {
	const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
	if (signal?.aborted) {
		const aborted = createAbortedMessage(partial);
		stream.push({ type: "error", reason: "aborted", error: aborted });
		stream.end(aborted);
		return;
	}

	stream.push({ type: "start", partial: { ...partial } });

	for (let index = 0; index < message.content.length; index++) {
		if (signal?.aborted) {
			const aborted = createAbortedMessage(partial);
			stream.push({ type: "error", reason: "aborted", error: aborted });
			stream.end(aborted);
			return;
		}

		// 这个下标是本循环对 `message.content` 自己的计数器，条目一定在；说一次，下面的每次
		// narrowing 都不必重新证明。
		const block = message.content[index];
		if (block === undefined) continue;

		if (block.type === "thinking") {
			partial.content = [...partial.content, { type: "thinking", thinking: "" }];
			stream.push({ type: "thinking_start", contentIndex: index, partial: { ...partial } });
			for (const chunk of splitStringByTokenSize(block.thinking, minTokenSize, maxTokenSize)) {
				await scheduleChunk(chunk, tokensPerSecond);
				if (signal?.aborted) {
					const aborted = createAbortedMessage(partial);
					stream.push({ type: "error", reason: "aborted", error: aborted });
					stream.end(aborted);
					return;
				}
				(partial.content[index] as ThinkingContent).thinking += chunk;
				stream.push({ type: "thinking_delta", contentIndex: index, delta: chunk, partial: { ...partial } });
			}
			stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: { ...partial } });
			continue;
		}

		if (block.type === "text") {
			partial.content = [...partial.content, { type: "text", text: "" }];
			stream.push({ type: "text_start", contentIndex: index, partial: { ...partial } });
			for (const chunk of splitStringByTokenSize(block.text, minTokenSize, maxTokenSize)) {
				await scheduleChunk(chunk, tokensPerSecond);
				if (signal?.aborted) {
					const aborted = createAbortedMessage(partial);
					stream.push({ type: "error", reason: "aborted", error: aborted });
					stream.end(aborted);
					return;
				}
				(partial.content[index] as TextContent).text += chunk;
				stream.push({ type: "text_delta", contentIndex: index, delta: chunk, partial: { ...partial } });
			}
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: { ...partial } });
			continue;
		}

		partial.content = [...partial.content, { type: "toolCall", id: block.id, name: block.name, arguments: {} }];
		stream.push({ type: "toolcall_start", contentIndex: index, partial: { ...partial } });
		for (const chunk of splitStringByTokenSize(JSON.stringify(block.arguments), minTokenSize, maxTokenSize)) {
			await scheduleChunk(chunk, tokensPerSecond);
			if (signal?.aborted) {
				const aborted = createAbortedMessage(partial);
				stream.push({ type: "error", reason: "aborted", error: aborted });
				stream.end(aborted);
				return;
			}
			stream.push({ type: "toolcall_delta", contentIndex: index, delta: chunk, partial: { ...partial } });
		}
		(partial.content[index] as ToolCall).arguments = block.arguments;
		stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: { ...partial } });
	}

	if (message.stopReason === "pending") throw new Error("Fake response ended without a stop reason");
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		stream.push({ type: "error", reason: message.stopReason, error: message });
		stream.end(message);
		return;
	}

	stream.push({ type: "done", reason: message.stopReason, message });
	stream.end(message);
}

/**
 * 一个从队列里作答的 transport。
 *
 * 每次调用 shift 一步。空队列是一个错误消息而不是挂起，这样耗尽剧本回答的 smoke 会在需要答案的
 * 那条断言上失败，而不是在 watchdog 上失败。
 */
export function createFakeTransport(options: FakeTransportOptions = {}): FakeTransport {
	const minTokenSize = Math.max(
		1,
		Math.min(options.tokenSize?.min ?? DEFAULT_MIN_TOKEN_SIZE, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE),
	);
	const maxTokenSize = Math.max(minTokenSize, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE);
	const tokensPerSecond = options.tokensPerSecond;
	const fakeState: FakeState = { callCount: 0, apiKeys: [], thinkingLevels: [] };
	let pendingResponses: FakeResponseStep[] = [];

	const resolveResponse = async (
		step: FakeResponseStep,
		context: Context,
		streamOptions: SimpleStreamOptions | undefined,
		requestModel: Model<string>,
	): Promise<AssistantMessage> => {
		const resolved = typeof step === "function" ? await step(context, streamOptions, fakeState, requestModel) : step;
		return withUsageEstimate(cloneMessage(resolved, requestModel), context);
	};

	const stream = (requestModel: Model<string>, context: Context, streamOptions?: SimpleStreamOptions) => {
		const outer = createAssistantMessageEventStream();
		const step = pendingResponses.shift();
		fakeState.callCount++;
		// 在这里记录而不是在调用点断言：key 与 thinking 等级骑在 host 为本次请求构建的模型上，
		// 所以这是检查能看到"一个请求实际会发送什么"的唯一地方。
		fakeState.apiKeys.push(requestModel.apiKey);
		fakeState.thinkingLevels.push(requestModel.thinkingLevel ?? "off");

		queueMicrotask(async () => {
			try {
				if (!step) {
					const message = withUsageEstimate(
						createErrorMessage(new Error("No more fake responses queued"), requestModel),
						context,
					);
					outer.push({ type: "error", reason: "error", error: message });
					outer.end(message);
					return;
				}
				const message = await resolveResponse(step, context, streamOptions, requestModel);
				await streamWithDeltas(outer, message, minTokenSize, maxTokenSize, tokensPerSecond, streamOptions?.signal);
			} catch (error) {
				const message = createErrorMessage(error, requestModel);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			}
		});

		return outer;
	};

	return {
		api: {
			stream: (model, context, streamOptions) => stream(model, context, streamOptions),
		},
		fakeState,
		setResponses(responses: FakeResponseStep[]) {
			pendingResponses = [...responses];
		},
		appendResponses(responses: FakeResponseStep[]) {
			pendingResponses.push(...responses);
		},
		getPendingResponseCount() {
			return pendingResponses.length;
		},
	};
}
