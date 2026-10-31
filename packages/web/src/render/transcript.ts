import { element, icon, type IconName } from "../dom.ts";
import { Drain } from "../drain.ts";
import { usageTotal, type Item, type ToolCard } from "../state.ts";
import { diffStat, renderFileDiff } from "./diff.ts";
import { renderMarkdown, type MarkdownState } from "./markdown.ts";

export interface TranscriptOptions {
	/**
	 * A user message was right-clicked: the store entry it stands for — when one has been named for
	 * it yet — and the pointer, where a menu should open. The menu itself belongs to the caller; the
	 * transcript only knows which message was under the pointer.
	 */
	onUserContext(entryId: string | undefined, x: number, y: number): void;
	/**
	 * The fork button under a settled assistant answer was pressed.
	 *
	 * The entry is read from the turn at press time, not at build time: a message's entry id can
	 * arrive a frame after the turn, and the footer is built once. What a press *does* — rewind the
	 * session so the next prompt starts another way from this answer — is the caller's; the
	 * transcript only knows which answer was under the pointer.
	 */
	onBranch(entryId: string): void;
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
 * How close to the bottom counts as "following it", in pixels.
 *
 * A margin rather than an exact end: a render can land a frame's worth of content between the scroll
 * event and the reading, and a reader who was at the bottom must not stop following over that.
 */
const FOLLOW_DISTANCE_PX = 80;

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
	/** The live tail the head carries while the thought is still arriving. */
	tail: HTMLElement;
	body: HTMLElement;
	markdown?: MarkdownState;
	text: string;
	/** The tail the head last carried, so a repaint can skip work it already did. */
	tailText: string;
	/** The thought the static preview was last cut from, so the collapsed line is cut only on change. */
	previewText: string;
	running: boolean;
}

/** One chip of the agent footer: a small icon and the number under it. */
interface FootChip {
	root: HTMLElement;
	text: HTMLElement;
	/** The text the chip last carried, so an unchanged patch writes nothing. */
	shown?: string;
}

/** A user turn's meta row: the message's time and its copy control, under the bubble's right edge. */
interface MetaView {
	/** The time text, hidden until the message carries a stamp. */
	time: HTMLElement;
	/** Whether the time was last drawn visible, so a row that agrees with it writes nothing. */
	shown: boolean;
}

/** An agent turn's footer: copy, then usage / time / elapsed — one quiet row under the answer. */
interface FootView {
	root: HTMLElement;
	/** The fork control beside copy: the way into another branch from this answer. */
	fork: HTMLButtonElement;
	usage: FootChip;
	time: FootChip;
	elapsed: FootChip;
	/** Whether the row was last drawn visible, so a frame that agrees with it writes nothing. */
	shown?: boolean;
	/** Whether the fork was last drawn at all, and whether it was last refused. */
	forkShown?: boolean;
	forkRefused?: boolean;
}

/** The user message that opened the round an item sits in — the duration's start seat. */
interface RoundStart {
	id: string;
	at?: number;
}

/**
 * The facts a message needs that are not facts about itself.
 *
 * Which assistant closes its round, and which user message opened that round, are answered by a walk
 * over the conversation. The walk is cheap once but not per token: a delta changes the text of the
 * last message and nothing about the shape above it, so these are rebuilt only when the item list's
 * shape moves (see {@link TranscriptView.draw}) and reused for every delta in between.
 */
interface RoundIndex {
	/** The ids of the messages that close their round — the ones that draw a footer. */
	last: ReadonlySet<string>;
	/** For each of those, the user message that opened its round. */
	users: ReadonlyMap<string, RoundStart>;
	/** The last user message of the whole conversation, which is what the run timer ticks from. */
	user?: Extract<Item, { kind: "message" }>;
	/**
	 * The last assistant message of the whole conversation.
	 *
	 * It is the one answer a fork button is *not* offered on: the leaf is where the conversation
	 * already is, and "branch from here" on it is just carrying on. Once anything follows it, the
	 * answer becomes forkable — which is exactly the pair the user asked for (图 2：最底部那条不给，
	 * 倒数第二条开始给).
	 */
	lastAssistant?: string;
}

/** One rendered conversation entry, plus the little state needed to patch it in place. */
interface Turn {
	section: HTMLElement;
	body: HTMLElement;
	/** The parsed state of the body's Markdown, so a streaming message only re-parses its tail. */
	markdown?: MarkdownState;
	text: string;
	/** Whether this message closes its round at the last draw — the footer's visibility, patched on change. */
	roundLast: boolean;
	/** Whether the section wore the streaming caret at the last draw, so class writes happen on a flip. */
	streaming: boolean;
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
 * not to the conversation so far. Items are immutable and the reducer rebuilds only the ones a frame
 * changed, so each draw walks the list once with one reference comparison per item and renders only
 * the ones that are new. Everything else — placement, the round walk, pruning — is keyed to the item
 * list's *shape*, which a token landing in the last message does not move.
 *
 * The view owns its scroll policy: it follows the bottom while the reader is already there, and stops
 * the moment they scroll away, so reading history is never yanked back by a token. Following is a
 * write, not a measurement, and the frame that changed nothing asks for nothing (see {@link pin}).
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
	/**
	 * The items the screen was last drawn from, by index.
	 *
	 * This is the delta: an entry that is the same object as last time is a turn already on screen,
	 * because items are immutable and only the ones a frame changed are rebuilt. A deferred draw
	 * fills it a slice at a time, which is also how an immediate frame arriving mid-draw knows what is
	 * still missing.
	 */
	private drawnItems: readonly (Item | undefined)[] = [];
	/** The round facts of the last shape, reused while the shape holds (see {@link RoundIndex}). */
	private rounds: RoundIndex = { last: new Set(), users: new Map() };
	/** Whether the last complete draw was streaming — both the container class and the run's end. */
	private drawnStreaming = false;
	private welcome?: HTMLElement;
	private sticky = true;
	/** The frame the scroll reading is deferred to, so a burst of events costs one reading. */
	private scrollRead?: number;
	/** The ticking line while the loop streams, and the interval that moves it. */
	private runtime?: HTMLElement;
	private runtimeText?: HTMLElement;
	/** The text the ticking line last carried, so a frame inside the same second writes nothing. */
	private runtimeShown = "";
	private runtimeTimer?: number;
	/**
	 * The round the timer ticks from: the last user message seen while streaming, carrying the stamp
	 * the timer needs — the same seat a {@link RoundStart} names, narrowed to the case that has one.
	 */
	private runtimeFrom?: { id: string; at: number };
	/** Whether the previous draw was streaming — the flip back is the run's end. */
	private wasStreaming = false;
	/** The durations a watched run took, keyed by the round's user message. */
	private readonly observed = new Map<string, { lastId: string; ms: number }>();

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
		this.setSticky(this.sticky);
		this.container.addEventListener("scroll", () => this.followFromScroll());
	}

	/**
	 * Read the scroll position on the next frame, and decide whether to keep following.
	 *
	 * The reading is a layout read — `scrollHeight` forces the layout the frame that just grew the
	 * answer left dirty — and {@link pin} is a layout write. Doing both in one turn of the event loop
	 * is the forced reflow the reader sees as a stutter, so the read is moved to the frame, where it
	 * also coalesces however many scroll events landed (a scroll is not a frame). Only the last
	 * reading can decide anything anyway.
	 */
	private followFromScroll(): void {
		if (this.scrollRead !== undefined) return;
		this.scrollRead = requestAnimationFrame(() => {
			this.scrollRead = undefined;
			const distance = this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight;
			this.setSticky(distance < FOLLOW_DISTANCE_PX);
		});
	}

	/**
	 * Set whether the view follows the bottom, and wear the class that makes following cheap.
	 *
	 * `overflow-anchor: none` while pinned is the browser's help: anchoring otherwise holds the
	 * reader's place when content above the viewport changes, while a pinned view is appending below
	 * it every frame — the two policies fight and the reader sees a jump. Once they scroll away,
	 * anchoring is exactly right, so the class comes off with `sticky`.
	 */
	private setSticky(sticky: boolean): void {
		this.sticky = sticky;
		if (this.container.classList.contains("pinned") !== sticky) this.container.classList.toggle("pinned", sticky);
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
		this.setSticky(true);
		// A snapshot is a whole conversation arriving at once, so the delta table starts empty: a
		// streaming frame landing between two slices must see the undrawn half as undrawn and finish
		// that draw itself, which is the documented relationship between the two paths.
		this.drawnItems = [];
		const rounds = roundIndex(items);
		// Published here rather than left to the pass that closes the draw: by then every item is on
		// screen and the shape reads as unchanged, so that pass skips the round walk — and a delta
		// arriving afterwards trusts this index. An empty one would cost the answer its round: no
		// footer when the run settles, and a ticking line with no start seat.
		this.rounds = rounds;
		const wanted = idsOf(items);
		// The walk starts here rather than at a `yield`: a generator that queued the first slice for
		// the next frame would leave the pane showing the previous session's transcript for one whole
		// frame after the click, which is the thing being fixed.
		this.batch(items, streaming, rounds, wanted, 0, Math.min(items.length, BATCH_ITEMS));
		this.drain.start(() => this.producer(items, streaming, rounds, wanted));
	}

	/** The remaining slices of a deferred draw, one `yield` per frame. */
	private *producer(
		items: readonly Item[],
		streaming: boolean,
		rounds: RoundIndex,
		wanted: ReadonlySet<string>,
	): Generator<undefined> {
		yield;
		for (let index = BATCH_ITEMS; index < items.length; index += BATCH_ITEMS) {
			this.batch(items, streaming, rounds, wanted, index, Math.min(items.length, index + BATCH_ITEMS));
			yield;
		}
		// Everything is on screen, so the last word goes to the same complete pass the immediate path
		// runs — which is also what retires anything a newer snapshot dropped.
		this.draw(items, streaming);
	}

	/**
	 * One slice of a deferred draw: a contiguous run of `items`, in `items` order.
	 *
	 * A slice never reconciles against only itself: the items before `from` are still on screen, and
	 * `wanted` is the whole conversation, so a turn the new snapshot no longer carries is dropped by
	 * the first slice rather than lingering until the last one. Placement only walks up to `to` for
	 * the same reason — a slice is appended after what is already in order, and the complete pass at
	 * the end of the draw is what handles the one case that is not, a summary that belongs at the head.
	 */
	private batch(
		items: readonly Item[],
		streaming: boolean,
		rounds: RoundIndex,
		wanted: ReadonlySet<string>,
		from: number,
		to: number,
	): void {
		const drawn = this.drawnItems.slice();
		for (let index = from; index < to; index += 1) {
			const item = items[index]!;
			drawn[index] = item;
			this.renderItem(item, rounds);
		}
		this.drawnItems = drawn;
		this.reconcile(wanted);
		this.setWelcome(items.length === 0 && !streaming);
		this.setRuntime(streaming, rounds, items);
		this.setSticky(true);
		this.placeAll(items, to);
		this.pin();
	}

	/**
	 * Draw everything this frame knows about, and leave the screen clean.
	 *
	 * The immediate path and the pass that ends a deferred one are the same code, because they differ
	 * only in how much of the work is already on screen. The delta loop is the whole cost model: items
	 * are immutable and the reducer rebuilds only the ones a frame changed, so an index whose item is
	 * the same object as last draw is a turn already on screen, and the loop skips it with one `===`.
	 * A token landing in the streaming message therefore costs that one message's draw plus one
	 * reference comparison per item — nothing above the tail is touched.
	 *
	 * Everything proportional to the list is keyed to its *shape* — its length and the identity of its
	 * last item. Appending a message, folding in a note, a retry's note replacing an abandoned answer,
	 * a compaction summary landing at the head: those move the shape, and only those pay for the round
	 * walk, the prune and the placement pass. A reconnect that re-baselines the same conversation keeps
	 * the shape — every item is a new object, so the delta loop redraws them all, but neither their
	 * order nor the round facts above them moved.
	 */
	private draw(items: readonly Item[], streaming: boolean): void {
		const previous = this.drawnItems;
		const structural = !sameShape(previous, items);
		const wasStreaming = this.drawnStreaming;
		this.drawnStreaming = streaming;
		this.drawnItems = items;
		if (structural) this.rounds = roundIndex(items);

		// The prune runs against the whole conversation, not against the drawn slices: a deferred
		// draw abandoned half way must not leave the previous session's turns behind for a slice to
		// spare.
		if (structural) this.reconcile(idsOf(items));

		this.setWelcome(items.length === 0 && !streaming);
		// Before the delta loop, because the loop's footer patch is one of the readers of the
		// observation recorded when the run ends.
		this.setRuntime(streaming, this.rounds, items);
		if (streaming !== wasStreaming) this.container.classList.toggle("streaming", streaming);

		let touched = structural;
		for (let index = 0; index < items.length; index += 1) {
			const item = items[index]!;
			if (previous[index] === item) continue;
			this.renderItem(item, this.rounds);
			touched = true;
		}

		// The rows whose visibility is not a fact about their own item are re-read on the frames that
		// can move them: a new assistant message takes the footer from the one before it, and the
		// settled duration only lands when the run ends. Never per token.
		if (structural || streaming !== wasStreaming) this.patchFeet();

		// A new item does not always arrive at the end: a compaction summary is drawn at the head of
		// the conversation, and a reconnect that re-baselines the session replays every item in its
		// order. So once everything on screen has been drawn, the nodes are placed in `items` order —
		// the same "append in order, move only what moved" pass the sidebar runs. Without it a summary
		// that should sit at the top was appended last and read as the newest thing said.
		if (structural) this.placeAll(items, items.length);
		if (this.sticky && touched) this.pin();
	}

	/** Draw one item: a message's turn, or a tool group's cards. */
	private renderItem(item: Item, rounds: RoundIndex): void {
		if (item.kind === "message") this.renderMessage(item, rounds);
		else this.renderTools(item);
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
	private reconcile(wanted: ReadonlySet<string>): void {
		for (const [id, turn] of [...this.turns]) {
			if (wanted.has(id)) continue;
			this.turns.delete(id);
			turn.section.remove();
		}
		for (const [id, group] of [...this.tools]) {
			if (wanted.has(id)) continue;
			this.tools.delete(id);
			group.section.remove();
		}
	}

	/**
	 * Put the view at the bottom.
	 *
	 * A write, not a measurement: a `scrollTop` past the end is clamped by the browser to the range
	 * it has, so following costs no `scrollHeight` read and forces no layout inside the frame that
	 * just wrote the DOM. Reading `scrollHeight` here was one synchronous reflow per token, which is
	 * exactly the kind of frame the reader sees as a stutter.
	 *
	 * Nothing here decides *whether* to follow — that is `sticky`, set by the scroll listener and by a
	 * turn arriving, and only the frame that actually changed the content calls this.
	 */
	private pin(): void {
		this.container.scrollTop = Number.MAX_SAFE_INTEGER;
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
		this.setSticky(true);
		this.pin();
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
	 * this view or because a deferred draw has not reached it yet. The table and the prune agree on
	 * that answer because they are the same table.
	 *
	 * Only items the frame actually changed are handed here — the delta loop in {@link draw} filters
	 * them — so this side can spend its writes on what moved: the streaming caret, the entry id, the
	 * meta row, the footer.
	 */
	private renderMessage(item: Extract<Item, { kind: "message" }>, rounds: RoundIndex): void {
		const known = this.turns.get(item.id);
		const turn = known ?? this.createTurn(item);
		if (known === undefined) {
			this.turns.set(item.id, turn);
			this.container.append(turn.section);
			this.setSticky(true);
		} else if (known.item === item) {
			// A repeated slice of a deferred draw can hand over the very item already on screen; a
			// complete pass over an unchanged snapshot does the same. Nothing to say, nothing to write.
			return;
		}
		turn.item = item;
		turn.roundLast = rounds.last.has(item.id);
		// Whether *this* message is still arriving, which is what the stylesheet's streaming caret
		// keys on: the caret belongs to the message being written, not to whatever turn happens to
		// sit last while the run is in flight (16) — between an answer's end and the next one's
		// first delta, the last turn is often the user's own bubble.
		if (turn.streaming !== item.streaming) {
			turn.streaming = item.streaming;
			turn.section.classList.toggle("streaming", item.streaming);
		}
		this.applyEntry(turn);
		this.patchMeta(turn);
		this.patchFoot(turn, turn.roundLast, rounds.users.get(item.id), rounds.lastAssistant === item.id);

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
	 * its row added or dropped here. The head carries the thought while collapsed — the end of it
	 * while it is still arriving, frozen on its first line once it has stopped — and the running
	 * state is the class that swaps one for the other.
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
		if (thinking.running) patchTail(view, thinking.text);
		else if (view.previewText !== thinking.text) {
			// The preview is the first line of the whole thought, so cutting it walks the text. It is
			// cut only when the thought moved, which for a settled row is never again.
			view.previewText = thinking.text;
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
		const tail = element("span", "reasoning-tail");
		marquee.append(tail);
		const body = element("div", "reasoning-body");
		summary.append(chevron, element("span", "tool-name", "思考"), preview, marquee);
		details.append(summary, body);
		// The body is parsed on the way open, which is the first moment it is worth rendering.
		details.addEventListener("toggle", () => {
			if (details.open) this.paintReasoning(turn);
		});
		turn.section.insertBefore(details, turn.body);
		return {
			details,
			preview,
			tail,
			body,
			text: "",
			tailText: "",
			previewText: "",
			running: false,
		};
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
		const turn: Turn = { section, body, text: "", roundLast: false, streaming: false, item };

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
			turn.meta = { time, shown: false };
		} else if (item.role === "assistant" && !item.notice) {
			const usage = footChip("database");
			const time = footChip("clock");
			const elapsed = footChip("timer");
			const fork = element("button", "turn-copy", undefined, {
				type: "button",
				title: "从这条回答开始分支",
				"aria-label": "从这条回答开始分支",
			});
			fork.append(icon("fork"));
			// The entry is read at press time: an assistant message's id lands a frame after the turn
			// is built, and the footer is the one node that lives across those frames.
			fork.addEventListener("click", () => {
				const entryId = turn.item.forkEntryId ?? undefined;
				if (entryId !== undefined) this.options.onBranch(entryId);
			});
			const foot = element("div", "turn-foot");
			foot.hidden = true;
			foot.append(copyButton(() => turn.item.text), fork, usage.root, time.root, elapsed.root);
			section.append(body, foot);
			turn.foot = { root: foot, fork, usage, time, elapsed, shown: false };
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
		const shown = turn.section.dataset.entry;
		if (entryId === undefined) {
			if (shown !== undefined) delete turn.section.dataset.entry;
		} else if (shown !== entryId) {
			turn.section.dataset.entry = entryId;
		}
	}

	/** Draw the user meta row's time; a message without a stamp shows none. */
	private patchMeta(turn: Turn): void {
		const meta = turn.meta;
		if (meta === undefined) return;
		const stamp = turn.item.timestamp;
		const shown = stamp !== undefined;
		if (meta.shown !== shown) {
			meta.shown = shown;
			meta.time.hidden = !shown;
		}
		if (stamp === undefined) return;
		const text = formatClockTime(stamp);
		if (meta.time.textContent !== text) meta.time.textContent = text;
	}

	/**
	 * Draw the agent footer, or hide it.
	 *
	 * The footer belongs to the answer that closed its round — the last assistant message before the
	 * next user prompt — and only once that answer has stopped arriving: while it streams, the run's
	 * own line under the transcript is the elapsed time's seat. A notice is not an answer, and a
	 * message with no text has nothing to copy, so neither draws a footer.
	 *
	 * The fork sits beside copy on every footer but the conversation's last answer: the leaf is where
	 * the conversation already continues, so a branch from it would be the ordinary next prompt. It
	 * is refused while a run is in flight for the same reason the user menu hides its own branch
	 * item: moving the leaf under a run that is writing to it is the one thing a branch must wait out.
	 */
	private patchFoot(turn: Turn, roundLast: boolean, roundUser: RoundStart | undefined, isLastAnswer: boolean): void {
		const foot = turn.foot;
		if (foot === undefined) return;
		const item = turn.item;
		const visible = !item.notice && !item.streaming && roundLast && item.text.length > 0;
		if (foot.shown !== visible) {
			foot.shown = visible;
			foot.root.hidden = !visible;
		}
		const forkShown = visible && !isLastAnswer;
		if (foot.forkShown !== forkShown) {
			foot.forkShown = forkShown;
			foot.fork.hidden = !forkShown;
		}
		const refused = this.drawnStreaming;
		if (foot.forkRefused !== refused) {
			foot.forkRefused = refused;
			foot.fork.disabled = refused;
			foot.fork.title = refused ? "这一轮还在写，等它结束再分支" : "从这条回答开始分支";
		}
		if (!visible) return;

		const usage = usageTotal(item.usage);
		setChip(foot.usage, usage === undefined ? "" : `用量 ${shortTokens(usage)} tok`);
		setChip(foot.time, item.timestamp === undefined ? "" : formatClockTime(item.timestamp));

		// The round's duration. A run this window watched end is the authority — the answer's own
		// stamp is its request's start, so the persisted stamps alone read only up to the final
		// request, and the observed end is what makes the number the timer ticked into agree with
		// the one the footer freezes. Without an observation, the stamps are the fallback.
		let elapsedMs: number | undefined;
		if (roundUser?.at !== undefined && item.timestamp !== undefined) {
			const observed = this.observed.get(roundUser.id);
			elapsedMs =
				observed !== undefined && observed.lastId === item.id
					? observed.ms
					: item.timestamp - roundUser.at;
			if (elapsedMs < 0) elapsedMs = undefined;
		}
		setChip(foot.elapsed, elapsedMs === undefined ? "" : `用时 ${formatElapsed(elapsedMs)}`);
	}

	/**
	 * Re-read the footers on the frames where the round facts can move.
	 *
	 * A footer's visibility is not a fact about its own item: a later assistant message opening in the
	 * same round takes that seat from the answer before it, so the earlier turn has to be told even
	 * though its own item is untouched. The same applies to the settled duration, which is recorded
	 * only when the run ends — the answer's own stamp alone reads up to its final request.
	 *
	 * Called on a shape change or a streaming flip, never per token; within it, a turn that lost the
	 * round's last seat and gained nothing else costs one Set lookup and one comparison.
	 */
	private patchFeet(): void {
		for (const turn of this.turns.values()) {
			if (turn.foot === undefined) continue;
			const last = this.rounds.last.has(turn.item.id);
			const moved = turn.roundLast !== last;
			turn.roundLast = last;
			// A turn that still closes its round is re-read as well: the settled duration lands on a
			// frame that changes no item at all, and this is the only pass that can hand it over.
			if (moved || last) {
				this.patchFoot(turn, last, this.rounds.users.get(turn.item.id), this.rounds.lastAssistant === turn.item.id);
			}
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
	 * The node is built once per run and only moved when it is not already the last thing in the
	 * column: appending it every frame re-parented the line on every token, which is a DOM write the
	 * reader never saw. The text is written only when the second it names moved, for the same reason.
	 *
	 * When the streaming flips back, the elapsed is recorded against the round — the one observation
	 * the footer cannot derive from the transcript, since the answer's own stamp is its request's
	 * start. The recording is keyed to the round's user message and the answer's id both, so a stale
	 * observation from a previous run of the same round — a branch taken again — reads as absent and
	 * the stamps answer instead.
	 */
	private setRuntime(streaming: boolean, rounds: RoundIndex, items: readonly Item[]): void {
		if (!streaming) {
			if (this.wasStreaming) {
				this.wasStreaming = false;
				const from = this.runtimeFrom;
				const ended = items.at(-1);
				if (from !== undefined && ended !== undefined && ended.kind === "message" && ended.role === "assistant") {
					this.observed.set(from.id, { lastId: ended.id, ms: Math.max(0, Date.now() - from.at) });
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
		const user = rounds.user;
		this.runtimeFrom = user === undefined ? undefined : { id: user.id, at: user.timestamp ?? Date.now() };
		if (this.runtime === undefined) {
			const text = element("span", "runtime-time", "00:00");
			const line = element("div", "runtime");
			line.append("用时 ", text);
			this.runtime = line;
			this.runtimeText = text;
			this.runtimeShown = "";
			this.runtimeTimer = window.setInterval(() => this.tickRuntime(), 1000);
		}
		// The line sits under whatever the conversation currently ends with, and the placement pass
		// puts newly drawn items above it; only a line that is not already there is moved.
		if (this.container.lastChild !== this.runtime) this.container.append(this.runtime);
		this.tickRuntime();
	}

	/** Write the ticking line from the round's start seat, and only when the second it names moved. */
	private tickRuntime(): void {
		const from = this.runtimeFrom;
		if (this.runtimeText === undefined || from === undefined) return;
		const text = formatTick(Date.now() - from.at);
		if (text === this.runtimeShown) return;
		this.runtimeShown = text;
		this.runtimeText.textContent = text;
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
			this.setSticky(true);
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

	/** The first-run state: an empty conversation shows one question and nothing else. */
	private setWelcome(visible: boolean): void {
		if (!visible) {
			this.welcome?.remove();
			this.welcome = undefined;
			return;
		}
		if (this.welcome) return;

		const welcome = element("div", "welcome");
		welcome.append(element("h2", undefined, "想做点什么?"));
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
	return `${card.waiting ? "w" : card.running ? "r" : "d"}:${card.isError ? "e" : "o"}:${card.output.length}:${card.diff ? "D" : "-"}`;
}

/**
 * The round facts of the conversation, in one forward walk.
 *
 * A round runs from one user message to the next, and the footer belongs to the answer that closed
 * it — the last assistant message before the next prompt. Notices take no part: a fold or a failed
 * run is carried between rounds rather than spoken in one, and the seat stays with the last real
 * answer. The walk also remembers, for each closing answer, the user message that opened its round —
 * the elapsed time's start seat — and the conversation's last user message, which is the running
 * timer's.
 *
 * One pass, called when the item list's shape moves (see {@link TranscriptView.draw}); a delta in the
 * last message cannot change any of these facts.
 */
function roundIndex(items: readonly Item[]): RoundIndex {
	const last = new Set<string>();
	const users = new Map<string, RoundStart>();
	let user: Extract<Item, { kind: "message" }> | undefined;
	let start: RoundStart | undefined;
	let closing: string | undefined;
	let closingStart: RoundStart | undefined;
	let lastAssistant: string | undefined;

	// The round is committed when the next user message opens, and once more at the end: whichever
	// assistant was seen last in it is the one that closed it.
	const close = (): void => {
		if (closing === undefined) return;
		last.add(closing);
		if (closingStart !== undefined) users.set(closing, closingStart);
		closing = undefined;
		closingStart = undefined;
	};

	for (const item of items) {
		if (item.kind !== "message") continue;
		if (item.role === "user") {
			close();
			user = item;
			start = { id: item.id, at: item.timestamp };
			continue;
		}
		if (item.notice) continue;
		if (item.role !== "assistant") continue;
		closing = item.id;
		closingStart = start;
		lastAssistant = item.id;
	}
	close();
	return {
		last,
		users,
		...(user === undefined ? {} : { user }),
		...(lastAssistant === undefined ? {} : { lastAssistant }),
	};
}

/** The ids `items` carries, for a prune that asks membership rather than position. */
function idsOf(items: readonly Item[]): Set<string> {
	const ids = new Set<string>();
	for (const item of items) ids.add(item.id);
	return ids;
}

/**
 * Whether two item lists have the same shape, which is what the non-delta work is keyed to.
 *
 * Items are immutable, so "same shape" cannot mean "same references" — the streaming message's item
 * is a new object on every token. It means the list's length and the identity of its last item: an
 * append, a drop, a retry's note replacing an abandoned answer, or a whole new conversation moves
 * one of those, while a token landing in the message already at the end moves neither.
 */
function sameShape(previous: readonly (Item | undefined)[], next: readonly Item[]): boolean {
	if (previous.length !== next.length) return false;
	return shapeKey(previous.at(-1)) === shapeKey(next.at(-1));
}

/** The identity a shape comparison reads: an item's id, and the two flags the round walk keys on. */
function shapeKey(item: Item | undefined): string {
	if (item === undefined) return "";
	if (item.kind !== "message") return item.id;
	return `${item.id}|${item.role}|${item.notice ? "n" : "-"}`;
}

/**
 * The one copy control both meta rows use: an icon that answers with a check for a beat.
 *
 * The text is read at click time through a getter, because the message it copies can still be
 * streaming when the row is built. One pending restore at a time — a rapid second click replaces
 * the beat rather than stacking timers under it.
 */
function copyButton(getText: () => string): HTMLButtonElement {
	const button = element("button", "turn-copy", undefined, { type: "button", title: "复制", "aria-label": "复制" });
	button.append(icon("copy"));
	let restore = 0;
	button.addEventListener("click", () => {
		void navigator.clipboard.writeText(getText()).then(
			() => {
				button.replaceChildren(icon("check"));
				window.clearTimeout(restore);
				restore = window.setTimeout(() => {
					restore = 0;
					button.replaceChildren(icon("copy"));
				}, 1200);
			},
			() => {
				button.title = "复制失败";
				window.clearTimeout(restore);
				restore = window.setTimeout(() => {
					restore = 0;
					button.title = "复制";
				}, 1200);
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

/** Write one chip's text, hiding it when the text is empty; an unchanged chip is left alone. */
function setChip(chip: FootChip, text: string): void {
	if (chip.shown === text) return;
	chip.shown = text;
	chip.root.hidden = text === "";
	chip.text.textContent = text;
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
 * How much of the streaming thought the head carries, in characters.
 *
 * The head is one clipped line, so the only part of the thought with anything to say is its end. The
 * cap keeps the write bounded: a thought can be tens of thousands of characters, and the head re-reads
 * only its tail each frame rather than the whole of it.
 */
const TAIL_CHARS = 240;

/**
 * Write the end of the streaming thought into the collapsed row's head.
 *
 * This started as a marquee — the track carried the whole text twice and looped it with a
 * `translateX(-50%)` animation. That cannot stay smooth while the text is still arriving: a
 * percentage translate moves by half of the track's **current** width, so every appended character
 * shifts the visible text by half of what it appended. Bucketing the writes made it worse rather than
 * better — the head then jumped once every two seconds, which is the "思考一卡一卡" the reader
 * reported. So the head shows the tail instead: the line grows at its right edge and the start is
 * clipped away by the mask, which is what a ticker looks like when nothing is scrolling it.
 */
function patchTail(view: ReasoningView, text: string): void {
	if (view.tailText === text) return;
	view.tailText = text;
	const tail = text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text;
	// One line, whatever the thought did: the head is a line, and a newline in it would be a lost
	// character in a `nowrap` strip.
	const line = tail.replace(/\s+/g, " ").trimStart();
	if (view.tail.textContent !== line) view.tail.textContent = line;
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
	const details = element(
		"details",
		`tool${card.isError ? " error" : ""}${card.running ? " running" : ""}${card.waiting ? " waiting" : ""}`,
	);
	// A waiting card opens like a running one: the thing it says is the reason the run stopped, and a
	// reader should not have to unfold the line to find where the answer went.
	if (card.isError || card.running || card.waiting) details.open = true;

	const summary = element("summary");
	const chevron = element("span", "tool-chevron");
	chevron.append(icon("chevron"));
	summary.append(
		chevron,
		element("span", "tool-name", card.toolName),
		element("span", "tool-path", previewOf(card.args) || (card.diff?.relPath ?? "")),
	);
	if (card.diff) summary.append(diffStat(card.diff));
	// The line's right-end mark is the phase: pulsing while the call executes, steady while it waits
	// for the answer that lets it run. Neither mark shares a line with a diffstat, for the same reason.
	if (card.running) summary.append(element("span", "tool-spin"));
	if (card.waiting) summary.append(element("span", "tool-wait"));

	details.append(summary, card.diff ? renderFileDiff(card.diff) : outputOf(card));
	return details;
}

function outputOf(card: ToolCard): HTMLElement {
	const output = element("pre", "tool-output");
	output.textContent = card.output.length > 0
		? card.output
		: card.running
			? "运行中…"
			: card.waiting
				? "等待审批——本轮运行在此调用前暂停，答案到达后继续。"
				: "无输出";
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
