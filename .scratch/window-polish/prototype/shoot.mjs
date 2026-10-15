// 出图 + 交互核对：把原型页在本机缓存的 Chromium 里打开，逐条把交互跑一遍并截图（不依赖服务器）。
//   node .scratch/window-polish/prototype/shoot.mjs
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { chromium } = createRequire(import.meta.url)(
	"C:/Users/a1368/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js",
);

const here = dirname(fileURLToPath(import.meta.url));
const out = (name) => join(here, "..", "research", name);
const executablePath = "C:/Users/a1368/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath, headless: true });
const say = (line) => process.stdout.write(`${line}\n`);

/** Open one prototype page, optionally flip the theme or a view, and shoot it. */
async function shoot(file, name, opts = {}) {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
	await page.goto(pathToFileURL(join(here, file)).href);
	if (opts.light) await page.click("#theme-toggle");
	if (opts.view) await page.click(`.seg button[data-view="${opts.view}"]`);
	await page.waitForTimeout(450);
	await page.screenshot({ path: out(name) });
	say(`${name}${errors.length === 0 ? "  ok" : "  ERRORS: " + errors.join(" | ")}`);
	await page.close();
}

await shoot("index.html", "shot-window-dark.png");
await shoot("index.html", "shot-window-light.png", { light: true });
await shoot("index.html", "shot-sidebar.png", { view: "sidebar" });
await shoot("index.html", "shot-conv.png", { view: "conv" });
await shoot("index.html", "shot-branch-graph.png", { view: "branch" });
await shoot("index.html", "shot-branch-light.png", { view: "branch", light: true });
await shoot("typography.html", "shot-typography-dark.png");
await shoot("typography.html", "shot-typography-light.png", { light: true });

// 交互：顶部固定、树的方向、缩放、选中→回到对话、右键改名、右键 fork、两个把手。
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(pathToFileURL(join(here, "index.html")).href);
await page.waitForTimeout(350);

/* ---- 1. 会话顶部是整列的一条固定头：最上面是标题，推阅读列把手不许动 ---- */
const readVar = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--reading-w").trim());
say(`会话标题：${(await page.textContent("#conv-title")).trim()}｜入口：${(await page.textContent("#branch-chip")).replace(/\s+/g, " ").trim()}｜还有没有页签：${(await page.locator(".tabs").count()) === 0 ? "没有（对）" : "还在（错）"}`);
const headBefore = await page.locator(".conv-head").boundingBox();
const titleBefore = await page.locator("#conv-title").boundingBox();
const chipBefore = await page.locator("#branch-chip").boundingBox();
const colWidth = (await page.locator("#main-col").boundingBox()).width;
const w0 = await readVar();
say(`正文列默认：宽 ${parseInt(w0, 10)}px，会话列 ${Math.round(colWidth)}px，两侧各留 ${Math.round((colWidth - parseInt(w0, 10)) / 2)}px（应 ≈35）`);
const h = await page.locator("#reading-handle").boundingBox();
await page.mouse.move(h.x + 8, h.y + 380);
await page.mouse.down();
await page.mouse.move(h.x + 108, h.y + 380, { steps: 8 });
await page.mouse.up();
const headAfter = await page.locator(".conv-head").boundingBox();
const titleAfter = await page.locator("#conv-title").boundingBox();
const chipAfter = await page.locator("#branch-chip").boundingBox();
say(`阅读列把手往右推：${w0} -> ${await readVar()}（应收窄）`);
say(`顶部固定：标题 x ${Math.round(titleBefore.x)} -> ${Math.round(titleAfter.x)}、入口 x ${Math.round(chipBefore.x)} -> ${Math.round(chipAfter.x)}（都应不变）、头部宽 ${Math.round(headBefore.width)} -> ${Math.round(headAfter.width)}（会话列宽 ${Math.round(colWidth)}）`);

/* ---- 1b. 往左拖：正文列一直顶到"列宽 - 40"那条上限 ---- */
const wBeforeWide = parseInt(await readVar(), 10);
const h2 = await page.locator("#reading-handle").boundingBox();
await page.mouse.move(h2.x + 8, h2.y + 380);
await page.mouse.down();
await page.mouse.move(h2.x + 8 - 160, h2.y + 380, { steps: 10 });
await page.mouse.up();
const wide = parseInt(await readVar(), 10);
say(`再往左拖 160px：${wBeforeWide} -> ${wide}px（应顶到上限 ${Math.round(colWidth) - 40}px）；此时两侧各留 ${Math.round((colWidth - wide) / 2)}px`);

/* ---- 2. 从右上角那个入口进分支页：树是横着长的，根在最左，主干是最上面那条直线 ---- */
await page.click("#branch-chip");
await page.waitForTimeout(350);
const composer = await page.evaluate(() => {
	const wrap = document.querySelector(".composer-wrap");
	return { shown: getComputedStyle(wrap).display !== "none", visible: wrap.getBoundingClientRect().height > 0 };
});
say(`分支页里的输入框：display 还在 = ${composer.shown}（应为 false）`);
const shape = await page.evaluate(() => {
	const box = (id) => {
		const el = document.querySelector(`.gnode[data-id="${id}"]`);
		const r = el.getBoundingClientRect();
		return { id: id, x: Math.round(r.left), y: Math.round(r.top) };
	};
	return {
		nodes: [...document.querySelectorAll(".gnode")].length,
		paths: document.querySelectorAll(".graph-svg path").length,
		dots: document.querySelectorAll(".graph-svg circle").length,
		boxes: ["root", "v0", "v0b", "v1", "v2"].map(box),
		zoom: document.querySelector("#zoom-val").textContent,
		text: document.getElementById("branch-sum").textContent.replace(/\s+/g, " ").trim(),
	};
});
const byId = Object.fromEntries(shape.boxes.map((b) => [b.id, b]));
say(`分支视图：${shape.nodes} 个节点 / ${shape.paths} 条连线 / ${shape.dots} 个圆点｜缩放 ${shape.zoom}`);
say(`树的方向（x 应递增）：root ${byId.root.x} < v0 ${byId.v0.x} < v0b ${byId.v0b.x}；兄弟在同一列：v1 ${byId.v1.x} = v2 ${byId.v2.x}；主干水平：root.y ${byId.root.y} = v1.y ${byId.v1.y}`);
say(`摘要：${shape.text}`);
await page.screenshot({ path: out("shot-branch-graph.png") });

/* ---- 3. 一个节点平时只显示一小段话，悬停才展开完整的那句 ---- */
const vp = await page.locator("#graph-viewport").boundingBox();
const readCard = () =>
	page.evaluate(() => {
		const card = document.querySelector('.gnode[data-id="v2"]');
		const box = card.getBoundingClientRect();
		const lit = (sel) => getComputedStyle(card.querySelector(sel)).display !== "none";
		return {
			height: Math.round(box.height),
			short: lit(".lbl .short"),
			full: lit(".lbl .full"),
			text: card.querySelector(".lbl").innerText.replace(/\s+/g, " ").trim(),
		};
	});
const cardBox = await page.locator('.gnode[data-id="v2"]').boundingBox();
const cardRest = await readCard();
say(`节点卡默认：高 ${cardRest.height}px，短句在显 = ${cardRest.short}、整句在显 = ${cardRest.full}｜「${cardRest.text}」`);
await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
await page.waitForTimeout(250);
const cardHover = await readCard();
say(`悬停之后：高 ${cardRest.height} -> ${cardHover.height}px，短句在显 = ${cardHover.short}、整句在显 = ${cardHover.full}｜「${cardHover.text}」`);
await page.screenshot({ path: out("shot-branch-hover.png") });
await page.mouse.move(vp.x + 20, vp.y + vp.height - 20);
await page.waitForTimeout(200);

/* ---- 4. Ctrl+滚轮缩放（按指针锚定），按钮也还在 ---- */
const sizer0 = await page.evaluate(() => document.getElementById("graph-sizer").getBoundingClientRect().width);
await page.mouse.move(vp.x + 320, vp.y + 180);
await page.keyboard.down("Control");
await page.mouse.wheel(0, -120);
await page.mouse.wheel(0, -120);
await page.mouse.wheel(0, -120);
await page.keyboard.up("Control");
await page.waitForTimeout(200);
const zoomed = await page.evaluate(() => ({
	zoom: document.querySelector("#zoom-val").textContent,
	width: Math.round(document.getElementById("graph-sizer").getBoundingClientRect().width),
	scrollLeft: Math.round(document.getElementById("graph-viewport").scrollLeft),
	scrollWidth: Math.round(document.getElementById("graph-viewport").scrollWidth),
}));
say(`Ctrl+滚轮放大三格：${shape.zoom} -> ${zoomed.zoom}（sizer ${Math.round(sizer0)} -> ${zoomed.width}，可滚范围 ${zoomed.scrollWidth}）`);
await page.screenshot({ path: out("shot-branch-zoom.png") });

/* ---- 5. 按住左键拖动画布：压在节点上也拖得动，而且不算"点选" ---- */
const before = await page.evaluate(() => ({
	left: Math.round(document.getElementById("graph-viewport").scrollLeft),
	selected: document.querySelector(".gnode[data-selected]").dataset.id,
}));
const v1Box = await page.locator('.gnode[data-id="v2"]').boundingBox();
await page.mouse.move(v1Box.x + 40, v1Box.y + 10);
await page.mouse.down();
await page.mouse.move(v1Box.x + 40 - 220, v1Box.y + 140, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(200);
const after = await page.evaluate(() => ({
	left: Math.round(document.getElementById("graph-viewport").scrollLeft),
	selected: document.querySelector(".gnode[data-selected]").dataset.id,
}));
say(`按住左键从节点上拖 220px：scrollLeft ${before.left} -> ${after.left}（应变大，即画面往左走）｜选中项 ${before.selected} -> ${after.selected}（拖动不该改选中）`);

await page.click("#zoom-fit");
const fitted = await page.evaluate(() => ({
	zoom: document.querySelector("#zoom-val").textContent,
	width: Math.round(document.getElementById("graph-sizer").getBoundingClientRect().width),
	viewport: Math.round(document.getElementById("graph-viewport").clientWidth),
}));
say(`「适应」：缩放 ${fitted.zoom}，图宽 ${fitted.width} ≤ 视口 ${fitted.viewport}`);

/* ---- 6. 左键点一下 = 只是选中；按按钮才带着它切过去并回到对话 ---- */
const bubbleBefore = await page.locator(".turn.user .bubble").last().textContent();
await page.click('.gnode[data-id="v0b"]');
await page.waitForTimeout(250);
const picked = await page.evaluate(() => ({
	selected: document.querySelector(".gnode[data-selected]").dataset.id,
	stillBranch: !document.getElementById("branch-scroll").hidden,
	button: document.getElementById("back-to-chat").textContent,
	info: document.getElementById("sel-info").textContent.replace(/\s+/g, " ").trim(),
}));
const bubbleStill = await page.locator(".turn.user .bubble").last().textContent();
say(`选中 v0b：选中态 = ${picked.selected}｜还留在分支页 = ${picked.stillBranch}｜对话没动 = ${bubbleBefore === bubbleStill}｜按钮 = 「${picked.button}」`);
say(`选中提示：${picked.info}`);
await page.screenshot({ path: out("shot-branch-selected.png") });

await page.click("#back-to-chat");
await page.waitForTimeout(300);
const back = await page.evaluate(() => ({
	chatVisible: !document.getElementById("scroll").hidden,
	lastBubble: [...document.querySelectorAll(".turn.user .bubble")].at(-1).textContent,
	chip: document.getElementById("branch-chip").textContent.replace(/\s+/g, " ").trim(),
	chipHidden: document.getElementById("branch-chip").hidden,
	button: document.getElementById("back-to-chat").textContent,
}));
say(`回到对话：对话页可见 = ${back.chatVisible}｜末条用户消息 = ${back.lastBubble}｜抬头 = ${back.chip}（隐藏 ${back.chipHidden}）｜按钮 = 「${back.button}」`);
await page.screenshot({ path: out("shot-branch-returned.png") });

await page.click("#branch-chip");
await page.waitForTimeout(300);
say(`换过之后主干重排：当前 = ${await page.locator(".gnode[data-current] .lbl").textContent()}（应在最上面一栏）`);
await page.screenshot({ path: out("shot-branch-after-switch.png") });
await page.click("#back-to-chat");
await page.waitForTimeout(250);

/* ---- 7. 左栏：右键改名、右键 fork（老规矩，别被上面改坏） ---- */
const first = page.locator(".srow").first();
await first.click({ button: "right" });
await page.click('#session-menu .menu-item[data-act="rename"]');
await page.fill(".rename-input", "讲一下这个仓库");
await page.keyboard.press("Enter");
await page.waitForTimeout(150);
say(`改名：${await first.getAttribute("data-title")}`);
await page.screenshot({ path: out("shot-rename.png") });

await first.click({ button: "right" });
await page.click('#session-menu .menu-item[data-act="fork"]');
await page.waitForTimeout(200);
const rows = await page.evaluate(() =>
	[...document.querySelectorAll(".srow")].slice(0, 3).map((r) => ({
		title: r.dataset.title,
		indent: getComputedStyle(r).paddingInlineStart,
		slot: r.querySelector(".slot").innerHTML.length,
	})),
);
say(`fork 后头三行：${JSON.stringify(rows)}`);

const sideBefore = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"));
const s = await page.locator("#side-resizer").boundingBox();
await page.mouse.move(s.x + 3, s.y + 300);
await page.mouse.down();
await page.mouse.move(s.x + 63, s.y + 300, { steps: 6 });
await page.mouse.up();
const sideAfter = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"));
say(`左栏把手：${sideBefore.trim()} -> ${sideAfter.trim()}（应加宽）`);
say(`状态行：${(await page.locator(".statusbar").textContent()).replace(/\s+/g, " ").trim()}`);
say(errors.length === 0 ? "no page errors" : `ERRORS: ${errors.join(" | ")}`);

await page.screenshot({ path: out("shot-interaction.png") });
await browser.close();
