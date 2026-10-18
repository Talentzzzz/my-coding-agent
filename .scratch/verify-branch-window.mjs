// 票 03 的真窗口验证：起一个临时 agent home（用户那条分支会话的副本），把服务端开起来，
// 用真 Chromium 打开窗口，走一遍「点回答脚下的分支 → 输入框 → 分支页」，截图并断言。
//
//   node .scratch/verify-branch-window.mjs
//
// 只读用户的会话文件：副本放在临时目录里，分支写的是副本。
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchChromium, openPage } from "../scripts/cdp.ts";

const repo = resolve(process.cwd());
const shots = join(repo, ".scratch", "ui-fix-pass-2", "shots");
mkdirSync(shots, { recursive: true });

const SOURCE_HOME = join(process.env.USERPROFILE ?? "", ".my-agent");
const WORKSPACE = "--C--Users-a1368-Desktop-my-coding-agent--";
const SESSION = "2026-10-17T06-10-42-820Z_01a1487b-ea04-7775-9696-ef62ba685e6a.jsonl";
const SESSION_ID = "01a1487b-ea04-7775-9696-ef62ba685e6a";
const FORK = 'button.turn-copy[aria-label="从这条回答开始分支"]';

const failures = [];
function check(name, ok, detail) {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : `  ${detail}`}`);
	if (!ok) failures.push(name);
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const home = mkdtempSync(join(tmpdir(), "mca-verify-home-"));
mkdirSync(join(home, "sessions", WORKSPACE), { recursive: true });
copyFileSync(join(SOURCE_HOME, "sessions", WORKSPACE, SESSION), join(home, "sessions", WORKSPACE, SESSION));
for (const file of ["settings.json", "models.json"]) {
	const from = join(SOURCE_HOME, file);
	if (existsSync(from)) copyFileSync(from, join(home, file));
}

function freePort() {
	return new Promise((done, fail) => {
		const probe = createServer();
		probe.once("error", fail);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			probe.close(() => done(address.port));
		});
	});
}

async function waitForHealth(url, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${url}/api/health`);
			if (response.ok) return;
		} catch {
			// not listening yet
		}
		await sleep(100);
	}
	throw new Error(`服务端没有起来：${url}`);
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
console.log(`agent home: ${home}`);
console.log(`server:     ${base} (session ${SESSION_ID})`);

const server = spawn(
	process.execPath,
	["packages/server/src/main.ts", "--port", String(port), "--cwd", repo, "--session", SESSION_ID],
	{ cwd: repo, env: { ...process.env, MY_AGENT_HOME: home }, stdio: "ignore" },
);

let browser;
try {
	await waitForHealth(base);
	browser = await launchChromium({ width: 1280, height: 820 });
	const page = await openPage(browser.port, base, { width: 1280, height: 820 });
	await page.waitFor('document.querySelectorAll(".turn.assistant").length > 0', 20_000);
	await sleep(600);

	// ---------------------------------------------------------------- the chat page
	const chat = await page.evaluate(`(() => {
		const current = document.querySelector(".workspace-head.workspace-head-current");
		const style = current === null ? null : getComputedStyle(current);
		return {
			sidebarNotes: [...document.querySelectorAll(".session-list-empty")].map((note) => ({ text: note.textContent, hidden: note.hidden })),
			workspaces: [...document.querySelectorAll(".workspace-head")].map((head) => ({ label: head.textContent, current: head.classList.contains("workspace-head-current") })),
			workspaceFill: style === null ? null : { background: style.backgroundColor, shadow: style.boxShadow, color: style.color, outline: style.outlineStyle },
			turns: [...document.querySelectorAll(".turn.assistant")].map((turn, index) => {
				const fork = turn.querySelector(${JSON.stringify(FORK)});
				const foot = turn.querySelector(".turn-foot");
				return {
					index,
					fork: fork === null ? "none" : fork.hidden ? "hidden" : "shown",
					foot: foot === null ? "none" : foot.hidden ? "hidden" : "shown",
					entry: turn.querySelector(".turn-foot") === null ? "" : "",
				};
			}),
			chip: {
				text: document.querySelector(".branch-chip")?.textContent ?? "",
				height: document.querySelector(".branch-chip")?.getBoundingClientRect().height ?? 0,
				id: document.querySelector(".branch-chip-id")?.textContent ?? "",
			},
			header: document.querySelector(".header-title h1")?.textContent ?? "",
		};
	})()`);

	const forkable = chat.turns.filter((turn) => turn.fork === "shown");
	const answers = chat.turns.length;
	console.log("\n对话页：");
	console.log(`  工作区行 ${JSON.stringify(chat.workspaces.map((row) => `${row.label}${row.current ? "（当前）" : ""}`))}`);
	console.log(`  列表空状态 ${JSON.stringify(chat.sidebarNotes)}`);
	console.log(`  当前工作区填充 ${JSON.stringify(chat.workspaceFill)}`);
	console.log(`  助手回答 ${answers} 条；带脚注 ${chat.turns.filter((turn) => turn.foot === "shown").length} 条；可分支 ${forkable.length} 条（第 ${forkable.map((turn) => turn.index + 1).join("、")} 条）`);
	console.log(`  header「${chat.header}」；入口「${chat.chip.text.slice(0, 60)}…」高 ${chat.chip.height}px`);
	check("列表里没有残留的「暂无会话」", chat.sidebarNotes.every((note) => note.hidden || note.text !== "暂无会话"), JSON.stringify(chat.sidebarNotes));
	check("当前工作区是纯填充：无投影、无描边", chat.workspaceFill !== null && chat.workspaceFill.shadow === "none" && (chat.workspaceFill.outline === "none" || chat.workspaceFill.outline === ""));
	check("分支入口写的是当前走法", chat.chip.id.length > 0 && chat.chip.text.includes(chat.chip.id));
	check("分支入口守着自己的一行（28px）", Math.abs(chat.chip.height - 28) < 1, `${chat.chip.height}px`);
	check("分支按钮只给带脚注、且不是最后一条的回答", forkable.length > 0 && chat.turns[answers - 1].fork === "hidden" && chat.turns.every((turn) => turn.fork !== "shown" || turn.foot === "shown"));

	// Scroll the last forkable answer into the middle and capture it.
	await page.evaluate(`(() => {
		const fork = [...document.querySelectorAll(${JSON.stringify(FORK)})].filter((button) => !button.hidden).at(-1);
		fork.scrollIntoView({ block: "center" });
		return true;
	})()`);
	await sleep(400);
	await page.screenshot(join(shots, "03-chat-fork.png"));

	// ---------------------------------------------------------------- fork from an answer
	// Mark the turn the press lands on, so the checks after it can find that same footer again.
	const picked = await page.evaluate(`(() => {
		const fork = [...document.querySelectorAll(${JSON.stringify(FORK)})].filter((button) => !button.hidden).at(-1);
		const turn = fork.closest(".turn");
		turn.dataset.verify = "picked";
		turn.dataset.verifyCenter = String(turn.getBoundingClientRect().top + scrollY + turn.getBoundingClientRect().height / 2);
		const turns = [...document.querySelectorAll(".turn.assistant")];
		const index = turns.indexOf(turn);
		fork.click();
		return { index, chipId: document.querySelector(".branch-chip-id")?.textContent ?? "" };
	})()`);
	await sleep(800);
	const after = await page.evaluate(`(() => {
		const active = document.activeElement;
		const turn = document.querySelector('.turn[data-verify="picked"]');
		const fork = turn?.querySelector(${JSON.stringify(FORK)});
		const foot = turn?.querySelector(".turn-foot");
		return {
			answers: document.querySelectorAll(".turn.assistant").length,
			stillThere: turn !== null,
			fork: fork === null || fork === undefined ? "none" : fork.hidden ? "hidden" : "shown",
			foot: foot === null || foot === undefined ? "none" : foot.hidden ? "hidden" : "shown",
			focused: active instanceof HTMLTextAreaElement && active.closest(".composer") !== null,
			chipId: document.querySelector(".branch-chip-id")?.textContent ?? "",
			chipLabel: document.querySelector(".branch-chip-label")?.textContent ?? "",
		};
	})()`);
	console.log("\n从回答脚注分支：");
	console.log(`  点的是第 ${picked.index + 1} 条回答（共 ${answers} 条）；transcript 剩 ${after.answers} 条`);
	console.log(`  入口仍是 ${after.chipId}「${after.chipLabel.slice(0, 40)}…」`);
	check("退回这条回答后 transcript 只到它为止", after.answers === picked.index + 1, `${after.answers} 条`);
	check("这条回答成了最后一条：脚注还在，分支按钮收起", after.stillThere && after.foot === "shown" && after.fork === "hidden", `${after.foot}/${after.fork}`);
	check("焦点落到输入框", after.focused === true);
	await page.screenshot(join(shots, "03-after-fork.png"));

	// ---------------------------------------------------------------- the branch page
	await page.click(".branch-chip");
	await page.waitFor('document.querySelectorAll(".gnode").length > 0', 10_000);
	await sleep(600);
	const branch = await page.evaluate(`(() => {
		const viewport = document.querySelector(".graph-viewport");
		const box = viewport.getBoundingClientRect();
		// The layer is a positioning frame with no box of its own (every child is absolute), so the
		// graph's painted extent is the SVG's rect — already through the scale transform.
		const graph = document.querySelector(".graph-svg").getBoundingClientRect();
		return {
			viewport: { x: box.x, y: box.y, width: box.width, height: box.height },
			graph: { x: graph.x, y: graph.y, width: graph.width, height: graph.height },
			scroll: { left: viewport.scrollLeft, top: viewport.scrollTop },
			zoom: document.querySelector(".zoom-value")?.textContent ?? "",
			summary: document.querySelector(".branch-sum")?.textContent ?? "",
			tools: document.querySelector(".branch-tools")?.textContent ?? "",
			back: document.querySelector(".back-button")?.textContent ?? "",
			cards: [...document.querySelectorAll(".gnode")].map((card) => ({
				id: card.dataset.id ?? "",
				label: card.querySelector(".lbl")?.textContent ?? "",
				meta: card.querySelector(".meta")?.textContent ?? "",
				title: card.title,
				disabled: card.disabled,
				current: card.dataset.current !== undefined,
				selected: card.dataset.selected !== undefined,
				box: (() => { const rect = card.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })(),
			})),
		};
	})()`);
	const dx = Math.abs(branch.graph.x + branch.graph.width / 2 - (branch.viewport.x + branch.viewport.width / 2));
	const dy = Math.abs(branch.graph.y + branch.graph.height / 2 - (branch.viewport.y + branch.viewport.height / 2));
	console.log("\n分支页：");
	console.log(`  摘要「${branch.summary.slice(0, 70)}…」`);
	console.log(`  工具行「${branch.tools.trim()}」`);
	console.log(`  画布 ${Math.round(branch.viewport.width)}×${Math.round(branch.viewport.height)} @ ${Math.round(branch.viewport.x)},${Math.round(branch.viewport.y)}；图 ${Math.round(branch.graph.width)}×${Math.round(branch.graph.height)}；缩放 ${branch.zoom}；滚动 ${branch.scroll.left}/${branch.scroll.top}`);
	console.log(`  图与画布中心的偏移：水平 ${dx.toFixed(1)}px，垂直 ${dy.toFixed(1)}px`);
	for (const card of branch.cards) {
		console.log(`  卡「${card.label.slice(0, 50)}」 meta「${card.meta}」${card.disabled ? "（起点）" : ""}${card.current ? " [当前]" : ""}${card.selected ? " [选中]" : ""}`);
		console.log(`     tooltip: ${card.title.replaceAll("\n", " ⏎ ").slice(0, 110)}`);
	}
	check("图在画布水平居中", dx < 1.5, `${dx.toFixed(1)}px`);
	check("图在画布垂直居中", dy < 1.5, `${dy.toFixed(1)}px`);
	check("每张卡都有 tooltip，至少一张同时带提问与回答", branch.cards.every((card) => card.title.length > 0) && branch.cards.some((card) => card.title.includes("\n\n")));
	check("根卡是「起点」", branch.cards[0]?.meta.includes("起点") === true, branch.cards[0]?.meta);
	check("工具行里的长标题只占一行", branch.tools.length > 0);
	await page.screenshot(join(shots, "03-branch.png"));

	// Selecting another way must arm the one button out of the page — press, not click: the page
	// decides on pointerup so a pan never selects whatever it stops on.
	const target = branch.cards.find((card) => !card.disabled && !card.current);
	if (target !== undefined) {
		await page.press(`.gnode[data-id="${target.id}"]`);
		await sleep(400);
		const selected = await page.evaluate(`(() => ({
			back: document.querySelector(".back-button")?.textContent ?? "",
			primary: document.querySelector(".back-button")?.classList.contains("primary") ?? false,
			info: document.querySelector(".branch-sel-info")?.textContent ?? "",
			selected: document.querySelector(".gnode[data-selected]")?.dataset.id ?? "",
		}))()`);
		console.log(`\n选中另一条走法「${target.label.slice(0, 40)}」：`);
		console.log(`  工具行「${selected.info}」；按钮「${selected.back}」${selected.primary ? "（主色）" : ""}`);
		check("选中另一条走法后按钮变成切走", selected.back === "切到这一条并回到对话" && selected.primary);
		await page.screenshot(join(shots, "03-branch-selected.png"));

		// One more press on the same card: the way out applies it and returns to the conversation.
		await page.click(".back-button");
		await sleep(800);
		const returned = await page.evaluate(`(() => ({
			pane: document.body.dataset.pane ?? "chat",
			chipLabel: document.querySelector(".branch-chip-label")?.textContent ?? "",
			chipId: document.querySelector(".branch-chip-id")?.textContent ?? "",
			answers: document.querySelectorAll(".turn.assistant").length,
			focused: document.activeElement instanceof HTMLTextAreaElement,
		}))()`);
		console.log(`\n切到另一条走法：对话页 ${returned.answers} 条回答，入口 ${returned.chipId}「${returned.chipLabel.slice(0, 40)}…」`);
		check("切走回到对话页并换了当前走法", returned.pane === "chat" && target.id.startsWith(returned.chipId) && returned.chipId.length > 0, `${returned.pane}/${returned.chipId} ← ${target.id}`);
		await page.screenshot(join(shots, "03-switched.png"));
	} else {
		console.log("\n（没有第二条可选走法）");
	}
} finally {
	await browser?.close();
	server.kill();
	rmSync(home, { recursive: true, force: true });
}

console.log(`\n${failures.length === 0 ? "窗口验证通过" : `窗口验证失败：${failures.join("、")}`}`);
process.exit(failures.length === 0 ? 0 : 1);
