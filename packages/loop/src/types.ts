// Vendored from @earendil-works/pi-agent-core (0.99.2) with the engine renamed against upstream:
// Agent → Loop, AgentState → LoopState, AgentOptions → LoopOptions, AgentInitialState →
// LoopInitialState; diff against pi-main with those in mind. `prepareNextTurn`, and the
// `AgentLoopTurnUpdate` / `PrepareNextTurnContext` types only it used, are deleted here — the
// loop engine itself now lives on `Loop` in loop.ts. Also deleted here: the `transformContext`
// and `toolExecution` fields of LoopConfig, which this host never sets. Checked by
// packages/loop/tsconfig.json under pi's own compiler settings; @ts-nocheck keeps the
// workspace's stricter root config from flagging this file, while every import into
// packages/core stays fully checked.
// @ts-nocheck
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	LlmContext,
	ImageContent,
	JsonValue,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
	Usage,
} from "@my-agent/llm";
import type { Static, TSchema } from "typebox";

/**
 * Stream function used by the agent loop. A `ChatTransport`'s `stream`
 * satisfies this shape, as does the retry wrapper a host puts around one.
 *
 * The loop passes a normalized transcript: the system prompt and the complete current tool
 * list are carried by the transcript's leading system message. Tool loadout changes are never
 * sent as a later system message, so a transport reads the tool list from that leading message
 * and resends the whole list when it differs from the previous request.
 *
 * Contract:
 * - Must not throw or return a rejected promise for request/model/runtime failures.
 * - Must return an AssistantMessageEventStream.
 * - Failures must be encoded in the returned stream via protocol events and a
 *   final AssistantMessage with stopReason "error" or "aborted" and errorMessage.
 */
export type StreamFn = (
	model: Model<Api>,
	context: LlmContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * Configuration for how tool calls from a single assistant message are executed.
 *
 * - "sequential": each tool call is prepared, executed, and finalized before the next one starts.
 * - "parallel": tool calls are prepared sequentially, then allowed tools execute concurrently.
 *   `tool_execution_end` is emitted in tool completion order after each tool is finalized,
 *   while tool-result message artifacts are emitted later in assistant source order.
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * Controls how many queued user messages are injected when the agent loop reaches a queue drain point.
 *
 * - "all": drain and inject every queued message at that point.
 * - "one-at-a-time": drain and inject only the oldest queued message, leaving the rest queued for later drain points.
 */
export type QueueMode = "all" | "one-at-a-time";

/** A single tool call content block emitted by an assistant message. */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * Result returned from `beforeToolCall`.
 *
 * Returning `{ block: true }` prevents the tool from executing. The loop emits an error tool result instead.
 * `reason` becomes the text shown in that error result. If omitted, a default blocked message is used.
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
	/**
	 * Hint that the agent should stop after the current tool batch when this call is blocked.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
	/**
	 * End the run at this call without writing a result for it: the call stays in the transcript
	 * unanswered, and the host resumes it later by handing the answer to a recovery run
	 * (`RunLoopOptions.recovery`). The batch's remaining calls are left unanswered with it, the run
	 * ends without another provider request, and no `tool_execution_*` event is emitted for this call.
	 *
	 * This is the end-restart approval gate's answer (ADR-0006 §5): waiting for a person is not
	 * something a run can do, so the run ends and the answer arrives from outside it. `block` and
	 * `suspend` are alternatives — a result that sets both is treated as a suspend.
	 */
	suspend?: boolean;
}

/**
 * The answer one recovered tool call is resumed with.
 *
 * It is what the approval flow recorded while the call was dangling: a grant re-runs the call through
 * the loop's normal path (gate included), a denial closes the call with `reason` — or, when no reason
 * rides the answer, with the sentence that says the user denied it.
 */
export interface ToolCallAnswer {
	approved: boolean;
	/** For a denial: the sentence the synthesized tool result carries. */
	reason?: string;
}

/**
 * How a run recovers the tool calls a previous run left unanswered.
 *
 * Every run scans its context for dangling calls (a `toolCall` block no tool-result message answers)
 * before its first request, because a provider request that carries one is illegal. What happens to
 * each is fixed: an answer in {@link RunRecoveryOptions.answers} closes the call with itself — a
 * grant re-executes the call, a denial synthesizes its result — and a call no answer names is closed
 * with a synthesized error result when {@link RunRecoveryOptions.enablePendingToolRecovery} allows it.
 */
export interface RunRecoveryOptions {
	/** The answers the approval flow recorded, keyed by tool call id. */
	answers?: Record<string, ToolCallAnswer>;
	/**
	 * Close dangling calls that no answer names with a synthesized error result, so the first request
	 * of the run is provider-legal. Default true. A host that turns this off owns those calls: the run
	 * sends them unanswered and the provider decides what that is worth.
	 */
	enablePendingToolRecovery?: boolean;
}

/**
 * Partial override returned from `afterToolCall`.
 *
 * Merge semantics are field-by-field:
 * - `content`: if provided, replaces the tool result content array in full
 * - `details`: if provided, replaces the tool result details value in full
 * - `isError`: if provided, replaces the tool result error flag
 * - `usage`: if provided, replaces the tool result usage
 * - `terminate`: if provided, replaces the early-termination hint
 * - `structuredContent`: if provided, replaces the structured content. If `content` is provided
 *   without it, the structured content is dropped, because it may no longer match the content.
 *   Return it along with `content` to keep it.
 *
 * Other omitted fields keep the original executed tool result values.
 * There is no deep merge for `content`, `details`, or `usage`.
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	structuredContent?: JsonValue;
	isError?: boolean;
	/** Usage from the final tool execution itself, if available. Not used for main LLM context accounting. */
	usage?: Usage;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	args: unknown;
	/** Current agent context at the time the tool call is prepared. */
	context: LoopContext;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	args: unknown;
	/** The executed tool result before any `afterToolCall` overrides are applied. */
	result: AgentToolResult<any>;
	/** Whether the executed tool result is currently treated as an error. */
	isError: boolean;
	/** Current agent context at the time the tool call is finalized. */
	context: LoopContext;
}

/** Replacement runtime state for the provider request being prepared. */
export interface AgentRequestUpdate {
	/** Context for the next provider request. */
	context?: LoopContext;
	/** Model for the next provider request. It carries the thinking level it is asked at. */
	model?: Model<any>;
}

/** Runtime state available immediately before a conversational provider request. */
export interface PrepareRequestContext {
	context: LoopContext;
	model: Model<any>;
}

/**
 * Called immediately before every conversational provider request, including the first.
 * Pending messages have already been appended and emitted when this callback runs.
 */
export type PrepareRequest = (
	request: PrepareRequestContext,
	signal?: AbortSignal,
) => AgentRequestUpdate | void | Promise<AgentRequestUpdate | undefined> | Promise<void>;

export interface LoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * Called immediately before every conversational provider request, including the first.
	 * Pending messages have already been appended. The returned context, model, and thinking level
	 * replace the runtime values for this and later requests in the run. This hook does not poll queues.
	 */
	prepareRequest?: PrepareRequest;

	/**
	 * Returns steering messages to inject into the conversation mid-run.
	 *
	 * Called after the current assistant turn finishes executing its tool calls.
	 * If messages are returned, they are added to the context before the next LLM call.
	 * Tool calls from the current assistant message are not skipped.
	 *
	 * Use this for "steering" the agent while it's working.
	 *
	 * Contract: must not throw or reject. Return [] when no steering messages are available.
	 */
	getSteeringMessages?: () => Promise<Message[]>;

	/**
	 * Returns follow-up messages to process after the agent would otherwise stop.
	 *
	 * Called when the agent has no more tool calls and no steering messages.
	 * If messages are returned, they're added to the context and the agent
	 * continues with another turn.
	 *
	 * Use this for follow-up messages that should wait until the agent finishes.
	 *
	 * Contract: must not throw or reject. Return [] when no follow-up messages are available.
	 */
	getFollowUpMessages?: () => Promise<Message[]>;

	/**
	 * Called before a tool is executed, after arguments have been validated.
	 *
	 * Return `{ block: true }` to prevent execution. The loop emits an error tool result instead.
	 * A blocked result can also set `terminate: true` to participate in the batch early-termination rule.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * Called after a tool finishes executing, before `tool_execution_end` and tool-result message events are emitted.
	 *
	 * Return an `AfterToolCallResult` to override parts of the executed tool result:
	 * - `content` replaces the full content array
	 * - `details` replaces the full details payload
	 * - `isError` replaces the error flag
	 * - `usage` replaces the tool result usage
	 * - `terminate` replaces the early-termination hint
	 *
	 * Any omitted fields keep their original values. No deep merge is performed.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

/** Final or partial result produced by a tool. */
export interface AgentToolResult<T = JsonValue | undefined> {
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

/** Final outcome of a tool call after hooks ran. */
export interface AgentToolCallOutcome {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
}

/**
 * Callback used by tools to stream partial execution updates.
 *
 * The callback is scoped to the current `execute()` invocation. Calls made after
 * the tool promise settles are ignored.
 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/** Tool definition used by the agent runtime. */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
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
	 */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
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

/**
 * Context snapshot passed into the low-level loop: the base {@link Context} shape whose
 * tools are the executable counterparts. The loop runs these; a request only declares them.
 */
export interface LoopContext extends Context {
	/** Tools available for execution in this run. */
	tools?: AgentTool<any>[];
}

/**
 * Events emitted by the Loop for UI updates.
 *
 * `agent_end` is the last event emitted for a run, but awaited `Loop.subscribe()`
 * listeners for that event are still part of run settlement. The agent becomes
 * idle only after those listeners finish.
 */
export type AgentEvent =
	// Loop lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: Message[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: Message; toolResults: ToolResultMessage[] }
	// Message lifecycle - emitted for system, user, assistant, and toolResult messages
	| { type: "message_start"; message: Message }
	// Only emitted for assistant messages during streaming
	| { type: "message_update"; message: Message; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: Message }
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
