import { element, icon } from "../dom.ts";
import type { Item, ToolCard } from "../state.ts";
import { diffStat, renderFileDiff } from "./diff.ts";
import { renderMarkdown, type MarkdownState } from "./markdown.ts";

export interface TranscriptOptions {
	/**
	 * A user message was right-clicked: the store entry it stands for — when one has been named for
	 * it yet — and the pointer, where a menu should open. The menu itself belongs to the caller; the
	 * transcript only knows which message was under the pointer.
	 */
	onUserContext(entryId: string | undefined, x: number, y: number): void;
}

/**
 * One turn's reasoning row.
 *
 * The row is a `<details>` so the open/closed state is the browser's to keep: it is created closed,
 * and the reader toggles it without the view having to remember anything. Only the summary line and
 * the running state are patched on a render; the body's Markdown is parsed only while the row is
 * open, so a collapsed long thought costs nothing to stream.
 */
interface ReasoningView {
	details: HTMLDetailsElement;
	preview: HTMLElement;
	body: HTMLElement;
	markdown?: MarkdownState;
	text: string;
	running: boolean;
}

/** One rendered conversation entry, plus the little state needed to patch it in place. */
interface Turn {
	section: HTMLElement;
	body: HTMLElement;
	/** The parsed state of the body's Markdown, so a streaming message only re-parses its tail. */
	markdown?: MarkdownState;
	text: string;
	/** The reasoning row, once this turn's message has any. */
	reasoning?: ReasoningView;
	/**
	 * The item this turn is currently drawn from.
	 *
	 * Kept on the turn rather than closed over: a snapshot can replace every item, so the entry the
	 * context menu acts on is whatever the last render said it was.
	 */
	item: Extract<Item, { kind: "message" }>;
}

/**
 * The conversation column.
 *
 * Rendering is a reconcile against `items` rather than a rebuild, because the transcript is the hot
 * path: a `message_update` arrives many times a second and must cost work proportional to the delta,
 * not to the conversation so far. Three things make that true — a message keeps its element and gets
 * appended to, a tool group is only rebuilt when its card list actually changes, and anything that
 * left `items` is dropped.
 *
 * The view owns its scroll policy: it follows the bottom while the reader is already there, and stops
 * the moment they scroll away, so reading history is never yanked back by a token.
 */
export class TranscriptView {
	private readonly container: HTMLElement;
	private readonly options: TranscriptOptions;
	private readonly turns = new Map<string, Turn>();
	private readonly tools = new Map<string, { section: HTMLElement; source: readonly ToolCard[]; cards: Map<string, { node: HTMLElement; shape: string }> }>();
	private welcome?: HTMLElement;
	private sticky = true;

	constructor(container: HTMLElement, options: TranscriptOptions) {
		this.container = container;
		this.options = options;
		// The message menu is the caller's; this side only decides *which* message was under the
		// pointer, and hands the caller the entry that message stands for.
		container.addEventListener("contextmenu", (event) => {
			if (!(event.target instanceof Element)) return;
			const turn = event.target.closest(".turn[data-role=\"user\"]");
			if (!(turn instanceof HTMLElement)) return;
			event.preventDefault();
			this.options.onUserContext(turn.dataset.entry || undefined, event.clientX, event.clientY);
		});
	}

	/** Follow the bottom unless the reader has scrolled away from it. */
	trackScroll(): void {
		this.container.addEventListener("scroll", () => {
			const distance = this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight;
			this.sticky = distance < 80;
		});
	}

	render(items: readonly Item[], streaming: boolean): void {
		const seen = new Set<string>();

		for (const item of items) {
			seen.add(item.id);
			if (item.kind === "message") this.renderMessage(item);
			else this.renderTools(item);
		}

		for (const [id, turn] of [...this.turns]) {
			if (seen.has(id)) continue;
			this.turns.delete(id);
			turn.section.remove();
		}
		for (const [id, group] of [...this.tools]) {
			if (seen.has(id)) continue;
			this.tools.delete(id);
			group.section.remove();
		}

		// A new item does not always arrive at the end: a compaction summary is drawn at the head of
		// the conversation, and a reconnect that re-baselines the session replays every item in its
		// order. So once everything on screen has been drawn, the nodes are placed in `items` order —
		// the same "append in order, move only what moved" pass the sidebar runs. Without it a summary
		// that should sit at the top was appended last and read as the newest thing said.
		let previous: HTMLElement | undefined;
		for (const item of items) {
			const node = item.kind === "message" ? this.turns.get(item.id)?.section : this.tools.get(item.id)?.section;
			if (node === undefined) continue;
			this.place(this.container, node, previous);
			previous = node;
		}

		this.setWelcome(items.length === 0 && !streaming);
		this.container.classList.toggle("streaming", streaming);
		if (this.sticky) this.container.scrollTop = this.container.scrollHeight;
	}

	/** Put a node after `previous`, doing nothing when it is already there. */
	private place(parent: HTMLElement, node: HTMLElement, previous: HTMLElement | undefined): void {
		const wanted = previous === undefined ? parent.firstChild : previous.nextSibling;
		if (node === wanted) return;
		parent.insertBefore(node, wanted);
	}

	scrollToBottom(): void {
		this.sticky = true;
		this.container.scrollTop = this.container.scrollHeight;
	}

	/** Whether the reader is at the bottom, which decides if a redraw should chase it. */
	following(): boolean {
		return this.sticky;
	}

	private renderMessage(item: Extract<Item, { kind: "message" }>): void {
		const known = this.turns.get(item.id);
		const turn = known ?? this.createTurn(item);
		if (known === undefined) {
			this.turns.set(item.id, turn);
			this.container.append(turn.section);
			this.sticky = true;
		} else if (known.item === item) {
			// Items are immutable — the reducer rebuilds only the ones a frame changed — so a turn
			// already drawn from this very item has nothing to do. This is the second half of "cost
			// proportional to the delta": the walk reaches every item, but each untouched one costs
			// one `===` and no DOM work at all.
			return;
		}
		turn.item = item;
		this.applyEntry(turn);

		// A notice is plain text and never streams, so it is written once and left alone.
		if (item.notice) {
			this.clearReasoning(turn);
			if (turn.text !== item.text) {
				turn.body.replaceChildren(element("p", undefined, item.text));
				turn.text = item.text;
			}
			return;
		}

		// Drawn before the body, and before the early return below: a message that is only thinking so
		// far has no text to change, and its row still has to appear and to keep up as it streams.
		this.renderReasoning(turn, item);

		if (item.text === turn.text) return;
		turn.markdown = renderMarkdown(turn.body, item.text, turn.markdown);
		turn.text = item.text;
	}

	/**
	 * Draw or patch the reasoning row that precedes a message's text.
	 *
	 * A message with no reasoning has no row; a message that gains or loses one between renders gets
	 * its row added or dropped here. The summary line carries the first line of the reasoning, which
	 * is enough to say what it is about while collapsed, and the running state is a class the styles
	 * use to keep the line moving while reasoning is still arriving.
	 */
	private renderReasoning(turn: Turn, item: Extract<Item, { kind: "message" }>): void {
		const thinking = item.thinking;
		if (thinking === undefined) {
			this.clearReasoning(turn);
			return;
		}

		let view = turn.reasoning;
		if (view === undefined) {
			view = this.createReasoning(turn);
			turn.reasoning = view;
		}

		const preview = reasoningPreviewOf(thinking.text, thinking.running);
		if (view.preview.textContent !== preview) view.preview.textContent = preview;
		if (view.running !== thinking.running) {
			view.running = thinking.running;
			view.details.classList.toggle("running", thinking.running);
		}
		// A collapsed row shows only the summary, so its Markdown is left unparsed until it is opened.
		if (view.details.open) this.paintReasoning(turn);
	}

	/** Build a reasoning row, closed, and place it between the role line and the message body. */
	private createReasoning(turn: Turn): ReasoningView {
		const details = element("details", "reasoning");
		const summary = element("summary", "reasoning-summary");
		const preview = element("span", "reasoning-preview");
		const body = element("div", "reasoning-body");
		summary.append(icon("think"), element("span", "reasoning-label", "思考"), element("span", "reasoning-sep"), preview);
		details.append(summary, body);
		// The body is parsed on the way open, which is the first moment it is worth rendering.
		details.addEventListener("toggle", () => {
			if (details.open) this.paintReasoning(turn);
		});
		turn.section.insertBefore(details, turn.body);
		return { details, preview, body, text: "", running: false };
	}

	/** Render the reasoning body's Markdown from the turn's current item. */
	private paintReasoning(turn: Turn): void {
		const view = turn.reasoning;
		const thinking = turn.item.thinking;
		if (view === undefined || thinking === undefined) return;
		if (view.text === thinking.text) return;
		view.markdown = renderMarkdown(view.body, thinking.text, view.markdown);
		view.text = thinking.text;
	}

	private clearReasoning(turn: Turn): void {
		if (turn.reasoning === undefined) return;
		turn.reasoning.details.remove();
		turn.reasoning = undefined;
	}

	/**
	 * One turn.
	 *
	 * A user message is a bubble against the right margin with no name on it — it is the reader's own
	 * words, and labelling them "You" wastes the line they sit on. The agent's work is the opposite:
	 * it runs the full width of the column, because it is what is being read, and it keeps its name so
	 * a long transcript still says who is speaking.
	 */
	private createTurn(item: Extract<Item, { kind: "message" }>): Turn {
		const section = element("section", `turn ${item.role}${item.notice ? " notice" : ""}`);
		const body = element("div", "turn-body");
		const turn: Turn = { section, body, text: "", item };

		// A user message is right-clickable: the menu's items are the caller's, and the entry it acts
		// on is patched in per frame by {@link applyEntry}.
		if (item.role === "user") {
			section.dataset.role = "user";
			section.append(body);
			return turn;
		}

		const role = element("div", "turn-role");
		role.append(element("span", "avatar", initialFor(item.role)), element("span", "role-name", labelFor(item.role)));
		section.append(role, body);
		return turn;
	}

	/**
	 * Keep a user turn's entry id current on its section.
	 *
	 * Everything here can arrive after the section was built: a user message is written to the store
	 * before the loop echoes it, so its entry id lands a frame later. The id rides on the section's
	 * dataset because the context menu reads it at right-click time, not at build time.
	 */
	private applyEntry(turn: Turn): void {
		if (turn.section.dataset.role !== "user") return;
		const entryId = turn.item.forkEntryId ?? undefined;
		if (entryId === undefined) delete turn.section.dataset.entry;
		else turn.section.dataset.entry = entryId;
	}

	/**
	 * One tool group, with only the cards that changed rebuilt.
	 *
	 * Cards of a group update as the tool runs — its output grows, then it settles — and a group can
	 * hold many of them. A card's reshape key is its run state, output length, and whether it brought
	 * a diff back; as long as the key holds, the card's node is left alone, which is what keeps a
	 * single growing output from rebuilding the whole group (and the `<details>` the reader opened).
	 */
	private renderTools(item: Extract<Item, { kind: "tools" }>): void {
		const { id, cards } = item;
		let group = this.tools.get(id);
		if (group !== undefined) {
			// Same shortcut as the message path: the reducer rebuilds a group's item only when one of
			// its cards changed, so the same array back means nothing here moved either. A long run
			// with many finished groups then costs each of them one `===` per frame.
			if (group.source === cards) return;
		} else {
			const section = element("section", "tool-group");
			group = { section, cards: new Map(), source: cards };
			this.tools.set(id, group);
			this.container.append(section);
			this.sticky = true;
		}
		group.source = cards;

		for (const card of cards) {
			const shape = shapeOf(card);
			const drawn = group.cards.get(card.toolCallId);
			if (drawn === undefined) {
				group.cards.set(card.toolCallId, { node: renderTool(card), shape });
			} else if (drawn.shape !== shape) {
				// The card's own content changed; its node is remade, and only its node.
				drawn.node.remove();
				drawn.node = renderTool(card);
				drawn.shape = shape;
			}
		}

		const present = new Set(cards.map((card) => card.toolCallId));
		for (const [toolCallId, drawn] of [...group.cards]) {
			if (present.has(toolCallId)) continue;
			drawn.node.remove();
			group.cards.delete(toolCallId);
		}

		let previous: HTMLElement | undefined;
		for (const card of cards) {
			const drawn = group.cards.get(card.toolCallId);
			if (drawn === undefined) continue;
			this.place(group.section, drawn.node, previous);
			previous = drawn.node;
		}
	}

	/** The first-run state: an empty conversation says what this is and what to do. */
	private setWelcome(visible: boolean): void {
		if (!visible) {
			this.welcome?.remove();
			this.welcome = undefined;
			return;
		}
		if (this.welcome) return;

		const welcome = element("div", "welcome");
		const mark = element("div", "welcome-mark");
		mark.append(icon("sparkle"));
		welcome.append(
			mark,
			element("h2", undefined, "想做点什么？"),
			element(
				"p",
				undefined,
				"描述要改的地方、要修的 bug，或要解释的内容。智能体运行的每个工具都会显示在这份记录里，任何要改动磁盘的操作都会先征求同意。",
			),
		);
		this.welcome = welcome;
		this.container.append(welcome);
	}
}

/**
 * A tool card's reshape key: run state, error state, output length, and whether it brought a diff.
 *
 * Distinct keys mean the card's own drawing would differ, so its node is remade; the same key means
 * the node on screen still says the right thing and is left alone. The id is the map key, not here.
 */
function shapeOf(card: ToolCard): string {
	return `${card.running ? "r" : "d"}:${card.isError ? "e" : "o"}:${card.output.length}:${card.diff ? "D" : "-"}`;
}

/** The first non-empty line of a reasoning block, for the collapsed row's summary. */
function firstLineOf(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length > 0) return trimmed.replace(/^#{1,6}\s+/, "");
	}
	return "";
}

/**
 * The collapsed row's summary line.
 *
 * Finished, a thought reads its first line. Still streaming, the line comes from the latest
 * paragraph that has already ended — the tail paragraph is still being written, and a summary that
 * rewrites itself every token reads as noise rather than as progress.
 */
function reasoningPreviewOf(text: string, running: boolean): string {
	if (!running) return firstLineOf(text);
	const paragraphs = text.split(/\r?\n[\t ]*\r?\n/);
	const done = paragraphs.length > 1 ? paragraphs[paragraphs.length - 2]! : text;
	return firstLineOf(done);
}

/** What a message's role reads as in the transcript. */
function labelFor(role: string): string {
	if (role === "user") return "你";
	if (role === "assistant") return "智能体";
	if (role === "compactionSummary") return "上下文摘要";
	return role;
}

function initialFor(role: string): string {
	if (role === "user") return "你";
	if (role === "assistant") return "智";
	return "•";
}

/**
 * One tool card: a summary line that always shows what was called, and the result behind it.
 *
 * A call that changed a file shows the change itself, which is the one thing about it worth reading:
 * the diff carries the path and the counts that the tool's own text was there to state, so the text
 * is left out rather than repeated in a worse form. Every other call — and any tool that reported no
 * diff — falls back to its output.
 */
function renderTool(card: ToolCard): HTMLElement {
	const details = element("details", `tool${card.isError ? " error" : ""}${card.running ? " running" : ""}`);
	if (card.isError || card.running) details.open = true;

	const summary = element("summary");
	const chevron = element("span", "tool-chevron");
	chevron.append(icon("chevron"));
	summary.append(
		chevron,
		element("span", "tool-status"),
		element("span", "tool-name", card.toolName),
		// A diff names the file it changed, which is what a card says when its arguments had no path
		// to preview in the first place.
		element("span", "tool-preview", previewOf(card.args) || (card.diff?.path ?? "")),
	);
	if (card.diff) summary.append(diffStat(card.diff));

	details.append(summary, card.diff ? renderFileDiff(card.diff) : outputOf(card));
	return details;
}

function outputOf(card: ToolCard): HTMLElement {
	const output = element("pre", "tool-output");
	output.textContent = card.output.length > 0 ? card.output : card.running ? "运行中…" : "无输出";
	return output;
}

/**
 * The one argument a tool card shows collapsed.
 *
 * These are the tools whose call is recognizable from a single value, in the order that reads best:
 * a shell command, then a path, then a pattern. Anything else shows nothing rather than a JSON blob,
 * which would only be a worse version of what the expanded card already shows.
 */
function previewOf(args: unknown): string {
	if (args === undefined || args === null) return "";
	const record = args as Record<string, unknown>;
	for (const key of ["command", "path", "pattern", "include"]) {
		const value = record[key];
		if (typeof value === "string") {
			const single = value.replace(/\s+/g, " ").trim();
			return single.length > 90 ? `${single.slice(0, 87)}…` : single;
		}
	}
	return "";
}
