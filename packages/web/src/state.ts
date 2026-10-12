import {
	addUsage,
	EMPTY_USAGE,
	type AgentSessionEvent,
	type BranchPoint,
	type FileDiff,
	type ModelOption,
	type PendingApproval,
	type ServerMessage,
	type SessionRef,
	type SessionSnapshot,
	type SettingsSnapshot,
	type UsageTotals,
	type WorkspaceGroup,
} from "@my-agent/core/protocol";

export interface ToolCard {
	toolCallId: string;
	toolName: string;
	args: unknown;
	output: string;
	isError: boolean;
	running: boolean;
	/**
	 * What the call changed on disk, when the tool reported it.
	 *
	 * The report is part of the tool's result, so it arrives on the loop's `tool_execution_end` event
	 * and is recorded with the result in the transcript. The card draws it instead of the tool's text —
	 * the text is the same change written for a model — and falls back to the text for every result
	 * that carries no report: a failed call, a no-op write, or a tool that changes nothing.
	 */
	diff?: FileDiff;
}

export type Item =
	| {
			kind: "message";
			id: string;
			role: string;
			text: string;
			notice: boolean;
			streaming: boolean;
			/** The store entry behind this message, when the message is forkable from. */
			forkEntryId?: string | null;
			/**
			 * The branch point this message sits on, when the conversation carried on from it more than
			 * one way. The alternatives are entry ids and nothing more: where each one leads is worked out
			 * when the choice is made, because a branch grows at its tip and a remembered tip would be a
			 * place the conversation had already left.
			 */
			branch?: BranchPoint;
	  }
	| { kind: "tools"; id: string; cards: ToolCard[] };

/** A backoff the session is waiting out, from `retry_scheduled` until `retry_end`. */
export interface RetryState {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
}

/** An entry the server named before the transcript had an item to put it on. */
export interface PendingEntry {
	entryId: string;
	messageTimestamp?: number;
}

export interface ViewState {
	connected: boolean;
	snapshot?: SessionSnapshot;
	items: Item[];
	/** Entry ids whose message has not shown up in `items` yet. */
	pendingEntries: PendingEntry[];
	streaming: boolean;
	usage: UsageTotals;
	approvals: PendingApproval[];
	/** Accepted messages the loop has not drained yet, for the composer's queue hint. */
	queued: number;
	/** A retry in flight, for the header's retrying line. */
	retry?: RetryState;
	/** The models the user has imported, for the settings panel and the session's model picker. */
	models: ModelOption[];
	/** The sessions of this workspace, for the picker the server answers with. */
	sessions: SessionRef[];
	/** Every workspace with stored sessions, for the sidebar's groups. */
	workspaces: WorkspaceGroup[];
	/** Theme, font size, and the approval set. Absent until the server has answered once. */
	settings?: SettingsSnapshot;
	error?: string;
}

export function initialState(): ViewState {
	return {
		connected: false,
		items: [],
		pendingEntries: [],
		streaming: false,
		usage: { ...EMPTY_USAGE },
		approvals: [],
		queued: 0,
		models: [],
		sessions: [],
		workspaces: [],
	};
}

/**
 * Paint the appearance the server reported.
 *
 * Called on every settings change rather than only at boot, because the panel edits these live: the
 * font size is a root variable and the theme is one attribute, so neither needs a reload to take
 * effect, and the panel would feel broken if either did.
 */
export function applyAppearance(settings: SettingsSnapshot): void {
	const root = document.documentElement;
	const theme = settings.appearance.theme;
	root.dataset.theme =
		theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
	root.style.setProperty("--app-font-size", `${settings.appearance.fontSize}px`);
}

/**
 * Fold one protocol message into the view state.
 *
 * Items are keyed by message timestamp, which the agent assigns once per message and repeats in
 * every `message_update`, so streaming updates land on the item they belong to.
 */
export function reduce(state: ViewState, message: ServerMessage): ViewState {
	switch (message.type) {
		case "session":
			return {
				...state,
				snapshot: message.session,
				items: attachBranches(itemsFromSnapshot(message.session), message.session.branchPoints),
				// A snapshot carries the ids of everything it shows, so nothing is left outstanding.
				pendingEntries: [],
				streaming: message.session.submitting,
				usage: message.session.usage,
				approvals: message.session.pendingApprovals,
				queued: message.session.queued,
				retry: message.session.isRetrying ? state.retry : undefined,
				error: undefined,
			};
		case "entry": {
			const drained = drainEntries(state.items, [{ entryId: message.entryId, messageTimestamp: message.messageTimestamp }]);
			return {
				...state,
				items: drained.items,
				pendingEntries: [...state.pendingEntries, ...drained.pending].slice(-PENDING_ENTRIES),
			};
		}
		case "status":
			return {
				...state,
				usage: message.usage,
				streaming: message.submitting,
				queued: message.queued,
				snapshot: state.snapshot
					? {
							...state.snapshot,
							submitting: message.submitting,
							queued: message.queued,
							isRetrying: message.isRetrying,
							retryAttempt: message.retryAttempt,
						}
					: undefined,
			};
		case "error":
			return { ...state, error: message.message };
		case "tool_approval_request":
			return {
				...state,
				approvals: [
					...state.approvals.filter((approval) => approval.toolCallId !== message.request.toolCallId),
					message.request,
				],
			};
		case "tool_approval_settled":
			return { ...state, approvals: state.approvals.filter((approval) => approval.toolCallId !== message.toolCallId) };
		case "session_event":
			return applySessionEvent(state, message.event);
		default:
			return state;
	}
}

/**
 * Fold one session event.
 *
 * The union is flat, so the loop's events keep the handling they always had and the session's own
 * members are cases beside them. `entry_appended` is swallowed on purpose: the transcript is built
 * from messages, and a store entry the browser cannot render yet must not appear as one.
 */
function applySessionEvent(state: ViewState, event: AgentSessionEvent): ViewState {
	switch (event.type) {
		case "agent_start":
			return { ...state, streaming: true, error: undefined };
		case "agent_end":
			return { ...state, streaming: false };
		case "message_start":
		case "message_update":
		case "message_end": {
			const items = upsertMessage(state.items, event.message, event.type === "message_end");
			// A user entry is named before the loop echoes it, so its id waits here for the item.
			const drained = drainEntries(items, state.pendingEntries);
			return { ...state, items: drained.items, pendingEntries: drained.pending };
		}
		case "tool_execution_start":
			return { ...state, items: upsertTool(state.items, event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				output: "",
				isError: false,
				running: true,
			}) };
		case "tool_execution_update":
			return { ...state, items: upsertTool(state.items, event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				output: contentToText(event.partialResult),
				isError: false,
				running: true,
			}) };
		case "tool_execution_end":
			// The loop's end event names the call and its result, but not the arguments it was made
			// with, so they are left where the start event put them: the card keeps naming what it ran.
			return { ...state, items: upsertTool(state.items, event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				output: contentToText(event.result),
				isError: event.isError,
				running: false,
				diff: fileDiffOf(event.result),
			}) };
		case "turn_end": {
			const usage = assistantUsage(event.message);
			return usage ? { ...state, usage: addUsage(state.usage, usage, state.usage.contextWindow) } : state;
		}
		case "queue_update":
			return {
				...state,
				queued: event.queued,
				snapshot: state.snapshot ? { ...state.snapshot, queued: event.queued } : undefined,
			};
		case "compaction":
			// The summary is the transcript's record of what was folded away, so the note carries it
			// rather than a count: a reader can see what the agent still knows.
			return {
				...state,
				items: appendNote(
					state.items,
					`[上下文已压缩：${event.summarized} 条消息被总结，压缩前约 ${event.tokensBefore} tokens，当前上下文约 ${event.contextTokens} tokens。]\n\n${event.summary}`,
				),
			};
		case "compaction_failed":
			return { ...state, items: appendNote(state.items, `[压缩失败：${event.message}]`) };
		case "pruned":
			// The cleared results carry their own notice in the transcript, so this line only has to say
			// how much went and what it was worth — the messages themselves already show what changed.
			return {
				...state,
				items: appendNote(
					state.items,
					`[已清理 ${event.cleared} 条过期工具结果：清理前约 ${event.tokensBefore} tokens，当前上下文约 ${event.contextTokens} tokens。]`,
				),
			};
		case "arg_trimmed":
			// The trimmed calls carry their own "... [truncated] ..." marker in the transcript, so this
			// line only has to say how much went and what it was worth.
			return {
				...state,
				items: appendNote(
					state.items,
					`[已缩短 ${event.trimmed} 次工具调用的记录参数：缩短前约 ${event.tokensBefore} tokens，当前上下文约 ${event.contextTokens} tokens。]`,
				),
			};
		case "retry_scheduled":
			return {
				...state,
				// The abandoned attempt's partial item goes with it: the retry replaces that message in
				// place server-side, and two items for one answer is the one thing the fold must not do.
				items: appendNote(
					dropStreamingAssistant(state.items),
					retryingLine(event.attempt, event.maxAttempts, event.delayMs, event.errorMessage),
				),
				retry: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs },
				snapshot: state.snapshot
					? { ...state.snapshot, isRetrying: true, retryAttempt: event.attempt }
					: undefined,
			};
		case "retry_start":
			// The backoff is over and the retried call is in flight, so the line loses its countdown
			// but stays up until the loop ends.
			return {
				...state,
				retry: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: 0 },
			};
		case "retry_end":
			return {
				...state,
				retry: undefined,
				snapshot: state.snapshot ? { ...state.snapshot, isRetrying: false, retryAttempt: 0 } : undefined,
			};
		case "config_changed": {
			// No new snapshot is sent for a config change, so the header's copy is patched in place.
			// `thinkingLevels` stays as the session last reported them; the next `session` frame fixes it.
			if (!state.snapshot) return state;
			const snapshot = { ...state.snapshot };
			if (event.model !== undefined) snapshot.model = event.model;
			if (event.thinkingLevel !== undefined) snapshot.thinkingLevel = event.thinkingLevel;
			if (event.approvals !== undefined) snapshot.approvals = { ...snapshot.approvals, ...event.approvals };
			if (event.tools !== undefined) snapshot.activeTools = event.tools;
			return { ...state, snapshot };
		}
		case "entry_appended":
			return state;
		default:
			return state;
	}
}

/** Append a transcript note — something the session did, rendered where a message would be. */
function appendNote(items: Item[], text: string): Item[] {
	const ordinal = items.filter((item) => item.kind === "message" && item.role === "system").length;
	return [...items, { kind: "message", id: `note:${ordinal}`, role: "system", text, notice: true, streaming: false }];
}

/** The retrying line: the transcript's note carries the error, the header's copy does not. */
export function retryingLine(attempt: number, maxAttempts: number, delayMs: number, errorMessage?: string): string {
	const line = `${delayMs > 0 ? `将在 ${retrySeconds(delayMs)} 秒后重试` : "正在重试"}（第 ${attempt}/${maxAttempts} 次）`;
	return errorMessage === undefined ? line : `${line}：${errorMessage}`;
}

function retrySeconds(delayMs: number): number {
	return delayMs >= 1000 ? Math.round(delayMs / 1000) : Number((delayMs / 1000).toFixed(1));
}

/** Drop the streaming assistant item, which a retry has abandoned. */
function dropStreamingAssistant(items: Item[]): Item[] {
	const last = items.at(-1);
	return last?.kind === "message" && last.role === "assistant" && last.streaming ? items.slice(0, -1) : items;
}

function itemsFromSnapshot(snapshot: SessionSnapshot): Item[] {
	let items: Item[] = [];
	snapshot.messages.forEach((message, index) => {
		items = upsertMessage(items, message, true, snapshot.messageEntryIds?.[index] ?? undefined);
	});
	return items;
}

/**
 * Put each branch point on the message it belongs to.
 *
 * A branch point names the entry the alternatives hang off, and a message item already carries the
 * entry behind it — the same pairing "派生新会话" is drawn from — so this is a match on entry id
 * rather than a second walk of the tree. A point whose message is not on screen, because a compaction
 * folded that turn into its summary, has nowhere to be drawn and is dropped.
 */
function attachBranches(items: Item[], branchPoints: readonly BranchPoint[] | undefined): Item[] {
	if (branchPoints === undefined || branchPoints.length === 0) return items;

	const byEntry = new Map(branchPoints.map((point) => [point.entryId, point]));
	return items.map((item) => {
		if (item.kind !== "message" || item.forkEntryId === undefined || item.forkEntryId === null) return item;
		const branch = byEntry.get(item.forkEntryId);
		return branch === undefined ? item : { ...item, branch };
	});
}

function upsertMessage(
	items: Item[],
	message: unknown,
	final: boolean,
	forkEntryId: string | null | undefined = undefined,
): Item[] {
	const record = message as {
		role?: string;
		content?: unknown;
		timestamp?: number;
		summary?: string;
		errorMessage?: string;
	};
	const role = record.role ?? "unknown";
	if (role === "toolResult") return items;

	// A compaction checkpoint is a role of its own on the wire: its text is the summary, and it is the
	// one thing in the transcript that stands for history the model no longer has verbatim.
	let text = role === "compactionSummary" ? (record.summary ?? "") : contentToText(record.content);
	if (text.length === 0 && role === "assistant" && final && typeof record.errorMessage === "string") {
		text = `错误：${record.errorMessage}`;
	}
	if (text.length === 0) return items;

	const id = `${role}:${String(record.timestamp ?? "unknown")}`;
	const notice =
		role === "compactionSummary" || text.startsWith("[上下文已压缩：") || text.startsWith("错误：");
	const index = items.findIndex((item) => item.kind === "message" && item.id === id);
	const existing = index === -1 ? undefined : (items[index] as Extract<Item, { kind: "message" }>);
	const carried = forkEntryId ?? existing?.forkEntryId;
	const item: Extract<Item, { kind: "message" }> = { kind: "message", id, role, text, notice, streaming: !final };
	// A streaming update carries no entry id, so an id already attached to this item is kept — and with
	// it the branch point that was read off that id, which rebuilding this same message would drop.
	if (carried !== undefined && carried !== null) item.forkEntryId = carried;
	if (existing?.branch !== undefined) item.branch = existing.branch;

	if (index === -1) {
		// A new message ends the current tool group, so cards that follow belong to it.
		return [...items, item];
	}
	const next = [...items];
	next[index] = item;
	return next;
}

/**
 * Put entry ids on the items whose messages they belong to.
 *
 * Items are keyed by `role:timestamp`, and a store entry holds the very message the loop echoes, so
 * the timestamp is what pairs them. An entry whose item has not appeared yet stays pending.
 */
function drainEntries(items: Item[], pending: PendingEntry[]): { items: Item[]; pending: PendingEntry[] } {
	if (pending.length === 0) return { items, pending };

	const rest: PendingEntry[] = [];
	let next = items;
	for (const entry of pending) {
		const index = next.findIndex(
			(item) => item.kind === "message" && !item.forkEntryId && item.id.endsWith(`:${String(entry.messageTimestamp)}`),
		);
		if (index === -1) {
			rest.push(entry);
			continue;
		}
		const copy = [...next];
		copy[index] = { ...(next[index] as Extract<Item, { kind: "message" }>), forkEntryId: entry.entryId };
		next = copy;
	}
	return { items: next, pending: rest };
}

/** How many named-but-unmatched entries to hold; one turn's worth is far fewer. */
const PENDING_ENTRIES = 20;

/**
 * Fold one tool event into the card it belongs to.
 *
 * The event carries what it knows, not the whole card: a start event has the arguments and no result,
 * an end event the result and no arguments. So the card is patched field by field and everything the
 * event stays silent about is left as it was, which is what keeps a finished card able to say what
 * was called.
 */
function upsertTool(items: Item[], toolCallId: string, patch: Partial<ToolCard> & { toolName: string }): Item[] {
	const next = items.map((item) => {
		if (item.kind !== "tools") return item;
		if (!item.cards.some((candidate) => candidate.toolCallId === toolCallId)) return item;
		return {
			...item,
			cards: item.cards.map((candidate) =>
				candidate.toolCallId === toolCallId ? { ...candidate, ...patch } : candidate,
			),
		};
	});

	if (next.some((item) => item.kind === "tools" && item.cards.some((c) => c.toolCallId === toolCallId))) return next;

	const card: ToolCard = {
		toolCallId,
		args: undefined,
		output: "",
		isError: false,
		running: true,
		...patch,
	};

	// Cards of one turn share the group that directly follows that turn's assistant message.
	const last = next.at(-1);
	if (last?.kind === "tools" && last.cards.every((candidate) => candidate.running)) {
		const updated = [...next];
		updated[updated.length - 1] = { ...last, cards: [...last.cards, card] };
		return updated;
	}
	return [...next, { kind: "tools", id: `tools:${toolCallId}`, cards: [card] }];
}

/** The line kinds a report may carry; anything else is not a report this client understands. */
const DIFF_KINDS: ReadonlySet<string> = new Set(["add", "remove", "context", "skip"]);

/**
 * The diff inside a tool result, when it holds one.
 *
 * A result crosses a process boundary and arrives as plain JSON, so nothing about its shape can be
 * assumed from the type that described it on the way out: a card shows a diff only when the payload
 * really is one, and falls back to the tool's text otherwise.
 */
function fileDiffOf(result: unknown): FileDiff | undefined {
	const details = (result as { details?: unknown } | null | undefined)?.details;
	const candidate = (details as { diff?: unknown } | null | undefined)?.diff;
	if (typeof candidate !== "object" || candidate === null) return undefined;

	const record = candidate as Partial<FileDiff>;
	if (typeof record.path !== "string") return undefined;
	if (typeof record.added !== "number" || typeof record.removed !== "number") return undefined;
	if (typeof record.created !== "boolean" || typeof record.omitted !== "number") return undefined;
	if (!Array.isArray(record.lines) || !record.lines.every(isDiffLine)) return undefined;
	return record as FileDiff;
}

function isDiffLine(line: unknown): boolean {
	if (typeof line !== "object" || line === null) return false;
	const record = line as { kind?: unknown; text?: unknown };
	return typeof record.text === "string" && typeof record.kind === "string" && DIFF_KINDS.has(record.kind);
}

export function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (content === undefined || content === null) return "";
	if (!Array.isArray(content)) {
		const nested = (content as { content?: unknown }).content;
		return nested === undefined ? "" : contentToText(nested);
	}

	const blocks: unknown[] = content;
	return blocks
		.map((block) => {
			if (typeof block !== "object" || block === null) return "";
			const typed = block as { type?: unknown; text?: unknown; thinking?: unknown; content?: unknown; name?: unknown };
			if (typed.type === "text") return String(typed.text ?? "");
			if (typed.type === "thinking") return `[思考] ${String(typed.thinking ?? "")}`;
			if (typed.type === "toolCall") return `[调用 ${String(typed.name ?? "tool")}]`;
			if (typed.type === "image") return "[图片]";
			return typed.content === undefined ? "" : contentToText(typed.content);
		})
		.join("");
}

function assistantUsage(message: unknown): Parameters<typeof addUsage>[1] | undefined {
	const record = message as { role?: string; usage?: unknown };
	if (record.role !== "assistant" || record.usage === undefined) return undefined;
	return record.usage as Parameters<typeof addUsage>[1];
}
