// 核验（22 号）：空态里模型位不再读作「（已丢失）」。
//
//   npm run build:web && node .scratch/window-polish/research/verify-22.ts
//
// 走 19 号那条已证实的路：bootServer + 脚本传输 + 本机 Chromium、生产 bundle、真浏览器。
// 「还没轮到选」（model === ""）这个第三态只在空态（snapshot === undefined）现形——新装配的
// 会话快照里已经有装配时采纳的默认行，所以 A 段先钉住这个基线，B 段验删除后的空态
// （19 号 a5 截图撞见的那一处），顺带验占位项不是一次选择；C 段把 models.length === 0 的
// 「未配置模型」一支钉住（本票的判定条件动过它的次序）。
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { SessionSnapshot, UserModel } from "@my-agent/core";

// 隔离 agent home：`AGENT_HOME`（由 `MY_AGENT_HOME` 环境变量驱动）在 config.ts 装载时求值，
// 所以必须在任何 core 模块进来之前把环境变量立住——动态 import 而不是顶部静态 import 就是
// 为此。没有这一步，写进 home 的假模型清单会落到真实的 ~/.my-agent/models.json（19 号的
// 脚本就这么覆盖过一次用户自己的清单，22 号核验途中撞见，见票面 Answer）。
const home = mkdtempSync(join(tmpdir(), "my-agent-verify22-home-"));
process.env.MY_AGENT_HOME = home;

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
// 模型清单要在 boot 之前就位：首个会话在装配时采纳当时的默认行，boot 后再补模型，
// 会话手里已经攥着 unconfigured 占位行了（store 每次都重读文件，所以写文件就够）。
writeFileSync(join(home, "models.json"), `${JSON.stringify({ models: rows }, null, "\t")}\n`, "utf8");

const { bootServer } = await import("../../../packages/server/src/boot.ts");
const { createFakeTransport, fakeAssistantMessage } = await import("../../../scripts/fake-transport.ts");

const fake = createFakeTransport();
const tag = `V22${Math.random().toString(36).slice(2, 7)}`;
const root = await mkdtemp(join(tmpdir(), `my-agent-verify22-${tag}-`));
const server = await bootServer({ cwd: root, port: 0, api: fake.api });
fake.appendResponses(["第一轮的回答。"].map((text) => fakeAssistantMessage(text)));

const outDir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const executablePath = "C:/Users/a1368/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath, headless: true });

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

async function ask(page: import("playwright-core").Page, text: string): Promise<void> {
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

async function until(page: import("playwright-core").Page, label: string, probe: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
	for (let waited = 0; waited < timeoutMs; waited += 120) {
		if (await probe()) return;
		await new Promise((resolve) => setTimeout(resolve, 120));
	}
	throw new Error(`timeout waiting for ${label}`);
}

/** 模型位此刻选中的那个选项：值与可见文案各取一半。 */
async function seatOf(page: import("playwright-core").Page): Promise<{ value: string; label: string }> {
	return page
		.locator('select[aria-label="模型"]')
		.evaluate((el) => {
			const select = el as HTMLSelectElement;
			return { value: select.value, label: select.selectedOptions[0]?.textContent ?? "" };
		});
}

// ============================================================ A：落在装配好的空会话上

const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
page.on("pageerror", (error) => process.stdout.write(`page error: ${error.message}\n`));
await page.goto(server.url);
await page.waitForSelector("textarea", { timeout: 10_000 });
await page.waitForSelector('.channel-indicator[data-state="live"]', { timeout: 15_000 });
await page.waitForSelector(".session-item", { timeout: 15_000 });
await until(page, "hero 欢迎态出现", async () => page.locator(".welcome").isVisible());

// 装配过的会话快照里已经有默认行，座位应显示那一行，而不是任何占位或「已丢失」。
const fresh = await seatOf(page);
check("新会话上座位显示装配采纳的那一行", fresh.value === "scripted/claude-sonnet-4-5" && fresh.label === "scripted", JSON.stringify(fresh));

// 发一句话让会话把选择记下来，座位继续跟那一行。
await ask(page, `${tag} 看结构`);
const { sessionId } = (await fetch(`${server.url}/api/sessions/current`, {
	headers: { accept: "application/json" },
}).then((response) => response.json() as Promise<{ sessionId: string }>));
await settle(sessionId, 2);
const live = await seatOf(page);
check("发话后座位仍是那一行", live.value === "scripted/claude-sonnet-4-5" && live.label === "scripted", JSON.stringify(live));

// ============================================================ B：删掉正在读的会话

const row = page.locator(".session-item").filter({ hasText: tag }).first();
await row.click({ button: "right" });
await page.waitForSelector(".menu", { timeout: 3_000 });
await page.getByRole("menuitem", { name: "删除" }).click();
await until(page, "窗口回到空态（hero）", async () => page.locator(".welcome").isVisible());
await page.waitForTimeout(400);
const empty = await seatOf(page);
check("删除后模型位的值是空串（第三态到达）", empty.value === "", JSON.stringify(empty));
check("删除后模型位读作「选择模型」而不是「（已丢失）」", empty.label === "选择模型", empty.label);
check("空态下模型位可用（还有模型可选）", await page.locator('select[aria-label="模型"]').isEnabled());
await page.screenshot({ path: join(outDir, "v22-b1-empty-seat.png") });
say("B1 v22-b1-empty-seat.png");

// 占位项不是模型：把它选上（change 以空串发出）不该被当成一次选择记下。
await page.locator('select[aria-label="模型"]').selectOption("");
// 随即新建一个会话：新会话有自己的装配模型，座位必须跟它——若空串被记成了选择，
// 这里会被压在空串上、继续读「选择模型」。
await page.locator(".new-session").click();
await until(page, "新会话的座位显示装配模型", async () => (await seatOf(page)).value === "scripted/claude-sonnet-4-5");
const reopened = await seatOf(page);
check("选过占位项后新建会话，座位跟新会话的模型", reopened.value === "scripted/claude-sonnet-4-5" && reopened.label === "scripted", JSON.stringify(reopened));

await page.close();

// ============================================================ C：一个模型都没配

// 第二台：一个模型都没配——「未配置模型」那一支的原样回归。两台服务器共享这个进程唯一的
// agent home，所以起它之前把第一台写下的模型清单抹掉（store 每次都重读文件，改文件就够）。
const emptyRoot = await mkdtemp(join(tmpdir(), `my-agent-verify22-bare-`));
writeFileSync(join(home, "models.json"), '{\n\t"models": []\n}\n', "utf8");
const bareServer = await bootServer({ cwd: emptyRoot, port: 0, api: fake.api });

const barePage = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
await barePage.goto(bareServer.url);
await barePage.waitForSelector("textarea", { timeout: 10_000 });
await barePage.waitForSelector('.channel-indicator[data-state="live"]', { timeout: 15_000 });
await until(barePage, "无模型横幅出现", async () => barePage.locator(".notice-card").isVisible());
const bare = await seatOf(barePage);
check("未配置模型时座位读作「未配置模型」", bare.label === "未配置模型", JSON.stringify(bare));
check("未配置模型时座位不可用", !(await barePage.locator('select[aria-label="模型"]').isEnabled()));
await barePage.close();

await browser.close();
await server.close();
await bareServer.close();
await rm(root, { recursive: true, force: true });
await rm(emptyRoot, { recursive: true, force: true });
await rm(home, { recursive: true, force: true });
say(failures === 0 ? "verify-22: 全绿" : `verify-22: ${failures} FAILURES`);
if (failures > 0) process.exitCode = 1;
