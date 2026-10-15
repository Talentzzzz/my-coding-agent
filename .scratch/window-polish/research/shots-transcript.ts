// 出图（07 号）：bootServer + 假传输 + 本机 Chromium —— 桌面外壳的 screenshot 在这台机器上必崩，
// 这条路是 09 号已证实的：真服务器、生产 bundle、真浏览器。
//
//   npm run build:web && node .scratch/window-polish/research/shots-transcript.ts before
//   npm run build:web && node .scratch/window-polish/research/shots-transcript.ts after
//
// 两张图，对应 07 号答案里的两问：一轮对话（用户气泡、分隔线、工具行、回答）长什么样、
// 输入框那一块（工作目录芯片、模型选择器、状态行）长什么样。
//
// 只用 read / glob 两个默认免审批的工具，避免审批接管卡盖住输入框。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { bootServer } from "../../../packages/server/src/boot.ts";
import { createFakeTransport, fakeAssistantMessage, fakeToolCall } from "../../../scripts/fake-transport.ts";
import type { UserModel } from "@my-agent/core";

const phase = process.argv[2] === "after" ? "after" : "before";

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
const root = await mkdtemp(join(tmpdir(), `my-agent-transcript-shots-${phase}-`));
// 工具要读到真东西，路径预览才有内容可写。
await writeFile(join(root, "README.md"), "# my-coding-agent\n\n一个带桌面 UI 的编码 agent。\n");
await writeFile(join(root, "notes.txt"), "随手记\n");
const server = await bootServer({ cwd: root, port: 0, api: fake.api });
server.hub.setUserModels(rows);
fake.appendResponses([
	// 时间戳显式给出：默认取 Date.now()，两条同毫秒会撞出同一个 `assistant:<ts>` item id，
	// 工具组就会排到回答后面（item 以 role:timestamp 为身份）。
	fakeAssistantMessage(
		[fakeToolCall("read", { path: "README.md" }), fakeToolCall("glob", { pattern: "*.md" })],
		{ timestamp: 1_000 },
	),
	fakeAssistantMessage(
		"README 是项目说明：这是一个带桌面 UI 的编码 agent，传输层、agent 循环、无头核心、HTTP 服务与窗口客户端分层而治。仓库里只有一份 markdown 的 glob 命中，就是这个 README。",
		{ timestamp: 2_000 },
	),
]);

const outDir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const executablePath = "C:/Users/a1368/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
page.on("pageerror", (error) => process.stdout.write(`page error: ${error.message}\n`));
await page.goto(server.url);
await page.waitForSelector("textarea", { timeout: 10_000 });
await page.waitForTimeout(1_200);

const say = (line: string): void => process.stdout.write(`${line}\n`);

/** 等一轮跑完：消息数到位、不再 submitting。 */
async function settle(sessionId: string, messages: number): Promise<void> {
	for (let waited = 0; waited < 15_000; waited += 150) {
		const response = await fetch(`${server.url}/api/sessions/${encodeURIComponent(sessionId)}`, {
			headers: { accept: "application/json" },
		});
		const body = (await response.json()) as { session: { submitting: boolean; messages: unknown[] } };
		if (!body.session.submitting && body.session.messages.length >= messages) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`session never settled at ${messages} messages`);
}

const { sessionId } = (await fetch(`${server.url}/api/sessions/current`, { headers: { accept: "application/json" } }).then(
	(response) => response.json() as Promise<{ sessionId: string }>,
));

// 一轮：用户问一句，模型读一个文件、数一遍 markdown，然后作答。
await page.fill(".composer textarea", "帮我看看 README 里写了什么，仓库里还有几份 markdown？");
await page.press(".composer textarea", "Enter");
await settle(sessionId, 4);
await page.waitForTimeout(800);

// 1. 整窗：一轮对话的形状（用户气泡、分隔线、工具行、回答）。
await page.screenshot({ path: join(outDir, `shot-transcript-${phase}.png`) });
say(`1 shot-transcript-${phase}.png`);

// 2. 输入框那一块：工作目录芯片、模型选择器、状态行。
await page.locator(".composer-wrap").screenshot({ path: join(outDir, `shot-composer-${phase}.png`) });
say(`2 shot-composer-${phase}.png`);

const counts = {
	roleRows: await page.locator(".turn-role").count(),
	toolRows: await page.locator(".tool").count(),
	hints: await page.locator(".composer-hint").count(),
	chipVisible: await page.locator(".workspace-chip").isVisible(),
};
say(JSON.stringify(counts));

await browser.close();
await server.close();
await rm(root, { recursive: true, force: true });
