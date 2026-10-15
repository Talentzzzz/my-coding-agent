import {
	addUsage,
	EMPTY_USAGE,
	type AgentSessionEvent,
	type BranchOption,
	type BranchPoint,
	type FileDiff,
	type ModelOption,
	type PendingApproval,
	type ServerMessage,
	type SessionSnapshot,
	type SettingsSnapshot,
	type UsageTotals,
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

/**
 * The model's reasoning for one message, kept apart from the answer it led to.
 *
 * A reasoning block and the text that follows it arrive on the same message, but they are read
 * differently — the answer is the point, the reasoning is behind it — so the transcript draws them
 * as separate rows and only the reasoning one collapses. `text` is the provider's Markdown as it
 * came (`packages/ai/src/api/anthropic-messages.ts` concatenates the deltas verbatim), and several
 * reasoning blocks in one message are joined with a blank line, which is where a paragraph break is.
 */
export interface MessageThinking {
	/** The reasoning, as Markdown, with the provider's own line breaks. */
	text: string;
	/** The message's reasoning included a redacted block; its text already says so in words. */
	redacted?: boolean;
	/**
	 * Whether reasoning is still arriving.
	 *
	 * The text itself needs no delta bookkeeping — every `message_update` carries the running total —
	 * but "still thinking" is not a fact about the text: it is a fact about which event is in flight.
	 * `thinking_start`/`thinking_delta` set it, `thinking_end` clears it, and a `text_*` event clears
	 * it too, because by then reasoning has stopped and only the answer is still being written.
	 */
	running: boolean;
}

export type Item =
	| {
			kind: "message";
			id: string;
			role: string;
			text: string;
			/** The reasoning that preceded this message's text, when the provider returned any. */
			thinking?: MessageThinking;
			notice: boolean;
			streaming: boolean;
			/** The store entry behind this message, when the message is forkable from. */
			forkEntryId?: string | null;
	  }
	| { kind: "tools"; id: string; cards: ToolCard[] };

/**
 * One way a conversation can go from a branch point.
 *
 * A way begins at one entry — a child of the branch point it hangs under — and the card that draws
 * it shows that entry's first few characters as the short id, so the id on screen is the id in the
 * store rather than a decoration. `children` are the ways that fork off this one further down; the
 * server only reports branch points on the active chain, so an inactive way arrives without children
 * and is drawn as a leaf until the conversation moves onto it.
 */
export interface BranchWay {
	/** The entry this way begins at: how a switch names it, and what the short id is cut from. */
	entryId: string;
	/** One line of the way's first message, as the server derived it. */
	label: string;
	/** The role of that message, so a card can say who speaks. */
	role: string;
	/** The round the way's first message sits in; user messages start a round. */
	turn: number;
	/** The ways that fork off this one, in the order they were written. */
	children: BranchWay[];
}

/**
 * The whole branch shape of one session, folded once per snapshot.
 *
 * The transcript is the hot path and `branchPoints` used to ride on individual message items, which
 * answered "what hangs off *this* message" and nothing more. Drawing the tree needs every point at
 * once, so the fold runs here — at the baseline, the only frame that can change the points — and the
 * view reads this field instead of walking `items`.
 */
export interface BranchTree {
	/** A label for the common ancestor the whole tree hangs off: the conversation's own title. */
	rootLabel: string;
	/** The ways hanging off the root, in the order the first branch point reported them. */
	ways: BranchWay[];
	/**
	 * The way the leaf currently sits on: the deepest option the active chain runs through.
	 *
	 * Undefined when the leaf is parked on a branch point itself — the conversation is between ways,
	 * and the next prompt starts a new one.
	 */
	currentId: string | undefined;
	/** How many branch points the tree has; every one of them carries at least two ways. */
	points: number;
	/** How many ways the tree holds in total, for the summary line. */
	options: number;
}

/**
 * Fold the snapshot's branch points into the tree the branch page draws.
 *
 * The points arrive in chain order, and the chain leaves a branch point only through the option it
 * marks active — so each point's options hang under the *previous* point's active option, and the
 * deepest active option is the way being read. Rounds come from the messages: user messages start a
 * round, and a way's first message sits in the round its branch point sits in, one later when that
 * first message is itself a user's.
 */
export function buildBranchTree(snapshot: SessionSnapshot): BranchTree | undefined {
	const points = snapshot.branchPoints;
	if (points.length === 0) return undefined;

	const roundOfEntry = new Map<string, number>();
	let round = 0;
	snapshot.messages.forEach((message, index) => {
		if (message.role === "user") round += 1;
		const entryId = snapshot.messageEntryIds[index];
		if (typeof entryId === "string") roundOfEntry.set(entryId, round);
	});

	const nodes = new Map<string, BranchWay>();
	const build = (option: BranchOption, turn: number): BranchWay => {
		const way: BranchWay = { entryId: option.entryId, label: option.label, role: option.role, turn, children: [] };
		nodes.set(option.entryId, way);
		return way;
	};

	let roots: BranchWay[] = [];
	let previous: BranchPoint | undefined;
	for (const point of points) {
		const at = roundOfEntry.get(point.entryId) ?? 1;
		const built = point.options.map((option) => build(option, option.role === "user" ? at + 1 : at));
		const host = previous?.options.find((option) => option.active)?.entryId;
		const parent = host === undefined ? undefined : nodes.get(host);
		if (previous === undefined) roots = built;
		else if (parent !== undefined) parent.children = built;
		previous = point;
	}

	return {
		rootLabel: snapshot.title,
		ways: roots,
		currentId: points.at(-1)?.options.find((option) => option.active)?.entryId,
		points: points.length,
		options: points.reduce((total, point) => total + point.options.length, 0),
	};
}

/** The way an id names, wherever it hangs in the tree. */
export function findWay(tree: BranchTree, id: string): BranchWay | undefined {
	const walk = (ways: readonly BranchWay[]): BranchWay | undefined => {
		for (const way of ways) {
			if (way.entryId === id) return way;
			const hit = walk(way.children);
			if (hit !== undefined) return hit;
		}
		return undefined;
	};
	return walk(tree.ways);
}

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
	/**
	 * Whether the server answers requests.
	 *
	 * This is the old `connected`, kept under a name that says what it measures: a successful `fetch`
	 * sets it and a `fetch` that never reached a server clears it. It is deliberately *not* the same
	 * fact as the mux channel being up — the two answer differently and asynchronously, and deriving
	 * one from the other would trade a known fact for a guess. A channel that is down while this is
	 * true is a normal state: the window can still send, and the request answers for itself.
	 *
	 * Not touched by {@link reduce}, because it is a fact about the connection rather than about any
	 * session, and a baseline is about one session.
	 */
	reachable: boolean;
	snapshot?: SessionSnapshot;
	items: Item[];
	/** Entry ids whose message has not shown up in `items` yet. */
	pendingEntries: PendingEntry[];
	/** The session's branch shape, folded once per snapshot for the header's entry and the branch page. */
	branchTree?: BranchTree;
	streaming: boolean;
	usage: UsageTotals;
	approvals: PendingApproval[];
	/** Accepted messages the loop has not drained yet, for the composer's queue hint. */
	queued: number;
	/** A retry in flight, for the header's retrying line. */
	retry?: RetryState;
	/** The models the user has imported, for the settings panel and the session's model picker. */
	models: ModelOption[];
	/** Theme, font size, and the approval set. Absent until the server has answered once. */
	settings?: SettingsSnapshot;
	error?: string;
}

export function initialState(): ViewState {
	return {
		reachable: false,
		items: [],
		pendingEntries: [],
		streaming: false,
		usage: { ...EMPTY_USAGE },
		approvals: [],
		queued: 0,
		models: [],
	};
}

/**
 * Paint the appearance the server reported.
 *
 * Called on every settings change rather than only at boot, because the panel edits these live: the
 * font size is the type scale's one moving part — the slider's value lands straight on
 * `--dsw-fs-body`, its leading deriving from it — and the theme is one attribute, so neither needs
 * a reload to take effect, and the panel would feel broken if either did.
 *
 * The sidebar's width rides the same road, with one asymmetry: the server stores the *preference*,
 * already clamped to the drag range at parse time, so what lands here is always drawable. A width
 * the settings never carried removes the variable rather than manufacturing a default — the
 * stylesheet's own value is the default, and "never dragged" must stay distinguishable from "dragged
 * to the default".
 */
export function applyAppearance(settings: SettingsSnapshot): void {
	const root = document.documentElement;
	const theme = settings.appearance.theme;
	root.dataset.theme =
		theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
	root.style.setProperty("--dsw-fs-body", `${settings.appearance.fontSize}px`);
	const sidebarWidth = settings.appearance.sidebarWidth;
	if (sidebarWidth === undefined) root.style.removeProperty("--dsw-sidebar-width");
	else root.style.setProperty("--dsw-sidebar-width", `${sidebarWidth}px`);
}

/**
 * Fold one protocol message into the view state.
 *
 * Items are keyed by message timestamp, which the agent assigns once per message and repeats in
 * every `message_update`, so streaming updates land on the item they belong to.
 */
export function reduce(state: ViewState, message: ServerMessage): ViewState {
	switch (message.type) {
		case "baseline":
			return {
				...state,
				snapshot: message.session,
				items: itemsFromSnapshot(message.session),
				// The branch shape rides the same frame: a snapshot is the only thing that can change
				// the points, so the fold runs here and nowhere else.
				branchTree: buildBranchTree(message.session),
				// A snapshot carries the ids of everything it shows, so nothing is left outstanding.
				pendingEntries: [],
				streaming: message.session.submitting,
				usage: message.session.usage,
				approvals: message.session.pendingApprovals,
				queued: message.session.queued,
				// Cleared rather than carried over, and not rebuilt from the snapshot either: the
				// countdown only ever came from the frame that scheduled the backoff, and a snapshot
				// knows a retry is in flight but not how long is left on it. Carrying the old value
				// across a reconnect would show a countdown for a backoff this stream never watched
				// begin. The header line still says "retrying", off the snapshot's own flag.
				retry: undefined,
				// `error` survives a baseline. It is the record of a failed operation, and the only
				// thing that should erase it is the next operation succeeding — a reconnect that
				// worked is not one of the user's operations. Clearing it here would mean a session
				// that failed while the channel was down silently forgave itself the moment it came
				// back, which is exactly the failure this notice exists to make visible.
				error: state.error,
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
		case "approval_request":
			return {
				...state,
				approvals: [
					...state.approvals.filter((approval) => approval.toolCallId !== message.request.toolCallId),
					message.request,
				],
			};
		case "approval_settled":
			return { ...state, approvals: state.approvals.filter((approval) => approval.toolCallId !== message.toolCallId) };
		case "event":
			return applySessionEvent(state, message.event);
		default:
			return state;
	}
}

/**
 * Fold the end of a logical stream.
 *
 * Not a case in {@link reduce} because it is not a `ServerMessage`: `end` is the frame that closes
 * the stream, so it sits beside the messages rather than among them, and giving it a `type` of its
 * own would put a stream-control fact into the payload vocabulary.
 *
 * Two things change and one deliberately does not.
 *
 * `approvals` is cleared. The baseline seeds it and per-approval frames maintain it, and after an
 * `end` there will be no further baseline on this stream to seed it again — so a banner left standing
 * is a button whose request goes nowhere. This is the one place that clears it, and it is here rather
 * than in the baseline branch because the baseline branch already had the right answer for a stream
 * that is still open.
 *
 * `streaming` stops, because a run cannot outlive the stream reporting it. The old code set this in
 * its own stream-end handler and would have lost it in the rewrite; folding it here means the state
 * has one place that knows what an end means.
 *
 * `items` stays. The transcript belongs to the session, not to the stream carrying it — clearing it
 * would throw away everything the window had drawn because the connection went away.
 */
export function reduceEnd(state: ViewState): ViewState {
	return { ...state, approvals: [], streaming: false };
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
			// A `message_update` is the only member that names the kind of delta in flight, and that
			// kind is what tells reasoning apart from the answer while both ride the same message.
			// The optional chain is deliberate: the field is required on the wire type, but a frame
			// without it is a server bug, and one malformed frame must not take the window down.
			const phase = event.type === "message_update" ? event.assistantMessageEvent?.type : undefined;
			const items = upsertMessage(state.items, event.message, event.type === "message_end", undefined, phase);
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
		items = replayMessage(items, message, snapshot.messageEntryIds?.[index] ?? undefined);
	});
	// A snapshot that is not submitting cannot have a call in flight, so a card it left unanswered is
	// a record cut short — a branch taken before the result was written — rather than a live one.
	// Settling it keeps a reopened transcript from spinning on history; a submitting snapshot skips
	// this, because its live `tool_execution_end` is still to come and will patch the card itself.
	if (!snapshot.submitting) items = settleCards(items);
	return items;
}

/**
 * Fold one persisted message the way its live arrival would have been folded.
 *
 * The message itself goes through {@link upsertMessage} exactly as before. The tool blocks inside it
 * go through {@link upsertTool} — the same card constructor the loop's `tool_execution_*` events
 * feed — so a reopened transcript is rebuilt from the same cards a watched run drew: the call's
 * name and arguments from the assistant message's `toolCall` block, the outcome from the
 * `toolResult` message that answers it by id. That pairing is the whole repair: a replay that only
 * ever rebuilt messages loses the entire tool process on reopen, not just the result.
 */
function replayMessage(items: Item[], message: unknown, entryId: string | null | undefined): Item[] {
	items = upsertMessage(items, message, true, entryId);
	const record = message as { role?: unknown; content?: unknown };
	if (record.role === "toolResult") return replayResult(items, message);
	if (!Array.isArray(record.content)) return items;
	for (const block of record.content) {
		if (typeof block !== "object" || block === null) continue;
		const typed = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
		if (typed.type !== "toolCall" || typeof typed.id !== "string") continue;
		// Created the way a start event creates it: running, no output. The result message settles it.
		items = upsertTool(items, typed.id, {
			toolCallId: typed.id,
			toolName: typeof typed.name === "string" ? typed.name : "tool",
			args: typed.arguments,
			output: "",
			isError: false,
			running: true,
		});
	}
	return items;
}

/** The same patch a `tool_execution_end` carries, read off the result message the file kept. */
function replayResult(items: Item[], message: unknown): Item[] {
	const record = message as { toolCallId?: unknown; toolName?: unknown; isError?: unknown };
	if (typeof record.toolCallId !== "string") return items;
	return upsertTool(items, record.toolCallId, {
		toolCallId: record.toolCallId,
		toolName: typeof record.toolName === "string" ? record.toolName : "tool",
		// Both read the whole result the way the end event does: the text from its content, the
		// diff from its `details`.
		output: contentToText(message),
		isError: record.isError === true,
		running: false,
		diff: fileDiffOf(message),
	});
}

/** Settle every card a snapshot left without a result, so a finished transcript shows none running. */
function settleCards(items: Item[]): Item[] {
	return items.map((item) => {
		if (item.kind !== "tools" || !item.cards.some((card) => card.running)) return item;
		return { ...item, cards: item.cards.map((card) => (card.running ? { ...card, running: false } : card)) };
	});
}

function upsertMessage(
	items: Item[],
	message: unknown,
	final: boolean,
	forkEntryId: string | null | undefined = undefined,
	phase?: string,
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

	// Reasoning is split out here rather than in `contentToText`, which tool output shares: the tool
	// path must keep folding a thinking block into its text, while a message keeps the two apart.
	const thinking = thinkingOf(record.content);

	// A compaction checkpoint is a role of its own on the wire: its text is the summary, and it is the
	// one thing in the transcript that stands for history the model no longer has verbatim.
	let text = role === "compactionSummary" ? (record.summary ?? "") : contentToText(withoutThinking(record.content));
	if (text.length === 0 && role === "assistant" && final && typeof record.errorMessage === "string") {
		text = `错误：${record.errorMessage}`;
	}
	// A message with text is kept; so is one that is only reasoning so far, because that is the whole
	// point of a collapsed row — it appears while the answer is still empty. Anything else is a frame
	// that carries nothing to draw.
	if (text.length === 0 && (thinking === undefined || thinking.text.length === 0)) return items;

	const id = `${role}:${String(record.timestamp ?? "unknown")}`;
	const notice =
		role === "compactionSummary" || text.startsWith("[上下文已压缩：") || text.startsWith("错误：");
	const index = indexOfMessage(items, id);
	const existing = index === -1 ? undefined : (items[index] as Extract<Item, { kind: "message" }>);
	const carried = forkEntryId ?? existing?.forkEntryId;
	const item: Extract<Item, { kind: "message" }> = { kind: "message", id, role, text, notice, streaming: !final };
	if (thinking !== undefined) {
		const running = !final && (phase === "thinking_start" || phase === "thinking_delta");
		item.thinking = thinking.redacted ? { text: thinking.text, redacted: true, running } : { text: thinking.text, running };
	}
	// A streaming update carries no entry id, so an id already attached to this item is kept.
	if (carried !== undefined && carried !== null) item.forkEntryId = carried;

	if (index === -1) {
		// A new message ends the current tool group, so cards that follow belong to it.
		return [...items, item];
	}
	const next = [...items];
	next[index] = item;
	return next;
}

/**
 * The index of a message item by id, or -1.
 *
 * The streaming message — the one every `message_update` targets — is the last item, so the tail is
 * checked first and the linear scan is only the fallback. That keeps the common frame from walking
 * the whole transcript before finding what it came to replace. (The array copy below is the part
 * that stays O(items): the state is immutable, so a changed item means a new array, and an index
 * would be a change to the shape of {@link ViewState} for a cost that is already small.)
 */
function indexOfMessage(items: Item[], id: string): number {
	const tail = items.at(-1);
	if (tail !== undefined && tail.kind === "message" && tail.id === id) return items.length - 1;
	return items.findIndex((item) => item.kind === "message" && item.id === id);
}

/**
 * The reasoning blocks inside a message's content, pulled out of the array they came in.
 *
 * Only an array can hold blocks; a plain string or the nested `{ content }` fallback is text and has
 * no reasoning to find. The blocks keep their order and are joined with a blank line, so a paragraph
 * split survives into the Markdown the reasoning row renders. A redacted block is the same shape with
 * `redacted: true` and its text already reading "[Reasoning redacted]", so it needs no second field.
 */
function thinkingOf(content: unknown): { text: string; redacted: boolean } | undefined {
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	let redacted = false;
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const typed = block as { type?: unknown; thinking?: unknown; redacted?: unknown };
		if (typed.type !== "thinking") continue;
		parts.push(String(typed.thinking ?? ""));
		if (typed.redacted === true) redacted = true;
	}
	if (parts.length === 0) return undefined;
	return { text: parts.join("\n\n"), redacted };
}

/** The same content with its reasoning blocks dropped, for the text path. */
function withoutThinking(content: unknown): unknown {
	if (!Array.isArray(content)) return content;
	return content.filter(
		(block) => !(typeof block === "object" && block !== null && (block as { type?: unknown }).type === "thinking"),
	);
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
