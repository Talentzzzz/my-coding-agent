import type { AgentState, Live } from "./session/agent-state.ts";
import type { PendingMessageQueue } from "./session/queues.ts";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	anthropicMessages,
	type ChatTransport,
	createAssistantMessageEventStream,
	createSystemMessage,
	isContextOverflow,
	type JsonValue,
	type LlmContext,
	type Message,
	type RetryCallbacks,
	retryAssistantCall,
	type SimpleStreamOptions,
	toToolDeclaration,
	type ToolResultMessage,
	type Usage,
	validateToolArguments,
} from "@my-agent/llm";
import {
	type AfterToolCallResult,
	type AgentContext,
	type AgentEvent,
	type AgentRequestUpdate,
	type AgentTool,
	type AgentToolCall,
	type AgentToolCallOutcome,
	type AgentToolResult,
	type BeforeToolCallResult,
	type RunRecoveryOptions,
	type ToolCallAnswer,
	type ToolCallHooks,
} from "./types.ts";
import {
	compact as compactTranscript,
	compactionThresholdFor,
	estimateTokens,
	shouldCompact,
	type Summarize,
} from "./context/compaction.ts";
import { trimmableToolArgEntryIds } from "./context/trim-tool-call-args.ts";
import { clearableToolResultIds, isCacheProbablyExpired } from "./context/clear-tool-results.ts";
import { spillOversizedToolResult } from "./context/spill.ts";
import { type AgentsMdFile, loadAgentsMd } from "./context/agents-md.ts";
import { danglingApprovalsOf } from "./session/dangling.ts";
import { boundToolContent, createHooks, type Hooks } from "./hooks.ts";
import {
	type Model,
	type ModelConfig,
	type ModelSource,
	modelFor,
	normalizeThinkingLevel,
	rowFor,
	type ThinkingLevel,
	unconfiguredStream,
} from "./models.ts";
import {
	type ConfigPatch,
	type ModelSelection,
	type PendingApproval,
	type PromptBehavior,
	type QueuedPrompt,
	type SessionSnapshot,
} from "./protocol.ts";
import { sessionSnapshot } from "./session/snapshot.ts";
import {
	type SessionEntry,
	type Session,
	SessionManager,
	sessionEntryToContextMessages,
} from "./session/session-manager.ts";
import { followsGlobalOf, toolStateOf } from "./session/tool-config.ts";
import { getApprovals } from "./settings-manager.ts";
import {
	applySettings,
	getBashSettings,
	getFollowUpMode,
	getRetrySettings,
	getSteeringMode,
} from "./settings-manager.ts";
import { type ToolRegistry, type ToolRunContext, type ToolState } from "./tools/index.ts";

/**
 * The services one orchestrator coordinates, already built by the caller.
 *
 * The session never loads settings, creates a working directory, reads AGENTS.md, or picks a model: every
 * method names a session by id and fetches what it needs, at the line that needs it, from the
 * service that owns it — the transcript from the session manager's cache, the live half from the
 * session's own state, the model from the ledger and the live rows. That is what makes the class
 * stateless (ADR-0007): there is no per-session field here beyond the state table itself, so a test
 * drives a session by assembling its state in the factory and handing it over with `adopt`, and a
 * host that owns the services does the same. `session-factory.ts` does the assembling for the real
 * process.
 *
 * None of these fields is session *state*. The five singletons this orchestrator coordinates — the
 * ledger, the settings, the model rows, the tool definitions, and this class — each hold their own
 * pure-data state (ADR-0006 §1–2); what used to be the `Agent`'s private session fields are gone:
 * the run-time transients are locals of the run (ADR-0006 §5), the approvals are derived from the
 * ledger, the stamps are derived from the file, and the assembly rides the state the open adopted
 * into the table this class holds (ADR-0011).
 */
export interface AgentConfig {
	/**
	 * The stateless session service every transcript read and write goes through.
	 *
	 * A host that owns one — the hub, whose `stateOf` cache must be the same object the session
	 * writes through — hands its own in. Methods resolve a session's bag with `stateOf(id)`, so the
	 * cache is what makes an id answer the one bag every writer shares.
	 */
	sessionManager: SessionManager;
	/**
	 * The user's models, read on every request.
	 *
	 * Handed over rather than copied, because a row is the thing most likely to change while a session
	 * is open: a session that cached one would keep sending a key the user has already corrected, to an
	 * endpoint they have already moved. Reading through this is what makes an edit in the settings panel
	 * reach the next message — the per-request fill re-derives the session's model from the row
	 * it finds here, so the key, the endpoint, the window, and the wire id are all as fresh as the row is.
	 */
	models: ModelSource;
	/**
	 * The tool definitions this build knows, plus whatever a caller registered on it — a test's custom
	 * tool. Structure only: the choice is not here.
	 *
	 * The active set and the approval map are derived from the session's recorded choices — the
	 * `.json` snapshot's current values — on every read (the global default's live view is the
	 * fallback), so nothing mutates when the choice moves. No
	 * directory is resident either: the executable set is built fresh against the run context every
	 * request asks for it, so the workDirAbsPath is a value that arrives with the request and leaves with it.
	 */
	tools: ToolRegistry;
	/**
	 * The transport every model this orchestrator builds carries.
	 *
	 * A model is what a request is made with and the transport is how it is sent, so each model is
	 * constructed with the one it was assembled with, and every one it re-derives from a row
	 * afterwards. Defaults to Anthropic Messages, which is the only one this app speaks. It is
	 * injectable because the smokes drive the real engine against a scripted answer, and a seam that could
	 * not be handed a different transport would mean testing the session through a network.
	 */
	api?: ChatTransport;
	/**
	 * The seams sessions dispatch through: the provider transcript, the approval gate, and the
	 * tool-result backstop. `createSessionAgent` installs the defaults; an orchestrator built without a
	 * hook surface still runs, it just has nothing to dispatch to.
	 */
	hooks?: Hooks;
	/**
	 * Builds the prompt for the tools the model may call, from the session's live settings.
	 *
	 * A function rather than a string because two things it names can change mid-session: the active
	 * tool set, and which of those tools ask for approval. A captured prompt would offer the model tools
	 * the run then refuses to run, or promise an approval the session no longer asks for. It is handed
	 * both answers rather than reaching for them, so the builder never has to know where a session keeps
	 * its choices: `toolNames` is the active set, and `approvals` is the effective approval map — the
	 * whole map the gate reads, including the tools that are not active.
	 *
	 * The working directory arrives the same way, and for the same reason: it is read for the request
	 * that names it — off the session's entry, beside the project instructions read off disk — because
	 * one builder serves every session this process runs (ADR-0007 §6) and has no session of its own
	 * to borrow them from.
	 */
	systemPrompt: (
		workDirAbsPath: string,
		agentsMd: readonly AgentsMdFile[],
		toolNames: readonly string[],
		approvals: Record<string, boolean>,
	) => string;
}

/** Called with the session's state whenever anything a reader can see has moved. */
export type SessionListener = (snapshot: SessionSnapshot) => void;

/**
 * One `message_update` as a session publishes it: the characters that just arrived, not the message.
 *
 * The engine's own event carries both the whole partial message and the provider's delta, and a session
 * used to republish both — so a token at the end of a long answer cost a frame the size of the answer,
 * serialized once here and parsed once in the window, and the window then re-read the whole text to
 * find what changed. What actually moves between two frames is one delta, so that is what is sent.
 * The full message still travels on `message_start` and `message_end`, and once more in a baseline's
 * `partial` for a window that attaches mid-run.
 *
 * The message is named by `timestamp` rather than by entry id: the entry does not exist until the
 * message ends, and the stamp is what a transcript already keys an item on.
 */
export interface MessageDelta {
	timestamp: number;
	/** Which of the two running texts moved; a tool call has its own events and is not a delta. */
	kind: "text" | "thinking";
	/** Where the block sits in the message, so a second block can be joined the way a full message is. */
	contentIndex: number;
	/** The characters that arrived. */
	text: string;
}

/**
 * Everything one session publishes: the engine's events as they arrive, plus the facts the engine has no
 * words for — queue depth, a compaction, an entry landing in the store, a settings change.
 *
 * The union is flat rather than nested, so a consumer keeps one `switch` over event types. That is
 * safe only because no `AgentEvent` type name collides with the names added here: a new session event
 * must therefore never reuse one of the engine's names. `message_update` is the one member deliberately
 * *replaced* rather than added beside the engine's: the session keeps the engine's full-message shape for
 * itself (it is what a mid-run baseline needs) and republishes the delta alone.
 */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "message_update" }>
	| { type: "message_update"; delta: MessageDelta }
	| { type: "queue_update"; queued: QueuedPrompt[] }
	| {
			type: "compaction";
			/** The summary that now stands for everything before `firstKeptEntryId`. */
			summary: string;
			firstKeptEntryId: string;
			/** How many messages were folded into the summary. */
			summarized: number;
			/** The estimated prompt size before the compaction ran. */
			tokensBefore: number;
			/** The estimated prompt size the next request will carry. */
			contextTokens: number;
	  }
	/**
	 * A compaction that was attempted and could not produce a summary; the transcript is unchanged.
	 */
	| { type: "compaction_failed"; message: string }
	| {
			type: "tool_results_cleared";
			/**
			 * Tool results were cleared out of the transcript, and recorded as one `clear_tool_result`
			 * entry.
			 *
			 * Reported because it is invisible otherwise: the entries it names keep their place in the
			 * file, so a reader comparing messages would see the notice appear with nothing to explain it.
			 */
			/** How many tool results were cleared. */
			cleared: number;
			/** The estimated prompt size before the clear. */
			tokensBefore: number;
			/** The estimated prompt size the next request will carry. */
			contextTokens: number;
	  }
	| {
			type: "tool_call_args_trimmed";
			/**
			 * Recorded tool-call arguments were shortened, and recorded as one `trim_tool_call_arg` entry.
			 *
			 * Reported for the same reason `tool_results_cleared` is: the file keeps the full arguments,
			 * and the view drops their bodies, so a reader comparing messages would otherwise see the cut
			 * with nothing to explain it.
			 */
			/** How many entries had their recorded tool-call arguments shortened. */
			trimmed: number;
			/** The estimated prompt size before the trim. */
			tokensBefore: number;
			/** The estimated prompt size the next request will carry. */
			contextTokens: number;
	  }
	| { type: "entry_appended"; entryId: string; kind: SessionEntry["type"] }
	| {
			type: "branch_changed";
			/**
			 * The branch structure changed: the leaf moved, or a message was appended behind one that
			 * already had a continuation — which is the same event, seen from the other side.
			 *
			 * Emitted rather than only answered on the request that asked for it, because neither is the
			 * requesting client's business alone. Every window on this session holds branch points that
			 * came from a snapshot and may be showing a chain that is no longer the active one, so each
			 * stream re-reads the snapshot on this event rather than trusting what it drew before.
			 */
			leafId: string;
	  }
	| {
			type: "config_changed";
			model?: string;
			thinkingLevel?: string;
			approvals?: Record<string, boolean>;
			/** The active tool names, when `setActiveTools` moved them. */
			tools?: string[];
	  }
	/**
	 * A transient provider failure was classified as retryable, before its backoff sleep.
	 */
	| { type: "retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	/**
	 * The backoff ended and the retried provider call is starting.
	 */
	| { type: "retry_start"; attempt: number; maxAttempts: number }
	/**
	 * The retry loop ended, whichever way it ended. Emitted once per scheduled retry.
	 */
	| { type: "retry_end"; success: boolean; attempt: number; finalError?: string };

/** Called with every event the session publishes, in the order they happened. */
export type SessionEventListener = (event: AgentSessionEvent) => void;

/**
 * The transients of one run, as the run's own locals.
 *
 * Superseded in place (ADR-0011): the run now writes these onto the session's live half
 * ({@link Live}), which is what a mid-run reader reaches through, and this bag has no writer left.
 * Kept until the registry entry it typed is deleted (issue 09).
 */
export interface RunScope {
	/**
	 * The assistant message being written right now, as the engine last reported it.
	 *
	 * The engine's `message_update` carries the whole partial message and the session republishes only
	 * its delta — but a window that attaches mid-run has missed every delta so far, so a baseline has
	 * to carry the running text once. Cleared when the message ends, which is also when the store
	 * gains it and a snapshot starts reading it from the transcript instead.
	 */
	partial: Message | undefined;
	/**
	 * The model the run is on, as the request in flight was built from it: the name the composer
	 * shows, and the window the usage meter measures against.
	 *
	 * Here rather than rebuilt per snapshot because publishing must not read a file — `models.list()`
	 * is the disk, and a snapshot is emitted once per delta. A run that has not reached its first
	 * request yet leaves it undefined, and the read falls back to the catalog.
	 */
	model?: Model;
	/**
	 * True when the gate ended this run: a call was left dangling for someone to answer.
	 *
	 * The one end that keeps the queues. Every other end drops what was accepted and never taken —
	 * the send contract is fire-and-forget, and a message nothing will drain must not outlive the run
	 * that took it — but a suspended run is owed an answer to that message by the recovery run, so
	 * dropping it here would throw away something a person typed. See {@link Agent.dropQueued}.
	 */
	suspended: boolean;
	/** True between `retry_scheduled` and `retry_end`: the run is waiting out a backoff. */
	retrying: boolean;
	/** The attempt the policy is on, 1-based, or 0 when no retry is pending. */
	retryAttempt: number;
	retryMaxAttempts: number;
}

/**
 * What one run is started with: the message that opened it, or the answers a resume closes its
 * dangling calls with.
 *
 * The two are alternatives rather than fields that may both be set: a prompted run has nothing to
 * recover but what a crash left behind, and a resumed run has no new message — its first act is the
 * recovery pass over the calls the run before it left unanswered.
 */
type RunStart =
	| { prompt: Message; answers?: undefined }
	| { prompt?: undefined; answers: Record<string, ToolCallAnswer> };

/**
 * The delta an engine `message_update` is worth, or `undefined` for the frames that carry no characters.
 *
 * Start/end frames and tool-call deltas are dropped: a block boundary needs no frame of its own — the
 * first delta of a block is what opens it in the window — and a tool call's card is built from the
 * tool events, which carry the arguments and the result rather than the JSON being assembled. An
 * empty delta is dropped for the same reason: it says nothing a frame could carry.
 */
function messageDeltaOf(event: Extract<AgentEvent, { type: "message_update" }>): MessageDelta | undefined {
	const inner = event.assistantMessageEvent;
	if (inner.type !== "text_delta" && inner.type !== "thinking_delta") return undefined;
	if (inner.delta.length === 0) return undefined;
	const stamp = (event.message as { timestamp?: unknown }).timestamp;
	if (typeof stamp !== "number") return undefined;
	return {
		timestamp: stamp,
		kind: inner.type === "text_delta" ? "text" : "thinking",
		contentIndex: inner.contentIndex,
		text: inner.delta,
	};
}

// ---------------------------------------------------------------------------- the engine
//
// The run engine — one turn loop, one tool batch, one recovery pass — used to be `packages/loop`'s
// `Loop` class. It lives here now because every seam it needs is a seam of the orchestrator below,
// and the package boundary bought nothing but a constructor argument: what the engine actually holds
// is the run in flight, and that is a local of `Agent.runEngine`. So the parts that were instance
// state became members of the orchestrator, and what is left here is stateless machinery — the
// helpers a batch needs, which run outside any instance and take the two tool-call gates as the run's
// own {@link ToolCallHooks}. The recovery machine is exported because it is a contract a smoke drives
// directly (ADR-0006 §5), and the rest is private to this file.

/** Where one run's events go. Awaited, so a run settles only after what it emitted has been handled. */
type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
	/**
	 * The gate suspended the batch: the call it stopped on and every call after it have no result,
	 * and the run ends without another request — the answer the gate waits for comes from outside
	 * any run, and the host resumes the calls through a recovery run.
	 */
	suspended?: boolean;
};

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type SuspendedToolCall = {
	kind: "suspended";
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<unknown>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<unknown>;
	isError: boolean;
};

type ToolUpdateSink = (partialResult: AgentToolResult<unknown>) => Promise<void> | void;

type FinalizedToolCallEntry = AgentToolCallOutcome | (() => Promise<AgentToolCallOutcome>);

/**
 * Stream one assistant response from the model, into the transcript and out through the sink.
 *
 * The model carries its own transport — the run's retry-wrapping one — so this asks the model it was
 * handed and the request is authed with exactly the key that model carries. Tools reach the request
 * as a parameter, not as a message, so the executable set the run holds is declared here:
 * `toToolDeclaration` keeps the name, description, and schema and drops the rest. The system prompt
 * stays where the caller put it — a leading system message — and the transport reads it from there
 * when the request carries no explicit `system`.
 */
async function streamAssistantResponse(
	context: AgentContext,
	model: Model,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<AssistantMessage> {
	const llmContext: LlmContext = {
		messages: context.messages,
		tools: context.tools?.map((tool) => toToolDeclaration(tool)),
	};

	const response = await model.stream(llmContext, {
		apiKey: model.apiKey,
		signal,
	});
	// Record the requested level, whichever stream function answered. It is read off the model the
	// request was made with, so the transcript cannot report a strength the wire never carried.
	// A thunk, not a value: the stream only has a final message once it is drained, and both exits
	// below ask for it after the loop has seen the terminal event.
	const settled = async () =>
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
				const finalMessage = await settled();
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

	const finalMessage = await settled();
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
 * Fail all tool calls from an assistant message that was truncated by the output token limit.
 *
 * Streamed tool-call arguments are finalized with a best-effort JSON salvage parser, so a truncated
 * message can yield tool calls whose arguments parse and validate but are silently incomplete. None of
 * them are safe to execute; report each as an error so the model can re-issue them.
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
		const finalized: AgentToolCallOutcome = {
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

/** One tool call the transcript still waits on: the call block, and the message that issued it. */
export type DanglingToolCall = {
	toolCall: AgentToolCall;
	assistantMessage: AssistantMessage;
};

/**
 * The tool calls in a context that no tool-result message answers, in transcript order.
 *
 * A call dangles when its run ended before the result landed — a crash, or the end-restart approval
 * gate, which leaves the call it stopped on unanswered on purpose. Either way a provider request that
 * carries it is illegal, which is why every run closes what it finds before its first request.
 */
export function danglingToolCallsOf(messages: Message[]): DanglingToolCall[] {
	const calls: DanglingToolCall[] = [];
	const answered = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			answered.add(message.toolCallId);
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			calls.push({ toolCall: block, assistantMessage: message });
		}
	}
	return calls.filter(({ toolCall }) => !answered.has(toolCall.id));
}

/**
 * Close the dangling calls a run was entered with, before its first request.
 *
 * The recovery machine of the end-restart architecture (ADR-0006 §5): an answer closes the call with
 * itself — a grant re-runs the call through the same steps a live batch uses (gate, validation,
 * execution, `afterToolCall`), so the resumed call is indistinguishable from one the model just
 * issued; a denial synthesizes the result its reason names. A call no answer names is closed with a
 * synthesized error result while `enablePendingToolRecovery` allows it. Every closed call emits the
 * events its counterpart in a live batch would, so the window and the store learn of it the same way
 * as any other tool result.
 *
 * A gate that suspends again mid-recovery — the grant this run resumed on did not actually clear it —
 * stops the recovery where it stands: the remaining calls stay dangling and the caller ends the run
 * without a request, exactly as a live batch's suspend does.
 *
 * Exported because it is the one part of the engine a host can drive without a run: the smoke that
 * pins this contract calls it with a transcript and a set of answers, and nothing else.
 */
export async function recoverPendingToolCalls(
	currentContext: AgentContext,
	dangling: DanglingToolCall[],
	recovery: RunRecoveryOptions | undefined,
	hooks: ToolCallHooks,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const answers = recovery?.answers ?? {};
	const enabled = recovery?.enablePendingToolRecovery !== false;
	const messages: ToolResultMessage[] = [];

	for (const { toolCall, assistantMessage } of dangling) {
		const answer = answers[toolCall.id];
		if (answer !== undefined && answer.approved) {
			const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, hooks, signal);
			if (preparation.kind === "suspended") {
				return { messages, terminate: true, suspended: true };
			}
			await emit({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.arguments,
			});
			let finalized: AgentToolCallOutcome;
			if (preparation.kind === "immediate") {
				finalized = { toolCall, result: preparation.result, isError: preparation.isError };
			} else {
				const executed = await executePreparedToolCall(preparation, signal, emitToolExecutionUpdate(toolCall, emit));
				finalized = await finalizeExecutedToolCall(currentContext, assistantMessage, preparation, executed, hooks, signal);
			}
			await emitToolExecutionEnd(finalized, emit);
			const toolResultMessage = createToolResultMessage(finalized);
			await emitToolResultMessage(toolResultMessage, emit);
			messages.push(toolResultMessage);
			continue;
		}
		// Toggle off is the host taking the calls into its own hands: they go to the provider
		// unanswered, and nothing is synthesized for them here.
		if (answer === undefined && !enabled) continue;
		const text =
			answer !== undefined
				? answer.reason ?? `The user denied permission to run ${toolCall.name}.`
				: `Tool call "${toolCall.name}" was left unanswered: the run that issued it ended before a result landed. Issue the call again if it is still needed.`;
		messages.push(await synthesizeToolResult(toolCall, text, emit));
	}
	return { messages, terminate: true };
}

/** Close one unanswered call with a synthesized error result, carrying the events of a live batch. */
async function synthesizeToolResult(
	toolCall: AgentToolCall,
	text: string,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	await emit({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
	});
	const finalized: AgentToolCallOutcome = {
		toolCall,
		result: createErrorToolResult(text),
		isError: true,
	};
	await emitToolExecutionEnd(finalized, emit);
	const toolResultMessage = createToolResultMessage(finalized);
	await emitToolResultMessage(toolResultMessage, emit);
	return toolResultMessage;
}

/**
 * Execute the tool calls one assistant message issued: sequential when any of them says so, parallel
 * otherwise. Both paths prepare the calls in source order and write their results as messages.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	hooks: ToolCallHooks,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((block): block is AgentToolCall => block.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, hooks, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, hooks, signal, emit);
}

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	hooks: ToolCallHooks,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: AgentToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		// Prepared before it is announced: a suspended call is announced never — the gate ended the
		// run at it, no result is written, and the events stay silent so the window shows no card for
		// a call that never ran. The call and everything after it in the batch stay unanswered.
		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, hooks, signal);
		if (preparation.kind === "suspended") {
			return { messages, terminate: true, suspended: true };
		}
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		let finalized: AgentToolCallOutcome;
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
				hooks,
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
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	hooks: ToolCallHooks,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];
	let suspended = false;

	for (const toolCall of toolCalls) {
		// Prepared before it is announced, as in the sequential path: a suspended call gets no events
		// and no result, and the calls after it are not prepared either. The calls already queued
		// above run to completion — they were underway when the gate answered.
		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, hooks, signal);
		if (preparation.kind === "suspended") {
			suspended = true;
			break;
		}
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies AgentToolCallOutcome;
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
				} satisfies AgentToolCallOutcome;
				await emitToolExecutionEnd(finalized, emit);
				return finalized;
			}
			const executed = await executePreparedToolCall(preparation, signal, emitToolExecutionUpdate(toolCall, emit));
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				hooks,
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
		terminate: suspended || shouldTerminateToolBatch(orderedFinalizedCalls),
		suspended: suspended || undefined,
	};
}

function shouldTerminateToolBatch(finalizedCalls: AgentToolCallOutcome[]): boolean {
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
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	hooks: ToolCallHooks,
	signal: AbortSignal | undefined,
	tools: readonly AgentTool<any>[] = currentContext.tools ?? [],
): Promise<PreparedToolCall | ImmediateToolCallOutcome | SuspendedToolCall> {
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
		if (hooks.beforeToolCall) {
			const beforeResult = await hooks.beforeToolCall(
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
			// The gate ended the run at this call: no result is written for it here — the caller sees
			// `suspended` on the batch and ends the run, and a recovery run closes the call from the
			// answer that arrives later. `block` alongside it would write a result, so suspend wins.
			if (beforeResult?.suspend === true) {
				return { kind: "suspended" };
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
interface RunToolCallOptions extends ToolCallHooks {
	/** Tools the call resolves against. */
	tools: readonly AgentTool<any>[];
	/** Passed to the hooks as the message that issued the call. */
	assistantMessage: AssistantMessage;
	/** Passed to the hooks as the current agent context. */
	context: AgentContext;
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
 * errors come back as `isError: true`. Nothing in this build calls it yet — a tool that wants to
 * nest another call would — so it stays internal to this file rather than exported.
 */
async function runToolCall(toolCall: AgentToolCall, options: RunToolCallOptions): Promise<AgentToolCallOutcome> {
	const { assistantMessage, context, signal } = options;
	const preparation = await prepareToolCall(context, assistantMessage, toolCall, options, signal, options.tools);
	if (preparation.kind === "immediate") {
		return { toolCall, result: preparation.result, isError: preparation.isError };
	}
	// A nested call has no batch to suspend and no run of its own to end, so the suspend comes back
	// as the error result it is: the tool did not run, and the caller sees why.
	if (preparation.kind === "suspended") {
		return {
			toolCall,
			result: createErrorToolResult(`Tool call "${toolCall.name}" was suspended before it ran`),
			isError: true,
		};
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
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	hooks: ToolCallHooks,
	signal: AbortSignal | undefined,
): Promise<AgentToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (hooks.afterToolCall) {
		try {
			const afterResult = await hooks.afterToolCall(
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

function createErrorToolResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: AgentToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: AgentToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools can return results without content; normalize so the null never enters session
		// history or provider payloads.
		content: finalized.result.content ?? [],
		// A tool's details are arbitrary JSON the ledger stores verbatim, so the one narrowing this
		// file makes is here: the transcript's message shape says `JsonValue`, and the tool's own
		// `details` is untyped by design.
		details: finalized.result.details as JsonValue | undefined,
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
 * The version of a tool result the ledger keeps, decided once at the write boundary.
 *
 * This is the backstop for a result nothing bounded on the way in — every built-in tool bounds its
 * own output, and an `after_tool` rewrite is final by the time it gets here, so what remains is the
 * tool that forgot. A result too large for the context is archived whole under the working directory
 * (`context/spill.ts`) and stored as its head and tail plus the archive's path, so nothing is lost
 * that cannot be read back; when the archive cannot be written, the hard clip in `boundToolContent`
 * is the floor. Anything else passes through untouched: for a well-bounded result the whole check is
 * one length sum.
 *
 * Running it here, at the one door every write walks through, is what lets the request read the
 * ledger as it is: the content on disk is the content the model is served, on this process and on
 * every later one.
 */
function finalizeToolResult(state: AgentState, message: Message): Message {
	if (message.role !== "toolResult") return message;
	const spilled = spillOversizedToolResult(
		state.session.sessionSetting.workDirAbsPath,
		state.session.sessionId,
		message.toolName,
		message.toolCallId,
		message.content,
	);
	const content = spilled ?? boundToolContent(message.content);
	return content === undefined ? message : { ...message, content };
}

/**
 * One orchestration service for every conversation this process runs.
 *
 * This is the orchestration layer of the stateless architecture (ADR-0006 §1): the four domains are
 * stateless singletons, and the cross-domain order — record the selection, fill the model, replay
 * the ledger, build the request, assemble the tools, merge the approvals, build the prompt, run the
 * engine — lives here and nowhere else, because it belongs to no single domain. The engine itself is
 * a method of this class rather than an object beside it, which is what makes the run's entry a
 * method call and leaves nothing in the process holding a run's transients. The class still
 * holds no session state: a method names its session by id, resolves the ledger bag from the session
 * manager and the live half from the registry entry, and rebuilds everything a request needs from
 * those two. A resumed session and a live session run the same chain, which is what makes them
 * indistinguishable.
 */
export class Agent {
	/**
	 * The stateless session service every transcript read and write goes through.
	 *
	 * Exposed rather than hidden because it is the durable half's owner: a host that has to fork,
	 * list, or name the file reads it here, and there is no second copy of that state to keep in step.
	 * The bag a call operates on is never exposed — it is `stateOf(id)`'s answer, and the id is the
	 * caller's.
	 */
	readonly sessionManager: SessionManager;
	/** The user's models, as every session reads them: see {@link AgentConfig.models}. */
	readonly models: ModelSource;
	/**
	 * The seams sessions dispatch through, including the defaults `openAgent` installed.
	 *
	 * Exposed so a host that already has a session can add behaviour to it: a handler registered here
	 * runs after the defaults and refines what they answered.
	 */
	readonly hooks: Hooks;

	/** The caller's prompt builder; {@link Agent.prepareRequest} is what a request calls it from. */
	private readonly promptBuilder: AgentConfig["systemPrompt"];
	private readonly tools: ToolRegistry;
	/** Where a request actually leaves: the injected transport, before the retry policy wraps it. */
	private readonly base: ChatTransport;
	/**
	 * The states of the sessions this process runs, keyed by id (ADR-0011).
	 *
	 * One bag per session — the durable half, the settings the open resolved, the live half, the
	 * subscribers — and the only thing this class holds between calls. States enter through
	 * {@link Agent.adopt} and leave through {@link Agent.evict} / {@link Agent.drop}, both owned
	 * here: one writer, one deleter.
	 */
	private readonly sessions = new Map<string, AgentState>();

	constructor(config: AgentConfig) {
		this.sessionManager = config.sessionManager;
		this.models = config.models;
		this.tools = config.tools;
		this.promptBuilder = config.systemPrompt;
		this.hooks = config.hooks ?? createHooks();
		this.base = config.api ?? anthropicMessages;
		// Nothing per session is built here: a state is assembled by the factory and adopted, and an
		// id is resolved at the top of each method against the table below. No engine object is built
		// here either: the engine is a method of this class, and everything it holds is the run's own
		// local — see {@link Agent.runEngine}.
	}

	// ---------------------------------------------------------------------------- resolution

	/**
	 * Put one assembled state in the table. The only way in.
	 *
	 * The factory (`session-factory.ts`) is what assembles — the working directory, the settings, the
	 * live half, the model choice seeded onto the session — and the caller hands the result here,
	 * whether that caller is a host adopting into its long-lived orchestrator or a test adopting
	 * into one of its own. First adoption wins: a state already in the table is kept, never
	 * replaced, because the one it would replace holds the queues, the subscribers, and the run in
	 * flight (ADR-0007 §4) — and re-adopting the same id is the ordinary idempotent move, not an
	 * error.
	 */
	adopt(state: AgentState): void {
		if (this.sessions.has(state.session.sessionId)) return;
		this.sessions.set(state.session.sessionId, state);
	}

	/**
	 * Drop one session's state from the table, when nothing holds it.
	 *
	 * The eviction criteria (ADR-0011, issue 04): no run in flight, nothing parked at the approval
	 * gate, and a durable half actually on disk — a session whose file is not born yet has no
	 * half to rebuild from, so dropping its state would be deleting the id, and its life ends
	 * with the first message or the process, never with a sweep. Refusing (returning `false`) is
	 * the answer to a caller that named a session still held.
	 */
	evict(id: string): boolean {
		const state = this.sessions.get(id);
		if (state === undefined) return false;
		if (state.live.activeRun !== undefined || state.live.suspended) return false;
		if (state.session.fileCreated !== true) return false;
		return this.sessions.delete(id);
	}

	/**
	 * Drop one session's state from the table, whatever it holds.
	 *
	 * The unconditional half of the teardown (issue 03 §7): the user has deleted the session, so
	 * the id is gone from disk and no criteria apply — there is nothing left for the state to
	 * protect. Anything queued or in flight dies with it, exactly as a process restart would have
	 * killed it.
	 */
	drop(id: string): boolean {
		return this.sessions.delete(id);
	}

	/**
	 * The state the session's live half lives in.
	 *
	 * Every method needs it — the durable half, the settings, the queues, the run in flight, the
	 * subscribers — and a missing one is a bug in the caller rather than a state to invent: only
	 * `adopt` puts a state here, and only a host knows when that is. Refusing here is what keeps a
	 * method from answering a session nobody runs from something it just made up.
	 */
	private agentStateOf(id: string): AgentState {
		const state = this.sessions.get(id);
		if (state === undefined) throw new Error(`Session is not running: ${id}`);
		return state;
	}

	// ---------------------------------------------------------------------------- the read surface

	/**
	 * The state of the session `id` names, built by the one function that also serves a cold reader.
	 *
	 * This is the whole read surface: every scalar a caller used to ask for by name — the row, the
	 * level, the tool set, the depth, the retry state — is a field here, so there is one answer rather
	 * than a getter per field to keep in step with it.
	 *
	 * The construction lives in `sessionSnapshot` rather than here so that a transcript this process
	 * is *not* running is answered by the same code from the same parts: the only fields the two
	 * callers can disagree on are the five they supply — `submitting`, `queued`, `isRetrying`,
	 * `retryAttempt`, `pendingApprovals` — and everything a transcript can answer is read identically.
	 * Of those five, four are the run's locals and one is derived from the ledger.
	 */
	snapshot(id: string): SessionSnapshot {
		const state = this.agentStateOf(id);
		const session = state.session;
		const live = state.live;
		return sessionSnapshot({
			sessions: this.sessionManager,
			session,
			workDirAbsPath: session.sessionSetting.workDirAbsPath,
			// The run's own model is the one its request went out with, so the meter measures the window
			// the answer was actually asked against. An idle session has no run to ask, and builds it
			// from the catalog — one small file read, on a command rather than on a delta. The choice
			// read here is the one in force: the assembly seeds it onto the session before the first
			// message, and a request records it (issue 03 §7).
			model: live.model ?? modelFor(session.sessionSetting.model ?? {}, this.models.list()),
			approvals: this.approvalsOf(session, state),
			allTools: this.tools.names(),
			activeTools: this.toolStateOf(session, state).activeToolNames,
			// Judged against this directory's own settings, the same way a cold read judges it, so the
			// panel's "沿用全局" label cannot disagree with itself between the two paths.
			...followsGlobalOf(this.sessionManager, session, state.setting, this.tools),
			...(live.partial === undefined ? {} : { partial: live.partial }),
			submitting: live.activeRun !== undefined,
			queued: live.followUpQueue.previews(),
			isRetrying: live.retrying,
			retryAttempt: live.retryAttempt,
			pendingApprovals: live.activeRun === undefined ? this.danglingApprovals(session) : [],
		});
	}

	/**
	 * The tool choice in force, derived from the ledger, on every read.
	 *
	 * Never held: every write of it lands in the ledger in the same stack (`setActiveTools`, an
	 * approval choice), so deriving here is what keeps the snapshot and a settings edit answered live
	 * when the fallback is the global default. See {@link toolStateOf}.
	 */
	private toolStateOf(session: Session, state: AgentState): ToolState {
		return toolStateOf(this.sessionManager, session, state.setting, this.tools);
	}

	/**
	 * The approval map in force: the directory's settings with this session's own choices over them.
	 *
	 * The single read point for the gate, the snapshot, and the prompt — all three answer the same
	 * question, so none of them may reach past this to the settings alone. The session's own
	 * half is the recorded choice, read off the `.json` snapshot beside the tool set it was written
	 * beside.
	 */
	getApprovals(id: string): Record<string, boolean> {
		const state = this.agentStateOf(id);
		return this.approvalsOf(state.session, state);
	}

	/** The one merge the gate, the snapshot, and the prompt all read through. */
	private approvalsOf(session: Session, state: AgentState): Record<string, boolean> {
		return { ...getApprovals(state.setting), ...this.toolStateOf(session, state).approvalOverride };
	}

	/**
	 * Whether the transcript holds a tool call nobody has answered.
	 *
	 * Only an idle session reports one. A call that dangles *during* a run is a result in the middle
	 * of landing, not a question waiting for a person, and reporting it would flash a banner on every
	 * tool batch; the calls that wait for an answer are the ones whose run has already ended.
	 */
	hasPendingApprovals(id: string): boolean {
		const state = this.agentStateOf(id);
		return state.live.activeRun === undefined && this.danglingApprovals(state.session).length > 0;
	}

	/** Subscribe to the session's state. The returned function unsubscribes. */
	onChange(id: string, listener: SessionListener): () => void {
		const listeners = this.agentStateOf(id).listeners;
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	/** Subscribe to the session's events. The returned function unsubscribes. */
	onEvent(id: string, listener: SessionEventListener): () => void {
		const listeners = this.agentStateOf(id).eventListeners;
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	// ---------------------------------------------------------------------------- the run lifecycle

	/**
	 * Append a user message and run the engine until the agent stops.
	 *
	 * `selection` is the composer's model and level, applied here and recorded by the request that
	 * follows. Both come with the message rather than as a command of their own, so a choice that was
	 * never sent with is nowhere.
	 *
	 * While a run is streaming the message is queued instead of rejected: `steer` is injected at the
	 * current turn's next drain point, `followUp` waits until the agent would otherwise stop. Either
	 * way it is handed to the engine unwritten, and the drain that takes it is what the store records —
	 * a drained message is one the conversation has reached, so the file gains it in the place the
	 * model met it, behind the answer it interrupted. A message the run never drains is dropped with
	 * the run ({@link Agent.dropQueued}): the send contract is fire-and-forget, and queued never
	 * promised stored.
	 */
	async prompt(id: string, text: string, options: { behavior?: PromptBehavior; selection?: ModelSelection } = {}): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;

		// The composer's choice arrives with the message, so this is the only place either half is
		// applied. A message that never reaches here — an empty one, a rejected send — moves nothing.
		if (options.selection !== undefined) this.applyModelSelection(id, options.selection);

		const state = this.agentStateOf(id);
		if (state.live.activeRun !== undefined) {
			const message: Message = {
				role: "user",
				content: [{ type: "text", text: trimmed }],
				timestamp: this.nextStamp(state.session),
			};
			const queue = options.behavior ?? "followUp";
			if (queue === "steer") state.live.steeringQueue.enqueue(message);
			else {
				state.live.followUpQueue.enqueue(message);
				this.emitQueueUpdate(state);
			}
			this.publish(state);
			return;
		}

		await this.startPromptedRun(state, trimmed);
	}

	/**
	 * Send a message into the running turn's next drain point.
	 *
	 * The same session as {@link Agent.prompt} with `behavior: "steer"` — named on its own because it
	 * is its own answer in the protocol's terms: a steered message is spent by the turn it interrupted.
	 * On an idle session it is an ordinary prompt, because a message nobody is running cannot steer.
	 */
	steer(id: string, text: string, options: { selection?: ModelSelection } = {}): Promise<void> {
		return this.prompt(id, text, { ...options, behavior: "steer" });
	}

	/**
	 * Queue a message for when the run ends.
	 *
	 * The same session as {@link Agent.prompt} with `behavior: "followUp"`: the message waits until the
	 * agent would otherwise stop, and the depth it adds is what the composer shows.
	 */
	followUp(id: string, text: string, options: { selection?: ModelSelection } = {}): Promise<void> {
		return this.prompt(id, text, { ...options, behavior: "followUp" });
	}

	/** Write the prompted message into the transcript, then run over it. */
	private async startPromptedRun(state: AgentState, trimmed: string): Promise<void> {
		const message: Message = {
			role: "user",
			content: [{ type: "text", text: trimmed }],
			timestamp: this.nextStamp(state.session),
		};
		this.appendMessage(state, message);
		this.publish(state);
		await this.startRun(state, { prompt: message });
	}

	/**
	 * Run the engine once, over everything the transcript already holds.
	 *
	 * A run starts one of two ways. A prompted run hands over the message that started it, which the
	 * store already holds — the engine's own echo of it must not be recorded twice. A resumed run hands
	 * over the approval answers instead: the engine's recovery pass pairs them with the calls the last
	 * run left dangling and continues from there, so no message is written and none is echoed.
	 *
	 * This is where the run lives, and it is the whole reason the class holds no run state: the
	 * transport, the retry scope, the event handler, and the engine's own take points are all built
	 * with the run, closed over its locals, and dropped when the run settles. What crosses the stack
	 * is exactly what the state names — the queues, the active run, the subscribers — and the live
	 * half itself, which is how a reader outside the run sees its transients: the run writes its
	 * partial message, its model, and its retry state onto `state.live` as it goes, and the `finally`
	 * below wipes them, so an idle session answers from the bag again. The session the run serves is
	 * resolved once, at the top, and every closure below threads the same locals: no request
	 * re-resolves its way to a different bag.
	 */
	private async startRun(
		state: AgentState,
		start: RunStart,
	): Promise<void> {
		const live = state.live;

		// The run's send policy rides on every request object this run's models are built with. The
		// engine is never told about it: it asks for a stream from whatever model it holds, and the
		// model answers through this — so retries, and the "no row behind this model" answer, happen
		// below everything that could report them.
		const transport: ChatTransport = {
			stream: (model, context, options) => {
				const outer = createAssistantMessageEventStream();
				// Deliberately not awaited: the run owns the stream's lifetime, and a failure that
				// cannot be retried comes back as an error event on it rather than as a rejection out
				// of the stream function (which the engine's contract forbids anyway).
				void this.pumpAttempts(state, outer, model as Model, context, options);
				return outer;
			},
		};

		try {
			// The transcript and the tools are built per run — the engine keeps no state of its own —
			// and both are rebuilt for the request that actually goes out by the fill chain anyway.
			// The engine's take points read this session's own queues, so nothing is wired in.
			await this.runEngine(state, transport, start);
		} finally {
			// A message accepted in the last moment of the run — after the engine had already decided to
			// stop looking for one — is on a queue nothing will drain, so it is dropped here rather than
			// carried into a later run. The ordinary end path has already emptied both lists by this
			// point, which is what makes this a no-op for a run that ended the way it should.
			//
			// A suspended run is the exception: its queues are what the recovery run drains, and the
			// message someone typed while this run was streaming is theirs, not this run's to bin.
			// A drop that took something is a queue change the window has not heard yet, so it is the
			// one end path that publishes here; a parked run keeps its queue and says nothing.
			if (!live.suspended && this.dropQueued(state)) this.emitQueueUpdate(state);
			// The transients come down with the run: an idle session answers from the bag again, which
			// is what makes "in flight, read the run; idle, read the choice" a state rather than a
			// leak. The suspended flag is read by the sweep above, so it is wiped last.
			live.model = undefined;
			live.partial = undefined;
			live.retrying = false;
			live.retryAttempt = 0;
			live.suspended = false;
			// The run is not over until the engine's `runEngine` resolves — after every awaited listener for
			// `agent_end` and the engine's own `finally`. So this is the first moment nothing is in
			// flight, and without publishing here nothing ever reports it.
			//
			// In a `finally` rather than after the `await`, because the two ends of a run reach this point
			// by different roads: a run that ends normally falls through, but a run whose own failure
			// handling rejected — the persistence that reports the failure is the persistence that broke —
			// arrives here as a rejection, and a publish placed after the `await` would be skipped by
			// exactly the run that most needs the frame. Every end path a run has goes through this one
			// block; the error frame that may precede it is announced by the caller that learns of the
			// rejection, not by the session.
			this.publish(state);
		}
	}

	/**
	 * The engine: one entry and one exit, over the context as it stands.
	 *
	 * The body is what `packages/loop` used to run, rewritten to read its seams off this orchestrator
	 * instead of off a constructor argument: the run registers itself on the session's live half
	 * (`live.activeRun`, where an abort from any layer lands), every event goes through
	 * {@link Agent.dispatchEvent} — which persists it and fans it out — the per-turn fill is
	 * {@link Agent.prepareRequest}, and both take points drain this session's own queues. Nothing here
	 * outlives the stack, which is why the model the run is on is a local rather than a field: it is
	 * the one thing a request may replace, and a member would hand it to a second session's run. What
	 * crosses the stack is the live half's own slot, for the snapshot that reads it mid-delta.
	 *
	 * A run either starts on a prompt — which enters the transcript at the first drain point, exactly
	 * where a steered message enters on a later turn — or resumes: it opens on the transcript as it
	 * stands, and its first act is the recovery pass over the calls a previous run left dangling.
	 * Returns the messages the run produced.
	 */
	private async runEngine(
		state: AgentState,
		transport: ChatTransport,
		start: RunStart,
	): Promise<Message[]> {
		const session = state.session;
		const live = state.live;
		if (live.activeRun !== undefined) {
			throw new Error(
				"A run is already in flight. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}

		const abortController = new AbortController();
		let settle = () => {};
		const promise = new Promise<void>((done) => {
			settle = done;
		});
		live.activeRun = { promise, resolve: settle, abortController };
		const signal = abortController.signal;

		// The model the run is on. Seeded from the choice as it stands; `prepareRequest` answers with
		// the one each request is actually sent with, so a synthesized failure still names a real model
		// even when the run dies before its first request. The slot on the live half is what a snapshot
		// outside this stack reads instead of going back to the catalog.
		let model: Model = modelFor(session.sessionSetting.model ?? {}, this.models.list(), transport);
		live.model = model;
		const hooks = this.toolCallHooks(session);
		const emit: AgentEventSink = (event) => this.dispatchEvent(state, event);

		try {
			const newMessages: Message[] = [];
			let currentContext: AgentContext = {
				messages: [...this.sessionManager.buildSessionContext(session).messages],
				tools: [...this.tools.active(this.toolStateOf(session, state), this.runContext(state))],
			};

			await emit({ type: "agent_start" });

			// Recovery pass (ADR-0006 §5): a call in the context that no tool result answers would make
			// the first request illegal, so every run closes what it finds before its first turn — a
			// grant re-runs the call, a denial and an orphan get synthesized results. A suspend here
			// (the grant this run resumed on did not clear the gate) ends the run before any request.
			let suspendedAtEntry = false;
			const dangling = danglingToolCallsOf(currentContext.messages);
			if (dangling.length > 0) {
				const recovered = await recoverPendingToolCalls(
					currentContext,
					dangling,
					{ answers: start.answers },
					hooks,
					signal,
					emit,
				);
				for (const message of recovered.messages) {
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				suspendedAtEntry = recovered.suspended === true;
			}
			if (suspendedAtEntry) {
				// The recovery pass re-ran the granted call and the gate refused it again, so this run
				// ends the same way the last one did — and keeps the queues for the same reason.
				live.suspended = true;
				await emit({ type: "agent_end", messages: newMessages });
				return newMessages;
			}

			// The run's prompt occupies the first drain point: every turn — the first one included — is
			// `turn_start`, then a drain, then a request. A resumed run has no prompt; its recovered
			// results are already in the context. Steering is polled at the end of each turn, so the
			// earliest a steered message surfaces is after the first response.
			let pendingMessages: Message[] = start.prompt === undefined ? [] : [start.prompt];

			// Outer loop: continues when queued follow-up messages arrive after the agent would stop.
			while (true) {
				let hasMoreToolCalls = true;
				// Set when the gate suspends a batch: the run ends at that turn, before the take points.
				let suspended = false;

				// Inner loop: process tool calls and steering messages.
				while (hasMoreToolCalls || pendingMessages.length > 0) {
					await emit({ type: "turn_start" });

					// Process queued messages before the next assistant response. The run's own prompts drain
					// here on the first turn, exactly where a steered message drains on a later one.
					for (const message of pendingMessages) {
						await emit({ type: "message_start", message });
						await emit({ type: "message_end", message });
						currentContext.messages.push(message);
						newMessages.push(message);
					}
					pendingMessages = [];

					// The per-request fill chain (ADR-0006 §2): adopt the live row, record the selection,
					// replay the ledger into a view, compact it if it is over the window, build the prompt
					// from the live tool and approval answers, and hand the request back — built here, used
					// once, dropped.
					const requestUpdate = await this.prepareRequest(transport, currentContext, signal, state);
					if (requestUpdate) {
						currentContext = requestUpdate.context ?? currentContext;
						model = requestUpdate.model ?? model;
						// The model this request goes out with is the one a snapshot taken during it
						// should report, and the one the meter measures the answer against.
						live.model = model;
					}

					// A run can be cut short while its request is being built — an abort from `close()`,
					// a stop from the window — and `prepareRequest` has awaits of its own (a compaction
					// summary, the project instructions read off disk). A request issued after that point
					// would go out on a dead signal: nothing it returns could be used, and a transport is
					// free to answer an already-aborted call however it likes. Ending here is the same
					// ending an abort mid-stream gets, arrived at one step earlier.
					if (signal?.aborted === true) throw signal.reason ?? new Error("The run was aborted");

					// Stream assistant response.
					const message = await streamAssistantResponse(currentContext, model, signal, emit);
					newMessages.push(message);

					if (message.stopReason === "error" || message.stopReason === "aborted") {
						await emit({ type: "turn_end", message, toolResults: [] });
						await emit({ type: "agent_end", messages: newMessages });
						return newMessages;
					}

					const toolCalls = message.content.filter((block): block is AgentToolCall => block.type === "toolCall");

					const toolResults: ToolResultMessage[] = [];
					hasMoreToolCalls = false;
					if (toolCalls.length > 0) {
						// A "length" stop means the output was cut off by the token limit, so every tool call
						// in the message may carry truncated arguments. Fail them all instead of executing
						// potentially borked calls.
						const executedToolBatch =
							message.stopReason === "length"
								? await failToolCallsFromTruncatedMessage(toolCalls, emit)
								: await executeToolCalls(currentContext, message, hooks, signal, emit);
						toolResults.push(...executedToolBatch.messages);
						hasMoreToolCalls = !executedToolBatch.terminate;
						suspended = executedToolBatch.suspended === true;
						if (suspended) live.suspended = true;

						for (const result of toolResults) {
							currentContext.messages.push(result);
							newMessages.push(result);
						}
					}

					await emit({ type: "turn_end", message, toolResults });

					// A suspended batch ends the run here: the take points are skipped, so nothing new is
					// taken into a run the gate has already stopped — what was accepted waits on the queues
					// and the caller's end-of-run sweep writes it, and the answer to the suspended call
					// arrives from outside any run to start the next one.
					if (suspended) break;

					pendingMessages = await this.drainTranscribed(live.steeringQueue, state);
				}

				// A suspend ends the follow-up side of the run with it: the queued messages were never
				// taken, and the run that would answer them is over.
				if (suspended) break;

				// The run would stop here. Take whatever the follow-up queue holds.
				const followUpMessages = await this.drainTranscribed(live.followUpQueue, state);
				if (followUpMessages.length > 0) {
					// Set as pending so the inner loop processes them.
					pendingMessages = followUpMessages;
					this.emitQueueUpdate(state);
					continue;
				}

				break;
			}

			await emit({ type: "agent_end", messages: newMessages });
			return newMessages;
		} catch (error) {
			// A throw outside the engine's own error encoding — a bug in the engine, or persistence that
			// escaped its own handling — still surfaces as a complete event stream so subscribers see a
			// terminal state.
			await this.handleRunFailure(emit, model, error, signal.aborted);
			return [];
		} finally {
			this.finishRun(state);
		}
	}

	/**
	 * The two tool-call gates, as this run's own pair.
	 *
	 * The batch helpers are file-level and hold no session, so the run hands them the seams it needs:
	 * the session's `before_tool` gate and its `after_tool` one. An `after_tool` rewrite is final —
	 * the message is written with exactly the content the hooks left — so neither gate closes over the
	 * run's transients any more; the session id is all either one reads through.
	 */
	private toolCallHooks(state: Session): ToolCallHooks {
		const sessionId = state.sessionId;
		return {
			beforeToolCall: async ({ toolCall, args }) => this.beforeTool(sessionId, toolCall.id, toolCall.name, args),
			afterToolCall: async ({ toolCall, result, isError }) =>
				this.afterTool(sessionId, toolCall.id, toolCall.name, result, isError),
		};
	}

	/**
	 * Write the failure a run died of as a message, and close the run's event stream with it.
	 *
	 * The message is synthesized rather than reported: a run that threw has no assistant message to
	 * point at, and a subscriber that only ever sees `agent_end` would have no account of why nothing
	 * came back. The model named is the one the last request was made with.
	 */
	private async handleRunFailure(
		emit: AgentEventSink,
		model: Model,
		error: unknown,
		aborted: boolean,
	): Promise<void> {
		const failureMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			model: model.id,
			usage: NO_USAGE,
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		} satisfies Message;
		await emit({ type: "message_start", message: failureMessage });
		await emit({ type: "message_end", message: failureMessage });
		await emit({ type: "turn_end", message: failureMessage, toolResults: [] });
		await emit({ type: "agent_end", messages: [failureMessage] });
	}

	/** Settle the run: fire the promise idle-waiters sleep on, then give the slot up. */
	private finishRun(state: AgentState): void {
		state.live.activeRun?.resolve();
		state.live.activeRun = undefined;
	}

	/**
	 * The per-request fill chain, from the ledger to the request object.
	 *
	 * In order: the model is re-derived from the live row (an edit takes effect without reopening
	 * anything), the selection this request is made with is recorded — exactly one entry per move, so
	 * a choice that was never sent with is not in the file — the ledger is replayed into the view, the
	 * view is compacted if it is over this model's window, the prompt is built from the live tool and
	 * approval answers, and the whole thing is returned as the one request object this turn sends.
	 * Nothing here outlives the request.
	 */
	private async prepareRequest(
		transport: ChatTransport,
		context: AgentContext,
		signal: AbortSignal | undefined,
		state: AgentState,
	): Promise<AgentRequestUpdate> {
		const session = state.session;
		// The model this request is made with, built from the live row before anything else reads it,
		// because the compaction decision below is measured against its context window and a threshold
		// taken from a window the row had a moment ago would compact the wrong transcript. This is the
		// whole of "an edit takes effect without reopening anything": the endpoint, the wire id, the
		// window, and the key are read here, from the catalog, and never captured when the session was
		// assembled. A row that is gone — deleted, or renamed under a session that was using it —
		// leaves the choice as it is, and `unconfiguredStream` is what answers for that.
		const catalog = this.models.list();
		const model = modelFor(session.sessionSetting.model ?? {}, catalog, transport);
		// The choice this request is made with reaches the transcript here, at the moment a request
		// is built from it — so a model or a level the user moved and never sent with is not in the
		// file at all. It runs before the compaction decision below, which measures the prompt
		// against this model's window.
		this.recordSelection(session, catalog);
		// One pass decides both what the request carries and whether it has to be summarized: the
		// trigger, the clearing of stale tool results, and the summary all read the same entries, so the
		// decision and the request cannot disagree about how large the prompt is.
		const entries = await this.compactFor(state, this.sessionManager.buildContextEntries(session), Date.now(), signal, model);
		// The prompt is rebuilt here, not remembered: `applyConfig` can move the approval set and
		// `setActiveTools` the tool set, and the model must be told about both on the next request.
		// Both are derived from the ledger at this moment, so a choice that just landed is what the
		// prompt describes.
		const toolState = this.toolStateOf(session, state);
		// The project instructions are read here, per request, rather than taken from the state: an
		// edit to a file on disk is meant to reach the very next request, the same way an edit to a
		// model row does, and the walk is a handful of stats. What it costs is a prompt that can change
		// between two requests of one run — the tool set already can, for the same reason.
		const agentsMd = await loadAgentsMd(session.sessionSetting.workDirAbsPath);
		const prompt = this.promptBuilder(
			session.sessionSetting.workDirAbsPath,
			agentsMd,
			toolState.activeToolNames,
			this.approvalsOf(session, state),
		);
		// The tool results the request carries are read replay-side (`buildContextEntries` applied the
		// ledger's own view records), so there is no per-request pass over them: a tool result in the
		// ledger is already the version the model is served.
		const injected = { sessionId: session.sessionId, messages: messagesOf(entries), systemPrompt: prompt };
		const rewritten = await this.hooks.apply("context", injected);
		// The leading system message is replaced rather than appended to, and every other system
		// message is dropped: the prompt is rebuilt whole on this request, so a second one would
		// describe a state that is already gone. A hook that wants to change the prompt returns
		// `systemPrompt`; one that pushes a system message into `messages` loses it here.
		const system = createSystemMessage(rewritten?.systemPrompt ?? injected.systemPrompt);
		// A compaction checkpoint is already the user turn it stands for — `sessionEntryToContextMessages`
		// wraps the summary in tags — so the transcript goes to the provider as it is.
		const conversation = pairLateToolResults((rewritten?.messages ?? injected.messages).filter((message) => message.role !== "system"));
		return {
			// Built above, from the row this request is made with: run-local, used for the one
			// request, dropped.
			model,
			context: {
				...context,
				messages: system === undefined ? conversation : [system, ...conversation],
				// The live executable set, built fresh against this request's run context from the choice
				// derived above. The engine declares it on the request (`toToolDeclaration`) rather than
				// reading it out of the transcript, so a tool switched on mid-session reaches the model on
				// the next request and the two cannot drift.
				tools: this.tools.active(toolState, this.runContext(state)),
			},
		};
	}

	/**
	 * The value objects this request's tools are built against: the working directory, read off the
	 * session's own setting, and the bash timeouts, read off the settings the same way. Per request,
	 * like the tool list itself — nothing here outlives the request that carries it.
	 */
	private runContext(state: AgentState): ToolRunContext {
		return {
			workDirAbsPath: state.session.sessionSetting.workDirAbsPath,
			bash: getBashSettings(state.setting),
		};
	}

	/**
	 * Write what this request is being made with into the session, once per move.
	 *
	 * The model and the level are recorded here rather than where the user chose them, because these
	 * are the transcript's account of what answered a turn: a row the user picked and never
	 * sent with answered nothing, and a level that was never asked at was never in force. The write
	 * baseline is the snapshot on disk, read fresh — not the bag, which already carries the choice in
	 * force (`applyModelSelection` and the assembly seed put it there, issue 03 §7), so comparing
	 * against the bag would be self-comparison and a level-only move would never reach the file. A
	 * run of turns on one selection still costs one write: when the disk already says what is in
	 * force, nothing is written.
	 *
	 * The catalog is the caller's, so this and the model the request is built with read the file once
	 * between them. A choice no row answers records no row — there is no wire id to write, and the
	 * request it belongs to is about to be refused by the transport rather than sent; its level, if
	 * it has one, still records. This is the one place a choice reaches the disk: `applyModelSelection`
	 * and the assembly seed only move the in-memory field (issue 03 §7), and the request made with the
	 * choice is what commits it. The setters run first to keep the bag the whole truth (the wire id
	 * only lands here), then the flush carries whatever the bag holds to the snapshot — the setters'
	 * own gates compare against the bag, so a level already in the bag passes them silently.
	 */
	private recordSelection(session: Session, catalog: readonly ModelConfig[]): void {
		const recorded = this.sessionManager.recordedOnDisk(session);
		const row = rowFor(session.sessionSetting.model ?? {}, catalog);
		const level = normalizeThinkingLevel(session.sessionSetting.model?.thinkingLevel) as ThinkingLevel;
		if (
			level === recorded.thinkingLevel &&
			(row === undefined || (row.name === recorded.model?.name && row.id === recorded.model?.modelId))
		) {
			return;
		}
		if (row !== undefined) this.sessionManager.setModel(session, row.name, row.id);
		this.sessionManager.setThinkingLevel(session, level);
		this.sessionManager.flushMeta(session);
	}

	/**
	 * Run one provider call through the retry policy, pumping it into the stream the engine reads.
	 *
	 * Retries live on the transport, below the engine, because an error response is a hard exit: the
	 * engine emits `turn_end` and `agent_end` the moment a stream ends in `stopReason: "error"` and
	 * returns, so there is no later turn in which a failed assistant message could be rewritten. Below
	 * the engine the failed attempt is never a message at all: the transcript gains exactly one
	 * assistant message, the store keeps none of the failures, and the next request has no leftover
	 * error to explain.
	 *
	 * `retryAssistantCall` owns the classification, the backoff, and abort normalization — an abort
	 * during the sleep comes back as an aborted message — so nothing here counts attempts or sleeps. It
	 * wants `() => Promise<AssistantMessage>`, so each attempt is drained here and its events are
	 * forwarded as they arrive; only the terminal event is decided after the attempt, because that is
	 * what says whether this attempt is the one the engine gets to keep.
	 *
	 * The engine must see exactly one `start`: on a retry the failed attempt already put a partial
	 * message in its context, and a second `start` would append a second assistant message instead of
	 * replacing the abandoned one. So `start` is forwarded once per request and the retried attempt's
	 * deltas overwrite that same slot in place.
	 */
	private async pumpAttempts(
		state: AgentState,
		outer: AssistantMessageEventStream,
		model: Model,
		context: LlmContext,
		options: SimpleStreamOptions | undefined,
	): Promise<void> {
		const live = state.live;
		let started = false;
		const produce = async (): Promise<AssistantMessage> => {
			// A session with no row has nothing to send with, so it answers with the sentence that says
			// what to do instead of a request to a placeholder endpoint.
			const inner =
				this.models.list().find((userModel) => userModel.name === model.name) === undefined
					? unconfiguredStream(model)
					: await this.base.stream(model, context, options);
			for await (const event of inner) {
				if (event.type === "done" || event.type === "error") continue;
				if (event.type === "start") {
					if (started) continue;
					started = true;
				}
				outer.push(event);
			}
			const message = await inner.result();
			if (message.stopReason === "error" && isContextOverflow(message, model.contextWindow)) {
				// Context overflow is compaction's problem, never transient: stop the retry loop before
				// it can classify this as something worth trying again.
				throw new ContextOverflow(message);
			}
			return message;
		};

		let final: AssistantMessage;
		try {
			final = await retryAssistantCall(
				produce,
				getRetrySettings(state.setting),
				options?.signal,
				this.retryCallbacks(state),
			);
		} catch (error) {
			// A stream function that throws breaks the engine's contract, so it ends up as an error
			// message here rather than as a rejected promise nobody is left to catch.
			final = error instanceof ContextOverflow ? error.message : failureMessage(model, error);
		}
		// A retry the policy never announced an end for — the run was cut short above — still has to
		// close, or `isRetrying` would outlive the run.
		if (live.retrying) this.endRetry(state, false, live.retryAttempt, final.errorMessage);
		pushTerminal(outer, final);
		outer.end();
	}

	/** The three notifications `retryAssistantCall` makes, mapped one-to-one onto session events. */
	private retryCallbacks(state: AgentState): RetryCallbacks {
		const live = state.live;
		let retryMaxAttempts = 0;
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				live.retrying = true;
				live.retryAttempt = attempt;
				retryMaxAttempts = maxAttempts;
				this.emit(state, { type: "retry_scheduled", attempt, maxAttempts, delayMs, errorMessage });
				this.publish(state);
			},
			onRetryAttemptStart: () => {
				this.emit(state, {
					type: "retry_start",
					attempt: live.retryAttempt,
					maxAttempts: retryMaxAttempts,
				});
				this.publish(state);
			},
			onRetryFinished: (success, attempt, finalError) => this.endRetry(state, success, attempt, finalError),
		};
	}

	/** Leave the retrying state and say how the retry ended. */
	private endRetry(state: AgentState, success: boolean, attempt: number, finalError?: string): void {
		state.live.retrying = false;
		state.live.retryAttempt = 0;
		this.emit(state, { type: "retry_end", success, attempt, finalError });
		this.publish(state);
	}

	/**
	 * Stop the session's current run and wait for it to settle.
	 *
	 * Settling means the engine finished persisting the turn it was in the middle of, including tool
	 * results. The abort lands on the run's controller — the one the run registered on the runtime —
	 * and the run that ends writes what it was writing, so a stopped turn is a complete turn on disk.
	 * Calls the transcript would otherwise show without a result are closed by
	 * {@link Agent.denyAllApprovals}, so an abort never leaves a question the next request cannot ask.
	 *
	 * A retry that is only waiting out its backoff is cancelled by the same call: the abort signal is
	 * the one `retryAssistantCall` sleeps on, so it returns an aborted message instead of sleeping to
	 * the end. Nothing here has to know whether the run is live or in a backoff.
	 */
	async abort(id: string): Promise<void> {
		const state = this.agentStateOf(id);
		// Read once: the run clears its own registration as it settles, and the promise is what waits
		// for that settlement.
		const active = state.live.activeRun;
		active?.abortController.abort();
		await (active?.promise ?? Promise.resolve());
		// The run drops its own slot in its `finally`, a microtask after the idle promise resolves;
		// wait for that too, so the sweep below sees the idle session it is defined on.
		while (state.live.activeRun !== undefined) await Promise.resolve();
		this.denyAllApprovals(id, "The run was aborted.");
		// The same end a finished run publishes, and for the same reason: an abort is how a run that
		// nobody asked to stop otherwise reports that it has. See {@link Agent.prompt}.
		this.publish(state);
	}

	// ---------------------------------------------------------------------------- config moves

	/**
	 * Move the conversation onto another branch of its own tree.
	 *
	 * The store has always been a tree — an entry may have any number of children — and this is the one
	 * way a window moves through it. The leaf lands on the newest tip of `entryId`'s subtree, so
	 * choosing an alternative brings the whole of it back into view at the point it stopped, and the
	 * next prompt continues from there. Nothing is deleted: the branch that was left keeps its entries,
	 * still reachable by id, and a fork from any of them still copies what it always would.
	 *
	 * `descend: false` is the other half of the same gesture — rewinding to a message itself, so the
	 * next prompt starts a *new* alternative at it instead of continuing one. Switching between
	 * alternatives that already exist and rewinding to make another are one operation with two ends.
	 *
	 * Refused while a run is in flight, because the run appends to the leaf: a move under it would
	 * file the rest of that turn under a branch the turn was not answering.
	 */
	branchTo(id: string, entryId: string, descend = true): string {
		const state = this.agentStateOf(id);
		if (state.live.activeRun !== undefined) throw new Error("A run is in flight: the branch cannot move under it");

		const leafId = descend ? this.sessionManager.getBranchTip(state.session, entryId) : entryId;
		this.sessionManager.branch(state.session, leafId);
		// No config report rides the move: the model, the level, and the tool choices are the
		// session's own values now (the `.json` snapshot), so a leaf move changes none of them —
		// unlike the days when they were replayed off the branch's entries.
		this.emit(state, { type: "branch_changed", leafId });
		this.publish(state);
		return leafId;
	}

	/**
	 * Narrow the tools the model may call. An unknown name throws and leaves the session as it was.
	 *
	 * The change is recorded on the session's `.json` snapshot and takes effect on the next request:
	 * the fill chain derives the choice from the ledger with every request, so the model is told about
	 * the narrowed set when the next prompt is built.
	 */
	setActiveTools(id: string, names: string[]): void {
		const state = this.agentStateOf(id);
		const previous = this.toolStateOf(state.session, state).activeToolNames;
		const known = new Set(this.tools.names());
		const unknown = names.filter((name) => !known.has(name));
		if (unknown.length > 0) {
			throw new Error(`Unknown tool${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
		}
		if (names.length === previous.length && names.every((name, index) => name === previous[index])) return;

		this.sessionManager.setToolConfig(state.session, [...names], this.approvalsOf(state.session, state));
		this.publish(state);
		this.emitConfigChanged(state, { tools: [...names] });
	}

	/**
	 * Point this session at another row, another level, or both.
	 *
	 * There is no entry here and no settings write: a choice is not something that happened until a
	 * request is made with it, so it lands on the session's own setting field — in memory, where the
	 * snapshot and the next request read it — and reaches the transcript in
	 * {@link Agent.recordSelection}, at the moment the request it belongs to is built. What a caller
	 * gets back immediately is the change itself — the snapshot, the level, and the next request are
	 * all about the new model, whether or not that request is ever sent.
	 *
	 * A level the chosen model has no room for is refused rather than clamped, because the caller is a
	 * composer that offered the levels of the model it is moving to; "off" is the exception and is
	 * always accepted, since it means "as quiet as this model gets".
	 */
	applyModelSelection(id: string, selection: ModelSelection): void {
		const state = this.agentStateOf(id);
		const setting = state.session.sessionSetting;
		const previousName = setting.model?.name;
		const previousLevel = normalizeThinkingLevel(setting.model?.thinkingLevel);
		// Nothing named is nothing to do, which is how a caller sends an ordinary message.
		if (selection.model === undefined && selection.thinkingLevel === undefined) return;

		const name = selection.model ?? previousName;
		const userModel = this.models.list().find((userModel) => userModel.name === name);
		if (userModel === undefined) throw new Error(`Unknown model: ${name}`);

		// The choice is the client's selection, written as it arrived onto the session's own setting:
		// the row's name, and the level the caller named or the one already in force. Nothing of the
		// row follows it — the wire id is what the request made with the choice records
		// (`recordSelection`), and a snapshot taken before the next request already reads the row the
		// name picks out, because every build looks the name up in the catalog, so an edit to that row
		// wins without anything here being refreshed. The write is in memory only: until a request is
		// made with the choice, the file keeps the choice it was last made with.
		const renamed = previousName !== userModel.name;
		setting.model = {
			// A rename drops the wire id along with the name it belonged to.
			...(renamed ? {} : setting.model),
			name: userModel.name,
			thinkingLevel: selection.thinkingLevel ?? normalizeThinkingLevel(setting.model?.thinkingLevel),
		};

		this.publish(state);
		this.emitConfigChanged(state, {
			...(setting.model.name === previousName ? {} : { model: userModel.name }),
			...(normalizeThinkingLevel(setting.model.thinkingLevel) === previousLevel
				? {}
				: { thinkingLevel: setting.model.thinkingLevel }),
		});
	}

	/**
	 * Update settings and persist them. Approval changes take effect on the next tool call.
	 *
	 * The two halves of a patch live in different places. Approval is session-scoped: it merges into
	 * this session's own choices and is recorded on its `.json` snapshot, so another session over
	 * this directory is untouched. The queue modes go to the settings bag, which owns both the
	 * merged value and the file it goes in — and onto the runtime's queues, which read the mode at
	 * each drain.
	 *
	 * The model and the thinking level are not part of a patch at all. They are chosen in the composer
	 * and arrive with the message they belong to ({@link ModelSelection}), so there is nothing here to
	 * apply: a config change that no request followed is not a config change.
	 */
	applyConfig(id: string, patch: ConfigPatch): void {
		const state = this.agentStateOf(id);
		const previousApprovals = this.approvalsOf(state.session, state);
		if (patch.approval !== undefined) {
			// The snapshot records the whole map in force — the settings with this session's choice over
			// them — which is the shape every read of the ledger answers from.
			const approvals = { ...previousApprovals, ...patch.approval };
			this.sessionManager.setToolConfig(state.session, this.toolStateOf(state.session, state).activeToolNames, approvals);
		}
		applySettings(state.setting, patch.approval === undefined ? patch : { ...patch, approval: undefined });
		state.live.steeringQueue.mode = getSteeringMode(state.setting);
		state.live.followUpQueue.mode = getFollowUpMode(state.setting);
		this.publish(state);
		this.emitConfigChanged(state, {
			approvals: changedApprovals(previousApprovals, this.approvalsOf(state.session, state)),
		});
	}

	// ---------------------------------------------------------------------------- approvals

	/**
	 * The tool calls the transcript is still waiting on, as the approval flow sees them.
	 *
	 * Derived from the ledger, never held (ADR-0006 §5): an approval that is waiting *is* a dangling
	 * call in the view, and the answer arrives over REST to close it. See
	 * {@link Agent.hasPendingApprovals} for why a run in flight reports none.
	 */
	private danglingApprovals(session: Session): PendingApproval[] {
		return danglingApprovalsOf(this.sessionManager.buildContextEntries(session));
	}

	/**
	 * Whether this id names a tool call nobody has answered. Read-only.
	 *
	 * The approvals endpoint checks this before answering, because the check has to happen without
	 * answering: an answer starts the recovery run that closes the call, and the frame that reports
	 * the settlement is built from the change that lands when it does — recording the answer first is
	 * what keeps that frame from reading as a denial by whatever reads the answer back. An unknown id
	 * is the endpoint's 409, not a silent no-op: a button that answers nothing and says so to no one
	 * is worse than an error the client can show.
	 */
	hasPendingApproval(id: string, toolCallId: string): boolean {
		const state = this.agentStateOf(id);
		return (
			state.live.activeRun === undefined &&
			this.danglingApprovals(state.session).some((call) => call.toolCallId === toolCallId)
		);
	}

	/**
	 * Answer one unanswered tool call, and resume the run that asked for it.
	 *
	 * The answering half of the end-restart chain (ADR-0006 §5): the run that asked is over, the call
	 * dangles in the ledger, and the answer starts the run that closes it. The engine's recovery pass
	 * pairs the answer with the call by id — a grant re-runs the call through the gate and the tool
	 * itself, a denial closes it with the sentence a press of "deny" writes — and the run continues
	 * from there, so the model sees the call resolved and carries on in the same run. A grant also
	 * records the session's approval choice for that tool — the tool stops asking — on the session's
	 * `.json` snapshot, the same move a config patch makes: the recovery pass re-runs the call
	 * through the gate, and the gate lets through only a tool the map no longer gates.
	 *
	 * An id nothing is waiting on is ignored: the caller checked first, and answered it. A dangling
	 * call the answer does not name is closed by the recovery pass as an orphan — which is what keeps
	 * the resumed request provider-legal when a crash left several calls behind.
	 */
	async respondApproval(id: string, toolCallId: string, approved: boolean): Promise<void> {
		const state = this.agentStateOf(id);
		if (state.live.activeRun !== undefined) return;
		const call = this.danglingApprovals(state.session).find((candidate) => candidate.toolCallId === toolCallId);
		if (call === undefined) return;
		const answer: ToolCallAnswer = approved
			? { approved: true }
			: { approved: false, reason: `The user denied permission to run ${call.toolName}.` };
		if (approved) {
			// The grant is the session's own choice for this tool, recorded as the whole map in force
			// with the tool turned off — the same move a config patch makes.
			const approvals = { ...this.approvalsOf(state.session, state), [call.toolName]: false };
			this.sessionManager.setToolConfig(state.session, this.toolStateOf(state.session, state).activeToolNames, approvals);
		}
		// Said before the run starts: the choice is the session's own and lands now, while the call
		// itself stays dangling until the run's recovery pass closes it.
		this.publish(state);
		await this.startRun(state, { answers: { [toolCallId]: answer } });
	}

	/**
	 * Close every unanswered tool call with the reason nothing answered.
	 *
	 * The reason rides the answer into the transcript: each closed call's tool result says what
	 * actually happened — the run was aborted, no window answered — rather than the same sentence a
	 * press of "deny" writes, which would record an abandonment as a choice.
	 *
	 * Only an idle session closes anything: a call that dangles mid-run is a result the engine itself is
	 * about to write, and closing it here would write the answer twice.
	 *
	 * The queues go with it. A suspended run keeps them because the recovery run it is waiting for is
	 * what drains them; this is the notice that no recovery run is coming, so nothing would ever take
	 * what was accepted — and a depth nobody will lower is a session `settle` waits on forever.
	 */
	denyAllApprovals(id: string, reason: string): void {
		const state = this.agentStateOf(id);
		if (state.live.activeRun !== undefined) return;
		const dangling = this.danglingApprovals(state.session);
		if (dangling.length === 0) return;
		for (const call of dangling) this.appendDanglingResult(state, call, { approved: false, reason });
		if (this.dropQueued(state)) this.emitQueueUpdate(state);
		this.publish(state);
	}

	/** Write the result that closes one dangling call, and announce the entry like any other message. */
	private appendDanglingResult(
		state: AgentState,
		call: PendingApproval,
		answer: { approved: boolean; reason?: string },
	): void {
		const text = answer.approved
			? `The user approved running ${call.toolName}. Issue the call again to run it.`
			: answer.reason ?? `The user denied permission to run ${call.toolName}.`;
		const message: Message = {
			role: "toolResult",
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			content: [{ type: "text", text }],
			details: {},
			isError: !answer.approved,
			timestamp: Date.now(),
		};
		this.appendMessage(state, message);
	}

	/**
	 * Whether a tool that settings mark as requiring approval still needs the user's answer.
	 *
	 * The gate's decision, not its wording: what comes back is only whether the call may run now.
	 * Under the end-restart semantics a call that needs the answer does not get a block or a result —
	 * the `before_tool` gate turns this answer into the suspend that ends the run with the call
	 * dangling in the ledger, and the answer arrives over REST to start the recovery run that closes
	 * it. A tool the map does not gate runs without asking.
	 */
	async authorize(id: string, name: string, _toolCallId: string, _args: unknown): Promise<boolean> {
		const state = this.agentStateOf(id);
		return this.approvalsOf(state.session, state)[name] === true;
	}

	// ---------------------------------------------------------------------------- waiting and closing

	/**
	 * Wait for the current run to finish and for its writes to reach the file system, without stopping
	 * anything. A run that is already idle returns immediately.
	 *
	 * A queued message is part of the run that accepted it, so the run is drained to the end: the queue
	 * can still be non-empty when one turn settles, which is exactly the case a caller waiting for "the
	 * transcript is complete" must not resolve on. {@link Agent.close} stops the run first, which is
	 * what makes it terminate.
	 *
	 * A run the gate ended is settled, not awaited: its queue is kept for the recovery run, and
	 * `stillBusy` reads a dangling call as "a question, not work" — the same reading {@link
	 * Agent.close} makes when it leaves a parkable call unanswered for a person. Without that, a
	 * parked session would look busy to every caller that settles one — the hub's reap above all.
	 *
	 * A pending retry is part of the run too, so it is waited for rather than resolved past: the
	 * retry runs inside the stream the engine is awaiting, which keeps the agent non-idle for the whole
	 * backoff, and the condition is here so that stays true if that ever changes.
	 */
	async settle(id: string): Promise<void> {
		const state = this.agentStateOf(id);
		// Read through a closure: the run slot is reassigned across the awaits below, and a narrow
		// taken before them would tell the checker the slot is always empty here.
		const stillBusy = (): boolean =>
			(state.live.followUpQueue.size > 0 && this.danglingApprovals(state.session).length === 0) ||
			state.live.retrying === true;
		for (;;) {
			await (state.live.activeRun?.promise ?? Promise.resolve());
			// The run drops its own slot a microtask after the idle promise resolves; wait for that too,
			// so a caller that settles sees the idle session — and the dangling calls the run ended
			// with — rather than one still finishing its writes. The same bounded wait `abort` makes.
			while (state.live.activeRun !== undefined) await Promise.resolve();
			if (!stillBusy()) return;
		}
	}

	/**
	 * Stop the run, if any, and wait for the session to go quiet.
	 *
	 * A call left dangling stays a question: the transcript is the only state (ADR-0006 §5), so the
	 * reopen derives it from the ledger and shows it again, and the answer that arrives then starts
	 * the run that closes it. Closing does not answer for the user — the denials an exit used to
	 * write recorded an abandonment as a choice, and the reopen that inherited them inherited a lie.
	 * {@link Agent.abort} is the deliberate stop, and the denial is its answer; a process shutdown
	 * and a reap that has already denied both land here.
	 */
	async close(id: string): Promise<void> {
		this.agentStateOf(id).live.activeRun?.abortController.abort();
		await this.settle(id);
	}

	// ---------------------------------------------------------------------------- compaction

	// The per-request fill chain calls the resolver below; this public shape lets a caller run the
	// same three steps against a session it names by id — the smoke that exercises the pruning
	// ladder drives it directly.
	maybeCompact(
		id: string,
		entries: readonly SessionEntry[],
		now: number,
		signal?: AbortSignal,
		transport?: ChatTransport,
	): Promise<readonly SessionEntry[]> {
		const state = this.agentStateOf(id);
		const model = modelFor(state.session.sessionSetting.model ?? {}, this.models.list(), transport);
		return this.compactFor(state, entries, now, signal, model);
	}

	/**
	 * Shrink the context before the next request, and answer with the entries that request should carry.
	 *
	 * Three steps, cheapest first. The trigger is this session's own model's window minus a fixed reserve,
	 * so the same transcript compacts under a small-window model and does not under a large one. When it
	 * fires, the recorded arguments of the heavy tools are shortened first — the bodies a `write` or an
	 * `edit` carried live in the files they changed, so dropping them from the view costs nothing and no
	 * request. Then results that can be fetched again are cleared if the provider has probably forgotten
	 * the cache — an hour without a request means the prompt is being paid for in full, and what a tool
	 * can reproduce is the next cheapest thing to lose. Only if that is still not enough is the
	 * transcript folded into a summary, which costs a request; nothing is kept verbatim but the turn in
	 * flight.
	 *
	 * Both steps before the summary are *recorded*, not held in memory: `appendTrimToolCallArgs` and
	 * `appendClearToolResults` name the entries, and the store's own view applies them from then on.
	 * So a resumed process, the next request in the run, and the window all read one transcript
	 * instead of each re-deciding.
	 *
	 * A summary that cannot be produced leaves the transcript exactly as it was and is reported rather
	 * than thrown: compaction is an optimization, and failing the turn over it would replace a clear
	 * context-overflow error with a mysterious crash inside the request path.
	 *
	 * Returns the entries to send: the ones it was given when no step changed anything, the store's view
	 * after whichever step was enough, and that view again once a checkpoint was written. The counts are
	 * reported by the `tool_call_args_trimmed`, `tool_results_cleared`, and `compaction` events, not by this answer.
	 */
	private async compactFor(
		state: AgentState,
		entries: readonly SessionEntry[],
		now: number,
		signal: AbortSignal | undefined,
		model: Model,
	): Promise<readonly SessionEntry[]> {
		const threshold = compactionThresholdFor(model.contextWindow);
		if (!shouldCompact(messagesOf(entries), threshold)) return entries;

		const trimmed = this.trimRecordedArgs(state, entries);
		if (!shouldCompact(messagesOf(trimmed), threshold)) return trimmed;

		const cleared = this.clearStaleToolResults(state, trimmed, now);
		if (!shouldCompact(messagesOf(cleared), threshold)) return cleared;

		// The one completion compaction makes: the same model the turn is on, with the summary
		// instructions. It is the caller's model — the one this request is built from — so the summary
		// carries the same key, endpoint, and window as the conversation it summarizes rather than
		// reaching for a second configuration.
		const summarize: Summarize = async (request) => {
			// The same absence a turn meets: a session with no row answers with the sentence that says what
			// to add, rather than sending a summary request to a placeholder endpoint.
			if (this.models.list().find((userModel) => userModel.name === model.name) === undefined) {
				return unconfiguredStream(model).result();
			}
			const messages: Message[] = [
				{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() },
			];
			return model
				.stream({ messages, system: createSystemMessage(request.systemPrompt) }, {
					// The row's key, said here rather than only carried on the model: this is the one call
					// that does not travel through the engine, and the engine is what copies the key into options.
					apiKey: model.apiKey,
					maxTokens: request.maxTokens,
					// A one-off summary is never sent again, so paying to cache it would buy nothing.
					cacheRetention: "none",
					...(request.signal === undefined ? {} : { signal: request.signal }),
				})
				.result();
		};

		let outcome;
		try {
			outcome = await compactTranscript(cleared, model, summarize, signal);
		} catch (error) {
			// An abort is not a compaction failure: the run is ending, and the transcript simply keeps the
			// history it already had. Anything else is worth saying out loud, because the next request may
			// then be the one that overflows.
			if (signal?.aborted !== true) {
				this.emit(state, {
					type: "compaction_failed",
					message: error instanceof Error ? error.message : String(error),
				});
			}
			return cleared;
		}
		if (!outcome) return cleared;

		this.sessionManager.appendCompaction(
			state.session,
			outcome.summary,
			outcome.firstKeptEntryId,
			outcome.tokensBefore,
			outcome.usage,
		);
		// Published after the transcript moved, so a listener that reacts reads back the same numbers:
		// `summarized` is what this pass folded in, `contextTokens` is what the provider will now be sent.
		const compacted = this.sessionManager.buildContextEntries(state.session);
		this.emit(state, {
			type: "compaction",
			summary: outcome.summary,
			firstKeptEntryId: outcome.firstKeptEntryId,
			summarized: outcome.summarized,
			tokensBefore: outcome.tokensBefore,
			contextTokens: estimateTokens(messagesOf(compacted)),
		});
		return compacted;
	}

	/**
	 * Shorten the recorded arguments of the heavy tools, and record it.
	 *
	 * This is the cheapest step compaction has: no request, and no clock to wait out — the bodies a
	 * `write` or an `edit` carried are already in the files they changed, so the view loses nothing the
	 * the files they changed, so the view loses nothing the machine does not hold. It is also the
	 * reason this runs before the clear rather than beside it:
	 * the clear needs an expired cache to be worth its cache invalidation, and this does not, because
	 * when the transcript is over the trigger the next request is in trouble whatever the cache says.
	 */
	private trimRecordedArgs(state: AgentState, entries: readonly SessionEntry[]): readonly SessionEntry[] {
		const trimmed = trimmableToolArgEntryIds(entries);
		if (trimmed.length === 0) return entries;

		const tokensBefore = estimateTokens(messagesOf(entries));
		this.sessionManager.appendTrimToolCallArgs(state.session, trimmed, tokensBefore);
		const view = this.sessionManager.buildContextEntries(state.session);
		this.emit(state, {
			type: "tool_call_args_trimmed",
			trimmed: trimmed.length,
			tokensBefore,
			contextTokens: estimateTokens(messagesOf(view)),
		});
		return view;
	}

	/**
	 * Clear what can be fetched again, and record it, when the provider has probably dropped the cache.
	 *
	 * A warm cache is the reason not to do this: rewriting the middle of a prompt the provider has
	 * already read costs more than the tokens it saves, which is why the summary — one deliberate
	 * invalidation that shrinks the transcript for good — is the answer for a warm transcript.
	 */
	private clearStaleToolResults(
		state: AgentState,
		entries: readonly SessionEntry[],
		now: number,
	): readonly SessionEntry[] {
		if (!isCacheProbablyExpired(entries, now)) return entries;

		const cleared = clearableToolResultIds(entries);
		if (cleared.length === 0) return entries;

		const tokensBefore = estimateTokens(messagesOf(entries));
		this.sessionManager.appendClearToolResults(state.session, cleared, tokensBefore);
		const view = this.sessionManager.buildContextEntries(state.session);
		this.emit(state, {
			type: "tool_results_cleared",
			cleared: cleared.length,
			tokensBefore,
			contextTokens: estimateTokens(messagesOf(view)),
		});
		return view;
	}

	// ---------------------------------------------------------------------------- the run's event half

	/**
	 * A stamp no other message from this session shares.
	 *
	 * `Date.now()` is not enough: two messages queued in the same millisecond would be
	 * indistinguishable, and the echo of one would then be mistaken for the other. Derived from the
	 * ledger rather than held, so a restart — which forgets every counter — still cannot issue a stamp
	 * an existing message already has: the newest timestamp the file holds is the floor.
	 */
	private nextStamp(state: Session): number {
		let newest = 0;
		for (const entry of this.sessionManager.getEntries(state)) {
			if (entry.type !== "message") continue;
			const stamp = entry.message.timestamp;
			if (typeof stamp === "number" && stamp > newest) newest = stamp;
		}
		return Math.max(Date.now(), newest + 1);
	}

	/**
	 * Run the `before_tool` hooks.
	 *
	 * The engine's seam can block a call, suspend one, or let it through, so those are the decisions
	 * that reach it: an `args` refinement goes as far as the handlers registered after this one. A
	 * suspend comes from the approval gate, and it is the whole end-restart move (ADR-0006 §5): the
	 * engine ends the run at that call without writing a result, the call dangles in the ledger, and
	 * the answer that arrives over REST starts the recovery run that closes it.
	 *
	 * The gate's own answer is the effective approval map, which the default handler reads through
	 * `authorize` — the same merge the snapshot and the prompt describe, so the three cannot disagree.
	 */
	private async beforeTool(
		sessionId: string,
		toolCallId: string,
		toolName: string,
		args: unknown,
	): Promise<BeforeToolCallResult | undefined> {
		const decided = await this.hooks.apply("before_tool", { sessionId, toolCallId, toolName, args });
		if (decided?.suspend === true) return { suspend: true };
		if (decided?.block === undefined) return undefined;
		return {
			block: true,
			reason: decided.block.reason,
			...(decided.terminate === true ? { terminate: true } : {}),
		};
	}

	/**
	 * Run the `after_tool` hooks. Their answer is final.
	 *
	 * The engine builds the transcript message from what this returns, and the message is written with
	 * exactly that content: a rewrite is a decision about the one version of the result that will ever
	 * exist, made the moment the result does. A hook that means to bound a result archives the full
	 * text itself (`archiveToolResult`, `context/spill.ts`) and puts the path in what it returns; the
	 * write boundary's backstop below still catches a result nobody bounded.
	 */
	private async afterTool(
		sessionId: string,
		toolCallId: string,
		toolName: string,
		result: AgentToolResult<unknown>,
		isError: boolean,
	): Promise<AfterToolCallResult | undefined> {
		const decided = await this.hooks.apply("after_tool", {
			sessionId,
			toolCallId,
			toolName,
			content: result.content,
			isError,
		});
		if (decided?.content === undefined) return undefined;
		return { content: decided.content };
	}

	/**
	 * Drain one queue, writing each message to the transcript the moment it is taken.
	 *
	 * The write rides the drain rather than the engine's echo of it: taking a message off the queue is
	 * the moment the run takes responsibility for it, so the ledger gains it there and the gap where
	 * a message was neither queued nor stored never opens. The echo never persists user messages, so
	 * nothing has to mark these as already written.
	 */
	private drainTranscribed(queue: PendingMessageQueue, state: AgentState): Message[] {
		const messages = queue.drain();
		for (const message of messages) {
			this.appendMessage(state, message);
		}
		return messages;
	}

	/**
	 * The engine's sink: persist what the run reports, and pass it on.
	 *
	 * This is the one listener a run has — the engine awaits it, which is what makes a run settle only
	 * after its writes landed — and the run's transients are this handler's closure rather than
	 * anything on the session. It is the successor of the `Loop.subscribe` callback the engine used to
	 * be handed, and it is why the engine needs no listener registry of its own.
	 */
	private async dispatchEvent(state: AgentState, event: AgentEvent): Promise<void> {
		const live = state.live;
		if (event.type === "message_update") {
			// The hot path: one event per provider delta. Keep the running message for a baseline that
			// has to hand a mid-run attach the text it missed, and publish only what moved since the
			// last frame. Nothing is written here — the message is persisted when it ends.
			live.partial = event.message;
			const delta = messageDeltaOf(event);
			if (delta !== undefined) this.emit(state, { type: "message_update", delta });
			return;
		}
		if (event.type === "message_end" || event.type === "agent_end") live.partial = undefined;
		if (event.type === "message_end") {
			// The echo never persists a user message: every one of them reached the engine already
			// written — the prompt before the run started, a queued message at the drain. Everything
			// else the engine announces has no other writer and is written here as it stands —
			// the content is final by the time it lands (the write boundary is the last rewrite).
			if (event.message.role !== "user") {
				this.appendMessage(state, event.message);
			}
		}
		if (event.type === "agent_end" && !live.suspended) {
			// A message still queued is one the run never reached — an abort, a failure, a prompt that
			// arrived in the moment the engine stopped looking. Nothing will drain it, and the send
			// contract is fire-and-forget: it goes with the run, and the queues empty so the depth
			// falls to zero, which is what `settle()` waits on. See {@link Agent.dropQueued}.
			//
			// A run the gate ended is the one exception, and it is checked here rather than only in
			// `startRun`'s `finally` because this fires first: the recovery run drains what this one
			// leaves behind, so the depth stays up and the window keeps showing it.
			if (this.dropQueued(state)) this.emitQueueUpdate(state);
		}
		this.emit(state, event);
		if (event.type === "message_start" || event.type === "message_end" || event.type === "turn_end") {
			this.publish(state);
		}
	}

	// ---------------------------------------------------------------------------- the fan-out

	/** Fan one event out. The only place a session publishes an event. */
	private emit(state: AgentState, event: AgentSessionEvent): void {
		for (const listener of state.eventListeners) listener(event);
	}

	/**
	 * Publish the queue's current contents.
	 *
	 * Called only where the queue itself changed — a message accepted onto it, a drain point taking
	 * one, a run dropping what it never reached — so no baseline is kept: the fact of the call is the
	 * change. The queue is read off the live half.
	 */
	private emitQueueUpdate(state: AgentState): void {
		this.emit(state, { type: "queue_update", queued: state.live.followUpQueue.previews() });
	}

	/** Report a config change with only the fields that moved; silence when none did. */
	private emitConfigChanged(
		state: AgentState,
		changes: {
			model?: string;
			thinkingLevel?: string;
			approvals?: Record<string, boolean>;
			tools?: string[];
		},
	): void {
		if (
			changes.model === undefined &&
			changes.thinkingLevel === undefined &&
			changes.approvals === undefined &&
			changes.tools === undefined
		) {
			return;
		}
		this.emit(state, { type: "config_changed", ...changes });
	}

	/**
	 * Append a message entry and announce it.
	 *
	 * Both writers of message entries go through here — a prompt for the optimistic user write and
	 * {@link Agent.dispatchEvent} for everything the engine hands back — so a listener that follows
	 * `entry_appended` sees the whole transcript, not just the engine's half of it.
	 */
	private appendMessage(state: AgentState, message: Message): void {
		// A message appended where something already followed is a *second* alternative at that message
		// rather than a continuation of its tip — which is what rewinding and asking again is. The tree
		// gained a branch point there, so the windows are told where the leaf is, exactly as a move does:
		// their branch points came from a snapshot and this append changed them.
		// The count is the raw child count, so a `leaf` entry — the record a branch move writes — counts
		// too. The cost is one
		// extra full-snapshot frame that shows no extra branch point, which is harmless.
		const parent = state.session.leafId;
		const continued = parent !== null && this.sessionManager.getChildren(state.session, parent).length > 0;

		const entryId = this.sessionManager.appendMessage(state.session, finalizeToolResult(state, message));
		if (continued) this.emit(state, { type: "branch_changed", leafId: entryId });
		this.emit(state, { type: "entry_appended", entryId, kind: "message" });
	}

	/**
	 * Empty the queues a run leaves behind.
	 *
	 * A message still queued when the run ends is one the run never reached — an abort, a failure,
	 * a prompt that arrived in the moment the engine stopped looking. Nothing will drain it, and the
	 * send contract is fire-and-forget: the message drops with the run rather than being stored
	 * unasked, and the queues empty so the depth falls to zero — which is what `settle()` waits on —
	 * and no later run inherits what this one never took.
	 *
	 * Returns whether anything was actually dropped, so the caller publishes a queue change only
	 * when there was one.
	 *
	 * The one end that does not come here is the gate's: a suspended run keeps its queue for the
	 * recovery run the answer starts, which drains it at its take points (`RunScope.suspended`). The
	 * abandonment sweep is the exception to that exception — {@link Agent.denyAllApprovals} calls
	 * this, because no recovery run is coming to take them.
	 */
	private dropQueued(state: AgentState): boolean {
		const dropped = state.live.steeringQueue.size > 0 || state.live.followUpQueue.size > 0;
		state.live.steeringQueue.clear();
		state.live.followUpQueue.clear();
		return dropped;
	}

	/** Tell every listener what the session looks like now. */
	private publish(state: AgentState): void {
		const snapshot = this.snapshot(state.session.sessionId);
		for (const listener of state.listeners) listener(snapshot);
	}
}

/**
 * The approval keys whose value differs, or undefined when none do.
 *
 * `config_changed` carries only what moved, so an `applyConfig` that re-sends the current settings —
 * which is what a reconnect or an unchanged form does — must not claim anything changed.
 */
function changedApprovals(
	before: Record<string, boolean>,
	after: Record<string, boolean>,
): Record<string, boolean> | undefined {
	const changed: Record<string, boolean> = {};
	let moved = false;
	for (const [key, value] of Object.entries(after)) {
		if (before[key] === value) continue;
		changed[key] = value;
		moved = true;
	}
	return moved ? changed : undefined;
}

/**
 * Thrown out of an attempt that failed with a context overflow, so the retry policy never sees it.
 *
 * `retryAssistantCall` classifies what `produce` returns, so the only way to keep an overflow out of
 * the retry budget is to not return it: the pump catches this and ends the run with the same error
 * message, exactly as it would for a failure the classifier rejects.
 */
class ContextOverflow {
	readonly message: AssistantMessage;

	constructor(message: AssistantMessage) {
		this.message = message;
	}
}

/** A zero `Usage`, for a message no provider produced. */
const NO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A stream function that threw, in the shape the engine ends a run on. */
function failureMessage(model: Model, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		model: model.id,
		usage: NO_USAGE,
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/**
 * End the session's stream the way a provider would.
 *
 * The engine's terminal branch is driven by this event, and `AssistantMessageEventStream.result()`
 * answers with exactly the message it carries, so the event is rebuilt from the message the retry
 * policy settled on rather than copied from the attempt that produced it — an attempt that was
 * retried had its own terminal event discarded.
 */
function pushTerminal(outer: AssistantMessageEventStream, message: AssistantMessage): void {
	const { stopReason } = message;
	if (stopReason === "error" || stopReason === "aborted" || stopReason === "pending") {
		// `pending` means the stream ended without a terminal event at all; report it as the failure
		// it is rather than as a completed turn.
		outer.push({ type: "error", reason: stopReason === "pending" ? "error" : stopReason, error: message });
		return;
	}
	outer.push({ type: "done", reason: stopReason, message });
}

/**
 * Move each late tool result back beside the call it answers.
 *
 * The ledger is append-only, so a result can stand behind messages its call never saw: a prompt the
 * orchestrator wrote before the run's recovery pass closed the call, a message the run flushed at its
 * end after the gate had already left the call dangling. On disk that order is the honest one — the
 * prompt really did come before the answer — but a provider request that carries it is not legal: the
 * wire wants every tool result in the user turn that follows its own assistant message, and a call
 * answered two turns later reads as a call never answered.
 *
 * The repair is the request's, never the file's: a result is late when its call was issued, left
 * unanswered across a non-result message, and answered afterwards; each late result is hoisted to
 * directly after the assistant message that carries its call, in the order the calls were made.
 * Everything else stays exactly where the ledger put it.
 */
function pairLateToolResults(messages: readonly Message[]): Message[] {
	// Which results are late: a call still open when a non-result message arrives is answered too
	// late by whatever comes after, because the wire has already moved on.
	const lateIds = new Set<string>();
	{
		const open = new Set<string>();
		for (const message of messages) {
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "toolCall") open.add(block.id);
				}
			} else if (message.role === "toolResult") {
				open.delete(message.toolCallId);
			} else if (open.size > 0) {
				for (const id of open) lateIds.add(id);
			}
		}
	}
	if (lateIds.size === 0) return messages as Message[];

	// The late results, grouped by call id and kept in the order the ledger gave them.
	const late = new Map<string, Message[]>();
	for (const message of messages) {
		if (message.role === "toolResult" && lateIds.has(message.toolCallId)) {
			const grouped = late.get(message.toolCallId) ?? [];
			grouped.push(message);
			late.set(message.toolCallId, grouped);
		}
	}

	const out: Message[] = [];
	for (const message of messages) {
		if (message.role === "toolResult" && lateIds.has(message.toolCallId)) continue;
		out.push(message);
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const grouped = late.get(block.id);
				if (grouped !== undefined) out.push(...grouped);
			}
		}
	}
	return out;
}

/**
 * The messages one selection of entries stands for — the same projection the store hands a request.
 *
 * It is the only way the trigger measures a prompt, so `maybeCompact` can compare the transcript as
 * stored with the transcript after a clear without building the request twice.
 */
function messagesOf(entries: readonly SessionEntry[]): Message[] {
	return entries.flatMap((entry) => sessionEntryToContextMessages(entry));
}
