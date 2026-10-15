// 核验（19 号）：真窗口把三个入口各跑一遍并出图。
//
//   npm run build:web && node .scratch/window-polish/research/verify-19.ts
//
// 走的是 09 号那条已证实的路：bootServer + 脚本传输 + 本机 Chromium、生产 bundle、真浏览器。
// 三个入口都在真 UI 上点，不被任何 dispatch 绕过：
//   A. 左栏会话行右键 → 派生新会话 / 重命名 / 删除
//   B. 会话里的用户消息右键 → 从此分支
//   C. 分过岔的会话顶部「当前分支」块 → 分支页 → 切回去
//
// 每一步入图；某一入口若点了没反应，check 会红，脚本照样跑完把剩下的也验一遍——红的那条就是
// 19 号要登记的 bug（修复另开票，不在这里顺手改）。退出码 1 表示至少一条红。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { bootServer } from "../../../packages/server/src/boot.ts";
import { createFakeTransport, fakeAssistantMessage } from "../../../scripts/fake-transport.ts";
import type { SessionSnapshot, UserModel } from "@my-agent/core";

const { chromium } = createRequire(import.meta.url)(
	"C:/Users/a1368/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js",
);

const fake = createFakeTransport();
const rows: UserModel[] = [
	{
		name: "scripted",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "unused",
		modelId: "claude-sonnet-4-5",
		contextWindow: 200_000,
		maxTokens: 8_192,
		reasoning: false,
	},
];
// 每次运行一个唯一标记：左栏的会话清单是**整机**的（本机上还堆着几百条别的历史工作区），
// 靠文字找行时若用固定开场白，上一次运行残留的临时工作区会被匹配上，操作就落到旧会话去了。
// 标记要短：行标题长了会被 CSS 截断，`（1）` 那个后缀就拍不进图里了。
const tag = `V19${Math.random().toString(36).slice(2, 7)}`;
const root = await mkdtemp(join(tmpdir(), `my-agent-verify19-${tag}-`));
const server = await bootServer({ cwd: root, port: 0, api: fake.api });
server.hub.setUserModels(rows);
fake.appendResponses(
	[
		"第一轮的回答：先讲项目结构。",
		"第二轮的回答：入口在 main.ts。",
		"第三条走法的回答：从第二轮岔出去的另一条路。",
		"备用回答一。",
		"备用回答二。",
	].map((text) => fakeAssistantMessage(text)),
);

const outDir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const executablePath = "C:/Users/a1368/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
page.on("pageerror", (error) => process.stdout.write(`page error: ${error.message}\n`));
await page.goto(server.url);
await page.waitForSelector("textarea", { timeout: 10_000 });
// 等常驻通道真的接上、清单帧也到了再动手。首跑偶发过一次「通道还没接上，第一句按了 Enter 被丢掉」，
// settle 于是永远等不到——那是脚本自己的竞态，不是入口的问题，所以在这里把就绪说清楚。
await page.waitForSelector('.channel-indicator[data-state="live"]', { timeout: 15_000 });
await page.waitForSelector(".session-item", { timeout: 15_000 });
await page.waitForTimeout(800);

const say = (line: string): void => process.stdout.write(`${line}\n`);
let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` << ${detail}`}\n`);
	if (!condition) failures += 1;
}

async function snapshotOf(sessionId: string): Promise<SessionSnapshot> {
	const response = await fetch(`${server.url}/api/sessions/${encodeURIComponent(sessionId)}`, {
		headers: { accept: "application/json" },
	});
	const body = (await response.json()) as { session: SessionSnapshot };
	return body.session;
}

/** 等一轮跑完：消息数到位、不再 submitting。 */
async function settle(sessionId: string, messages: number): Promise<SessionSnapshot> {
	for (let waited = 0; waited < 15_000; waited += 150) {
		const snapshot = await snapshotOf(sessionId);
		if (!snapshot.submitting && snapshot.messages.length >= messages) return snapshot;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`session never settled at ${messages} messages`);
}

/**
 * 从输入框发一句话。
 *
 * 发送成功会清空输入框，所以「框里还剩着字」就等于没发出去——那种情况只可能是按 Enter 的那一刻
 * 基线还没落地，再按一次即可。这一步不掩盖任何入口的问题：它确认的是发送本身有没有落地。
 */
async function ask(text: string): Promise<void> {
	const input = page.locator(".composer textarea");
	await input.fill(text);
	await input.press("Enter");
	for (let attempt = 0; attempt < 4; attempt++) {
		if ((await input.inputValue()) === "") return;
		await page.waitForTimeout(500);
		await input.press("Enter");
	}
	throw new Error("composer never cleared: the message did not send");
}

/** 轮询直到 `probe` 为真，超时抛错（把竞态变成一条可读的失败，而不是一句 waitForTimeout 之后碰运气）。 */
async function until(label: string, probe: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
	for (let waited = 0; waited < timeoutMs; waited += 120) {
		if (await probe()) return;
		await new Promise((resolve) => setTimeout(resolve, 120));
	}
	throw new Error(`timeout waiting for ${label}`);
}

/**
 * 右栏底部那条错误横幅此刻写着什么（没有就是空串）。
 *
 * 三个入口本身是否可用由 check 判定；这里只是把过程中冒出来的错误记下来——核验时它出现过一次，
 * 不记的话就只剩一张图里的一行红字，说不清是哪一步跟出来的。
 */
let banners = 0;
async function banner(step: string): Promise<void> {
	if (!(await page.locator(".error-bar").isVisible())) return;
	const text = ((await page.locator(".error-bar").textContent()) ?? "").trim();
	if (text === "") return;
	banners += 1;
	say(`  !!  错误横幅 @${step}：${text}`);
}

/** 一条会话行，按它显示的文字片段找——本机的会话清单里还有很多别的工作区，靠文字定位。 */
function rowWith(text: string) {
	return page.locator(".session-item").filter({ hasText: text });
}

/** 一条会话行现在显示的标题。 */
async function titleOf(text: string): Promise<string> {
	const row = rowWith(text).first();
	if ((await row.count()) === 0) return "";
	return ((await row.locator(".session-item-title").textContent()) ?? "").trim();
}

/** 在一条会话行上右键、选菜单里的一项。 */
async function rowMenu(text: string, item: string): Promise<void> {
	await rowWith(text).first().click({ button: "right" });
	await page.waitForSelector(".menu", { timeout: 3_000 });
	await page.getByRole("menuitem", { name: item }).click();
}

const { sessionId } = (await fetch(`${server.url}/api/sessions/current`, {
	headers: { accept: "application/json" },
}).then((response) => response.json() as Promise<{ sessionId: string }>));

// ------------------------------------------------------------------ 会话内容

await ask(`${tag} 看结构`);
await settle(sessionId, 2);
await ask(`${tag} 入口文件`);
await settle(sessionId, 4);
await page.waitForTimeout(500);

// 没有 rename entry 时，行的标题就是从分支首条 user 消息派生的，所以这里读到的就是那句开场白。
const baseTitle = await titleOf(tag);
check("会话行已出现在左栏", baseTitle.length > 0 && baseTitle.includes(tag), baseTitle);
await until("正在读的那行被标成当前", async () =>
	(((await page.locator('.session-item[aria-current="true"]').first().textContent()) ?? "").includes(tag)),
);
say(`base title: ${baseTitle}`);

// ============================================================ 入口 A：会话行右键

// A1. 菜单里三项都在。
await rowWith(baseTitle).first().click({ button: "right" });
await page.waitForSelector(".menu", { timeout: 3_000 });
const menuLabels = await page.locator(".menu-item .menu-label").allTextContents();
check(
	"右键菜单三项：派生新会话 / 重命名 / 删除",
	menuLabels.join("|") === "派生新会话|重命名|删除",
	menuLabels.join("|"),
);
await page.screenshot({ path: join(outDir, "v19-a1-session-menu.png") });
say("A1 v19-a1-session-menu.png");
await banner("A1");

// A2. 重命名：就地编辑，提交 REST，行从 session_row 帧回来。
const RENAMED = `${tag} 改名`;
await page.getByRole("menuitem", { name: "重命名" }).click();
await page.waitForSelector(".rename-input", { timeout: 3_000 });
const seed = await page.locator(".rename-input").inputValue();
check("改名框预填净名", seed === baseTitle, seed);
await page.screenshot({ path: join(outDir, "v19-a2-rename-input.png") });
say("A2 v19-a2-rename-input.png");
await banner("A2");
await page.fill(".rename-input", RENAMED);
await page.press(".rename-input", "Enter");
await until("改名后的行从帧回来", async () => (await titleOf(tag)) === RENAMED);
check("改名后左栏行显示新名", (await titleOf(tag)) === RENAMED, await titleOf(tag));
check("改名后旧名不再出现", (await titleOf(baseTitle)) === "", await titleOf(baseTitle));
const headerAfterRename = ((await page.locator(".header-title h1").textContent()) ?? "").trim();
check("改名的是正在读的会话时头部跟上", headerAfterRename === RENAMED, headerAfterRename);
await page.screenshot({ path: join(outDir, "v19-a3-renamed.png") });
say("A3 v19-a3-renamed.png");
await banner("A3");

// A3. 派生新会话：新行带（1）后缀、挂在源行下，并且窗口跟过去。
const forkTitle = `${RENAMED}（1）`;
await rowMenu(RENAMED, "派生新会话");
await until("派生行出现在左栏", async () => (await titleOf(forkTitle)) === forkTitle);
check("派生行的标题是 源标题（1）", (await titleOf(forkTitle)) === forkTitle, await titleOf(forkTitle));
await until("窗口跟到派生会话", async () => {
	const marked = (await page.locator('.session-item[aria-current="true"]').first().textContent()) ?? "";
	return marked.includes(forkTitle);
});
await page.waitForTimeout(400);
await page.screenshot({ path: join(outDir, "v19-a4-forked.png") });
say("A4 v19-a4-forked.png");
await banner("A4");
const { sessionId: forkId } = (await fetch(`${server.url}/api/sessions/current`, {
	headers: { accept: "application/json" },
}).then((response) => response.json() as Promise<{ sessionId: string }>));
const forkSnapshot = await snapshotOf(forkId);
check("派生会话复制了整份记录", forkSnapshot.messages.length === 4, String(forkSnapshot.messages.length));

// A4. 删除：派生行离开，这一行由 session_gone 帧带走。
await rowMenu(forkTitle, "删除");
await until("派生行离开左栏", async () => (await titleOf(forkTitle)) === "");
check("删除后派生行不再出现", (await titleOf(forkTitle)) === "", await titleOf(forkTitle));
check("源会话行还在", (await titleOf(RENAMED)) === RENAMED, await titleOf(RENAMED));
await page.screenshot({ path: join(outDir, "v19-a5-deleted.png") });
say("A5 v19-a5-deleted.png");
await banner("A5");

// ====================================================== 入口 B：用户消息右键

// 回到源会话（删的是正在读的派生会话，窗口已回空态；点源行回去）。
await rowWith(RENAMED).first().click();
// 行的文字里还跟着相对时间的读数，所以这里认的是片段而不是全等。
await until("点中的会话被标成当前", async () =>
	(((await page.locator('.session-item[aria-current="true"]').first().textContent()) ?? "").includes(RENAMED)),
);
check("点击会话行回到了那条会话", await page.locator(".composer").isVisible());
check("窗口真的载入了那条会话", (await snapshotOf(sessionId)).messages.length === 4);

// B1. 用户消息右键 → 从此分支 / 查看分支图。
await page.click('.turn[data-role="user"] >> nth=1', { button: "right" });
await page.waitForSelector(".menu", { timeout: 3_000 });
const userMenu = await page.locator(".menu-item .menu-label").allTextContents();
check("用户消息右键有「从此分支」", userMenu.includes("从此分支"), userMenu.join("|"));
check("用户消息右键有「查看分支图」", userMenu.includes("查看分支图"), userMenu.join("|"));
await page.screenshot({ path: join(outDir, "v19-b1-user-menu.png") });
say("B1 v19-b1-user-menu.png");
await banner("B1");

// B2. 「从此分支」= rewind 到那条消息，接着再发一句就岔出第二条走法。
await page.getByRole("menuitem", { name: "从此分支" }).click();
await page.waitForTimeout(700);
const rewound = await snapshotOf(sessionId);
check("从此分支回卷了 leaf", rewound.messages.length === 3, String(rewound.messages.length));
await ask(`${tag} 另一条路`);
const forked = await settle(sessionId, 5);
check("再发一句长出第二条走法", forked.branchPoints.length >= 1, `points=${forked.branchPoints.length}`);
await page.waitForTimeout(500);
check("分过岔后「当前分支」块出现", await page.locator(".branch-chip").isVisible());
await page.screenshot({ path: join(outDir, "v19-b2-branched.png") });
say("B2 v19-b2-branched.png");
await banner("B2");

// ==================================================== 入口 C：当前分支 → 切回去

await page.click(".branch-chip");
await page.waitForTimeout(600);
check("分支块点开换成分支页", await page.locator(".graph-viewport").isVisible());
check("分支页没有输入框", !(await page.locator(".composer").isVisible()));
const nodes = await page.locator(".gnode").count();
check("分支页画出了节点", nodes >= 3, String(nodes));
await page.screenshot({ path: join(outDir, "v19-c1-branch-page.png") });
say("C1 v19-c1-branch-page.png");
await banner("C1");

const alternative = forked.branchPoints[0]?.options.find((option) => !option.active)?.entryId;
check("存在一条可选的非活跃走法", alternative !== undefined, String(alternative));
if (alternative !== undefined) {
	await page.click(`.gnode[data-id="${alternative}"]`);
	await page.waitForTimeout(300);
	const buttonText = ((await page.locator(".back-button").textContent()) ?? "").trim();
	check("选中后按钮改口成「切到这一条并回到对话」", buttonText === "切到这一条并回到对话", buttonText);
	await page.screenshot({ path: join(outDir, "v19-c2-branch-selected.png") });
	say("C2 v19-c2-branch-selected.png");
	await banner("C2");

	await page.click(".back-button");
	await page.waitForTimeout(800);
	check("切回去后回到对话页", await page.locator(".composer").isVisible());
	const chipText = ((await page.locator(".branch-chip").textContent()) ?? "").trim();
	check(
		"固定头写着新的当前分支",
		chipText.includes("当前分支") && chipText.includes(alternative.slice(0, 7)),
		chipText,
	);
	await page.screenshot({ path: join(outDir, "v19-c3-branch-switched.png") });
	say("C3 v19-c3-branch-switched.png");
	await banner("C3");
}

await browser.close();
await server.close();
await rm(root, { recursive: true, force: true });
// 横幅是**过程记录**，不是断言：三个入口本身全绿，这条红字是 21 号那条竞态白送给用户的噪音，
// 修复在 21 号。它的出现取决于「派生」到「删除」之间隔了多久，所以这里把次数打出来留档。
say(
	failures === 0
		? `verify-19: 三个入口全绿（过程中出现错误横幅 ${banners} 次）`
		: `verify-19: ${failures} FAILURES`,
);
if (failures > 0) process.exitCode = 1;
