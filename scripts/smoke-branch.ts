// Branch-page smoke: drives the production `BranchView` against the shared DOM shim and pins the two
// things the page's geometry is supposed to be — **every card is the same fixed height on one line,
// with no hover of its own**, and **that height comes from the tokens, not from a literal**.
//
// Why this file exists: ticket `.scratch/ui-pass/issues/02-branch-card-truncate.md`. The card used to
// be a two-line box whose hover state grew to `auto` and swapped a cut sentence for the whole one, so a
// long first message stretched a card, covered the row below and made the tree — which is the only
// reason the page exists — read as unreadable prose. Generalising that into a literal height is the
// next way to get it wrong: the window's font-size slider moves the type scale, and a card fixed at the
// default size clips its meta line at the top of the range. So the height and the lane are tokens
// (`tokens.css`) the paint reads back, and this file checks the whole chain. The `title` that followed
// the first cut went the same way later: a tooltip big enough to say the whole message covered the tree
// it was drawn over, so a card now says one ellipsised line and nothing else.
//
// The shim has no layout and no CSS, so "same height" here means "the paint gave every card the height
// it read", not "a browser measured it": the token values are fed in through `styleMetrics`, and the
// tokens themselves are resolved from `tokens.css` as text.
//
// Run with: node scripts/smoke-branch.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BranchView } from "../packages/web/src/render/branch-view.ts";
import type { BranchTree, BranchWay } from "../packages/web/src/state.ts";
import { FakeElement, FakeNode, installDom } from "./dom-shim.ts";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

const dom = installDom();

/** How much further right the next message on the line sits, in pixels (`STEP_X` in the view). */
const STEP = 300;

// ------------------------------------------------------------------ reading the page

/** Every node of a class below `root`, in document order. */
function nodesOfClass(root: FakeNode, className: string): FakeNode[] {
	const found: FakeNode[] = [];
	const walk = (node: FakeNode): void => {
		if (node.className.split(/\s+/).includes(className)) found.push(node);
		for (const child of node.children) walk(child);
	};
	walk(root);
	return found;
}

/** The card's own lines, as text — what a screenshot of the card would read. */
function textOf(node: FakeNode): string {
	let text = "";
	const walk = (current: FakeNode): void => {
		if (current.children.length === 0) text += current.textContent;
		for (const child of current.children) walk(child);
	};
	walk(node);
	return text;
}

/** Every card's height and the distance between two rows, as the paint wrote them. */
function geometryOf(cards: FakeNode[]): { heights: string[]; tops: number[] } {
	const heights = [...new Set(cards.map((fakeNode) => String(fakeNode.style.height ?? "")))];
	const tops = [...new Set(cards.map((fakeNode) => Number(String(fakeNode.style.top).replace("px", ""))))].sort((a, b) => a - b);
	return { heights, tops };
}

/** What the next graph measures for the two branch tokens. */
let boxes = { node: 46, lane: 58 };

/**
 * Answer the graph's geometry probe with the box a browser would have given it.
 *
 * The tokens are `calc()` chains, and an unregistered custom property's computed value keeps its
 * `calc()` — which is why the production code measures a **box** rather than parsing the token string
 * (see `cardMetrics`). The shim has no layout, so this is that box: from here on, a `branch-metric`
 * element answers with what `probeAt` last said, and everything else answers as it always did. The first
 * cut of this file fed `parseFloat` a literal instead, which is precisely the read-back the real window
 * got wrong: production was fine here and broken there, and the shim said nothing.
 */
const answerProbe = ((): (() => void) => {
	const original = FakeNode.prototype.getBoundingClientRect;
	FakeNode.prototype.getBoundingClientRect = function (this: FakeNode) {
		if (this.className.split(/\s+/).includes("branch-metric")) {
			const measured = String(this.style.height ?? "").includes("node") ? boxes.node : boxes.lane;
			return { left: 0, right: 0, top: 0, bottom: measured, width: 0, height: measured };
		}
		return original.call(this);
	};
	return () => {
		FakeNode.prototype.getBoundingClientRect = original;
	};
})();

/** The card's height and its lane, as the layout's own answer to the two tokens. */
function probeAt(node: number, lane: number): void {
	boxes = { node, lane };
}

/** Build the page the way `main.ts` does, then show it, so the paint has run. */
function painted(tree: BranchTree): FakeNode[] {
	const branchView = new BranchView({ onSwitch: () => {}, onBack: () => {} });
	branchView.render(tree, false);
	branchView.enter();
	return cardsOf(branchView);
}

/** The cards one page is showing. */
function cardsOf(branchView: BranchView): FakeNode[] {
	return nodesOfClass(branchView.element as unknown as FakeNode, "gnode");
}

// ------------------------------------------------------------------ the stylesheets

const STYLE_PATH = fileURLToPath(new URL("../packages/web/src/style.css", import.meta.url));
const TOKENS_PATH = fileURLToPath(new URL("../packages/web/src/tokens.css", import.meta.url));

/** A flat stylesheet, split into `a, b { … }` rules: selector order is the cascade, so it is kept. */
function rulesOf(css: string): { selector: string; body: string }[] {
	const rules: { selector: string; body: string }[] = [];
	// Comments first: a rule written down in a comment is not a rule.
	const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const pattern = /([^{}]+)\{([^{}]*)\}/g;
	for (const match of bare.matchAll(pattern)) rules.push({ selector: match[1]!.trim(), body: match[2]! });
	return rules;
}

/**
 * The winning value of one declaration on one selector, cascade order included.
 *
 * `undefined` means no rule for that selector declares the property at all.
 */
function declared(css: string, selector: string, property: string): string | undefined {
	let value: string | undefined;
	for (const rule of rulesOf(css)) {
		const selectors = rule.selector.split(",").map((part) => part.trim());
		if (!selectors.includes(selector)) continue;
		for (const declaration of rule.body.split(";")) {
			const at = declaration.indexOf(":");
			if (at < 0) continue;
			if (declaration.slice(0, at).trim() !== property) continue;
			value = declaration.slice(at + 1).trim();
		}
	}
	return value;
}

const css = readFileSync(STYLE_PATH, "utf8");
const tokens = readFileSync(TOKENS_PATH, "utf8");

/**
 * Arithmetic for one `calc()` body: numbers, `+ - * /`, and parentheses.
 *
 * A shunting-yard would be the general answer; this stylesheet's token chain only ever nests a couple
 * of levels, so the expression is parsed straight into a small tree. `eval` would be shorter and is
 * exactly what a harness should not run on values read out of a stylesheet.
 */
function arithmetic(expression: string): number {
	let at = 0;
	const skip = (): void => {
		while (at < expression.length && /\s/.test(expression[at]!)) at += 1;
	};
	const product = (): number => {
		let value = atom();
		for (;;) {
			skip();
			const operator = expression[at];
			if (operator !== "*" && operator !== "/") return value;
			at += 1;
			const right = atom();
			value = operator === "*" ? value * right : value / right;
		}
	};
	const sum = (): number => {
		let value = product();
		for (;;) {
			skip();
			const operator = expression[at];
			if (operator !== "+" && operator !== "-") return value;
			at += 1;
			const right = product();
			value = operator === "+" ? value + right : value - right;
		}
	};
	const atom = (): number => {
		skip();
		if (expression[at] === "(") {
			at += 1;
			const value = sum();
			skip();
			if (expression[at] !== ")") throw new Error(`calc 少一个右括号：${expression}`);
			at += 1;
			return value;
		}
		if (expression[at] === "-") {
			at += 1;
			return -atom();
		}
		const start = at;
		while (at < expression.length && /[0-9.]/.test(expression[at]!)) at += 1;
		if (start === at) throw new Error(`calc 里读不懂的一段：${expression.slice(at)}`);
		return Number.parseFloat(expression.slice(start, at));
	};
	const value = sum();
	skip();
	if (at !== expression.length) throw new Error(`calc 里有没算完的部分：${expression.slice(at)}`);
	return value;
}

/**
 * A `--dsw-*` token's value in pixels, the way a browser would resolve it.
 *
 * Values in these stylesheets are `calc()` over a chain of other tokens, so this walks `var()`
 * references and folds the arithmetic — enough to answer "what height does the default font size
 * produce", which is the whole point of the checks below.
 */
function tokenPixels(name: string, fontBase = 15): number {
	const value = declared(tokens, ":root", name);
	if (value === undefined) throw new Error(`tokens.css 里没有 ${name}`);
	const substituted = value.replace(/var\(\s*(--[a-z0-9-]+)\s*\)/g, (_whole, inner: string) =>
		inner === "--dsw-fs-base" ? `${fontBase}` : `${tokenPixels(inner, fontBase)}`,
	);
	// The `calc(` wrapper goes first: stripping units with a blind `px` replace would eat it too.
	return arithmetic(substituted.replace(/calc\(([\s\S]*)\)/, "$1").replace(/(\d)px/g, "$1"));
}

// ------------------------------------------------------------------ the trees

const LONG = "把整个窗口的布局问题一次说清楚：从标题栏到输入框、从侧边栏到状态行，连同分支图卡片为什么会被撑高。";

/** One way on the page: a user message on the line, or a way that left it. */
function way(entryId: string, label: string, turn: number, landing: BranchWay["landing"] = "here"): BranchWay {
	return { entryId, label, turn, branches: [], landing };
}

/**
 * The shape a conversation without any fork draws: three questions in a row.
 *
 * This is the shape the page has to be worth opening for — `.scratch/branch-line-and-smoothness/
 * issues/04-branch-line.md`: with no branch points the page used to be blank, which is the one
 * conversation state where "where can I go back to" is the only question there is.
 */
function lineTree(): BranchTree {
	const first = way("aaaaaaa1", LONG, 1);
	const second = way("bbbbbbb2", "换个说法再来一次", 2);
	const third = way("ccccccc3", "最后一句", 3);
	first.next = second;
	second.next = third;
	return {
		trunk: first,
		currentId: "ccccccc3",
		points: 0,
		options: 1,
		line: new Set(["aaaaaaa1", "bbbbbbb2", "ccccccc3"]),
	};
}

/** The line plus one way that left it: a fork hangs below the card it left, on its own row. */
function forkedTree(): BranchTree {
	const first = way("aaaaaaa1", "先随便问一句", 1);
	const second = way("bbbbbbb2", LONG, 2);
	first.next = second;
	second.branches = [way("ddddddd4", "另一条走法", 3, "tip")];
	return {
		trunk: first,
		currentId: "bbbbbbb2",
		points: 1,
		options: 2,
		line: new Set(["aaaaaaa1", "bbbbbbb2"]),
	};
}

/**
 * The shape a conversation draws when its first question already has its answer: the first card's
 * `replyId` is the entry a rewind lands after. This is also the shape a rewind leaves — the leaf
 * parked on a question's answer — so it is the one a returning reader meets first.
 */
function singleTree(): BranchTree {
	const first = way("aaaaaaa1", LONG, 1);
	first.replyId = "eeeeeee5";
	const second = way("bbbbbbb2", "第二句", 2);
	first.next = second;
	return {
		trunk: first,
		currentId: "bbbbbbb2",
		points: 0,
		options: 1,
		line: new Set(["aaaaaaa1", "bbbbbbb2"]),
	};
}

/** A card's `left` / `top`, as the paint wrote them. */
function placeOf(fakeNode: FakeNode): { left: number; top: number } {
	return {
		left: Number(String(fakeNode.style.left ?? "").replace("px", "")),
		top: Number(String(fakeNode.style.top ?? "").replace("px", "")),
	};
}

/** The page's one graph element, found by tag: `setAttribute("class")` is not `className` on the shim. */
function svgOf(branchView: BranchView): FakeNode {
	let found: FakeNode | undefined;
	const walk = (node: FakeNode): void => {
		if (node.tagName === "SVG") found = node;
		for (const child of node.children) walk(child);
	};
	walk(branchView.element as unknown as FakeNode);
	if (found === undefined) throw new Error("量具找不到那张 svg");
	return found;
}

/** The layer's transform, read back the way the browser receives it. */
function transformOf(branchView: BranchView): { x: number; y: number; zoom: number } {
	const fakeNode = nodesOfClass(branchView.element as unknown as FakeNode, "graph-zoom")[0];
	if (fakeNode === undefined) throw new Error("量具找不到 .graph-zoom");
	const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(String(fakeNode.style.transform ?? ""));
	if (match === null) throw new Error(`transform 读不懂：${String(fakeNode.style.transform)}`);
	return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

// -------------------------------------------- 1. one card per message, one row per way

process.stdout.write("\nbranch：一条线一张卡，走法各占一行\n");

{
	// The shim has no layout, so the two numbers below stand for the boxes the layout gives the graph's
	// probe element: the paint measures `--dsw-branch-node-h` and `--dsw-branch-lane-h` off a probe
	// rather than parsing them, because an unregistered `calc()` token reads back as its own token
	// stream. Part 2 checks the tokens; this part checks that whatever the probe answers is what lands.
	probeAt(46, 58);

	const cards = painted(lineTree());
	check("没有分支也画：三条消息三张卡", cards.length === 3, `${cards.length} 张`);
	check("所有卡片高度相同，且就是量到的高度", new Set(cards.map((fakeNode) => String(fakeNode.style.height))).size === 1 && String(cards[0]?.style.height) === "46px", cards.map((fakeNode) => String(fakeNode.style.height)).join(" / "));

	const places = cards.map(placeOf);
	check("一条线在同一行上", new Set(places.map((place) => place.top)).size === 1, places.map((place) => place.top).join(" / "));
	check("一条线每隔一格往右一格", places.every((place, at) => at === 0 || place.left - places[at - 1]!.left === STEP), places.map((place) => place.left).join(" / "));

	const labels = cards.map((fakeNode) => nodesOfClass(fakeNode, "lbl"));
	check("每张卡片恰好有一行标签", labels.every((found) => found.length === 1), labels.map((found) => found.length).join(" / "));
	check("标签就是整句，截断交给 CSS", textOf(labels[0]![0]!) === LONG, textOf(labels[0]![0]!));
	check("悬停什么都不弹：卡片没有 title", cards.every((fakeNode) => fakeNode.title === undefined || fakeNode.title === ""), String(cards[0]?.title));
	check("最新的一条戴着「当前」", nodesOfClass(cards[2]!, "tag").some((fakeNode) => fakeNode.textContent === "当前"));
}

{
	const cards = painted(forkedTree());
	check("有分支时：线两张卡加一条走法", cards.length === 3, `${cards.length} 张`);

	const byId = new Map(cards.map((fakeNode) => [fakeNode.dataset.id, fakeNode]));
	const host = byId.get("bbbbbbb2")!;
	const branch = byId.get("ddddddd4")!;
	check("走法挂在线下面一行", placeOf(branch).top - placeOf(host).top === 58, String(placeOf(branch).top - placeOf(host).top));
	check("走法比它离开的那一条往右一格", placeOf(branch).left - placeOf(host).left === STEP, String(placeOf(branch).left - placeOf(host).left));
	check("走法不进「这条线」", !branch.attributes.has("data-on-path"));
	check("线上的卡进「这条线」", host.attributes.has("data-on-path"));
}

{
	// A fork **below** a way nobody is reading. The card that left the line carries alternatives of its
	// own, and they hang off it exactly like a line card's do — one column right, a row further down.
	// This is the shape a rewind to the first question leaves standing, and the one the page used to
	// lose: a tree that only reported forks on the chain dropped everything below the leaf.
	const first = way("aaaaaaa1", "先随便问一句", 1);
	const second = way("bbbbbbb2", "第二条", 2);
	first.next = second;
	const left = way("ddddddd4", "另一条走法", 2, "tip");
	left.branches = [way("fffffff6", "那一支下面的另一个问法", 3, "tip")];
	second.branches = [left];
	const cards = painted({
		trunk: first,
		currentId: "bbbbbbb2",
		points: 2,
		options: 3,
		line: new Set(["aaaaaaa1", "bbbbbbb2"]),
	});
	const byId = new Map(cards.map((fakeNode) => [fakeNode.dataset.id, fakeNode]));
	check("线上线外一共四张卡", cards.length === 4, `${cards.length} 张`);
	const leftCard = byId.get("ddddddd4");
	const deep = byId.get("fffffff6");
	const stepRight = (from: FakeNode | undefined, to: FakeNode | undefined) =>
		from === undefined || to === undefined ? "没有那张卡" : String(placeOf(to).left - placeOf(from).left);
	check("走法自己的岔也往右一格", leftCard !== undefined && deep !== undefined && placeOf(deep).left - placeOf(leftCard).left === STEP, stepRight(leftCard, deep));
	check("走法自己的岔自己占一行", leftCard !== undefined && deep !== undefined && placeOf(deep).top - placeOf(leftCard).top === 58, leftCard === undefined || deep === undefined ? "没有那张卡" : String(placeOf(deep).top - placeOf(leftCard).top));
	check("线外的岔不算「这条线」", deep !== undefined && !deep.attributes.has("data-on-path"));
}

{
	// Only the first question exists — the newest conversation, or the leaf parked on an answer. The
	// line is still drawn: one card per question, and nothing else on the page.
	probeAt(46, 58);
	const cards = painted(singleTree());
	check("只有第一句也画：一张卡在线上", cards.length === 2 && cards[0]?.dataset.id === "aaaaaaa1" && textOf(nodesOfClass(cards[0]!, "lbl")[0]!) === LONG, `${cards.length} 张`);
}

{
	// A stylesheet that never loaded leaves the probe without a box, and the honest answer is a graph the
	// browser says is nothing — not a card height guessed in TypeScript, which would be right only at the
	// default font size and would hide the fact that the tokens stopped resolving.
	probeAt(0, 0);
	const cards = painted(forkedTree());
	check("令牌量不到就照量到的画，不猜一个兜底高度", cards.length === 3 && cards.every((fakeNode) => String(fakeNode.style.height) === "0px"), cards.map((fakeNode) => String(fakeNode.style.height)).join(" / "));
	probeAt(46, 58);
}

// ------------------------------------------------ 2. the stylesheet agrees with the paint

process.stdout.write("\nbranch：卡片几何来自令牌，画布不再靠滚动\n");

{
	const nodeHeight = declared(css, ".gnode", "height");
	check("卡片高度读的是令牌，不是字面量", nodeHeight === "var(--dsw-branch-node-h)", String(nodeHeight));
	check("悬停只换颜色和阴影，不改高度", declared(css, ".gnode:hover", "height") === undefined, String(declared(css, ".gnode:hover", "height")));
	check("标签单行且溢出用省略号", declared(css, ".gnode .lbl", "white-space") === "nowrap" && declared(css, ".gnode .lbl", "text-overflow") === "ellipsis", `${declared(css, ".gnode .lbl", "white-space")} / ${declared(css, ".gnode .lbl", "text-overflow")}`);

	// The canvas is a map, not a scroll box: the viewport never scrolls, and the layer carries the pan and
	// the zoom as one transform. A `scrollLeft` pan had no range at all once the graph fitted the window,
	// which is the state `enter` puts it in — that is why dragging did nothing.
	check("画布不滚动", declared(css, ".graph-viewport", "overflow") === "hidden", String(declared(css, ".graph-viewport", "overflow")));
	check("缩放以左上角为原点（平移与缩放同一套坐标）", declared(css, ".graph-zoom", "transform-origin") === "0 0", String(declared(css, ".graph-zoom", "transform-origin")));
	check("画布上的元素不再被浏览器面板接管手势", declared(css, ".graph-viewport", "user-select") === "none", String(declared(css, ".graph-viewport", "user-select")));

	// The tokens follow the type scale, so the slider moves the card instead of clipping it.
	const node = declared(tokens, ":root", "--dsw-branch-node-h") ?? "";
	const lane = declared(tokens, ":root", "--dsw-branch-lane-h") ?? "";
	check("卡片高度由字号阶梯派生", node.includes("--dsw-fs-delta") && node.includes("--dsw-lh-caption") && node.includes("--dsw-lh-meta"), node);
	check("行高由卡片高度派生", lane.includes("--dsw-branch-node-h"), lane);
	check("默认字号下卡片 46px、行高 58px", tokenPixels("--dsw-branch-node-h") === 46 && tokenPixels("--dsw-branch-lane-h") === 58, `${tokenPixels("--dsw-branch-node-h")} / ${tokenPixels("--dsw-branch-lane-h")}`);
	// The card has to hold its own two lines inside `box-sizing: border-box`: 18 + 2 + 16 + (4+4+1+1).
	check("卡片高度装得下两行加内边距和边框", tokenPixels("--dsw-branch-node-h") >= tokenPixels("--dsw-lh-meta") + tokenPixels("--dsw-lh-caption") + 2 + 10, String(tokenPixels("--dsw-branch-node-h")));
	const tallest = tokenPixels("--dsw-branch-node-h", 22);
	check("字号拉满时卡片跟着长高，行高仍然装得下它", tallest > 46 && tokenPixels("--dsw-branch-lane-h", 22) >= tallest + 12, `${tallest} / ${tokenPixels("--dsw-branch-lane-h", 22)}`);
}

// ------------------------------------------------- 3. the map: fits, centres, drags, zooms

process.stdout.write("\nbranch：进入时整图居中，画布能拖能缩\n");

/** A page whose viewport measures `width × height` — the one thing a shim cannot work out for itself. */
function pageOf(tree: BranchTree, width: number, height: number): { branchView: BranchView; fakeNode: FakeNode } {
	const branchView = new BranchView({ onSwitch: () => {}, onBack: () => {} });
	const fakeNode = (branchView.element as unknown as FakeNode).querySelector(".graph-viewport");
	if (fakeNode === null) throw new Error("量具找不到 viewport");
	fakeNode.clientWidth = width;
	fakeNode.clientHeight = height;
	branchView.render(tree, false);
	branchView.enter();
	return { branchView, fakeNode };
}

/** How far the graph sits from the viewport's two edges, in viewport pixels. */
function marginsOf(branchView: BranchView, width: number, height: number): { left: number; right: number; top: number; bottom: number } {
	const fakeNode = svgOf(branchView);
	const { x, y, zoom } = transformOf(branchView);
	const scaledW = Number(fakeNode.getAttribute("width")) * zoom;
	const scaledH = Number(fakeNode.getAttribute("height")) * zoom;
	return { left: x, right: width - (x + scaledW), top: y, bottom: height - (y + scaledH) };
}

{
	probeAt(46, 58);
	const { branchView } = pageOf(forkedTree(), 2000, 1200);
	const margins = marginsOf(branchView, 2000, 1200);
	check("装得下：左右留白相等", Math.abs(margins.left - margins.right) < 0.5, `${margins.left} / ${margins.right}`);
	check("装得下：上下留白相等", Math.abs(margins.top - margins.bottom) < 0.5, `${margins.top} / ${margins.bottom}`);
	check("装得下时不放大过 100%", transformOf(branchView).zoom <= 1, String(transformOf(branchView).zoom));
	check("居中是真的留了白", margins.left > 0 && margins.top > 0, `${margins.left} / ${margins.top}`);
}

{
	// Too narrow for the graph: it still centres, and the overflow is simply outside the clip — no scroll
	// range, no clamping, and therefore nothing for a pan to run out of.
	probeAt(44, 56);
	const { branchView } = pageOf(forkedTree(), 300, 300);
	const margins = marginsOf(branchView, 300, 300);
	check("装不下也居中（两侧留白相等，可以是负的）", Math.abs(margins.left - margins.right) < 0.5, `${margins.left} / ${margins.right}`);
}

{
	// Dragging is a translate that follows the pointer, and it works whether or not the graph is bigger
	// than the window — the case that used to be impossible.
	probeAt(46, 58);
	const { branchView, fakeNode } = pageOf(forkedTree(), 2000, 1200);
	const before = transformOf(branchView);
	fakeNode.dispatch("pointerdown", { button: 0, clientX: 100, clientY: 100 });
	fakeNode.dispatch("pointermove", { clientX: 160, clientY: 130 });
	const moved = transformOf(branchView);
	check("按住左键拖：画布跟着走", moved.x - before.x === 60 && moved.y - before.y === 30, `${moved.x - before.x} / ${moved.y - before.y}`);
	check("拖动画布不动缩放", moved.zoom === before.zoom, `${moved.zoom} / ${before.zoom}`);
	dom.window.dispatch("pointerup", { target: null, clientX: 160, clientY: 130 });

	fakeNode.dispatch("pointerdown", { button: 0, clientX: 100, clientY: 100 });
	fakeNode.dispatch("pointermove", { clientX: 101, clientY: 101 });
	check("不到 4px 算「按一下」，不算拖", transformOf(branchView).x === moved.x, String(transformOf(branchView).x - moved.x));
	dom.window.dispatch("pointerup", { target: null, clientX: 101, clientY: 101 });
}

{
	// The wheel is the other hand: bare wheel pans, Ctrl+wheel zooms, and the point under the pointer is
	// the one that stays put.
	probeAt(46, 58);
	const { branchView, fakeNode } = pageOf(forkedTree(), 2000, 1200);
	const before = transformOf(branchView);
	fakeNode.dispatch("wheel", { deltaX: 0, deltaY: 40, ctrlKey: false, metaKey: false, clientX: 500, clientY: 400, preventDefault() {} });
	const panned = transformOf(branchView);
	check("滚轮平移：内容跟着滚动方向走", panned.y - before.y === -40, String(panned.y - before.y));

	// The graph point under (500, 400) before the zoom has to be under it after.
	const px = 500;
	const py = 400;
	const graphX = (px - panned.x) / panned.zoom;
	const anchorY = (py - panned.y) / panned.zoom;
	fakeNode.dispatch("wheel", { deltaX: 0, deltaY: -40, ctrlKey: true, metaKey: false, clientX: px, clientY: py, preventDefault() {} });
	const zoomed = transformOf(branchView);
	check("Ctrl+滚轮：放大", zoomed.zoom > panned.zoom, `${zoomed.zoom} / ${panned.zoom}`);
	check("放大时指针下那一点不动", Math.abs((px - zoomed.x) / zoomed.zoom - graphX) < 0.001 && Math.abs((py - zoomed.y) / zoomed.zoom - anchorY) < 0.001, `${(px - zoomed.x) / zoomed.zoom} vs ${graphX}`);
}

{
	// "适应" is the same landing as entering: fit, centre, and no bigger than 100%.
	probeAt(46, 58);
	const { branchView, fakeNode } = pageOf(forkedTree(), 2000, 1200);
	fakeNode.dispatch("pointerdown", { button: 0, clientX: 100, clientY: 100 });
	fakeNode.dispatch("pointermove", { clientX: 700, clientY: 500 });
	dom.window.dispatch("pointerup", { target: null, clientX: 700, clientY: 500 });
	const moved = transformOf(branchView);
	const fit = nodesOfClass(branchView.toolsBar as unknown as FakeNode, "zoom-button").find((fakeNode) => fakeNode.textContent === "适应");
	if (fit === undefined) throw new Error("量具找不到「适应」按钮");
	fit.dispatch("click");
	const home = transformOf(branchView);
	check("「适应」把画布拉回居中", home.x !== moved.x && home.y !== moved.y, `${home.x} / ${moved.x}`);
	const margins = marginsOf(branchView, 2000, 1200);
	check("「适应」之后左右留白相等", Math.abs(margins.left - margins.right) < 0.5, `${margins.left} / ${margins.right}`);
}

// ------------------------------------------------- 4. the two ways out of the page

process.stdout.write("\nbranch：两个出口按钮，两种落地\n");

/**
 * The card a window-level `pointerup` names.
 *
 * `branch-view.ts` refuses any target that is not `instanceof Element`, and the shim's nodes are
 * `FakeNode`s, so the release is handed a proxy that is really a `FakeElement` and answers everything
 * else with the card's own values. A harness that passed the card over bare would be testing a path the
 * browser never takes.
 */
function cardTarget(card: FakeNode): FakeNode {
	return new Proxy(Object.create(FakeElement.prototype) as FakeNode, {
		get: (_target, key) => Reflect.get(card as object, key),
		has: (_target, key) => Reflect.has(card as object, key),
	});
}

/** Press a card the way a browser does: the press on the viewport, the release on the window. */
function clickCard(root: FakeNode, id: string): void {
	const viewport = root.querySelector(".graph-viewport");
	if (viewport === null) throw new Error("量具找不到 viewport");
	viewport.dispatch("pointerdown", { button: 0, clientX: 10, clientY: 10 });
	const cards = nodesOfClass(root, "gnode");
	const card = cards.find((node) => node.dataset.id === id);
	if (card === undefined) throw new Error(`量具找不到节点 ${id}（有 ${cards.map((node) => node.dataset.id).join("|")}）`);
	dom.window.dispatch("pointerup", { target: cardTarget(card), clientX: 10, clientY: 10 });
}

/** The page's one exit button. */
function backButtonOf(branchView: BranchView): FakeNode | undefined {
	return nodesOfClass(branchView.toolsBar as unknown as FakeNode, "back-button")[0];
}

interface ExitRun {
	branchView: BranchView;
	switched: { entryId: string; landing: string }[];
	backs: number;
}

/** Show a page, optionally press a card on it, then press the exit button once and report what it did. */
function pressExit(tree: BranchTree, options: { select?: string; streaming?: boolean } = {}): ExitRun {
	probeAt(46, 58);
	const switched: { entryId: string; landing: string }[] = [];
	let backs = 0;
	const branchView = new BranchView({
		onSwitch: (entryId, landing) => switched.push({ entryId, landing }),
		onBack: () => {
			backs += 1;
		},
	});
	branchView.render(tree, options.streaming ?? false);
	branchView.enter();
	if (options.select !== undefined) clickCard(branchView.element as unknown as FakeNode, options.select);
	backButtonOf(branchView)?.dispatch("click");
	return { branchView, switched, backs };
}

{
	// The gesture the page exists for: pick an earlier question on the line, go back, and the next prompt
	// starts a second way from it. So the landing is `here` — rewind, not "follow this way".
	const run = pressExit(lineTree(), { select: "aaaaaaa1" });
	check("选中线上一张卡：按钮说「从这里继续」", backButtonOf(run.branchView)?.textContent === "从这里继续", String(backButtonOf(run.branchView)?.textContent));
	check("按下之后落地是「回到这一句」", run.switched.length === 1 && run.switched[0]!.landing === "here" && run.switched[0]!.entryId === "aaaaaaa1", JSON.stringify(run.switched));
	check("移动的那一次不会再回一趟对话", run.backs === 0, `${run.backs}`);
}

{
	// A question that already has its answer lands **after the answer**: the conversation comes back
	// showing the question and what it said, and the next prompt forks there — where a new question
	// belongs. Landing on the question itself would hide the very reply the card stands for.
	const run = pressExit(singleTree(), { select: "aaaaaaa1" });
	check("有回答的一句：落地落在回答之后", run.switched.length === 1 && run.switched[0]!.entryId === "eeeeeee5" && run.switched[0]!.landing === "here", JSON.stringify(run.switched));
}

{
	// A card that left the line means "take me there": the way below it already has work in it.
	const run = pressExit(forkedTree(), { select: "ddddddd4" });
	check("选中一条走法：按钮说「切到这一条」", backButtonOf(run.branchView)?.textContent === "切到这一条并回到对话", String(backButtonOf(run.branchView)?.textContent));
	check("按下之后落地是「跟到它的尽头」", run.switched.length === 1 && run.switched[0]!.landing === "tip", JSON.stringify(run.switched));
}

{
	// Nothing but the way being read is selected: the button is the plain way out.
	const run = pressExit(lineTree(), { select: "ccccccc3" });
	check("选中当前那一句：按钮只是「回到对话」", backButtonOf(run.branchView)?.textContent === "回到对话", String(backButtonOf(run.branchView)?.textContent));
	check("这一按没有移动会话", run.switched.length === 0, JSON.stringify(run.switched));
	check("这一按回到了对话", run.backs === 1, `${run.backs}`);
}

{
	// A run is writing to the tree the button would move, so the move waits — but only the move. The way
	// out is the window swapping pages and is never refused.
	const move = pressExit(lineTree(), { select: "aaaaaaa1", streaming: true });
	check("运行中：移动被拒", move.switched.length === 0, JSON.stringify(move.switched));
	check("运行中：按钮说自己被拒了", String(backButtonOf(move.branchView)?.title).length > 0, String(backButtonOf(move.branchView)?.title));

	// But the door out is never refused: with nothing selected the button is "回到对话", which is this
	// window changing which page it shows — no run can be in the middle of that.
	const out = pressExit(lineTree(), { streaming: true });
	check("运行中：没有选中时，「回到对话」照样可以", out.backs === 1, `${out.backs}`);
}

process.stdout.write(failures === 0 ? "\nbranch ok\n" : `\nbranch：${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
