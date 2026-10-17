// Ticket 02 (mode-only composer seat, editable built-in default mode, roomier tool rows), checked in
// a real browser.
//
// The acceptance is what the window actually does, not what a unit test says: the composer bar has
// one seat on the left and no session-settings door; the built-in default card in 设置 → 模式 opens
// the same inline form the stored modes do, saves the global tools/approval, and a session created
// afterwards opens on the new defaults. The row-spacing half is measured as computed style.
//
//   npm run build:web && node .scratch/ui-fix-pass/research/verify-02.ts [--shots]
//
// `--shots` writes the comparison images next to this file; without it the checks alone run.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { UserModel } from "@my-agent/core";

const shots = process.argv.includes("--shots");
const { chromium } = createRequire(import.meta.url)(
	"C:/Users/a1368/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js",
);

let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

const root = await mkdtemp(join(tmpdir(), "my-agent-verify-02-"));
process.env.MY_AGENT_HOME = join(root, "home");
const { bootServer } = await import("../../../packages/server/src/boot.ts");

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
await writeFile(join(root, "README.md"), "# my-coding-agent\n");

// No provider call is made: the ticket is about the settings panel and the composer bar, so the
// server's real transport is never reached.
const server = await bootServer({ cwd: root, port: 0 });
server.hub.setUserModels(rows);

const browser = await chromium.launch({
	executablePath: "C:/Users/a1368/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe",
	headless: true,
});
const outDir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
page.on("pageerror", (error: Error) => process.stdout.write(`page error: ${error.message}\n`));
await page.goto(server.url);
await page.waitForSelector("textarea", { timeout: 10_000 });
await page.waitForTimeout(800);

async function settings(): Promise<{
	tools?: string[];
	approval: Record<string, boolean>;
	modes?: unknown;
}> {
	const response = await fetch(`${server.url}/api/settings`, { headers: { accept: "application/json" } });
	return ((await response.json()) as { settings: { tools?: string[]; approval: Record<string, boolean>; modes?: unknown } })
		.settings;
}

// ------------------------------------------------------------------ 1. the composer bar

process.stdout.write("\n02：输入框左下角只剩模式座位\n");
{
	const children = await page.$$eval(".composer-bar > *", (elements: Element[]) =>
		elements.map((element) => element.className),
	);
	check("bar 的第一个座位是模式", children[0]?.includes("composer-mode") === true, JSON.stringify(children));
	check("会话设置齿轮不再存在", (await page.locator(".composer-gear").count()) === 0);
	check("没有「会话设置」按钮", (await page.locator('[title="会话设置"]').count()) === 0);
	check(
		"模式座位是左端唯一的会话控件",
		(await page.locator(".composer-bar .composer-mode").count()) === 1 &&
			(await page.locator(".composer-bar .icon-button").count()) === 0,
	);

	if (shots) await page.locator(".composer-bar").screenshot({ path: join(outDir, "after-02-composer-bar.png") });
}

// -------------------------------------------------- 2. the built-in default mode opens a form

process.stdout.write("\n02：「默认」模式可点开、可保存\n");
{
	const before = await settings();
	await page.locator(".settings-entry").click();
	await page.waitForSelector(".app-settings", { timeout: 10_000 });
	await page.locator(".settings-nav-item", { hasText: "模式" }).click();
	await page.waitForSelector(".settings-body .model-row", { timeout: 10_000 });

	const card = page.locator(".settings-body .model-row").first();
	check("收起时没有展开的工具行", (await card.locator(".mode-tool").count()) === 0);
	check("内置模式没有删除按钮", (await card.locator(".model-row-del").count()) === 0);
	const headText = (await card.locator(".model-row-head").innerText()).replace(/\s+/g, " ");
	check(
		"收起时是一行摘要",
		headText.includes("默认") && headText.includes("内置") && /个工具/.test(headText),
		headText,
	);

	await card.locator(".model-row-head").click();
	const form = page.locator(".settings-body .model-form").first();
	await form.waitFor({ timeout: 10_000 });
	check("名称不可编辑", (await form.locator('input[type="text"]').count()) === 0);
	const nameText = (await form.locator(".mode-name-static").innerText()).replace(/\s+/g, " ");
	check("名称显示「默认」+「内置」", nameText.includes("默认") && nameText.includes("内置"), nameText);

	const toolRows = form.locator(".mode-tool");
	check("工具勾选与审批下拉可改", (await toolRows.count()) >= 8, String(await toolRows.count()));

	// C. the row spacing: 8px apart, 30px high, and all three controls share one middle line.
	const gap = await form.locator(".mode-tooltable").evaluate((element: Element) => getComputedStyle(element).rowGap);
	check("行距 8px", gap === "8px", gap);
	const heights = await toolRows.evaluateAll((elements: Element[]) =>
		elements.map((element) => element.getBoundingClientRect().height),
	);
	check("行高 30px", heights.every((height) => Math.abs(height - 30) < 0.6), JSON.stringify(heights));
	const selectHeight = await form
		.locator(".mode-tool-approval")
		.first()
		.evaluate((element: Element) => getComputedStyle(element).height);
	check("下拉高 30px", selectHeight === "30px", selectHeight);
	const middles = await toolRows.first().evaluate((element: Element) => {
		const rect = (selector: string): number => {
			const box = element.querySelector(selector)!.getBoundingClientRect();
			return box.top + box.height / 2;
		};
		return [rect("input"), rect(".mode-tool-name"), rect("select")];
	});
	check("复选框、名称与下拉同一中线", Math.max(...middles) - Math.min(...middles) < 1, JSON.stringify(middles));

	// Edit the draft: turn `bash` off and ask before `glob` (auto-allowed by default).
	await form.locator('input[aria-label="启用 bash"]').uncheck();
	const globRow = form.locator(".mode-tool").filter({ has: page.locator('input[aria-label="启用 glob"]') });
	await globRow.locator("select").selectOption("ask");
	check("改动尚未写盘", (await settings()).tools === before.tools, JSON.stringify((await settings()).tools));

	if (shots) await page.locator(".app-settings").screenshot({ path: join(outDir, "after-02-default-form.png") });

	await form.getByRole("button", { name: "保存" }).click();

	let saved = await settings();
	for (let waited = 0; waited < 10_000; waited += 100) {
		saved = await settings();
		if (saved.tools !== undefined && !saved.tools.includes("bash") && saved.approval.glob === true) break;
		await page.waitForTimeout(100);
	}
	check("保存写了全局工具集", saved.tools !== undefined && !saved.tools.includes("bash") && saved.tools.length === 7, JSON.stringify(saved.tools));
	check("保存写了全局审批", saved.approval.glob === true && saved.approval.bash === true, JSON.stringify(saved.approval));
	check("没有回写 modes 列表", JSON.stringify(saved.modes) === JSON.stringify(before.modes), JSON.stringify(saved.modes));

	await page.waitForFunction(() => document.querySelectorAll(".settings-body .model-form").length === 0, { timeout: 10_000 });
	const summary = (await card.locator(".mode-summary").innerText()).replace(/\s+/g, " ");
	check("保存后收起为一行摘要", summary.includes("7 个工具") && summary.includes("3 项询问"), summary);

	// The acceptance's last sentence: a session created afterwards opens on the new defaults.
	const created = (await fetch(`${server.url}/api/sessions`, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/json" },
		body: JSON.stringify({ cwd: root }),
	}).then((response) => response.json())) as { sessionId: string };
	const read = (await fetch(`${server.url}/api/sessions/${encodeURIComponent(created.sessionId)}`, {
		headers: { accept: "application/json" },
	}).then((response) => response.json())) as {
		session: { activeTools: string[]; approvals: Record<string, boolean> };
	};
	check(
		"新会话按新工具集打开",
		read.session.activeTools.length === 7 && !read.session.activeTools.includes("bash"),
		JSON.stringify(read.session.activeTools),
	);
	check(
		"新会话按新的审批开",
		read.session.approvals.glob === true && read.session.approvals.read === false,
		JSON.stringify(read.session.approvals),
	);
}

await browser.close();
await server.close();
await rm(root, { recursive: true, force: true });

process.stdout.write(failures === 0 ? "\n02 ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
