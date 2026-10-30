// Vendored from @earendil-works/pi-agent-core (0.99.2) with the engine renamed against upstream:
// Agent → Loop, AgentState → LoopState, AgentOptions → LoopOptions, AgentInitialState →
// LoopInitialState; diff against pi-main with those in mind. `prepareNextTurn` (and Loop's
// `prepareNextTurnWithContext`) are deleted here: no host in this workspace ever installed them, so
// the turn boundary is just `turn_end` followed by `turn_start`; `finishTurn` is deleted for the
// same reason, which leaves the loop no `end`/`continue` decision — a run ends exactly when there
// are no tool calls and no queued messages. The `continue` entry went with them (`Loop.continue`,
// `runAgentLoopContinue`, and the `agentLoop`/`agentLoopContinue` stream wrappers: nothing called
// them), and `runLoop` is merged into the run entry, leaving one entry and one exit. The run's
// prompts occupy the first drain point, so upstream's opening steering poll is gone too: steering
// is polled at the end of each turn and first surfaces after the first response. Also deleted
// here: the `transformContext` and `toolExecution` config fields, which this host never sets;
// tool batches run parallel unless a tool declares `executionMode`.
//
// Local restructuring: agent-loop.ts was merged into this file as the single public `runLoop`
// method — the engine body (upstream's free function `runAgentLoop`) and the run lifecycle
// wrapper are one entry and one exit. It reads `streamFunction` and the tool-call hooks off
// `this` and dispatches events through `this.dispatchEvent`. "prompt" is deliberately not a
// loop concept — that word belongs to the session layer (`Agent.prompt`); the loop takes
// messages the caller already assembled. The tool-call helpers stay file-scope functions
// because they need no instance state; `runToolCall` remains exported for tools that call
// other tools.
//
// Checked by packages/loop/tsconfig.json under pi's own compiler settings; @ts-nocheck keeps
// the workspace's stricter root config from flagging this file, while every import into
// packages/core stays fully checked.
// @ts-nocheck
import {
	type AssistantMessage,
	type LlmContext,
	type Message,
	Model,
	type ToolResultMessage,
	toToolDeclaration,
	validateToolArguments,
} from "@my-agent/llm";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	LoopContext,
	AgentEvent,
	LoopConfig,
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
	BeforeToolCallContext,
	BeforeToolCallResult,
	PrepareRequest,
	StreamFn,
} from "./types.ts";

export type { QueueMode } from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * The model a run falls back on when nothing ever names one.
 *
 * Only reachable for a run that was never seeded and whose `prepareRequest` returned no model, so it
 * exists to keep a synthesized failure message from reading a field off nothing. It is a real `Model`
 * because the class carries a `stream()` and cannot be imitated by an object literal.
 */
const DEFAULT_MODEL = new Model({
	id: "unknown",
	name: "unknown",
	api: "unknown",
	baseUrl: "",
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
});

/** Options for constructing an {@link Loop}. */
export interface LoopOptions {
	streamFn: StreamFn;
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	prepareRequest?: PrepareRequest;
}

/** Queue drain hooks a run pulls at its take points. The queues themselves live with the caller. */
export interface LoopQueueHooks {
	getSteeringMessages?: () => Promise<Message[]>;
	getFollowUpMessages?: () => Promise<Message[]>;
}

/**
 * What one run is handed, on top of the context and prompts.
 */
export type RunLoopOptions = LoopQueueHooks & {
	/** The model the run starts with. `prepareRequest` can replace it per request. */
	model: Model<any>;
};

type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
};

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = AgentToolCallOutcome;

/** The `beforeToolCall` and `afterToolCall` hooks of {@link LoopConfig}. */
export type ToolCallHooks = Pick<LoopConfig, "beforeToolCall" | "afterToolCall">;

type ToolUpdateSink = (partialResult: AgentToolResult<any>) => Promise<void> | void;

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

/**
 * Stream an assistant response from the LLM.
 */
async function streamAssistantResponse(
	context: LoopContext,
	model: Model<any>,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<AssistantMessage> {
	// Tools reach the request as a parameter, not as a message, so the executable set this run holds
	// is declared here: `toToolDeclaration` keeps the name, description, and schema and drops the rest.
	// The system prompt stays where the caller put it — a leading system message — and the transport
	// reads it from there when the request carries no explicit `system`.
	const llmContext: LlmContext = {
		messages: context.messages,
		tools: context.tools?.map((tool) => toToolDeclaration(tool)),
	};

	// The key rides on the model, and the stream function is the model's own `stream` in this build —
	// so the request is authed with exactly the key the model carries, and a stream function that
	// wanted a key from somewhere else would have to reach past the object it was handed.
	const response = await streamFunction(model, llmContext, {
		apiKey: model.apiKey,
		signal,
	});
	// Record the requested level, whichever stream function answered. It is read off the model the
	// request was made with, so the transcript cannot report a strength the wire never carried.
	const result = async () =>
		Object.assign(await response.result(), { thinkingLevel: model.thinkingLevel ?? "off" });

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: LoopContext,
	assistantMessage: AssistantMessage,
	config: LoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

async function executeToolCallsSequential(
	currentContext: LoopContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emitToolExecutionUpdate(toolCall, emit));
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: LoopContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			if (signal?.aborted) {
				const finalized = {
					toolCall,
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				} satisfies FinalizedToolCallOutcome;
				await emitToolExecutionEnd(finalized, emit);
				return finalized;
			}
			const executed = await executePreparedToolCall(preparation, signal, emitToolExecutionUpdate(toolCall, emit));
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: LoopContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
	tools: readonly AgentTool<any>[] = currentContext.tools ?? [],
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

function emitToolExecutionUpdate(toolCall: AgentToolCall, emit: AgentEventSink): ToolUpdateSink {
	return (partialResult) =>
		emit({
			type: "tool_execution_update",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
			partialResult,
		});
}

/** Options for {@link runToolCall}. */
export interface RunToolCallOptions extends ToolCallHooks {
	/** Tools the call resolves against. */
	tools: readonly AgentTool<any>[];
	/** Passed to the hooks as the message that issued the call. */
	assistantMessage: AssistantMessage;
	/** Passed to the hooks as the current agent context. */
	context: LoopContext;
	signal?: AbortSignal;
	onUpdate?: ToolUpdateSink;
}

/**
 * Run one tool call through the same steps as a model-issued call: argument preparation, schema
 * validation, `beforeToolCall`, execution, and `afterToolCall`. Emits no events and adds no
 * messages. Tools that call other tools use this so the hooks (for example permission checks)
 * apply to those calls too.
 *
 * Never rejects for tool failures: unknown tools, validation errors, blocked calls, and thrown
 * errors come back as `isError: true`.
 */
export async function runToolCall(toolCall: AgentToolCall, options: RunToolCallOptions): Promise<AgentToolCallOutcome> {
	const { assistantMessage, context, signal } = options;
	const preparation = await prepareToolCall(context, assistantMessage, toolCall, options, signal, options.tools);
	if (preparation.kind === "immediate") {
		return { toolCall, result: preparation.result, isError: preparation.isError };
	}
	const executed = await executePreparedToolCall(preparation, signal, options.onUpdate ?? (() => {}));
	return finalizeExecutedToolCall(context, assistantMessage, preparation, executed, options, signal);
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	onUpdate: ToolUpdateSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(Promise.resolve(onUpdate(partialResult)));
			},
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: result.isError === true };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}

async function finalizeExecutedToolCall(
	currentContext: LoopContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				// Structured content not replaced along with the content may no longer match it.
				const structuredContent =
					afterResult.structuredContent ?? (afterResult.content ? undefined : result.structuredContent);
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				if (structuredContent === undefined) delete result.structuredContent;
				else result.structuredContent = structuredContent;
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}

/**
 * Run engine around the low-level agent loop.
 *
 * The loop holds no conversation state: the caller owns the transcript, the
 * tools, and the model, and hands them over per run through `runLoop`. What it
 * does hold is execution machinery — the active run with its abort signal, the
 * idle promise, the event dispatch to subscribers, and the engine itself,
 * which is the body of {@link Loop.runLoop}.
 */
export class Loop {
	private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();

	public streamFunction: StreamFn;
	public beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	public afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
	public prepareRequest?: PrepareRequest;
	private activeRun?: ActiveRun;
	/**
	 * The static half of the loop config — the hooks that are fixed for the
	 * Loop's lifetime, assembled once in the constructor. The per-run half
	 * (`model` and the queue drain hooks, which live with the caller) is
	 * spread in at {@link Loop.runLoop}.
	 */
	private readonly baseConfig: Pick<LoopConfig, "beforeToolCall" | "afterToolCall" | "prepareRequest">;
	/**
	 * The model the current run is being made with.
	 *
	 * Seeded from `runLoop` and refreshed whenever a `prepareRequest` replaces
	 * it, so a synthesized failure message names the model the request actually
	 * went out with, not the one the run started from.
	 */
	private runModel: Model<any> = DEFAULT_MODEL;

	constructor(options: LoopOptions) {
		// Older compiled consumers may omit options or streamFn even though the current API requires them.
		const runtimeOptions: Partial<LoopOptions> = options ?? {};
		if (!runtimeOptions.streamFn) {
			throw new Error("Loop requires streamFn. Pass streamFn explicitly when constructing Loop.");
		}
		this.streamFunction = runtimeOptions.streamFn;
		this.beforeToolCall = runtimeOptions.beforeToolCall;
		this.afterToolCall = runtimeOptions.afterToolCall;
		this.prepareRequest = runtimeOptions.prepareRequest;
		this.baseConfig = {
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			// Wrapped rather than passed through so a model a prepareRequest
			// replaces per request is what a synthesized failure message names.
			prepareRequest:
				this.prepareRequest === undefined
					? undefined
					: async (input, signal) => {
							const update = await this.prepareRequest?.(input, signal);
							if (update?.model !== undefined) this.runModel = update.model;
							return update;
						},
		};
	}

	/**
	 * Subscribe to agent lifecycle events.
	 *
	 * Listener promises are awaited in subscription order and are included in
	 * the current run's settlement. Listeners also receive the active abort
	 * signal for the current run.
	 *
	 * `agent_end` is the final emitted event for a run, but the loop does not
	 * become idle until all awaited listeners for that event have settled.
	 */
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Active abort signal for the current run, if any. */
	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	/** Abort the current run, if one is active. */
	abort(): void {
		this.activeRun?.abortController.abort();
	}

	/**
	 * Resolve when the current run and all awaited event listeners have finished.
	 *
	 * This resolves after `agent_end` listeners settle.
	 */
	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	/**
	 * Run the loop over the prompt the caller has already assembled.
	 *
	 * `prompt` is the message that starts the run — the one user message that
	 * triggered it. It enters the transcript at the first drain point, exactly
	 * where a steered message enters on a later turn. The context and the
	 * model are handed over per run and never kept: the engine works on its
	 * own shallow copy of the context and mutates only that. Returns the
	 * messages the run produced.
	 */
	async runLoop(
		context: LoopContext,
		prompt: Message,
		options: RunLoopOptions,
	): Promise<Message[]> {
		if (this.activeRun) {
			throw new Error(
				"Loop is already processing a run. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}

		const abortController = new AbortController();
		let resolvePromise = () => {};
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		this.activeRun = { promise, resolve: resolvePromise, abortController };
		this.runModel = options.model;

		try {
			// `let`: a prepareRequest update rewrites the model mid-run.
			let model = options.model;
			const streamFunction = this.streamFunction;
			const signal = abortController.signal;

			const newMessages: Message[] = [];
			let currentContext: LoopContext = {
				messages: context.messages.slice(),
				tools: context.tools.slice(),
			};

			await this.dispatchEvent({ type: "agent_start" });

			// The run's prompt occupies the first drain point: every turn — the first one
			// included — is `turn_start`, then a drain, then a request. Steering is polled at the end of
			// each turn, so the earliest a steered message can surface is after the first response.
			let pendingMessages: Message[] = [prompt];

			// Outer loop: continues when queued follow-up messages arrive after agent would stop
			while (true) {
				let hasMoreToolCalls = true;

				// Inner loop: process tool calls and steering messages
				while (hasMoreToolCalls || pendingMessages.length > 0) {
					await this.dispatchEvent({ type: "turn_start" });

					// Process queued messages before the next assistant response. The run's own prompts drain
					// here on the first turn, exactly where a steered message drains on a later one.
					for (const message of pendingMessages) {
						await this.dispatchEvent({ type: "message_start", message });
						await this.dispatchEvent({ type: "message_end", message });
						currentContext.messages.push(message);
						newMessages.push(message);
					}
					pendingMessages = [];

					const requestUpdate = await this.baseConfig.prepareRequest?.(
						{ context: currentContext, model },
						signal,
					);
					if (requestUpdate) {
						currentContext = requestUpdate.context ?? currentContext;
						model = requestUpdate.model ?? model;
					}

					// Stream assistant response
					const message = await streamAssistantResponse(currentContext, model, signal, this.dispatchEvent, streamFunction);
					newMessages.push(message);

					if (message.stopReason === "error" || message.stopReason === "aborted") {
						await this.dispatchEvent({ type: "turn_end", message, toolResults: [] });
						await this.dispatchEvent({ type: "agent_end", messages: newMessages });
						return newMessages;
					}

					// Check for tool calls
					const toolCalls = message.content.filter((c) => c.type === "toolCall");

					const toolResults: ToolResultMessage[] = [];
					hasMoreToolCalls = false;
					if (toolCalls.length > 0) {
						// A "length" stop means the output was cut off by the token limit, so
						// every tool call in the message may carry truncated arguments. Fail
						// them all instead of executing potentially borked calls.
						const executedToolBatch =
							message.stopReason === "length"
							? await failToolCallsFromTruncatedMessage(toolCalls, this.dispatchEvent)
							: await executeToolCalls(currentContext, message, this.baseConfig, signal, this.dispatchEvent);
						toolResults.push(...executedToolBatch.messages);
						hasMoreToolCalls = !executedToolBatch.terminate;

						for (const result of toolResults) {
							currentContext.messages.push(result);
							newMessages.push(result);
						}
					}

					await this.dispatchEvent({ type: "turn_end", message, toolResults });

					pendingMessages = (await options.getSteeringMessages?.()) || [];
				}

				// Loop would stop here. Check for follow-up messages.
				const followUpMessages = (await options.getFollowUpMessages?.()) || [];
				if (followUpMessages.length > 0) {
					// Set as pending so inner loop processes them
					pendingMessages = followUpMessages;
					continue;
				}

				// No more messages, exit
				break;
			}

			await this.dispatchEvent({ type: "agent_end", messages: newMessages });
			return newMessages;
		} catch (error) {
			// A throw outside the engine's own error encoding — a bug in the engine,
			// or a subscriber that escaped the event contract — still surfaces as a
			// complete event stream so subscribers see a terminal state.
			await this.handleRunFailure(error, abortController.signal.aborted);
			return [];
		} finally {
			this.finishRun();
		}
	}

	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		const failureMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: this.runModel.api,
			model: this.runModel.id,
			usage: EMPTY_USAGE,
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		} satisfies Message;
		await this.dispatchEvent({ type: "message_start", message: failureMessage });
		await this.dispatchEvent({ type: "message_end", message: failureMessage });
		await this.dispatchEvent({ type: "turn_end", message: failureMessage, toolResults: [] });
		await this.dispatchEvent({ type: "agent_end", messages: [failureMessage] });
	}

	private finishRun(): void {
		this.activeRun?.resolve();
		this.activeRun = undefined;
	}

	/**
	 * Await every listener for a loop event, in subscription order.
	 *
	 * `agent_end` only means no further loop events will be emitted. The run is
	 * considered idle later, after these listeners finish and `finishRun()`
	 * clears the active run.
	 *
	 * An arrow property rather than a method: the engine calls it directly and
	 * hands it to the file-scope helpers as a plain sink, so `this` has to be
	 * bound at definition time.
	 */
	private readonly dispatchEvent = async (event: AgentEvent): Promise<void> => {
		const signal = this.activeRun?.abortController.signal;
		if (!signal) {
			throw new Error("Loop listener invoked outside active run");
		}
		for (const listener of this.listeners) {
			await listener(event, signal);
		}
	};
}
