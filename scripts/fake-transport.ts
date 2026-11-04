// The scripted transport the smokes drive: a `ChatTransport` that answers from a queue instead of the
// network, so streaming, queueing, steering, retries, and compaction are testable with no provider
// key. Run with any smoke: `node scripts/smoke-session.ts`.
//
// It lives here rather than in the vendored transport under `packages/core/src/llm` because it is
// this app's test double and nothing else's.
// pi-ai ships a faux provider, but it was built on the provider registry this app no longer has — it
// registered itself into a `Models` collection, which is exactly the indirection that was removed.
// What is left to fake is one transport, so the double is one object with two methods.
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
 * One scripted answer.
 *
 * The `api` and `model` written here are placeholders: every answer is re-stamped with the request
 * model's own, so a scripted step never has to know which row it is answering for.
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
	/** The key each request carried, in call order, read off the model the request was made with. */
	apiKeys: (string | undefined)[];
	/**
	 * The thinking level each request carried, in call order, read off the same model.
	 *
	 * `"off"` stands for a model that named no level at all, which is the same request: nothing was
	 * asked for. The level rides on the model rather than in the options, so this is the only place a
	 * check can see what a request would have been asked at.
	 */
	thinkingLevels: ThinkingLevel[];
}

export type FakeResponseFactory = (
	context: Context,
	options: SimpleStreamOptions | undefined,
	state: FakeState,
	model: Model<string>,
) => AssistantMessage | Promise<AssistantMessage>;

export type FakeResponseStep = AssistantMessage | FakeResponseFactory;

export interface FakeTransportOptions {
	/** Delay each chunk to simulate a slow answer; unset means "as fast as the microtask queue". */
	tokensPerSecond?: number;
	/** Chunk sizes deltas are split into, so streaming is visible rather than one big push. */
	tokenSize?: { min?: number; max?: number };
}

export interface FakeTransport {
	/** Hand this to `openAgent({ api })`. */
	api: ChatTransport;
	state: FakeState;
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

// Scripted answers all read this module's clock, so two messages built in the same millisecond
// would carry one stamp — the window folds transcript items by `role:timestamp`, and a shared
// stamp makes it fold one message over the other (16; 07 hit this while shooting screenshots).
// The stamp is the double's own sequence, then: monotonic, like the session's `nextStamp`.
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
 * Fill in a token count for the answer.
 *
 * Cache reads and writes stay zero: this double answers from a queue rather than a provider, and it
 * has no prompt-cache identity to key a simulation by.
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

/** Re-stamp a scripted answer as the answer to *this* request, whichever row asked. */
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

/** Play one answer out as the delta events a real transport sends, honouring `signal` throughout. */
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

		// The index is this loop's own counter over `message.content`, so the entry is there; saying so
		// once keeps every narrowing below from having to re-prove it.
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
 * A transport that answers from a queue.
 *
 * Every call shifts one step. An empty queue is an error message rather than a hang, so a smoke that
 * runs out of scripted answers fails at the assertion that needed one instead of at the watchdog.
 */
export function createFakeTransport(options: FakeTransportOptions = {}): FakeTransport {
	const minTokenSize = Math.max(
		1,
		Math.min(options.tokenSize?.min ?? DEFAULT_MIN_TOKEN_SIZE, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE),
	);
	const maxTokenSize = Math.max(minTokenSize, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE);
	const tokensPerSecond = options.tokensPerSecond;
	const state: FakeState = { callCount: 0, apiKeys: [], thinkingLevels: [] };
	let pendingResponses: FakeResponseStep[] = [];

	const resolveResponse = async (
		step: FakeResponseStep,
		context: Context,
		streamOptions: SimpleStreamOptions | undefined,
		requestModel: Model<string>,
	): Promise<AssistantMessage> => {
		const resolved = typeof step === "function" ? await step(context, streamOptions, state, requestModel) : step;
		return withUsageEstimate(cloneMessage(resolved, requestModel), context);
	};

	const stream = (requestModel: Model<string>, context: Context, streamOptions?: SimpleStreamOptions) => {
		const outer = createAssistantMessageEventStream();
		const step = pendingResponses.shift();
		state.callCount++;
		// Recorded here rather than asserted at the call site: the key and the thinking level ride on the
		// model a host built for this request, so this is the one place a check can see what a request
		// would actually have sent.
		state.apiKeys.push(requestModel.apiKey);
		state.thinkingLevels.push(requestModel.thinkingLevel ?? "off");

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
		state,
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
