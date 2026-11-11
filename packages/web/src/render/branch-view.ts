import { element } from "../dom.ts";
import { findWay, type BranchTree, type BranchWay } from "../state.ts";

/*
 * 分支页：**正在读的线，从左往右画，离开它的路挂在下面** —— 列 = 右边多一条用户消息，行 = 另一条路。
 *
 * 线是主干且总是画出，即使什么都没派生过：没有分支点的对话仍然有它的问题，而"我想回到哪个问题"
 * 正是这个页面回答的问题。一次派生是挂在它离开的卡片下面的卡片，被读的那条路保有顶行，于是它
 * 从头到尾读作一条水平线。
 *
 * 交互是原型定下的两拍：点击卡片只是**选中**，固定头部的按钮才移动会话并回到对话。线上的卡片
 * 落在其问题产出的回答上（见 {@link BranchWay.replyId}），离开线的卡片沿它走到自己工作停下的
 * 地方 —— 页面本身不带任何说明文字：卡片就是全部的解释，装得下窗口的树读起来就只是那些卡片。
 * 卡片上方也不挂任何东西：卡片没有 tooltip，因为树才是页面要展示的东西，遮住下一行的悬停是在
 * 回答没人问过的问题。
 *
 * 画布表现得像地图而不是滚动盒：层只带一个 `translate` 和一个 `scale`，按住直接移动 translate，
 * 滚轮平移。过去它靠往 overflow 盒里写 `scrollLeft` / `scrollTop` 来平移，滚动范围就是图自身的
 * 大小 —— 于是装得下窗口的图（`enter` 正是把它装到窗口里的）完全没有范围，拖动什么都不做。
 * 平移没有这种前提：比窗口小的地图照样能拖。
 */

const NODE_W = 268; // 卡片宽度。
const STEP_X = 300; // 下一条消息再向右多少。
const DOT_R = 4.5; // 线上的圆点。
const DOT_X = 12; // 圆点距其卡片左缘的距离。
const PAD = 24; // 图被装下时四周保留的空隙。
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
/** 卡片和头部条目都显示的短 id：条目 id 的前几个字符。 */
const SHORT_ID = 7;
const SVG_NS = "http://www.w3.org/2000/svg";

export interface BranchViewOptions {
	/**
	 * 把会话移到一条路上并回到对话。
	 *
	 * `entryId` 是叶子落地的条目：对离开线的卡片，是那条路自己的条目（调用者沿它走到尖端）；对
	 * 线上的卡片，是问题产出的回答（若有），没有则是问题本身。
	 */
	onSwitch(entryId: string, landing: BranchWay["landing"]): void;
	/** 不移动、只回到对话。 */
	onBack(): void;
}

/** 一张已布局的卡片：一条路，放在网格里。 */
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

/** 分支页，以及固定头部自己的分支工具行。 */
export class BranchView {
	/** 页面本身：平移缩放视口，上面没有任何东西。 */
	readonly element: HTMLElement;
	/** 住在固定头部、标题之下的工具行。 */
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
	/** 页面是否是屏幕上的那一个；绘制等它，因为装下需要尺寸。 */
	private open = false;
	private zoom = 1;
	/** 层的平移量，视口像素 —— 平移的全部。 */
	private x = PAD;
	private y = PAD;
	/** 页面已选中但尚未应用的路；从正在读的那条开始。 */
	private selected: string | undefined;
	private laid: Layout | undefined;

	/** 平移簿记：按压开始的位置，以及它开始时的平移量。 */
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
		// 工具行属于分支页；页面显示时它才显示，之前绝不。
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
			// 小于 4px 仍算"按压"；超过它按压变成平移，捕获指针让拖动在视口外也能持续跟踪。
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
		// 松开是把从未拖动的按压变成点击的地方：由指针决定，而不是 `click` 事件 —— 否则一次平移会
		// 以选中它停下的卡片收场。
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
		// 滚轮是地图的另一只手：Ctrl / ⌘ 在指针下缩放，裸滚轮 —— 或触控板双指滑动 —— 平移。
		// 两者都没有可耗尽的滚动范围。
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
		// 一张卡片上按两下：一个手势里完成选中和应用 —— "就它了"。
		this.viewport.addEventListener("dblclick", (event) => {
			if (!(event.target instanceof Element)) return;
			const card = event.target.closest<HTMLButtonElement>(".gnode");
			if (card === null || card.disabled) return;
			this.select(card.dataset.id);
			this.applySelection();
		});
	}

	/**
	 * 折入最新的分支形状。
	 *
	 * 什么都不动时很便宜：树只在基线上变化，所以未变的引用只花一次比较。页面隐藏期间变化的树
	 * 在进入时绘制，那也是唯一能测量视口的时刻。
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

	/** 显示页面：画最新的树、装下它、把工具行放进头部。 */
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
	 * 重读样式表的几何并重画，应对树无法报告的变化。
	 *
	 * 卡片的高度和所在的行是 token（`cardMetrics`），唯一移动它们的是窗口的字号设置 —— 那不是
	 * 一棵新树，所以 `render` 的那一次比较会跳过绘制，让每张卡片保持滑块移动前的高度。未打开的
	 * 页面什么都不需要：`enter` 会在进来时绘制。
	 */
	remeasure(): void {
		if (this.open) this.paint();
	}

	// ------------------------------------------------------------------ 绘制

	private paint(): void {
		const tree = this.tree;
		if (tree === undefined) {
			// 没有树就没有图：页面空等第一个问题落地。
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
			// 沿线：下一条用户消息在同一行右侧一列。
			if (node.way.next !== undefined && at.has(node.way.next.entryId)) {
				drawEdge(`M${ax},${ay} H${dotX(node.depth + 1) - DOT_R}`, node.lane, true);
			}
			// 离线：沿主干跑到分支自己那一列之前的空隙，从空隙落下，再向右拐进卡片。空隙 —— 父列
			// 的卡片在 `NODE_W` 处结束、分支列的卡片从下一步开始之间 —— 是主干行之下没有卡片会占据
			// 的唯一一条 x 带，所以下降绝不会像过去从圆点垂直下落那样切在卡片背后。扇形从空隙右缘
			// 往回数，所以更晚的兄弟总是从更早兄弟的进入路径**左侧**下降，两者永不相交；超出空隙
			// 宽度时，下降共享最左的行而不是另开。
			node.way.branches.forEach((branch, index) => {
				const to = at.get(branch.entryId);
				if (to === undefined) return;
				const by = dotY(to.lane);
				const bx = dotX(to.depth) - DOT_R;
				const gapLeft = node.depth * STEP_X + NODE_W + 4;
				const gapRight = (node.depth + 1) * STEP_X - 16;
				const drop = Math.max(gapRight - index * 6, gapLeft);
				const pre = 14;
				const sign = by > ay ? 1 : -1;
				drawEdge(
					`M${ax},${ay} H${drop - pre}` +
						` Q${drop},${ay} ${drop},${ay + sign * 10}` +
						` V${by - sign * 10}` +
						` Q${drop},${by} ${drop + 10},${by}` +
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
			// 没有 `title`：卡片就是页面关于一条路要说的一切，悬停时把消息再展开一遍会盖住树 ——
			// 而树正是页面存在的理由。
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
	 * 如果按下出口按钮，页面将移到的那条路；没有树、没有选中、或选中的就是正在读的那条路时为
	 * `undefined`。
	 *
	 * 按钮的标签、主色调、禁用状态和按下的行为都取决于这一个事实，所以它在这里推导一次，而不是
	 * 在它们各自那里再写一遍。
	 */
	private movingWay(): BranchWay | undefined {
		const tree = this.tree;
		const id = this.selected;
		if (tree === undefined || id === undefined || id === tree.currentId) return undefined;
		return findWay(tree, id);
	}

	/** 固定头部的那一行：缩放兜底，和唯一的出路。 */
	private paintTools(): void {
		const moving = this.movingWay();
		this.back.textContent =
			moving === undefined ? "回到对话" : moving.landing === "here" ? "从这里继续" : "切到这一条并回到对话";
		this.back.classList.toggle("primary", moving !== undefined);
		// 运行正在写按钮要移动的树，所以移动等它结束 —— 但只有*移动*等。「回到对话」是窗口更换
		// 显示的页面，永远允许，按钮说出它拒绝的是两者中的哪个，而不是看起来能按却毫无反应。每次
		// 绘制都重写它，所以运行的结束就是把它重新打开的东西。
		this.back.disabled = moving !== undefined && this.streaming;
		// 允许移动时刻意为空而不是缺失：一个不携带自己 `title` 的按钮，悬停时仍会显示上一次拒绝的
		// tooltip。
		this.back.title = this.back.disabled ? "这一轮还在写，等它结束再切" : "";
	}

	// --------------------------------------------------------------- 选中

	private select(id: string | undefined): void {
		if (id === undefined || id === this.selected) return;
		this.selected = id;
		this.paint();
	}

	/**
	 * 离开页面的唯一出路：应用选中的，或者只是回去。
	 *
	 * 运行检查只守**移动**。回到对话是本窗口更换显示的页面，没有运行能半途拦住这件事。
	 *
	 * 线上的卡片落在其问题产出的**回答**上，而不是问题本身 —— 对话回来时显示问题和它说的话，
	 * 下一个提示在回答之后派生新分支，那正是新问题该在的地方。还没有回答的路，和离开线的卡片，
	 * 落在自己的条目上。
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

	// ------------------------------------------------------------------ 地图

	/** 写层的唯一 transform —— 平移和缩放的全部。 */
	private applyTransform(): void {
		this.zoomLayer.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.zoom})`;
		this.zoomValue.textContent = `${Math.round(this.zoom * 100)}%`;
	}

	/**
	 * 缩放，保持指针下（或视口中心）的点钉在原处。
	 *
	 * 视口点下的图点是 `(px - x) / zoom`；缩放后它必须落在同一个像素上，所以平移量由它解出，而不是
	 * 微调。没有滚动盒、没有可夹住的内容尺寸：地图不需要。
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

	/** 装下整张图的缩放比例，宽和高都装下。 */
	private fitScale(): number {
		const laid = this.laid;
		if (laid === undefined) return 1;
		const byWidth = (this.viewport.clientWidth - PAD * 2) / laid.width;
		const byHeight = (this.viewport.clientHeight - PAD * 2) / laid.height;
		return Math.min(byWidth, byHeight);
	}

	/** 进入页面和按"适应"都落到这里：整张图，居中，绝不超过 100%。 */
	private homeZoom(): void {
		const laid = this.laid;
		if (laid === undefined) return;
		this.zoom = Math.min(1, this.fitScale());
		this.x = (this.viewport.clientWidth - laid.width * this.zoom) / 2;
		this.y = (this.viewport.clientHeight - laid.height * this.zoom) / 2;
		this.applyTransform();
	}
}

	// --------------------------------------------------------------------- 布局

	/**
	 * 卡片的高度与它所在的行，按样式表解析出的值。
	 *
	 * 每次绘制读取，理由与调色板相同：绘制很少发生，而字号滑块能在两次绘制之间同时移动两者。
	 */
interface CardMetrics {
	node: number;
	lane: number;
}

/**
 * 图的几何，从一次性元素量出，而不是从 token 解析。
 *
 * `--dsw-branch-node-h` 是一条 `calc()` 链，而**未注册**自定义属性的计算值就是留着 `calc()` 未求值
 * 的 token 流 —— `getComputedStyle(root).getPropertyValue()` 返回
 * `"calc(calc(13px + calc(22px - 15px)) * 18 / 13) + ..."`，`parseFloat` 读成 `NaN`。探针以该 token
 * 作为自己的高度，返回的就是布局给真实卡片的盒子 —— 必须挂载才能测量，所以放进视口再立刻取出。
 * 它在的期间由 `.branch-metric` 保持不可见、脱离文档流。
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
 * 放置卡片：线沿第 0 行走，每条消息一列，每次派生的备选项占据它离开的卡片下面的行。
 *
 * 只有一条规则 —— **`next` 保有行，`branches` 开新行** —— 正是它让正在读的路成为一条水平直线、
 * 其余挂在上面。备选项自己也带分支（没人读的路再往下的一次派生仍然是一次派生），所以遍历递归，
 * 那些分支落在自己卡片下面的行上，与任何其他路一样向右一列。
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

/** 卡片和头部条目都显示的短 id：条目 id 的前几个字符。 */
export function shortId(entryId: string): string {
	return entryId.slice(0, SHORT_ID);
}

/**
 * 行调色板，从 token 读出，让两种主题各自作答。
 * 每次绘制读取而不是缓存：绘制很少发生，且主题切换不该与缓存谈判。
 */
function laneColors(): string[] {
	const styles = getComputedStyle(document.documentElement);
	return [1, 2, 3, 4].map((lane) =>
		styles.getPropertyValue(`--dsw-lane-${lane}`).trim() || "currentColor",
	);
}
