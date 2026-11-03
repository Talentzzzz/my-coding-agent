import type { AgentToolResult } from "./types.ts";
import type { Message } from "@my-agent/llm";
import { truncate } from "./tools/truncate.ts";
import { spillPathFor, spillText, spillView, writeSpillFile, SPILL_KEEP_CHARS } from "./context/spill.ts";

/** How a tool result carries its content: text and image blocks, in order. */
export type ToolResultContent = AgentToolResult<unknown>["content"];

/** A handler's answer, or a promise of it: the approval gate cannot answer before the user does. */
type MaybePromise<T> = T | Promise<T>;

/**
 * The seams every run dispatches through.
 *
 * A handler returns only the fields it decided, and a hook with no handlers changes nothing.
 * {@link Hooks.apply} runs the handlers in registration order, so a later one refines an earlier one's
 * answer rather than replacing the decision outright. Grow this map one entry per consumer; until
 * something calls a hook, adding one is a no-op.
 *
 * Every event names the session its run belongs to. The surface itself is process-level configuration
 * (ADR-0007 §6): one `Hooks` serves every session this process runs, so a handler that had to be told
 * its session by a closure would be the per-session object this seam exists to remove. The id is what
 * it resolves the rest with — the working directory, the transcript, the approval map.
 */
export interface HookMap {
	/** Rewrite what goes to the provider. Default: fresh system message + the store's messages. */
	context: (event: { sessionId: string; messages: Message[]; systemPrompt: string }) => MaybePromise<
		{ messages?: Message[]; systemPrompt?: string } | undefined
	>;
	/** Runs before a tool call. Default: the approval gate. */
	before_tool: (event: { sessionId: string; toolCallId: string; toolName: string; args: unknown }) => MaybePromise<
		{ block?: { reason: string }; args?: unknown; terminate?: boolean; suspend?: boolean } | undefined
	>;
	/**
	 * Runs on the result. Default: none — a rewrite is final, and the write boundary in `agent.ts`
	 * is the backstop for a result nobody bounded.
	 */
	after_tool: (event: {
		sessionId: string;
		toolCallId: string;
		toolName: string;
		content: ToolResultContent;
		isError: boolean;
	}) => MaybePromise<{ content?: ToolResultContent } | undefined>;
}

export type HookName = keyof HookMap;

/** What a hook is handed: its event, already carrying the fields earlier handlers set. */
export type HookEvent<TName extends HookName> = Parameters<HookMap[TName]>[0];

/** What a hook answered: the fields its handlers set, or undefined when none did. */
export type HookResult<TName extends HookName> = Awaited<ReturnType<HookMap[TName]>>;

export interface Hooks {
	/** Register a handler. It runs after the handlers already registered; the returned call removes it. */
	on<TName extends HookName>(name: TName, handler: HookMap[TName]): () => void;
	/** Run one hook's handlers in order and answer with what they decided together. */
	apply<TName extends HookName>(name: TName, event: HookEvent<TName>): Promise<HookResult<TName>>;
}

/** A registered handler, erased to the one shape every hook shares. */
type AnyHandler = (event: never) => MaybePromise<unknown>;

/**
 * Build the hook surface a process dispatches through.
 *
 * Registration order is the only order there is: the default handlers installed first run first, and
 * a host that registers later sees their answer and can refine it. State is held per call and nowhere
 * else, so a handler registered while a run is in flight is simply seen by the next call.
 */
export function createHooks(): Hooks {
	// Keyed by name rather than one field per hook: a lookup by name cannot carry the name's own types
	// through a `Map`, so the two edges that know the name — `on` and `apply` — cast, and nothing in
	// between does.
	const handlers = new Map<HookName, AnyHandler[]>();

	const registry: Hooks = {
		on<TName extends HookName>(name: TName, handler: HookMap[TName]): () => void {
			const entry = handler as AnyHandler;
			const registered = handlers.get(name) ?? [];
			registered.push(entry);
			handlers.set(name, registered);
			// Splice rather than rebuild: the handlers that remain keep the order they were added in.
			return () => {
				const index = registered.indexOf(entry);
				if (index !== -1) registered.splice(index, 1);
			};
		},
		async apply<TName extends HookName>(name: TName, event: HookEvent<TName>): Promise<HookResult<TName>> {
			let current: Record<string, unknown> = { ...event };
			let decided: Record<string, unknown> | undefined;
			for (const handler of handlers.get(name) ?? []) {
				const answer = await handler(current as never);
				if (answer === undefined) continue;
				const fields = defined(answer as Record<string, unknown>);
				// Later handlers win field by field and see the fields an earlier one set, which is what
				// makes one hook able to refine another's answer instead of merely replacing it.
				decided = { ...decided, ...fields };
				current = { ...current, ...fields };
			}
			return decided as HookResult<TName>;
		},
	};

	return registry;
}

/** The fields a handler actually set: an omitted field is not an instruction to erase an earlier one. */
function defined(patch: Record<string, unknown>): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	for (const [field, value] of Object.entries(patch)) if (value !== undefined) fields[field] = value;
	return fields;
}

/**
 * Session-level ceiling on one tool result, in UTF-8 bytes.
 *
 * Tools bound their own output (`tools/truncate.ts`, 60,000 characters), so a well-behaved tool never
 * reaches this. It is the floor under the spill (`context/spill.ts`), which archives a result over
 * 80,000 characters into the session's working directory instead of clipping it: when that archive
 * cannot be written, this is what still keeps one result from blowing the context. Deliberately far
 * above the per-tool budget, so a result a tool already bounded is never clipped a second time.
 */
export const MAX_TOOL_RESULT_BYTES = 200_000;

/** Room kept for the notice `truncate` writes, so a clip lands inside the budget and not just past it. */
const NOTICE_RESERVE_BYTES = 64;

/**
 * Bound one tool result to {@link MAX_TOOL_RESULT_BYTES}, or `undefined` when it already fits.
 *
 * Text is clipped with the same `truncate` the tools use, so a model that is told its output was cut
 * reads the same sentence wherever the cut happened. Image blocks are passed through untouched: this
 * budget is about text, and there is nothing in a picture to clip.
 */
export function boundToolContent(content: ToolResultContent): ToolResultContent | undefined {
	if (contentBytes(content) <= MAX_TOOL_RESULT_BYTES) return undefined;

	let remaining = MAX_TOOL_RESULT_BYTES;
	return content.map((block) => {
		if (block.type !== "text") return block;
		const budget = Math.max(0, remaining - NOTICE_RESERVE_BYTES);
		const { text } = truncate(block.text, charsForBytes(block.text, budget));
		remaining = Math.max(0, remaining - Buffer.byteLength(text));
		return { ...block, text };
	});
}

function contentBytes(content: ToolResultContent): number {
	let bytes = 0;
	for (const block of content) if (block.type === "text") bytes += Buffer.byteLength(block.text);
	return bytes;
}

/** The longest slice of `text` whose UTF-8 form fits `maxBytes`, at this text's own density. */
function charsForBytes(text: string, maxBytes: number): number {
	const bytes = Buffer.byteLength(text);
	if (bytes <= maxBytes) return text.length;
	return Math.floor((text.length * maxBytes) / bytes);
}

/**
 * Archive one tool result whole and answer with what an `after_tool` handler returns for it.
 *
 * The write-side rule the seam now carries is: **a rewrite is the final version** — the ledger keeps
 * exactly the content the handler returns, so bounding a result means the full text has to be
 * somewhere else first. This is that somewhere else, one call: it writes the result's text whole
 * under the working directory (`.my-agent/tool-results/`, the same path derivation the write
 * boundary's own backstop uses) and answers with the head-and-tail view that names the file, so a
 * model that needs the rest reads it back itself. A result the file could not take comes back
 * untouched rather than truncated-with-a-path-that-is-not-there — the write boundary still bounds it.
 *
 * The `workDirAbsPath` is the handler's to supply: the hook event names the session, and the handler
 * closes over the directory it is archiving into.
 *
 * ```ts
 * hooks.on("after_tool", (event) => archiveToolResult(event, workDirAbsPath));
 * ```
 */
export function archiveToolResult(
	event: { sessionId: string; toolCallId: string; toolName: string; content: ToolResultContent },
	workDirAbsPath: string,
): { content: ToolResultContent } {
	const text = spillText(event.content);
	const { absPath, relPath } = spillPathFor(workDirAbsPath, event.sessionId, event.toolName, event.toolCallId);
	if (!writeSpillFile(absPath, text)) return { content: event.content };
	return { content: spillView(event.content, text, relPath, SPILL_KEEP_CHARS) };
}
