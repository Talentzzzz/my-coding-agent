// 出图（15 号）：阅读列把手落地后的前后各一张，外加持久化读回的核验。
// 走 shots-transcript.ts 已证实的同一条路：真服务器、假传输、生产 bundle、真浏览器。
//
//   npm run build:web && node .scratch/window-polish/research/shots-content.ts
//
// 四件事：
//   1. 默认宽度出一张图（从未拖过 → 列宽 − 70）。
//   2. 把手往右拖 180px（往右推 = 变窄，位移乘 -2），再出一张。
//   3. 刷新页面，读回的宽度应该还在（偏好落在 settings.json，服务端已 clamp）。
//   4. 顺手核验固定头不跟着正文宽度动（04 号顺带拍掉的那条）。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { bootServer } from "../../../packages/server/src/boot.ts";
import { createFakeTransport, fakeAssistantMessage, fakeToolCall } from "../../../scripts/fake-transport.ts";
import type { UserModel } from "@my-agent/core";

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
const root = await mkdtemp(join(tmpdir(), "my-agent-content-shots-"));
await writeFile(join(root, "README.md"), "# my-coding-agent\n\n一个带桌面 UI 的编码 agent。\n");
const server = await bootServer({ cwd: root, port: 0, api: fake.api });
server.hub.setUserModels(rows);
fake.appendResponses([
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
// 等订阅挂上：mux 通道没 live 时按 Enter 会被吞掉，这一帧是竞态的源头。
await page.waitForTimeout(2_000);

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

await page.fill(".composer textarea", "帮我看看 README 里写了什么，仓库里还有几份 markdown？");
await page.press(".composer textarea", "Enter");
await settle(sessionId, 4);
await page.waitForTimeout(800);

/** `--dsw-content-width` 现在的值，以及量程与列宽，供核对。 */
async function width(): Promise<string> {
	return page.evaluate(() => {
		const styles = getComputedStyle(document.documentElement);
		return [
			styles.getPropertyValue("--dsw-content-width").trim(),
			`min=${styles.getPropertyValue("--dsw-content-min").trim()}`,
			`cap=${styles.getPropertyValue("--dsw-content-cap").trim()}`,
			`column=${(document.querySelector(".conversation") as HTMLElement | null)?.clientWidth}`,
		].join("  ");
	});
}

// 1. 默认：从未拖过，显示值应为 列宽 − 70。
say(`默认宽度：${await width()}`);
await page.screenshot({ path: join(outDir, "shot-content-before.png") });
say("1 shot-content-before.png");

// 2. 把手往右拖 180px：往右推是变窄，宽度应少 360。
const handle = page.locator(".content-resizer");
const box = await handle.boundingBox();
if (box === null) throw new Error("content-resizer not on screen");
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(400);
say(`拖右 180 后：${await width()}`);
await page.screenshot({ path: join(outDir, "shot-content-after.png") });
say("2 shot-content-after.png");

// 3. 刷新：偏好应从 settings.json 读回（服务端已按绝对量程 clamp 过）。
const stored = (await fetch(`${server.url}/api/settings`, { headers: { accept: "application/json" } }).then(
	(response) => response.json() as Promise<{ settings: { appearance: Record<string, unknown> } }>,
)).settings.appearance;
say(`settings 里的偏好：${JSON.stringify(stored)}`);
await page.reload();
await page.waitForSelector("textarea", { timeout: 10_000 });
await page.waitForTimeout(1_200);
say(`刷新后：${await width()}`);

// 4. 固定头不跟正文动：头的宽度应等于会话列宽，而不是正文宽度。
say(
	`固定头：${await page.evaluate(() => {
		const header = document.querySelector(".conversation header") ?? document.querySelector(".conversation > :first-child");
		const column = document.querySelector(".conversation") as HTMLElement | null;
		const box = (header as HTMLElement | null)?.getBoundingClientRect();
		return box && column ? `header=${Math.round(box.width)}  column=${column.clientWidth}` : "not found";
	})}`,
);

await browser.close();
await server.close();
await rm(root, { recursive: true, force: true });
