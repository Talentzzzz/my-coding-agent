// 19 号执行期发现的最小复现：派生一个会话、把它删掉、再点回源会话行，右栏底部会挂出
// 「未知的会话：<id>」——那是客户端为一个已经不存在的会话又发了一次 `open`，服务端照协议拒了它。
//
//   node .scratch/window-polish/research/repro-19.ts
//
// 脚本只做这三步，不碰别的入口；把 WS 上行/下行帧与错误横幅的时间线打出来，好让修复票拿着它走。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { bootServer } from "../../../packages/server/src/boot.ts";
import { createFakeTransport, fakeAssistantMessage } from "../../../scripts/fake-transport.ts";
import type { UserModel } from "@my-agent/core";

const { chromium } = createRequire(import.meta.url)(
	"C:/Users/a1368/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js",
);

const fake = createFakeTransport();
const rows: UserModel[] = [
	{ name: "scripted", baseUrl: "http://127.0.0.1:1/v1", apiKey: "unused", modelId: "claude-sonnet-4-5", contextWindow: 200_000, maxTokens: 8_192, reasoning: false },
];
const tag = `R19${Math.random().toString(36).slice(2, 7)}`;
const root = await mkdtemp(join(tmpdir(), `my-agent-repro19-${tag}-`));
const server = await bootServer({ cwd: root, port: 0, api: fake.api });
server.hub.setUserModels(rows);
fake.appendResponses([fakeAssistantMessage("回答。"), fakeAssistantMessage("又一个回答。")]);

const executablePath = "C:/Users/a1368/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
const say = (line: string): void => process.stdout.write(`${line}\n`);
page.on("pageerror", (error) => say(`[page error] ${error.message}`));
page.on("websocket", (ws) => {
	say("[ws] socket opened");
	ws.on("close", () => say("[ws] socket closed"));
	ws.on("framesent", (frame) => {
		const text = typeof frame === "string" ? frame : frame.toString();
		say(`[ws ->] ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`);
	});
	ws.on("framereceived", (frame) => {
		const text = typeof frame === "string" ? frame : frame.toString();
		if (text.includes('"type":"error"') || text.includes("gone") || text.includes("baseline")) {
			say(`[ws <-] ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`);
		}
	});
});
await page.goto(server.url);
await page.waitForSelector("textarea", { timeout: 10_000 });
await page.waitForSelector('.channel-indicator[data-state="live"]', { timeout: 15_000 });
await page.waitForSelector(".session-item", { timeout: 15_000 });
await page.waitForTimeout(800);

const currentId = async (): Promise<string> =>
	(await fetch(`${server.url}/api/sessions/current`, { headers: { accept: "application/json" } }).then((r) => r.json())).sessionId;
const banner = async (): Promise<string> =>
	(await page.locator(".error-bar").isVisible()) ? ((await page.locator(".error-bar").textContent()) ?? "").trim() : "";

const sourceId = await currentId();
say(`source session = ${sourceId}`);
await page.fill(".composer textarea", `${tag} 看结构`);
await page.press(".composer textarea", "Enter");
await page.waitForTimeout(1500);
await page.fill(".composer textarea", `${tag} 入口文件`);
await page.press(".composer textarea", "Enter");
await page.waitForTimeout(1500);

// 先改名，和核验脚本一样。
await page.locator(".session-item").filter({ hasText: tag }).first().click({ button: "right" });
await page.waitForSelector(".menu");
await page.getByRole("menuitem", { name: "重命名" }).click();
await page.waitForSelector(".rename-input");
await page.fill(".rename-input", `${tag} 改名`);
await page.press(".rename-input", "Enter");
await page.waitForTimeout(900);

const rowWith = (text: string) => page.locator(".session-item").filter({ hasText: text });
const titleOf = async (text: string): Promise<string> => {
	const row = rowWith(text).first();
	return (await row.count()) === 0 ? "" : ((await row.locator(".session-item-title").textContent()) ?? "").trim();
};

// 1. 派生。
await rowWith(tag).first().click({ button: "right" });
await page.waitForSelector(".menu");
say(`[step 1] 右栏右键菜单：${(await page.locator(".menu-item .menu-label").allTextContents()).join(" / ")}`);
await page.getByRole("menuitem", { name: "派生新会话" }).click();
// 核验脚本在这里等的是「行出现 + aria-current 挪过去」，不是「openSession 整个跑完」——
// aria-current 在 openSession 的第一次 await 之后就变了，而 mux.retain 在最后一次 await 之后。
for (let waited = 0; waited < 8_000; waited += 100) {
	const marked = (await page.locator('.session-item[aria-current="true"]').first().textContent()) ?? "";
	if (marked.includes("（1）")) break;
	await page.waitForTimeout(100);
}
const forkId = await currentId();
say(`fork session   = ${forkId}`);
say(`[step 1] 派生后横幅：${JSON.stringify(await banner())}`);

// 2. 删掉派生会话。
await rowWith(`${tag}`).filter({ hasText: "（1）" }).first().click({ button: "right" });
await page.waitForSelector(".menu");
await page.getByRole("menuitem", { name: "删除" }).click();
await page.waitForTimeout(1200);
say(`[step 2] 删除后横幅：${JSON.stringify(await banner())}`);
say(`[step 2] 当前会话 = ${await currentId()}`);

// 3. 点回源会话行，再对着一条用户消息右键（核验里横幅就是在这一步看到的）。
await rowWith(`${tag} 改名`).first().click();
await page.waitForTimeout(1500);
say(`[step 3] 点回源行后横幅：${JSON.stringify(await banner())}`);
say(`[step 3] 当前会话 = ${await currentId()}  （源会话 id = ${sourceId}）`);

await page.click('.turn[data-role="user"] >> nth=1', { button: "right" });
await page.waitForSelector(".menu");
await page.waitForTimeout(1500);
say(`[step 4] 用户消息右键后横幅：${JSON.stringify(await banner())}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(1500);
say(`[step 5] 再等 1.5s 横幅：${JSON.stringify(await banner())}`);

await page.screenshot({ path: join(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "repro-19-banner.png") });
await browser.close();
await server.close();
await rm(root, { recursive: true, force: true });
