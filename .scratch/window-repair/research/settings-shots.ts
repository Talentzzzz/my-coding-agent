// 06 号出图：应用级设置面板，钉住形状 + 左侧导航栏落地后的三个页。
// 走 shots.ts 那套（bootServer + 本机 Chromium；desktop:screenshot 已证可用但开不了面板子页）。
//   node .scratch/window-repair/research/settings-shots.ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { bootServer } from "../../../packages/server/src/boot.ts";
import type { UserModel } from "@my-agent/core";

const { chromium } = createRequire(import.meta.url)(
	"C:/Users/a1368/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js",
);

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

const say = (line: string): void => process.stdout.write(`${line}\n`);

const root = await mkdtemp(join(tmpdir(), "my-agent-shots-"));
const server = await bootServer({ cwd: root, port: 0 });
server.hub.setUserModels(rows);

const outDir = ".";
const executablePath = "C:/Users/a1368/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
await page.goto(server.url);
await page.waitForSelector("textarea", { timeout: 10_000 });
await page.waitForTimeout(1_500);

await page.click(".settings-entry");
await page.waitForTimeout(400);
await page.screenshot({ path: join(outDir, "settings-nav-appearance.png") });
say("1 settings-nav-appearance.png");

await page.getByRole("button", { name: "模型", exact: true }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: join(outDir, "settings-nav-models.png") });
say("2 settings-nav-models.png");

await page.getByRole("button", { name: "默认", exact: true }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: join(outDir, "settings-nav-defaults.png") });
say("3 settings-nav-defaults.png");

// 小窗自适应：把窗口压到 900x520，面板应该收进 800 宽与视口派生的高里。
await page.setViewportSize({ width: 900, height: 520 });
await page.waitForTimeout(300);
await page.screenshot({ path: join(outDir, "settings-nav-small.png") });
say("4 settings-nav-small.png");

// 顺带：会话级面板不该被这次改动波及。
await page.keyboard.press("Escape");
await page.setViewportSize({ width: 1280, height: 860 });
await page.waitForTimeout(200);
await page.click(".composer-gear");
await page.waitForTimeout(300);
await page.screenshot({ path: join(outDir, "session-settings-after.png") });
say("5 session-settings-after.png");

await browser.close();
await server.close();
