// Branch-page smoke: drives the production `BranchView` against the shared DOM shim and pins the two
// things the page's geometry is supposed to be — **every card is the same fixed height on one line with
// the whole sentence in its tooltip**, and **that height comes from the tokens, not from a literal**.
//
// Why this file exists: ticket `.scratch/ui-pass/issues/02-branch-card-truncate.md`. The card used to
// be a two-line box whose hover state grew to `auto` and swapped a cut sentence for the whole one, so a
// long first message stretched a card, covered the row below and made the tree — which is the only
// reason the page exists — read as unreadable prose. Generalising that into a literal height is the
// next way to get it wrong: the window's font-size slider moves the type scale, and a card fixed at the
// default size clips its meta line at the top of the range. So the height and the lane are tokens
// (`tokens.css`) the paint reads back, and this file checks the whole chain.
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
import { FakeNode, installDom } from "./dom-shim.ts";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

installDom();

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
	const heights = [...new Set(cards.map((card) => String(card.style.height ?? "")))];
	const tops = [...new Set(cards.map((card) => Number(String(card.style.top).replace("px", ""))))].sort((a, b) => a - b);
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
	const view = new BranchView({ onSwitch: () => {}, onBack: () => {} });
	view.render(tree, false);
	view.enter();
	return cardsOf(view);
}

/** The cards one page is showing. */
function cardsOf(view: BranchView): FakeNode[] {
	return nodesOfClass(view.element as unknown as FakeNode, "gnode");
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

/** A way whose first sentence is long enough that no card can hold it on one line honestly. */
function way(entryId: string, label: string, turn: number, children: BranchWay[] = []): BranchWay {
	return { entryId, label, role: "user", turn, children };
}

/** A tree with a fork: one short label, one very long one, and a child hanging off the long one. */
function forkedTree(): BranchTree {
	const long = way("bbbbbbb2", LONG, 2, [way("ccccccc3", "换个说法再来一次", 3)]);
	return {
		rootLabel: "分支图卡片为什么会被撑高",
		ways: [way("aaaaaaa1", "先随便问一句", 1), long],
		currentId: "ccccccc3",
		points: 1,
		options: 3,
	};
}

/** A deep chain of one long sentence per way: the shape that used to make the tallest cards. */
function chainTree(depth: number): BranchTree {
	let current = way("way00000", LONG, depth);
	for (let level = depth - 1; level >= 1; level -= 1) {
		current = way(`way0000${level}`, LONG, level, [current]);
	}
	return { rootLabel: LONG, ways: [current], currentId: "way00000", points: 0, options: depth };
}

// ------------------------------------------------- 1. one height, one line, whole sentence on hover

process.stdout.write("\nbranch：任意长的消息，卡片同一高度且不换行\n");

{
	// The shim has no layout, so the two numbers below stand for the boxes the layout gives the graph's
	// probe element: the paint measures `--dsw-branch-node-h` and `--dsw-branch-lane-h` off a probe
	// rather than parsing them, because an unregistered `calc()` token reads back as its own token
	// stream. Part 2 checks the tokens; this part checks that whatever the probe answers is what lands.
	probeAt(46, 58);

	const cards = painted(forkedTree());
	check("每一条走法、连同根，各有一张卡片", cards.length === 4, `${cards.length} 张`);

	const solid = geometryOf(cards);
	check("所有卡片高度相同，且就是量到的高度", solid.heights.length === 1 && solid.heights[0] === "46px", solid.heights.join(" / "));

	// The lane the tokens describe, read off the paint: two cards on different rows have to clear each
	// other — a card that clips is the failure this whole ticket is about.
	const steps = solid.tops.slice(1).map((top, index) => top - solid.tops[index]!);
	check("行与行之间就是量到的行高", steps.every((step) => step === 58), steps.join(" / "));

	// The label is one line of ordinary text with `text-overflow: ellipsis` doing the cutting: the card
	// must not carry a second, hidden copy of the sentence that a hover can swap in.
	check("卡片里没有第二份整句（悬停展开的那份）", nodesOfClass(cards[0]!, "full").length === 0);
	check("卡片里没有截断用的短句节点", nodesOfClass(cards[0]!, "short").length === 0);
	const labels = cards.map((card) => nodesOfClass(card, "lbl"));
	check("每张卡片恰好有一行标签", labels.every((found) => found.length === 1), labels.map((found) => found.length).join(" / "));

	// Acceptance: hovering shows the whole sentence. That is the card's `title`, and it is the whole
	// label even when the card can only show a few characters of it.
	const titles = cards.map((card) => card.title);
	check("悬停看得到整句", titles.includes(LONG), titles.join(" / "));
	check("标签就是整句，截断交给 CSS", textOf(labels[1]![0]!) === LONG, textOf(labels[1]![0]!));
}

{
	// The font-size slider moves the type scale, which is exactly why these two are tokens: a card sized
	// for the default size clips its meta line at the top of the range. Same tree, taller probe boxes.
	probeAt(52, 64);

	const cards = painted(forkedTree());
	const grown = geometryOf(cards);
	check("字号变大：卡片跟着量到的高度长高", grown.heights.length === 1 && grown.heights[0] === "52px", grown.heights.join(" / "));
	const steps = grown.tops.slice(1).map((top, index) => top - grown.tops[index]!);
	check("字号变大：行高也跟着量到的行高", steps.every((step) => step === 64), steps.join(" / "));

	probeAt(46, 58);
}

{
	// The font-size setting is not a new tree, so `render`'s one comparison would skip the paint: the page
	// has to be told to measure again, and only while it is on screen — `enter` paints on the way in.
	// The font-size setting is not a new tree, so `render`'s one comparison would skip the paint: the page
	// has to be told to measure again, and only while it is on screen — `enter` paints on the way in.
	probeAt(46, 58);
	const view = new BranchView({ onSwitch: () => {}, onBack: () => {} });
	const cards = (): FakeNode[] => nodesOfClass(view.element as unknown as FakeNode, "gnode");
	view.render(forkedTree(), false);
	view.remeasure();
	check("没打开的页面不需要重量", cards().length === 0, `${cards().length} 张`);

	view.enter();
	check("打开时画一次", cards().length === 4, `${cards().length} 张`);
	check("这时量到的是旧字号下的高度", String(cards()[0]?.style.height) === "46px", String(cards()[0]?.style.height));

	// The font grew. The tree did not, so the page keeps the height it measured until it is told to
	// measure again — which is exactly the bug that made `remeasure` necessary.
	probeAt(52, 64);
	check("字号变了、还没重量，卡片还是旧高度", String(cards()[0]?.style.height) === "46px", String(cards()[0]?.style.height));
	view.remeasure();
	check("重量之后卡片是新高度", String(cards()[0]?.style.height) === "52px", String(cards()[0]?.style.height));

	probeAt(46, 58);
}

{
	probeAt(46, 58);
	const cards = painted(chainTree(6));
	check("六层长句的链：卡片数对", cards.length === 7, `${cards.length} 张`);
	check("六层长句的链：高度仍然只有一个", geometryOf(cards).heights.length === 1, geometryOf(cards).heights.join(" / "));
	const wrapping = cards.filter((card) => nodesOfClass(card, "full").length > 0);
	check("六层长句的链：没有一张带悬停展开", wrapping.length === 0, `${wrapping.length} 张`);
}

{
	// A stylesheet that never loaded leaves the probe without a box, and the honest answer is a graph the
	// browser says is nothing — not a card height guessed in TypeScript, which would be right only at the
	// default font size and would hide the fact that the tokens stopped resolving.
	probeAt(0, 0);
	const cards = painted(forkedTree());
	check("令牌量不到就照量到的画，不猜一个兜底高度", cards.length === 4 && cards.every((card) => String(card.style.height) === "0px"), cards.map((card) => String(card.style.height)).join(" / "));
	probeAt(46, 58);
}

// ------------------------------------------------------- 2. the stylesheet agrees with the paint

process.stdout.write("\nbranch：卡片几何来自令牌，悬停不再撑高\n");

{
	const nodeHeight = declared(css, ".gnode", "height");
	check("卡片高度读的是令牌，不是字面量", nodeHeight === "var(--dsw-branch-node-h)", String(nodeHeight));
	check("悬停只换颜色和阴影，不改高度", declared(css, ".gnode:hover", "height") === undefined, String(declared(css, ".gnode:hover", "height")));
	check("悬停也不再设 min-height", declared(css, ".gnode:hover", "min-height") === undefined, String(declared(css, ".gnode:hover", "min-height")));
	check("标签单行且溢出用省略号", declared(css, ".gnode .lbl", "white-space") === "nowrap" && declared(css, ".gnode .lbl", "text-overflow") === "ellipsis", `${declared(css, ".gnode .lbl", "white-space")} / ${declared(css, ".gnode .lbl", "text-overflow")}`);
	check("悬停不再把标签放成多行", declared(css, ".gnode:hover .lbl", "white-space") === undefined, String(declared(css, ".gnode:hover .lbl", "white-space")));

	// The tokens follow the type scale, so the slider moves the card instead of clipping it.
	const node = declared(tokens, ":root", "--dsw-branch-node-h") ?? "";
	const lane = declared(tokens, ":root", "--dsw-branch-lane-h") ?? "";
	check("卡片高度由字号阶梯派生", node.includes("--dsw-fs-delta") && node.includes("--dsw-lh-caption") && node.includes("--dsw-lh-meta"), node);
	check("行高由卡片高度派生", lane.includes("--dsw-branch-node-h"), lane);
	check("默认字号下卡片 46px、行高 58px", tokenPixels("--dsw-branch-node-h") === 46 && tokenPixels("--dsw-branch-lane-h") === 58, `${tokenPixels("--dsw-branch-node-h")} / ${tokenPixels("--dsw-branch-lane-h")}`);
	// The card has to hold its own two lines inside `box-sizing: border-box`: 18 + 2 + 16 + (4+4+1+1).
	check("卡片高度装得下两行加内边距和边框", tokenPixels("--dsw-branch-node-h") >= tokenPixels("--dsw-lh-meta") + tokenPixels("--dsw-lh-caption") + 2 + 10, String(tokenPixels("--dsw-branch-node-h")));
	// The top of the slider's range (22px) used to clip the meta line at a fixed height.
	const tallest = tokenPixels("--dsw-branch-node-h", 22);
	check("字号拉满时卡片跟着长高，行高仍然装得下它", tallest > 46 && tokenPixels("--dsw-branch-lane-h", 22) >= tallest + 12, `${tallest} / ${tokenPixels("--dsw-branch-lane-h", 22)}`);
}

// ------------------------------------------------- 3. entering the page centres the graph
//
// Ticket `.scratch/ui-pass/issues/03-branch-center.md`. The page used to scroll to (0, 0) on the way
// in, which pins the graph to the top-left corner of a viewport it may only fill a third of. Centring
// is two halves that must not fight: the graph **that overflows** is centred by the scroll position
// (`scrollHome`), and the graph **that fits** has no scroll range at all, so the stylesheet centres it.
// A shim has no layout and no cascade, so each half is pinned where it lives — the scroll arithmetic
// against measured sizes, the centring against the stylesheet's own declarations.

process.stdout.write("\nbranch：进入时整图居中\n");

/**
 * A page whose viewport measures `width × height`, the one thing a shim cannot work out for itself.
 *
 * The sizer's box needs no such help: it is `style.width` / `style.height`, which the shim reads back
 * the way a browser would (a real sizer gets its height from the SVG child inside it).
 */
function pageOf(tree: BranchTree, width: number, height: number): { view: BranchView; viewport: FakeNode; sizer: FakeNode } {
	const view = new BranchView({ onSwitch: () => {}, onBack: () => {} });
	const root = view.element as unknown as FakeNode;
	const viewport = root.querySelector(".graph-viewport");
	const sizer = root.querySelector(".graph-sizer");
	if (viewport === null || sizer === null) throw new Error("量具找不到 viewport 或 sizer");
	viewport.clientWidth = width;
	viewport.clientHeight = height;
	view.render(tree, false);
	view.enter();
	return { view, viewport, sizer };
}

/** The sizer's own size, measured the way the view measures it. */
function sizerSizeOf(sizer: FakeNode): { width: number; height: number } {
	return { width: sizer.clientWidth, height: sizer.clientHeight };
}

/** The scroll position `scrollHome` is supposed to have reached, clamped the way a scroll range is. */
function centreOf(sizer: FakeNode, width: number, height: number): { left: number; top: number } {
	const size = sizerSizeOf(sizer);
	return { left: Math.max(0, (size.width - width) / 2), top: Math.max(0, (size.height - height) / 2) };
}

{
	// A viewport too narrow for the graph: it is clamped at the zoom floor, so the sizer is the wider
	// of the two and the scroll position can park in the middle of the remainder. (What the two axes
	// hold can differ — at a normal zoom the sizer is only wider because the graph's own margins do not
	// shrink with it.)
	probeAt(44, 56);
	const { viewport, sizer } = pageOf(forkedTree(), 300, 300);
	const want = centreOf(sizer, 300, 300);
	check("图比视口大：居中位置是两个溢出量的一半", viewport.scrollLeft === want.left && viewport.scrollTop === want.top, `${viewport.scrollLeft}/${viewport.scrollTop} 想要 ${want.left}/${want.top}`);
	check("图比视口大：这个用例确实滚到了里面", want.left > 0, `${want.left} / ${sizer.clientWidth}`);
}

{
	// A graph that fits: there is no scroll range to centre with, so the midpoint formula clamps to
	// zero — that is, the graph's own margin is all the centring there is left to do.
	probeAt(44, 56);
	const { viewport, sizer } = pageOf(forkedTree(), 2000, 1200);
	const want = centreOf(sizer, 2000, 1200);
	check("图装得下：没有可滚的余量，滚动停在零", viewport.scrollLeft === 0 && viewport.scrollTop === 0, `${viewport.scrollLeft} / ${viewport.scrollTop}`);
	check("图装得下：零正是那条公式被夹到下限的结果，不是另写的一条路", want.left === 0 && want.top === 0, `${want.left} / ${want.top}`);

	// The floor under the arithmetic: with the sizer allowed below the viewport, the scroll position
	// and the graph's own coordinates could slide apart, and the left and top edges would go with them.
	check("sizer 不小于视口，滚动位置与图的坐标不会错位", declared(css, ".graph-sizer", "min-width") === "100%" && declared(css, ".graph-sizer", "min-height") === "100%", `${declared(css, ".graph-sizer", "min-width")} / ${declared(css, ".graph-sizer", "min-height")}`);
}

{
	// "适应" is the same landing as entering: it fits the graph to the viewport and centres it. Scrolled
	// off the centre first, so the assertion is about the button and not about where the page started.
	probeAt(44, 56);
	const { viewport, sizer, view } = pageOf(forkedTree(), 300, 300);
	viewport.scrollLeft = 0;
	viewport.scrollTop = 0;
	const fit = nodesOfClass(view.toolsBar as unknown as FakeNode, "zoom-button").find((button) => button.textContent === "适应");
	if (fit === undefined) throw new Error("量具找不到「适应」按钮");
	fit.dispatch("click");
	const want = centreOf(sizer, 300, 300);
	check("「适应」之后同样居中", viewport.scrollLeft === want.left && viewport.scrollTop === want.top, `${viewport.scrollLeft}/${viewport.scrollTop} 想要 ${want.left}/${want.top}`);
	check("「适应」的用例确实滚到了别处", want.left > 0, `${want.left} / ${sizer.clientWidth}`);
}

process.stdout.write(failures === 0 ? "\nbranch ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
