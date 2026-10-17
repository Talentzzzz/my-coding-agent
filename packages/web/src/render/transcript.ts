import { element, icon, type IconName } from "../dom.ts";
import { Drain } from "../drain.ts";
import type { Item, MessageUsage, ToolCard } from "../state.ts";
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
 * How many items one slice of a deferred draw carries.
 *
 * A count rather than a time budget, measured against the harness: the price of a slice is the
 * Markdown parsing inside it, and 24 items is several milliseconds at the sizes a window really
 * sees while staying far under the block a whole conversation used to cost. One very long message
 * is a slice of its own, because a slice is never split — message text is Markdown, and half a
 * message is not a thing to parse.
 */
const BATCH_ITEMS = 24;

/**
 * How long one frame's batch of deferred drawing may spend.
 *
 * The drain turns the generator, and this is when it stops: a batch that ran to a slice boundary
 * is already bounded, and this bounds the case where slices are cheap enough to run several.
 */
const FRAME_BUDGET_MS = 4;

/**
 * One turn's reasoning row.
 *
 * The row shares the tool card's container and head — a `<details class="tool">`, the same chevron,
 * the same quiet line (01 ④) — with 「思考」 in the name seat. The row is created closed, and the
 * reader toggles it without the view having to remember anything. Only the head and the running
 * state are patched on a render; the body's Markdown is parsed only while the row is open, so a
 * collapsed long thought costs nothing to stream.
 */
interface ReasoningView {
	details: HTMLDetailsElement;
	/** The static head text, shown once the thought has stopped arriving. */
	preview: HTMLElement;
	/** The scrolling track that carries the thought while it is still arriving. */
	track: HTMLElement;
	/** The track's two copies of the text — two, so the `translateX(-50%)` loop is seamless. */
	spans: [HTMLElement, HTMLElement];
	body: HTMLElement;
	markdown?: MarkdownState;
	text: string;
	/** The text the track last carried, so a throttled repaint can skip work it already did. */
	marqueeText: string;
	/** When the track was last written, the anchor of the throttle below. */
	marqueeAt: number;
	running: boolean;
}

/** One chip of the agent footer: a small icon and the number under it. */
interface FootChip {
	root: HTMLElement;
	text: HTMLElement;
}

/** A user turn's meta row: the message's time and its copy control, under the bubble's right edge. */
interface MetaView {
	/** The time text, hidden until the message carries a stamp. */
	time: HTMLElement;
}

/** An agent turn's footer: copy, then usage / time / elapsed — one quiet row under the answer. */
interface FootView {
	root: HTMLElement;
	usage: FootChip;
	time: FootChip;
	elapsed: FootChip;
	/** The text each chip last carried, so an unchanged patch writes nothing. */
	usageText: string;
	timeText: string;
	elapsedText: string;
}

/** The user message that opened the round an item sits in — the duration's start seat. */
interface RoundStart {
	id: string;
	at?: number;
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
	/** The user turn's meta row, once the turn is a user's. */
	meta?: MetaView;
	/** The agent turn's footer, once the turn is a non-notice assistant's. */
	foot?: FootView;
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
	/**
	 * The draw of a whole snapshot, spread over frames.
	 *
	 * `render` stays the immediate path and this is the other one: the transcript arriving in a
	 * snapshot is drawn in slices, while a frame that carries a delta must land whole — a delta is
	 * what the reader is watching being written.
	 */
	private readonly drain = new Drain(FRAME_BUDGET_MS);
	/** The item ids the screen currently carries, for a deferred draw's cumulative reconcile. */
	private readonly drawn = new Set<string>();
	private welcome?: HTMLElement;
	private sticky = true;
	/** The ticking line while the loop streams, and the interval that moves it. */
	private runtime?: HTMLElement;
	private runtimeText?: HTMLElement;
	private runtimeTimer?: number;
	/** The round the timer ticks from: the last user message seen while streaming. */
	private runtimeFrom?: { key: string; at: number };
	/** Whether the previous draw was streaming — the flip back is the run's end. */
	private wasStreaming = false;
	/** The duration a watched run took: the round's user message to the run's last answer. */
	private observed?: { key: string; lastId: string; ms: number };

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

	/**
	 * Draw `items`, whole, in this frame.
	 *
	 * The path for everything the window reacts to as it happens: a `message_update`, a tool event, a
	 * snapshot small enough to draw in one go. A whole conversation drawn this way is what used to
	 * freeze the window, so {@link renderDeferred} exists for it — and this method is where that
	 * deferral ends: an outstanding draw is cancelled, and the pass below completes it.
	 */
	render(items: readonly Item[], streaming: boolean): void {
		this.drain.cancel();
		this.draw(items, streaming);
	}

	/**
	 * Draw a whole snapshot in bounded slices, the first one in this turn.
	 *
	 * The batching is the point: `render` on a session with a long history is one block of Markdown
	 * parsing and node building, and while it runs the browser does not repaint — not the transcript
	 * arriving, not the notice saying it is arriving. Here the first slice lands with the click, the
	 * frame is given back so the browser can paint it, and the rest follows one batch per frame.
	 *
	 * The first slice is deliberately a fixed count rather than "everything up to the fold": a slice
	 * that ran to the end of a short conversation would behave exactly like the immediate path, and
	 * the one case this method exists for is the long conversation, where a fixed count is the only
	 * bound that means anything. Its cost is therefore the price of the first paint, and it is the
	 * number the harness reports.
	 */
	renderDeferred(items: readonly Item[], streaming: boolean): void {
		this.drain.cancel();
		this.sticky = true;
		// The walk starts here rather than at a `yield`: a generator that queued the first slice for
		// the next frame would leave the pane showing the previous session's transcript for one whole
		// frame after the click, which is the thing being fixed.
		this.batch(items, streaming, 0, Math.min(items.length, BATCH_ITEMS));
		this.drain.start(() => this.producer(items, streaming));
	}

	/** The remaining slices of a deferred draw, one `yield` per frame. */
	private *producer(items: readonly Item[], streaming: boolean): Generator<undefined> {
		yield;
		for (let index = BATCH_ITEMS; index < items.length; index += BATCH_ITEMS) {
			this.batch(items, streaming, index, Math.min(items.length, index + BATCH_ITEMS));
			yield;
		}
		// Everything is on screen, so the last word goes to the same complete pass the immediate path
		// runs — which is also what retires anything a newer snapshot dropped.
		this.draw(items, streaming);
	}

	/**
	 * One slice of a deferred draw: a contiguous run of `items`, in `items` order.
	 *
	 * A slice never moves what earlier slices drew, and never reconciles against only itself: the
	 * items before `from` are still on screen, so the set the tables are pruned against is the whole
	 * conversation, not the slice. Placement only walks up to `to` for the same reason — a slice is
	 * appended after what is already in order, and the complete pass at the end of the draw is what
	 * handles the one case that is not, a summary that belongs at the head.
	 */
	private batch(items: readonly Item[], streaming: boolean, from: number, to: number): void {
		this.visit(items, from, to);
		this.reconcile();
		this.setWelcome(items.length === 0 && !streaming);
		this.setRuntime(streaming, items);
		this.sticky = true;
		this.placeAll(items, to);
		this.follow();
	}

	/**
	 * Draw everything this frame knows about, and leave the screen clean.
	 *
	 * The immediate path and the pass that ends a deferred one are the same code, because they differ
	 * only in how much of the work is already on screen: an item named by `drawn` has a turn here and
	 * is left alone unless its own item changed, which is what makes the pass that closes a deferred
	 * draw cost each turn one reference comparison instead of a second Markdown parse.
	 *
	 * `drawn` is cleared first because this is a complete pass: whatever `items` is, it is the whole
	 * screen when this returns, and a deferred draw the caller superseded must not leave the ids of
	 * its half-drawn slices behind for the prune below to spare.
	 */
	private draw(items: readonly Item[], streaming: boolean): void {
		this.drawn.clear();
		this.visit(items, 0, items.length);
		this.reconcile();

		// A new item does not always arrive at the end: a compaction summary is drawn at the head of
		// the conversation, and a reconnect that re-baselines the session replays every item in its
		// order. So once everything on screen has been drawn, the nodes are placed in `items` order —
		// the same "append in order, move only what moved" pass the sidebar runs. Without it a summary
		// that should sit at the top was appended last and read as the newest thing said.
		this.placeAll(items, items.length);

		this.setWelcome(items.length === 0 && !streaming);
		this.setRuntime(streaming, items);
		this.container.classList.toggle("streaming", streaming);
		if (this.sticky) this.follow();
	}

	/**
	 * Draw one run of `items`, noting each id as drawn. Both paths share this: a slice is not special.
	 *
	 * The round walk runs from the head even for a slice, because neither fact a message needs is a
	 * fact about itself: whether it closes its round, and which user message opened that round. Both
	 * are settled by one pass over the conversation before the slice renders.
	 */
	private visit(items: readonly Item[], from: number, to: number): void {
		const last = roundLastFlags(items);
		let roundUser: RoundStart | undefined;
		for (let index = 0; index < to; index += 1) {
			const item = items[index]!;
			if (item.kind === "message" && item.role === "user") roundUser = { id: item.id, at: item.timestamp };
			if (index < from) continue;
			this.drawn.add(item.id);
			if (item.kind === "message") this.renderMessage(item, last.has(item.id), roundUser);
			else this.renderTools(item);
		}
	}

	/**
	 * Put the first `to` items' nodes in `items` order.
	 *
	 * `to` is the whole conversation for a complete pass, and the end of the slice for one slice of a
	 * deferred draw — a slice only ever appends after what is already in order, so walking up to its
	 * own end is enough, and the complete pass is what settles the order for good.
	 */
	private placeAll(items: readonly Item[], to: number): void {
		let previous: HTMLElement | undefined;
		for (let index = 0; index < to; index += 1) {
			const item = items[index]!;
			const node = item.kind === "message" ? this.turns.get(item.id)?.section : this.tools.get(item.id)?.section;
			if (node === undefined) continue;
			this.place(this.container, node, previous);
			previous = node;
		}
	}

	/** Drop what the conversation no longer carries, from the tables and the DOM both. */
	private reconcile(): void {
		for (const [id, turn] of [...this.turns]) {
			if (this.drawn.has(id)) continue;
			this.turns.delete(id);
			turn.section.remove();
		}
		for (const [id, group] of [...this.tools]) {
			if (this.drawn.has(id)) continue;
			this.tools.delete(id);
			group.section.remove();
		}
	}

	/** Put the view back at the bottom, for a draw that just replaced the conversation. */
	private follow(): void {
		this.sticky = true;
		this.container.scrollTop = this.container.scrollHeight;
	}

	/**
	 * Run one batch of an outstanding deferred draw, and say whether more is left.
	 *
	 * The frame is the drain's to schedule, and this is the seam for a caller that has none: the
	 * harness and the smoke drive the queue a batch at a time to price the first paint and the worst
	 * slice. Production never calls it — a window's frames are the browser's to hand out.
	 */
	stepPending(): boolean {
		return this.drain.step();
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

	/**
	 * Draw or patch one message.
	 *
	 * The turn is looked up in this view's own table, which is exactly the question "is this id on
	 * screen": a turn that has left it is a turn to build, whether because the conversation is new to
	 * this view or because a deferred draw has not reached it yet. The table and the prune below agree
	 * on that answer because they are the same table — deciding from anywhere else is what let a turn
	 * the prune was about to drop be mistaken for the item arriving in its place.
	 */
	private renderMessage(
		item: Extract<Item, { kind: "message" }>,
		roundLast: boolean,
		roundUser: RoundStart | undefined,
	): void {
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
			//
			// The two exceptions are the rows whose visibility is not a fact about this item alone:
			// a later assistant message opening in the same round moves the footer, and the meta
			// row's stamp can land a frame after the bubble. Both are patched even when the item
			// itself has not changed.
			this.patchMeta(turn);
			this.patchFoot(turn, roundLast, roundUser);
			return;
		}
		turn.item = item;
		// Whether *this* message is still arriving, which is what the stylesheet's streaming caret
		// keys on: the caret belongs to the message being written, not to whatever turn happens to
		// sit last while the run is in flight (16) — between an answer's end and the next one's
		// first delta, the last turn is often the user's own bubble.
		turn.section.classList.toggle("streaming", item.streaming);
		this.applyEntry(turn);
		this.patchMeta(turn);
		this.patchFoot(turn, roundLast, roundUser);

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
	 * its row added or dropped here. The head carries the thought while collapsed — scrolling while
	 * it is still arriving, frozen on its first line once it has stopped — and the running state is
	 * the class that swaps one for the other.
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

		if (view.running !== thinking.running) {
			view.running = thinking.running;
			view.details.classList.toggle("running", thinking.running);
		}
		if (thinking.running) patchMarquee(view, thinking.text);
		else {
			const preview = firstLineOf(thinking.text);
			if (view.preview.textContent !== preview) view.preview.textContent = preview;
		}
		// A collapsed row shows only the head, so its Markdown is left unparsed until it is opened.
		if (view.details.open) this.paintReasoning(turn);
	}

	/** Build a reasoning row, closed, and place it between the role line and the message body. */
	private createReasoning(turn: Turn): ReasoningView {
		const details = element("details", "tool reasoning");
		const summary = element("summary");
		const chevron = element("span", "tool-chevron");
		chevron.append(icon("chevron"));
		const preview = element("span", "tool-path reasoning-preview");
		const marquee = element("div", "reasoning-marquee");
		const track = element("div", "reasoning-track");
		const spans: [HTMLElement, HTMLElement] = [element("span"), element("span")];
		track.append(...spans);
		marquee.append(track);
		const body = element("div", "reasoning-body");
		summary.append(chevron, element("span", "tool-name", "思考"), preview, marquee);
		details.append(summary, body);
		// The body is parsed on the way open, which is the first moment it is worth rendering.
		details.addEventListener("toggle", () => {
			if (details.open) this.paintReasoning(turn);
		});
		turn.section.insertBefore(details, turn.body);
		return { details, preview, track, spans, body, text: "", marqueeText: "", marqueeAt: 0, running: false };
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
	 * There is no role line and no per-turn marker — who is speaking is carried by the forms
	 * themselves: a user message is a bubble against the right margin with a meta row under it
	 * (time + copy, 06 ⑤), the agent's work runs the full width of the column, and the agent's
	 * answer closes its round with a footer of its own (06 ⑥).
	 *
	 * The rows are built here once and patched per frame, because the reconcile places one node per
	 * item; anything inside the turn is free to appear and disappear without the transcript's
	 * placement knowing.
	 */
	private createTurn(item: Extract<Item, { kind: "message" }>): Turn {
		const section = element("section", `turn ${item.role}${item.notice ? " notice" : ""}`);
		const body = element("div", "turn-body");
		const turn: Turn = { section, body, text: "", item };

		// A user message is right-clickable: the menu's items are the caller's, and the entry it acts
		// on is patched in per frame by {@link applyEntry}.
		if (item.role === "user") {
			section.dataset.role = "user";
			const time = element("span", "turn-time");
			time.hidden = true;
			const meta = element("div", "turn-meta");
			// The text is read at click time: the bubble can still be streaming when the row is built.
			meta.append(time, copyButton(() => turn.item.text));
			section.append(body, meta);
			turn.meta = { time };
		} else if (item.role === "assistant" && !item.notice) {
			const usage = footChip("database");
			const time = footChip("clock");
			const elapsed = footChip("timer");
			const foot = element("div", "turn-foot");
			foot.hidden = true;
			foot.append(copyButton(() => turn.item.text), usage.root, time.root, elapsed.root);
			section.append(body, foot);
			turn.foot = { root: foot, usage, time, elapsed, usageText: "", timeText: "", elapsedText: "" };
		} else {
			section.append(body);
		}
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

	/** Draw the user meta row's time; a message without a stamp shows none. */
	private patchMeta(turn: Turn): void {
		const meta = turn.meta;
		if (meta === undefined) return;
		const stamp = turn.item.timestamp;
		meta.time.hidden = stamp === undefined;
		const text = stamp === undefined ? "" : formatClockTime(stamp);
		if (meta.time.textContent !== text) meta.time.textContent = text;
	}

	/**
	 * Draw the agent footer, or hide it.
	 *
	 * The footer belongs to the answer that closed its round — the last assistant message before the
	 * next user prompt — and only once that answer has stopped arriving: while it streams, the run's
	 * own line under the transcript is the elapsed time's seat. A notice is not an answer, and a
	 * message with no text has nothing to copy, so neither draws a footer.
	 */
	private patchFoot(turn: Turn, roundLast: boolean, roundUser: RoundStart | undefined): void {
		const foot = turn.foot;
		if (foot === undefined) return;
		const item = turn.item;
		const visible = !item.notice && !item.streaming && roundLast && item.text.length > 0;
		foot.root.hidden = !visible;
		if (!visible) return;

		const usage = messageUsageTotal(item.usage);
		const usageText = usage === undefined ? "" : `用量 ${shortTokens(usage)} tok`;
		if (foot.usageText !== usageText) {
			foot.usageText = usageText;
			foot.usage.root.hidden = usageText === "";
			foot.usage.text.textContent = usageText;
		}

		const timeText = item.timestamp === undefined ? "" : formatClockTime(item.timestamp);
		if (foot.timeText !== timeText) {
			foot.timeText = timeText;
			foot.time.root.hidden = timeText === "";
			foot.time.text.textContent = timeText;
		}

		// The round's duration. A run this window watched end is the authority — the answer's own
		// stamp is its request's start, so the persisted stamps alone read only up to the final
		// request, and the observed end is what makes the number the timer ticked into agree with
		// the one the footer freezes. Without an observation, the stamps are the fallback.
		let elapsedMs: number | undefined;
		if (roundUser?.at !== undefined && item.timestamp !== undefined) {
			const observed = this.observed;
			elapsedMs =
				observed !== undefined && observed.key === roundUser.id && observed.lastId === item.id
					? observed.ms
					: item.timestamp - roundUser.at;
			if (elapsedMs < 0) elapsedMs = undefined;
		}
		const elapsedText = elapsedMs === undefined ? "" : `用时 ${formatElapsed(elapsedMs)}`;
		if (foot.elapsedText !== elapsedText) {
			foot.elapsedText = elapsedText;
			foot.elapsed.root.hidden = elapsedText === "";
			foot.elapsed.text.textContent = elapsedText;
		}
	}

	/**
	 * The run's ticking line, and the moment a watched run ends.
	 *
	 * While the loop streams, one plain line under the last item reads `用时 mm:ss`, ticking from the
	 * round's user message — the same seat the settled footer reads, so the timer and the number it
	 * freezes into are one clock (06). The tick is a local interval writing one text node: no event
	 * exists for "a second passed", and inventing one would put a display concern on the wire.
	 *
	 * When the streaming flips back, the elapsed is recorded against the round — the one observation
	 * the footer cannot derive from the transcript, since the answer's own stamp is its request's
	 * start. The recording is keyed to the round's user message and the answer's id both, so a stale
	 * observation from a previous run of the same round — a branch taken again — reads as absent and
	 * the stamps answer instead.
	 */
	private setRuntime(streaming: boolean, items: readonly Item[]): void {
		if (!streaming) {
			if (this.wasStreaming) {
				this.wasStreaming = false;
				const from = this.runtimeFrom;
				const ended = items.at(-1);
				if (from !== undefined && ended !== undefined && ended.kind === "message" && ended.role === "assistant") {
					this.observed = { key: from.key, lastId: ended.id, ms: Math.max(0, Date.now() - from.at) };
				}
			}
			this.runtimeFrom = undefined;
			if (this.runtimeTimer !== undefined) {
				window.clearInterval(this.runtimeTimer);
				this.runtimeTimer = undefined;
			}
			this.runtime?.remove();
			this.runtime = undefined;
			return;
		}

		this.wasStreaming = true;
		const user = lastUserOf(items);
		this.runtimeFrom = user === undefined ? undefined : { key: user.id, at: user.timestamp ?? Date.now() };
		if (this.runtime === undefined) {
			const text = element("span", "runtime-time", "00:00");
			const line = element("div", "runtime");
			line.append("用时 ", text);
			this.runtime = line;
			this.runtimeText = text;
			this.runtimeTimer = window.setInterval(() => this.tickRuntime(), 1000);
		}
		// The line sits under whatever the conversation currently ends with, so it is appended after
		// the placement pass has had its word.
		this.container.append(this.runtime);
		this.tickRuntime();
	}

	/** Write the ticking line from the round's start seat. */
	private tickRuntime(): void {
		const from = this.runtimeFrom;
		if (this.runtimeText === undefined || from === undefined) return;
		this.runtimeText.textContent = formatTick(Date.now() - from.at);
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

	/** The first-run state: an empty conversation shows the mark and one question, nothing more. */
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
		welcome.append(mark, element("h2", undefined, "想做点什么?"));
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

/**
 * The ids of each round's last assistant message.
 *
 * A round runs from one user message to the next; the footer belongs to the answer that closed it.
 * The walk runs backwards so one pass marks every round, and notices — role `system` — take no part:
 * they are folds the transcript carries between rounds, not things anyone said.
 */
function roundLastFlags(items: readonly Item[]): Set<string> {
	const last = new Set<string>();
	let seen = false;
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index]!;
		if (item.kind !== "message") continue;
		if (item.role === "user") {
			seen = false;
			continue;
		}
		// A notice — a fold, or a run that failed — neither closes a round nor takes the seat of the
		// answer that did finish; the footer stays with the last real answer.
		if (item.notice) continue;
		if (item.role === "assistant" && !seen) {
			last.add(item.id);
			seen = true;
		}
	}
	return last;
}

/** The last user message of the conversation — the run the timer ticks from. */
function lastUserOf(items: readonly Item[]): Extract<Item, { kind: "message" }> | undefined {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index]!;
		if (item.kind === "message" && item.role === "user") return item;
	}
	return undefined;
}

/**
 * The one copy control both meta rows use: an icon that answers with a check for a beat.
 *
 * The text is read at click time through a getter, because the message it copies can still be
 * streaming when the row is built.
 */
function copyButton(getText: () => string): HTMLButtonElement {
	const button = element("button", "turn-copy", undefined, { type: "button", title: "复制", "aria-label": "复制" });
	button.append(icon("copy"));
	button.addEventListener("click", () => {
		void navigator.clipboard.writeText(getText()).then(
			() => {
				button.replaceChildren(icon("check"));
				window.setTimeout(() => button.replaceChildren(icon("copy")), 1200);
			},
			() => {
				button.title = "复制失败";
			},
		);
	});
	return button;
}

/** One footer chip: a small icon and the number under it, hidden until it has something to say. */
function footChip(name: IconName): FootChip {
	const root = element("span", "foot-chip");
	root.hidden = true;
	const text = element("span");
	root.append(icon(name), text);
	return { root, text };
}

/** The token total a footer chip reads, or nothing when the message reported no spend. */
function messageUsageTotal(usage: MessageUsage | undefined): number | undefined {
	if (usage === undefined) return undefined;
	const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return total > 0 ? total : undefined;
}

/** The clock face of a message's stamp: hours and minutes, the way the meta row reads them. */
function formatClockTime(timestamp: number): string {
	const at = new Date(timestamp);
	const part = (value: number): string => String(value).padStart(2, "0");
	return `${part(at.getHours())}:${part(at.getMinutes())}`;
}

/** A chip's token count: whole below a thousand, one decimal of a thousand above. */
function shortTokens(total: number): string {
	return total < 1000 ? String(total) : `${(total / 1000).toFixed(1)}K`;
}

/** The settled duration a footer reads: a tenth below ten seconds, the clock above. */
function formatElapsed(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 10) return `${seconds.toFixed(1)}s`;
	if (seconds < 60) return `${Math.round(seconds)}s`;
	return formatTick(ms);
}

/** The ticking line's clock face: minutes and seconds, zero-padded. */
function formatTick(ms: number): string {
	const total = Math.floor(ms / 1000);
	const part = (value: number): string => String(value).padStart(2, "0");
	return `${part(Math.floor(total / 60))}:${part(total % 60)}`;
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
 * How often a streaming thought's marquee may be rewritten, in milliseconds.
 *
 * The track carries the whole text so far, which grows with every delta; rewriting it per token
 * would both copy the whole string each frame and force a layout per measurement below. A walking
 * pace is invisible on a line whose content is itself moving — the marquee shows where the thought
 * was, not where the token boundary is.
 */
const MARQUEE_INTERVAL_MS = 2000;

/** How fast the marquee glides, in pixels per second — the speed its duration is solved for. */
const MARQUEE_SPEED_PX_S = 50;

/** The shortest loop a marquee runs, so a short thought does not visibly snap back to its start. */
const MARQUEE_MIN_S = 12;

/**
 * Write the streaming thought into a collapsed row's marquee.
 *
 * While reasoning is still arriving the collapsed head scrolls the text instead of ellipsizing it
 * (01 ④): the track carries it twice so the `translateX(-50%)` loop is seamless, and the loop's
 * duration is solved from the measured width, so a long paragraph glides at the pace a short one
 * does. The read forces a layout, which is why the write is throttled to {@link MARQUEE_INTERVAL_MS}
 * — a delta frame pays for neither the copy nor the reflow.
 */
function patchMarquee(view: ReasoningView, text: string): void {
	const now = Date.now();
	if (view.marqueeText !== "" && now - view.marqueeAt < MARQUEE_INTERVAL_MS) return;
	view.marqueeAt = now;
	view.marqueeText = text;
	for (const span of view.spans) span.textContent = text;
	const duration = Math.max(MARQUEE_MIN_S, view.track.scrollWidth / 2 / MARQUEE_SPEED_PX_S);
	view.track.style.animationDuration = `${duration.toFixed(1)}s`;
}

/**
 * One tool card, read as a line: the name, then a short path, then nothing else.
 *
 * The call reads as `Read  README.md` — name first, a single recognizable argument after — and the
 * whole line is quietly coloured until hover, so a run of tool steps reads as one quiet block
 * (01 ④). The card has no box of its own; expanding is what reveals the content, an indented block
 * under the line. A call that changed a file shows the change itself instead of its text: the diff
 * carries the path and the counts that the tool's own text was there to state.
 *
 * A card whose arguments hold nothing recognizable shows its name alone — no placeholder is
 * invented for what the call did not carry.
 */
function renderTool(card: ToolCard): HTMLElement {
	const details = element("details", `tool${card.isError ? " error" : ""}${card.running ? " running" : ""}`);
	if (card.isError || card.running) details.open = true;

	const summary = element("summary");
	const chevron = element("span", "tool-chevron");
	chevron.append(icon("chevron"));
	summary.append(
		chevron,
		element("span", "tool-name", card.toolName),
		element("span", "tool-path", previewOf(card.args) || (card.diff?.path ?? "")),
	);
	if (card.diff) summary.append(diffStat(card.diff));
	if (card.running) summary.append(element("span", "tool-spin"));

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
