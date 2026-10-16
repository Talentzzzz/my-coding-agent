import { element } from "../dom.ts";
import { findWay, type BranchTree, type BranchWay } from "../state.ts";

/*
 * The branch page: one tree, drawn the way git draws one but turned on its side —
 * **column = depth (growing right), row = lane, root in the leftmost column**. A way occupies one
 * row, the line elbows over onto another row at a fork, and the trunk always keeps the top row, so
 * the way being read is one horizontal line from end to end. The geometry and the scale below are
 * the prototype's (12/13 号), copied rather than reinvented.
 *
 * Interaction is the two-beat the prototype settled on: clicking a node only **selects** it, and the
 * button in the fixed header is what moves the session and returns to the conversation. The page
 * zooms with Ctrl+wheel (anchored at the pointer) and pans with a held left button, anywhere — a
 * press that never moves more than 4px counts as a click, which is how select and pan share one
 * button without a click event of their own.
 */

const NODE_W = 268; // A node card's width.
const STEP_X = 300; // How much further right one level of depth sits.
const DOT_R = 4.5; // The dot on the line.
const DOT_X = 12; // The dot's distance from its card's left edge.
const PAD_X = 24; // Space around the graph (also the viewport's inset).
const PAD_Y = 16;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
/** The short id a card and the header's entry both show: the entry id's first few characters. */
const SHORT_ID = 7;
const SVG_NS = "http://www.w3.org/2000/svg";

export interface BranchViewOptions {
	/** Move the session onto a way and return to the conversation. */
	onSwitch(entryId: string): void;
	/** Return to the conversation without moving. */
	onBack(): void;
}

/** One laid-out node: a way, or the root card when `way` is undefined. */
interface LaidNode {
	way: BranchWay | undefined;
	id: string;
	label: string;
	turn: number | undefined;
	selectable: boolean;
	depth: number;
	lane: number;
}

interface Layout {
	nodes: LaidNode[];
	/** The ids on the way being read, which the paint marks solid. */
	path: Set<string>;
	width: number;
	height: number;
}

/** The branch page, and the fixed header's own row of branch tools. */
export class BranchView {
	/** The page itself: summary line over the pan-and-zoom viewport. */
	readonly element: HTMLElement;
	/** The tools row that lives in the fixed header, under the title. */
	readonly toolsBar: HTMLElement;

	private readonly options: BranchViewOptions;
	private readonly sum = element("div", "branch-sum");
	private readonly viewport = element("div", "graph-viewport");
	private readonly sizer = element("div", "graph-sizer");
	private readonly zoomLayer = element("div", "graph-zoom");
	private readonly selInfo = element("span", "branch-sel-info");
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
	/** The way the page has picked but not yet applied; starts on the way being read. */
	private selected: string | undefined;
	private laid: Layout | undefined;

	/** Pan bookkeeping: the press's origin, and whether it grew into a drag. */
	private drag: { x: number; y: number; left: number; top: number } | undefined;
	private dragged = false;

	constructor(options: BranchViewOptions) {
		this.options = options;
		this.viewport.append(this.sizer);
		this.sizer.append(this.zoomLayer);
		this.element = element("div", "branch-view");
		this.element.append(this.sum, this.viewport);

		this.zoomOut = element("button", "zoom-button", "−", { type: "button", title: "缩小" });
		this.zoomIn = element("button", "zoom-button", "＋", { type: "button", title: "放大" });
		this.zoomFit = element("button", "zoom-button", "适应", { type: "button", title: "缩放到刚好装下" });
		this.back = element("button", "back-button", "回到对话", { type: "button" });
		const zoomGroup = element("div", "zoom-group");
		zoomGroup.append(this.zoomOut, this.zoomValue, this.zoomIn, this.zoomFit);
		this.toolsBar = element("div", "branch-tools");
		this.toolsBar.append(this.selInfo, element("span", "header-spacer"), zoomGroup, this.back);
		// The tools row belongs to the branch page; it shows when the page does, and not before.
		this.toolsBar.hidden = true;

		this.zoomOut.addEventListener("click", () => this.applyZoom(this.zoom / 1.2));
		this.zoomIn.addEventListener("click", () => this.applyZoom(this.zoom * 1.2));
		this.zoomFit.addEventListener("click", () => {
			this.applyZoom(this.fitScale());
			this.scrollHome();
		});
		this.back.addEventListener("click", () => this.applySelection());

		this.viewport.addEventListener("pointerdown", (event) => {
			if (event.button !== 0) return;
			this.drag = { x: event.clientX, y: event.clientY, left: this.viewport.scrollLeft, top: this.viewport.scrollTop };
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
			this.viewport.scrollLeft = this.drag.left - dx;
			this.viewport.scrollTop = this.drag.top - dy;
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
		// Ctrl / ⌘ + wheel zooms with the point under the pointer pinned; an unmodified wheel scrolls.
		this.viewport.addEventListener(
			"wheel",
			(event) => {
				if (!event.ctrlKey && !event.metaKey) return;
				event.preventDefault();
				this.applyZoom(this.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), event.clientX, event.clientY);
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
			this.sum.replaceChildren(
				element("span", undefined, "这条会话还没有分支。对一条用户消息右键选「从此分支」，再发一条消息，这里就会长出第二条走法。"),
			);
			this.zoomLayer.replaceChildren();
			this.laid = undefined;
			this.paintTools();
			return;
		}

		const metrics = cardMetrics(this.viewport);
		const laid = (this.laid = layout(tree, metrics));
		this.paintSummary(tree);

		const svg = document.createElementNS(SVG_NS, "svg");
		svg.setAttribute("class", "graph-svg");
		svg.setAttribute("width", String(laid.width));
		svg.setAttribute("height", String(laid.height));

		const colors = laneColors();
		const at = new Map(laid.nodes.map((node, index) => [node.id, index]));
		const dotX = (depth: number) => depth * STEP_X + DOT_X;
		const dotY = (lane: number) => lane * metrics.lane + metrics.lane / 2;

		// Edges: parent's dot rightwards; a change of lane elbows over — out straight, one curve,
		// across, one curve back, in straight.
		const drawEdges = (way: BranchWay | undefined, id: string): void => {
			const kids = way === undefined ? tree.ways : way.children;
			kids.forEach((kid, index) => {
				const a = at.get(id);
				const b = at.get(kid.entryId);
				if (a !== undefined && b !== undefined) {
					const from = laid.nodes[a]!;
					const to = laid.nodes[b]!;
					const ax = dotX(from.depth) + DOT_R;
					const ay = dotY(from.lane);
					const bx = dotX(to.depth) - DOT_R;
					const by = dotY(to.lane);
					const color = colors[to.lane % colors.length] ?? "currentColor";
					const opacity = laid.path.has(kid.entryId) ? "1" : "0.4";
					let d: string;
					if (ay === by) {
						d = `M${ax},${ay} H${bx}`;
					} else {
						const out = ax + 10 + index * 9;
						const mid = out + 16;
						const sign = by > ay ? 1 : -1;
						d =
							`M${ax},${ay} H${out}` +
							` Q${mid},${ay} ${mid},${ay + sign * 10}` +
							` V${by - sign * 10}` +
							` Q${mid},${by} ${mid + 10},${by}` +
							` H${bx}`;
					}
					const edge = document.createElementNS(SVG_NS, "path");
					edge.setAttribute("d", d);
					edge.setAttribute("fill", "none");
					edge.setAttribute("stroke", color);
					edge.setAttribute("stroke-width", "1.6");
					edge.setAttribute("stroke-opacity", opacity);
					svg.append(edge);
				}
				drawEdges(kid, kid.entryId);
			});
		};
		drawEdges(undefined, "");

		for (const node of laid.nodes) {
			const color = colors[node.lane % colors.length] ?? "currentColor";
			const onPath = node.id !== "" && laid.path.has(node.id);
			const selected = node.id === this.selected;
			const dot = document.createElementNS(SVG_NS, "circle");
			dot.setAttribute("cx", String(dotX(node.depth)));
			dot.setAttribute("cy", String(dotY(node.lane)));
			dot.setAttribute("r", String(selected ? DOT_R + 1.5 : DOT_R));
			dot.setAttribute("fill", onPath ? color : "none");
			dot.setAttribute("stroke", color);
			dot.setAttribute("stroke-width", "1.8");
			dot.setAttribute("stroke-opacity", onPath ? "1" : "0.6");
			svg.append(dot);
		}

		const cards: HTMLElement[] = laid.nodes.map((node) => {
			const card = element("button", "gnode", undefined, {
				type: "button",
				"data-id": node.id,
				...(node.selectable ? {} : { disabled: true }),
			});
			const isSelected = node.id === this.selected;
			card.style.left = `${node.depth * STEP_X}px`;
			card.style.top = `${dotY(node.lane) - metrics.node / 2}px`;
			card.style.width = `${NODE_W}px`;
			card.style.height = `${metrics.node}px`;
			// The whole sentence rides in `title`: the card shows one line of it, cut by the stylesheet's
			// ellipsis, and the tooltip is what answers "what did it actually say".
			card.title = node.label;
			if (node.id === this.tree?.currentId) card.dataset.current = "";
			if (isSelected) card.dataset.selected = "";
			if (onPathOf(laid, node.id)) card.dataset.onPath = "";

			const label = element("span", "lbl", node.label);
			const meta = element("span", "meta");
			if (node.way === undefined) meta.append(element("span", undefined, "起点"));
			else meta.append(element("span", undefined, shortId(node.way.entryId)));
			if (node.turn !== undefined) meta.append(element("span", undefined, `轮 ${node.turn}`));
			if (node.id === this.tree?.currentId) meta.append(element("span", "tag", "当前"));
			else if (isSelected) meta.append(element("span", "tag", "已选中"));
			card.append(label, meta);
			return card;
		});

		this.zoomLayer.replaceChildren(svg, ...cards);
		this.applyZoom(this.zoom);
		this.paintTools();
	}

	private paintSummary(tree: BranchTree): void {
		const line = element("span");
		const count = element("b", undefined, String(tree.points));
		const ways = element("b", undefined, String(tree.options));
		line.append("这份记录有 ", count, " 个分支点、", ways, " 条走法；根在最左边，实心点连起来的那条是你现在读的。");
		const hint = element("span", "branch-hint", "左键点一个节点选中它 · 悬停看整句话 · 按住左键拖动画布 · Ctrl+滚轮放大");
		this.sum.replaceChildren(line, hint);
	}

	/** The fixed header's row: what is selected, the zoom fallbacks, and the one way out. */
	private paintTools(): void {
		const tree = this.tree;
		const selected = tree === undefined || this.selected === undefined ? undefined : findWay(tree, this.selected);
		const moving = selected !== undefined && tree !== undefined && this.selected !== tree.currentId;
		if (selected === undefined) {
			this.selInfo.replaceChildren("点一个节点选中它，再按右边的按钮回到对话。");
		} else {
			const head = element("b", undefined, shortId(selected.entryId));
			const name = element("em", undefined, selected.label);
			this.selInfo.replaceChildren(moving ? "已选中 " : "现在读的是 ", head, " ", name, `（轮 ${selected.turn}）`);
		}
		this.back.textContent = moving ? "切到这一条并回到对话" : "回到对话";
		this.back.classList.toggle("primary", moving);
		// A run is writing to the tree the button would move; switching waits for it to settle.
		this.back.disabled = moving && this.streaming;
	}

	// --------------------------------------------------------------- selection

	private select(id: string | undefined): void {
		if (id === undefined || id === this.selected) return;
		this.selected = id;
		this.paint();
	}

	/** The one way out of the page: apply what is selected, or just go back. */
	private applySelection(): void {
		if (this.streaming) return;
		const tree = this.tree;
		if (tree === undefined) {
			this.options.onBack();
			return;
		}
		if (this.selected !== undefined && this.selected !== tree.currentId) this.options.onSwitch(this.selected);
		else this.options.onBack();
	}

	// -------------------------------------------------------------- zoom & pan

	/**
	 * Zoom, keeping the point under the pointer (or the viewport's centre) pinned.
	 * The graph's natural size and its scaled size are two facts, which is why the sizer outside
	 * carries the scroll range while the layer inside carries the `scale()`.
	 */
	private applyZoom(next: number, clientX?: number, clientY?: number): void {
		const laid = this.laid;
		if (laid === undefined) return;
		const box = this.viewport.getBoundingClientRect();
		const vx = clientX === undefined ? this.viewport.clientWidth / 2 : clientX - box.left;
		const vy = clientY === undefined ? this.viewport.clientHeight / 2 : clientY - box.top;
		// Where the point under the pointer sits in the graph's own coordinates. Measured, not derived
		// from `scrollLeft`: a graph smaller than the viewport is centred by the stylesheet, so the
		// viewport's origin meets the sizer somewhere in the middle rather than at its corner.
		const sizer = this.sizer.getBoundingClientRect();
		const ox = box.left + this.viewport.scrollLeft - sizer.left;
		const oy = box.top + this.viewport.scrollTop - sizer.top;
		const gx = (ox + vx - PAD_X) / this.zoom;
		const gy = (oy + vy - PAD_Y) / this.zoom;

		this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
		this.sizer.style.width = `${laid.width * this.zoom + PAD_X * 2}px`;
		this.sizer.style.height = `${laid.height * this.zoom + PAD_Y * 2}px`;
		this.zoomLayer.style.left = `${PAD_X}px`;
		this.zoomLayer.style.top = `${PAD_Y}px`;
		this.zoomLayer.style.transform = `scale(${this.zoom})`;

		// The `- PAD_X` is the sizer's own inset: the graph sits inside it, so the scroll that pins the
		// graph's point under the pointer is the scroll that pins the sizer's box plus that inset.
		this.viewport.scrollLeft = gx * this.zoom + PAD_X - vx - ox;
		this.viewport.scrollTop = gy * this.zoom + PAD_Y - vy - oy;
		this.zoomValue.textContent = `${Math.round(this.zoom * 100)}%`;
	}

	/** The scale that fits the whole graph, width and height both. */
	private fitScale(): number {
		const laid = this.laid;
		if (laid === undefined) return 1;
		const byWidth = (this.viewport.clientWidth - PAD_X * 2) / laid.width;
		const byHeight = (this.viewport.clientHeight - PAD_Y * 2) / laid.height;
		return Math.min(byWidth, byHeight);
	}

	/**
	 * The scroll position that puts the graph in the middle of the viewport — entering the page and
	 * pressing "适应" both land here.
	 *
	 * Read off the sizer's painted size rather than recomputed from `zoom`: one size, one place, and
	 * the two cannot drift apart. A graph smaller than the viewport has no scroll range, so the clamp
	 * is the whole answer there and the stylesheet's `justify-items` does the visible half.
	 */
	private scrollHome(): void {
		if (this.laid === undefined) return;
		const sizer = this.sizer.getBoundingClientRect();
		this.viewport.scrollLeft = Math.max(0, (sizer.width - this.viewport.clientWidth) / 2);
		this.viewport.scrollTop = Math.max(0, (sizer.height - this.viewport.clientHeight) / 2);
	}

	/** Entering the page: 100% when the graph fits, shrunk only when it does not. */
	private homeZoom(): void {
		this.applyZoom(Math.min(1, this.fitScale()));
		this.scrollHome();
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
 * `NaN`. The first cut of this read the tokens that way, so it always took its fallback and painted
 * every card at the default size no matter what the font-size slider said: the clipping this page was
 * fixed for, back at the top of the range. `main.ts` can parse its own tokens because those are literal
 * pixels; these are not, so the browser does the arithmetic and this reads the result.
 *
 * The probe carries the token as its height, so what comes back is the box the layout gives a real
 * card — it has to be attached to be measured at all, so it goes into the viewport and comes straight
 * back out. `.branch-metric` keeps it invisible and out of the flow while it is there.
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
 * Place the nodes: **one rule only** — the child on the active path keeps its parent's lane, every
 * other child opens a new lane; rows are depth-first, so a subtree finishes before the next sibling
 * starts. The path child is sorted first, which is what keeps the trunk on the top row as one
 * straight horizontal line.
 */
function layout(tree: BranchTree, metrics: CardMetrics): Layout {
	const path = pathOf(tree);
	const nodes: LaidNode[] = [
		// The root is the common ancestor, not a way of its own — drawn so the tree has a place to
		// start, and never selectable.
		{ way: undefined, id: "", label: tree.rootLabel, turn: undefined, selectable: false, depth: 0, lane: 0 },
	];
	let nextLane = 0;
	const walk = (way: BranchWay, depth: number, lane: number): void => {
		nodes.push({
			way,
			id: way.entryId,
			label: way.label,
			turn: way.turn,
			selectable: true,
			depth,
			lane,
		});
		const kids = [...way.children].sort((a, b) => Number(path.has(b.entryId)) - Number(path.has(a.entryId)));
		kids.forEach((kid, index) => walk(kid, depth + 1, index === 0 ? lane : ++nextLane));
	};
	[...tree.ways]
		.sort((a, b) => Number(path.has(b.entryId)) - Number(path.has(a.entryId)))
		.forEach((way, index) => walk(way, 1, index === 0 ? 0 : ++nextLane));

	const lanes = Math.max(...nodes.map((node) => node.lane)) + 1;
	const depths = Math.max(...nodes.map((node) => node.depth)) + 1;
	return {
		nodes,
		path,
		width: (depths - 1) * STEP_X + DOT_X + NODE_W,
		height: lanes * metrics.lane,
	};
}

/** The ids from the root to the way being read — the chain the paint draws solid. */
function pathOf(tree: BranchTree): Set<string> {
	const path = new Set<string>();
	if (tree.currentId === undefined) return path;
	const walk = (ways: readonly BranchWay[], chain: string[]): boolean => {
		for (const way of ways) {
			const next = [...chain, way.entryId];
			if (way.entryId === tree.currentId) {
				next.forEach((id) => path.add(id));
				return true;
			}
			if (walk(way.children, next)) return true;
		}
		return false;
	};
	walk(tree.ways, []);
	return path;
}

function onPathOf(laid: Layout, id: string): boolean {
	return id !== "" && laid.path.has(id);
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
