// 出图（10 号）：bootServer + 本机 Chromium，桌面外壳的 screenshot 在这台机器上连 --disable-gpu
// 也崩（GPU 进程 0xC0000005），所以走 09 号已证实的同一条路：真服务器、生产 bundle、真浏览器。
//   node .scratch/window-rework/research/shots.ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { bootServer } from "../../../packages/server/src/boot.ts";
import type { UserModel } from "@my-agent/core";

const { chromium } = createRequire(import.meta.url)(
	"C:/Users/a1368/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js",
);

const root = await mkdtemp(join(tmpdir(), "my-agent-shots-"));
const transportless = undefined; // 不需要模型：出的是壳，不发起任何一次请求。
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
const server = await bootServer({ cwd: root, port: 0, ...(transportless === undefined ? {} : { api: transportless }) });
server.hub.setUserModels(rows);

const outDir = ".";
const executablePath = "C:/Users/a1368/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
await page.goto(server.url);
await page.waitForSelector("textarea", { timeout: 10_000 });
await page.waitForTimeout(1_500);

const say = (line: string): void => process.stdout.write(`${line}\n`);

// 1. 空态（hero 相位）：工作目录芯片 + 输入框 + composer 上的会话设置入口。
await page.screenshot({ path: join(outDir, "landing-after.png") });
say("1 landing-after.png");

// 2. 工作目录菜单：已知工作区列表 + 添加工作区…。
await page.click(".workspace-chip");
await page.waitForTimeout(300);
await page.screenshot({ path: join(outDir, "workspace-menu.png") });
say("2 workspace-menu.png");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// 3. 会话级设置（composer 上的齿轮）。
await page.click(".composer-gear");
await page.waitForTimeout(300);
await page.screenshot({ path: join(outDir, "session-settings.png") });
say("3 session-settings.png");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// 4. 应用级设置（左下角「设置」→「默认」页：默认模型 / bash / 全局审批 / 全局工具）。
await page.click(".settings-entry");
await page.waitForTimeout(300);
await page.getByRole("button", { name: "默认", exact: true }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: join(outDir, "app-settings.png") });
say("4 app-settings.png");

await browser.close();
await server.close();
await writeFile(join(outDir, "shots-url.txt"), server.url);
