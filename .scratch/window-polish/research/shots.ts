// 出图（09 号）：bootServer + 假传输 + 本机 Chromium —— 桌面外壳的 screenshot 在这台机器上必崩，
// 这条路是 window-rework 的 shots.ts 已证实的：真服务器、生产 bundle、真浏览器。
//
//   npm run build:web && node .scratch/window-polish/research/shots.ts
//
// 三张图，对应 09 号答案里的三问：分支图长什么样、切到另一条之后对话页的样子、
// 只有一条走法时入口不出现的样子。
//
// 对话必须从窗口自己走（输入框发送、右键菜单 rewind）——一条只在旁边看的流，宿主一走就结束，
// 窗口会停在旧基线上；窗口自己的动作（发送重开流、branch 的应答自带快照）才会把它带回当下。
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
const root = await mkdtemp(join(tmpdir(), "my-agent-branch-shots-"));
const server = await bootServer({ cwd: root, port: 0, api: fake.api });
server.hub.setUserModels(rows);
fake.appendResponses(
	[
		"第一轮的回答：先讲项目结构。",
		"第二轮的回答：入口在 main.ts。",
		"第二条走法的回答：入口在 main.ts 的另一条路上。",
		"第三条走法的回答：从第二轮岔出来的回答。",
	].map((text) => fakeAssistantMessage(text)),
);

const outDir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const executablePath = "C:/Users/a1368/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
page.on("pageerror", (error) => process.stdout.write(`page error: ${error.message}\n`));
await page.goto(server.url);
await page.waitForSelector("textarea", { timeout: 10_000 });
await page.waitForTimeout(1_200);

const say = (line: string): void => process.stdout.write(`${line}\n`);

let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
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

/** 从输入框发一句话。 */
async function ask(text: string): Promise<void> {
	await page.fill(".composer textarea", text);
	await page.press(".composer textarea", "Enter");
}

/** 对第 index 条用户消息（0 起）右键，选「从此分支」—— rewind 到那条消息。 */
async function rewindAt(index: number): Promise<void> {
	await page.click(`.turn[data-role="user"] >> nth=${index}`, { button: "right" });
	await page.getByRole("menuitem", { name: "从此分支" }).click();
	await page.waitForTimeout(500);
}

const { sessionId } = (await fetch(`${server.url}/api/sessions/current`, { headers: { accept: "application/json" } }).then(
	(response) => response.json() as Promise<{ sessionId: string }>,
));

// 跑出两轮，先拍「只有一条走法」：入口整块不出现。
await ask("帮我看看这个项目的结构");
await settle(sessionId, 2);
await ask("入口在哪个文件？");
await settle(sessionId, 4);
await page.waitForTimeout(500);
check("single way: chip hidden", !(await page.locator(".branch-chip").isVisible()));
await page.screenshot({ path: join(outDir, "shot-branch-single.png") });
say("1 shot-branch-single.png");

// 从第二轮 rewind 两次、各发一条：2 个分支点、4 条走法，其中一层是嵌套的。
await rewindAt(1);
await ask("入口在 main.ts 的哪一行？");
const forked = await settle(sessionId, 5); // 链 = U1 A1 U2 U2' A2'
check("first point has two ways", forked.branchPoints.length === 1 && forked.branchPoints[0]!.options.length === 2);
await rewindAt(2);
await ask("那这一条路再往深走一层呢？");
const tree = await settle(sessionId, 6); // 链 = U1 A1 U2 U2' U3' A3'
check(
	"two points, four ways",
	tree.branchPoints.length === 2 && tree.branchPoints.reduce((total, point) => total + point.options.length, 0) === 4,
);
check("deepest point nests", tree.branchPoints[1]!.options.length === 2);

// 1. 分支图：点固定头右上角的入口，整个会话区换成那棵树。
await page.click(".branch-chip");
await page.waitForTimeout(600);
check("branch page replaces the conversation", await page.locator(".graph-viewport").isVisible());
check("five nodes drawn", (await page.locator(".gnode").count()) === 5);
check("composer gone from the branch page", !(await page.locator(".composer").isVisible()));
await page.screenshot({ path: join(outDir, "shot-branch-graph.png") });
say("2 shot-branch-graph.png");

// 2. 选另一条走法（第二轮里被让出的那个答案），按按钮切过去并回到对话。
const otherWay = tree.branchPoints[0]!.options.find((option) => !option.active)!.entryId;
await page.click(`.gnode[data-id="${otherWay}"]`);
await page.waitForTimeout(300);
check("selected, not switched", (await page.locator(".gnode[data-selected]").count()) === 1);
const buttonText = (await page.locator(".back-button").textContent()) ?? "";
check("button names the move", buttonText === "切到这一条并回到对话", buttonText);
await page.screenshot({ path: join(outDir, "shot-branch-selected.png") });
say("3 shot-branch-selected.png");

await page.click(".back-button");
await page.waitForTimeout(800);
const after = await snapshotOf(sessionId);
check("leaf moved to the chosen way", after.messages.length === 4);
check("pane is back to chat", await page.locator(".composer").isVisible());
const chipText = (await page.locator(".branch-chip").textContent()) ?? "";
check(
	"chip names the new way",
	chipText.includes("当前分支") && chipText.includes(otherWay.slice(0, 7)),
	chipText,
);
await page.screenshot({ path: join(outDir, "shot-branch-switched.png") });
say("4 shot-branch-switched.png");

await browser.close();
await server.close();
await rm(root, { recursive: true, force: true });
say(failures === 0 ? "branch shots ok" : `${failures} FAILURES`);
if (failures > 0) process.exitCode = 1;
