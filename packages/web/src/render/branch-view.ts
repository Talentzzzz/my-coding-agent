import { element } from "../dom.ts";
import { findWay, type BranchTree, type BranchWay } from "../state.ts";

/*
 * The branch page: **the line you are reading, drawn left to right, with the ways that left it hanging
 * below** — column = one more user message to the right, row = another way.
 *
 * The line is the trunk and it is always drawn, even when nothing has forked: a conversation with no
 * branch points still has its questions, and "which question do I want to go back to" is the question
 * the page answers. A fork is a card below the card it left from, and the way being read keeps the top
 * row, so it reads end to end as one horizontal line.
 *
 * Interaction is the two-beat the prototype settled on: a click on a card only **selects** it, and the
 * button in the fixed header is what moves the session and returns to the conversation. A card on the
 * line lands on the answer its question produced (see {@link BranchWay.replyId}), a card that left the
 * line follows it to where its own work stopped — and the page itself carries no prose: the cards and
 * their tooltips are the whole of the explanation, so a tree that fits the window reads as just that.
 *
 * The canvas behaves like a map rather than a scroll box: the layer carries one `translate` and one
 * `scale`, the press moves the translate directly, and the wheel pans. It used to pan by writing
 * `scrollLeft` / `scrollTop` into an overflow box, whose scroll range was the graph's own size — so a
 * graph that fitted the window (which is what `enter` fits it to) had no range at all, and dragging did
 * nothing. Panning has no such precondition: a map can be dragged even when it is smaller than the
 * window.
 */

const NODE_W = 268; // A card's width.
const STEP_X = 300; // How much further right the next message sits.
const DOT_R = 4.5; // The dot on the line.
const DOT_X = 12; // The dot's distance from its card's left edge.
const PAD = 24; // Room kept around the graph when it is fitted.
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
/** The short id a card and the header's entry both show: the entry id's first few characters. */
const SHORT_ID = 7;
const SVG_NS = "http://www.w3.org/2000/svg";

export interface BranchViewOptions {
	/**
	 * Move the session onto a way and return to the conversation.
	 *
	 * `entryId` is the entry the leaf lands on: for a card that left the line, the way's own entry
	 * (the caller follows it to its tip); for a card on the line, the answer the question produced
	 * when there is one, the question itself when there is not.
	 */
	onSwitch(entryId: string, landing: BranchWay["landing"]): void;
	/** Return to the conversation without moving. */
	onBack(): void;
}

/** One laid-out card: a way, placed in the grid. */
interface LaidNode {
	way: BranchWay;
	depth: number;
	lane: number;
}

interface Layout {
	nodes: LaidNode[];
	width: number;
	height: number;
}

/** The branch page, and the fixed header's own row of branch tools. */
export class BranchView {
	/** The page itself: the pan-and-zoom viewport, with nothing above it. */
	readonly element: HTMLElement;
	/** The tools row that lives in the fixed header, under the title. */
	readonly toolsBar: HTMLElement;

	private readonly options: BranchViewOptions;
	private readonly viewport = element("div", "graph-viewport");
	private readonly zoomLayer = element("div", "graph-zoom");
	private readonly zoomValue = element("span", "zoom-value", "100%");
	private readonly back: HTMLButtonElement;
	private readonly zoomOut: HTMLButtonElement;
	private readonly zoomIn: HTMLButtonElement;
	private readonly zoomFit: HTMLButtonElement;

	private tree: BranchTree | undefined;
	private streaming = false;
	/** Whether the page is the one on screen; painting waits for it, because fitting needs a size. */
	private open = false;
	private zoom = 1;
	/** The layer's translation, in viewport pixels — the whole of the pan. */
	private x = PAD;
	private y = PAD;
	/** The way the page has picked but not yet applied; starts on the way being read. */
	private selected: string | undefined;
	private laid: Layout | undefined;

	/** Pan bookkeeping: where the press started, and the translation it started from. */
	private drag: { x: number; y: number; atX: number; atY: number } | undefined;
	private dragged = false;

	constructor(options: BranchViewOptions) {
		this.options = options;
		this.viewport.append(this.zoomLayer);
		this.element = element("div", "branch-view");
		this.element.append(this.viewport);

		this.zoomOut = element("button", "zoom-button", "−", { type: "button", title: "缩小" });
		this.zoomIn = element("button", "zoom-button", "＋", { type: "button", title: "放大" });
		this.zoomFit = element("button", "zoom-button", "适应", { type: "button", title: "缩放到刚好装下并居中" });
		this.back = element("button", "back-button", "回到对话", { type: "button" });
		const zoomGroup = element("div", "zoom-group");
		zoomGroup.append(this.zoomOut, this.zoomValue, this.zoomIn, this.zoomFit);
		this.toolsBar = element("div", "branch-tools");
		this.toolsBar.append(element("span", "header-spacer"), zoomGroup, this.back);
		// The tools row belongs to the branch page; it shows when the page does, and not before.
		this.toolsBar.hidden = true;

		this.zoomOut.addEventListener("click", () => this.zoomAt(this.zoom / 1.2));
		this.zoomIn.addEventListener("click", () => this.zoomAt(this.zoom * 1.2));
		this.zoomFit.addEventListener("click", () => this.homeZoom());
		this.back.addEventListener("click", () => this.applySelection());

		this.viewport.addEventListener("pointerdown", (event) => {
			if (event.button !== 0) return;
			this.drag = { x: event.clientX, y: event.clientY, atX: this.x, atY: this.y };
			this.dragged = false;
		});
		this.viewport.addEventListener("pointermove", (event) => {
			if (this.drag === undefined) return;
			const dx = event.clientX - this.drag.x;
			const dy = event.clientY - this.drag.y;
			// Under 4px it is still a "press"; past it the press becomes a pan, with the pointer captured
			// so the drag keeps tracking outside the viewport.
			if (!this.dragged && Math.abs(dx) + Math.abs(dy) < 4) return;
			if (!this.dragged) {
				this.dragged = true;
				this.viewport.classList.add("panning");
				this.viewport.setPointerCapture(event.pointerId);
			}
			this.x = this.drag.atX + dx;
			this.y = this.drag.atY + dy;
			this.applyTransform();
		});
		// The release is where a press that never dragged becomes a click: the pointer decides, not a
		// `click` event — otherwise a pan would end by selecting whatever card it stopped on.
		window.addEventListener("pointerup", (event) => {
			if (this.drag === undefined) return;
			const wasDrag = this.dragged;
			this.drag = undefined;
			this.dragged = false;
			this.viewport.classList.remove("panning");
			if (wasDrag || !(event.target instanceof Element)) return;
			const card = event.target.closest<HTMLButtonElement>(".gnode");
			if (card !== null && !card.disabled) this.select(card.dataset.id);
		});
		window.addEventListener("pointercancel", () => {
			this.drag = undefined;
			this.dragged = false;
			this.viewport.classList.remove("panning");
		});
		// The wheel is the map's other hand: Ctrl / ⌘ zooms under the pointer, and a bare wheel — or a
		// two-finger trackpad swipe — pans. Neither has a scroll range to run out of.
		this.viewport.addEventListener(
			"wheel",
			(event) => {
				event.preventDefault();
				if (event.ctrlKey || event.metaKey) {
					this.zoomAt(this.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), event.clientX, event.clientY);
					return;
				}
				this.x -= event.deltaX;
				this.y -= event.deltaY;
				this.applyTransform();
			},
			{ passive: false },
		);
		// Two presses on one card: selection and application in one gesture — "就它了".
		this.viewport.addEventListener("dblclick", (event) => {
			if (!(event.target instanceof Element)) return;
			const card = event.target.closest<HTMLButtonElement>(".gnode");
			if (card === null || card.disabled) return;
			this.select(card.dataset.id);
			this.applySelection();
		});
	}

	/**
	 * Fold the newest branch shape in.
	 *
	 * Cheap when nothing moved: the tree only changes on a baseline, so an unchanged reference costs
	 * one comparison. A tree that changed while the page was hidden is painted on entering, which is
	 * also when fitting can measure the viewport.
	 */
	render(tree: BranchTree | undefined, streaming: boolean): void {
		const changed = tree !== this.tree;
		this.tree = tree;
		if (changed) this.selected = tree?.currentId;
		if (streaming !== this.streaming) {
			this.streaming = streaming;
			this.paintTools();
		}
		if (!changed) return;
		if (this.open) {
			this.paint();
			this.homeZoom();
		}
	}

	/** Show the page: paint the newest tree, fit it, and put the tools row in the header. */
	enter(): void {
		this.open = true;
		this.toolsBar.hidden = false;
		this.paint();
		this.homeZoom();
	}

	leave(): void {
		this.open = false;
		this.toolsBar.hidden = true;
	}

	/**
	 * Re-read the stylesheet's geometry and paint again, for a change the tree cannot report.
	 *
	 * A card's height and its lane are tokens (`cardMetrics`), and the only thing that moves them is the
	 * window's font-size setting — which is not a new tree, so `render`'s one comparison would skip the
	 * paint and leave every card at the height it had before the slider moved. A page that is not open
	 * needs nothing: `enter` paints on the way in.
	 */
	remeasure(): void {
		if (this.open) this.paint();
	}

	// ------------------------------------------------------------------ painting

	private paint(): void {
		const tree = this.tree;
		if (tree === undefined) {
			// No tree, no graph: the page waits empty for the first question to land.
			this.zoomLayer.replaceChildren();
			this.laid = undefined;
			this.paintTools();
			return;
		}

		const metrics = cardMetrics(this.viewport);
		const laid = (this.laid = layout(tree, metrics));

		const svg = document.createElementNS(SVG_NS, "svg");
		svg.setAttribute("class", "graph-svg");
		svg.setAttribute("width", String(laid.width));
		svg.setAttribute("height", String(laid.height));

		const colors = laneColors();
		const dotX = (depth: number) => depth * STEP_X + DOT_X;
		const dotY = (lane: number) => lane * metrics.lane + metrics.lane / 2;
		const at = new Map(laid.nodes.map((node) => [node.way.entryId, node]));

		const drawEdge = (d: string, lane: number, solid: boolean): void => {
			const edge = document.createElementNS(SVG_NS, "path");
			edge.setAttribute("d", d);
			edge.setAttribute("fill", "none");
			edge.setAttribute("stroke", colors[lane % colors.length] ?? "currentColor");
			edge.setAttribute("stroke-width", "1.6");
			edge.setAttribute("stroke-opacity", solid ? "1" : "0.4");
			svg.append(edge);
		};

		for (const node of laid.nodes) {
			const ax = dotX(node.depth) + DOT_R;
			const ay = dotY(node.lane);
			// Along the line: the next user message is one column right, on the same row.
			if (node.way.next !== undefined && at.has(node.way.next.entryId)) {
				drawEdge(`M${ax},${ay} H${dotX(node.depth + 1) - DOT_R}`, node.lane, true);
			}
			// Off the line: out straight, one curve, down, one curve back, in straight.
			node.way.branches.forEach((branch, index) => {
				const to = at.get(branch.entryId);
				if (to === undefined) return;
				const by = dotY(to.lane);
				const bx = dotX(to.depth) - DOT_R;
				const out = ax + 10 + index * 9;
				const mid = out + 16;
				const sign = by > ay ? 1 : -1;
				drawEdge(
					`M${ax},${ay} H${out}` +
						` Q${mid},${ay} ${mid},${ay + sign * 10}` +
						` V${by - sign * 10}` +
						` Q${mid},${by} ${mid + 10},${by}` +
						` H${bx}`,
					to.lane,
					false,
				);
			});
		}

		for (const node of laid.nodes) {
			const color = colors[node.lane % colors.length] ?? "currentColor";
			const onLine = tree.line.has(node.way.entryId);
			const dot = document.createElementNS(SVG_NS, "circle");
			dot.setAttribute("cx", String(dotX(node.depth)));
			dot.setAttribute("cy", String(dotY(node.lane)));
			dot.setAttribute("r", String(node.way.entryId === this.selected ? DOT_R + 1.5 : DOT_R));
			dot.setAttribute("fill", onLine ? color : "none");
			dot.setAttribute("stroke", color);
			dot.setAttribute("stroke-width", "1.8");
			dot.setAttribute("stroke-opacity", onLine ? "1" : "0.6");
			svg.append(dot);
		}

		const cards: HTMLElement[] = laid.nodes.map((node) => {
			const way = node.way;
			const card = element("button", "gnode", undefined, { type: "button", "data-id": way.entryId });
			card.style.left = `${node.depth * STEP_X}px`;
			card.style.top = `${dotY(node.lane) - metrics.node / 2}px`;
			card.style.width = `${NODE_W}px`;
			card.style.height = `${metrics.node}px`;
			// The whole sentence rides in `title`: the card shows one line of it, cut by the stylesheet's
			// ellipsis, and the tooltip is what answers "what did it actually say". The question and the
			// answer both ride there — a card that names the way by its question and the two ways that
			// differ by their answers needs both to be readable, once each.
			const parts: string[] = [];
			for (const part of [way.question, way.answer, way.label]) {
				if (part.length > 0 && !parts.includes(part)) parts.push(part);
			}
			card.title = parts.join("\n\n");
			if (way.entryId === this.tree?.currentId) card.dataset.current = "";
			if (way.entryId === this.selected) card.dataset.selected = "";
			if (tree.line.has(way.entryId)) card.dataset.onPath = "";

			const label = element("span", "lbl", way.label);
			const meta = element("span", "meta");
			meta.append(element("span", undefined, shortId(way.entryId)));
			if (way.turn > 0) meta.append(element("span", undefined, `轮 ${way.turn}`));
			if (way.entryId === this.tree?.currentId) meta.append(element("span", "tag", "当前"));
			else if (way.entryId === this.selected) meta.append(element("span", "tag", "已选中"));
			card.append(label, meta);
			return card;
		});

		this.zoomLayer.replaceChildren(svg, ...cards);
		this.applyTransform();
		this.paintTools();
	}

	/**
	 * The way the page would move to if the exit button were pressed, or `undefined` when there is
	 * nothing to move to — no tree, nothing selected, or the way being read is what is selected.
	 *
	 * The button's label, its primary tint, its disabled state, and what a press does all turn on this
	 * one fact, so it is derived once here rather than spelled again at each of them.
	 */
	private movingWay(): BranchWay | undefined {
		const tree = this.tree;
		const id = this.selected;
		if (tree === undefined || id === undefined || id === tree.currentId) return undefined;
		return findWay(tree, id);
	}

	/** The fixed header's row: the zoom fallbacks and the one way out. */
	private paintTools(): void {
		const moving = this.movingWay();
		this.back.textContent =
			moving === undefined ? "回到对话" : moving.landing === "here" ? "从这里继续" : "切到这一条并回到对话";
		this.back.classList.toggle("primary", moving !== undefined);
		// A run is writing to the tree the button would move, so the move waits for it to settle — but
		// only the *move* waits. "回到对话" is the window changing which page it shows and is always
		// allowed, and the button says which of the two it is refusing rather than looking pressable and
		// doing nothing. Every paint rewrites this, so the end of the run is what turns it back on.
		this.back.disabled = moving !== undefined && this.streaming;
		// Deliberately empty when the move is allowed rather than absent: a button that carries no
		// `title` of its own would still show the last refusal's tooltip on hover.
		this.back.title = this.back.disabled ? "这一轮还在写，等它结束再切" : "";
	}

	// --------------------------------------------------------------- selection

	private select(id: string | undefined): void {
		if (id === undefined || id === this.selected) return;
		this.selected = id;
		this.paint();
	}

	/**
	 * The one way out of the page: apply what is selected, or just go back.
	 *
	 * The run check guards the **move** alone. Returning to the conversation is this window swapping
	 * which page it shows, which no run can be in the middle of.
	 *
	 * A card on the line lands on the **answer** its question produced, not on the question itself —
	 * the conversation comes back showing the question and what it said, and the next prompt forks
	 * after the answer, where a new question belongs. A way with no answer yet, and a card that left
	 * the line, land on their own entry.
	 */
	private applySelection(): void {
		const moving = this.movingWay();
		if (moving === undefined) {
			this.options.onBack();
			return;
		}
		if (this.streaming) return;
		const entryId = moving.landing === "here" && moving.replyId !== undefined ? moving.replyId : moving.entryId;
		this.options.onSwitch(entryId, moving.landing);
	}

	// ------------------------------------------------------------------ the map

	/** Write the layer's one transform — the whole of pan and zoom. */
	private applyTransform(): void {
		this.zoomLayer.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.zoom})`;
		this.zoomValue.textContent = `${Math.round(this.zoom * 100)}%`;
	}

	/**
	 * Zoom, keeping the point under the pointer (or the viewport's centre) pinned.
	 *
	 * The graph point under a viewport point is `(px - x) / zoom`; after the zoom it has to land on the
	 * same pixel, so the translation is solved from it rather than nudged. There is no scroll box and no
	 * content size to clamp against: a map does not need one.
	 */
	private zoomAt(next: number, clientX?: number, clientY?: number): void {
		if (this.laid === undefined) return;
		const box = this.viewport.getBoundingClientRect();
		const px = clientX === undefined ? this.viewport.clientWidth / 2 : clientX - box.left;
		const py = clientY === undefined ? this.viewport.clientHeight / 2 : clientY - box.top;
		const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
		if (zoom === this.zoom) return;
		this.x = px - ((px - this.x) / this.zoom) * zoom;
		this.y = py - ((py - this.y) / this.zoom) * zoom;
		this.zoom = zoom;
		this.applyTransform();
	}

	/** The scale that fits the whole graph, width and height both. */
	private fitScale(): number {
		const laid = this.laid;
		if (laid === undefined) return 1;
		const byWidth = (this.viewport.clientWidth - PAD * 2) / laid.width;
		const byHeight = (this.viewport.clientHeight - PAD * 2) / laid.height;
		return Math.min(byWidth, byHeight);
	}

	/** Entering the page and pressing "适应" both land here: the whole graph, centred, never above 100%. */
	private homeZoom(): void {
		const laid = this.laid;
		if (laid === undefined) return;
		this.zoom = Math.min(1, this.fitScale());
		this.x = (this.viewport.clientWidth - laid.width * this.zoom) / 2;
		this.y = (this.viewport.clientHeight - laid.height * this.zoom) / 2;
		this.applyTransform();
	}
}

// --------------------------------------------------------------------- layout

/**
 * A card's height and the lane it sits in, as the stylesheet resolves them.
 *
 * Read per paint for the same reason the palette is: a paint is rare, and the font-size slider can
 * move both between one paint and the next.
 */
interface CardMetrics {
	node: number;
	lane: number;
}

/**
 * The graph's geometry, measured off a throwaway element rather than parsed off the tokens.
 *
 * `--dsw-branch-node-h` is a `calc()` chain, and an **unregistered** custom property's computed value
 * is that token stream with the `calc()` left unevaluated — `getComputedStyle(root).getPropertyValue()`
 * hands back `"calc(calc(13px + calc(22px - 15px)) * 18 / 13) + ..."`, which `parseFloat` reads as
 * `NaN`. The probe carries the token as its height, so what comes back is the box the layout gives a
 * real card — it has to be attached to be measured at all, so it goes into the viewport and comes
 * straight back out. `.branch-metric` keeps it invisible and out of the flow while it is there.
 */
function cardMetrics(host: HTMLElement): CardMetrics {
	const measure = (height: string): number => {
		const probe = element("div", "branch-metric");
		probe.style.height = height;
		host.append(probe);
		const measured = probe.getBoundingClientRect().height;
		probe.remove();
		return measured;
	};
	return { node: measure("var(--dsw-branch-node-h)"), lane: measure("var(--dsw-branch-lane-h)") };
}

/**
 * Place the cards: the line runs along row 0, one column per message, and each fork's alternatives
 * take the rows below the card they left.
 *
 * One rule only — **`next` keeps the row, `branches` open new ones** — which is what makes the way
 * being read a straight horizontal line with the others hanging off it. Each alternative is a leaf:
 * the server only reports branch points on the active chain, so a way nobody is reading has no
 * further shape to draw.
 */
function layout(tree: BranchTree, metrics: CardMetrics): Layout {
	const nodes: LaidNode[] = [];
	let lane = 1;
	const walk = (way: BranchWay, depth: number, row: number): void => {
		nodes.push({ way, depth, lane: row });
		for (const branch of way.branches) walk(branch, depth + 1, lane++);
		if (way.next !== undefined) walk(way.next, depth + 1, row);
	};
	walk(tree.trunk, 0, 0);

	const depths = Math.max(...nodes.map((node) => node.depth)) + 1;
	const lanes = Math.max(...nodes.map((node) => node.lane)) + 1;
	return {
		nodes,
		width: (depths - 1) * STEP_X + DOT_X + NODE_W,
		height: lanes * metrics.lane,
	};
}

/** The short id a card and the header's entry both show: the entry id's first few characters. */
export function shortId(entryId: string): string {
	return entryId.slice(0, SHORT_ID);
}

/**
 * The lane palette, read off the tokens so both themes answer for themselves.
 * Read per paint rather than cached: a paint is rare, and a theme switch should not have to
 * negotiate with a cache.
 */
function laneColors(): string[] {
	const styles = getComputedStyle(document.documentElement);
	return [1, 2, 3, 4].map((lane) =>
		styles.getPropertyValue(`--dsw-lane-${lane}`).trim() || "currentColor",
	);
}
