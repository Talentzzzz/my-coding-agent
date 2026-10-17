// Ticket 04 (the built-in default model and the renamed model fields), checked in a real browser.
//
// The acceptance is what a window does on a machine with no imported model: the list is seeded with
// one `deepseek-flash` row through the ordinary model endpoint, that row is what the input box is on,
// a key typed into the panel makes it runnable, and deleting it stays deleted across a restart. The
// fields half is checked on the same open form, in the production panel rather than a shim.
//
// `MY_AGENT_HOME` is a scratch directory, so the machine's own models and settings are never read or
// written. The transport is scripted (`scripts/fake-transport.ts`): the send below proves the seeded
// row reaches the runnable path, not that DeepSeek would answer — no provider key is used or needed.
//
//   npm run build:web && node .scratch/ui-fix-pass/research/verify-04.ts [--shots]
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { ModelOption, SettingsSnapshot } from "@my-agent/core/protocol";

const shots = process.argv.includes("--shots");
const { chromium } = createRequire(import.meta.url)(
	"C:/Users/a1368/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js",
);

let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

const root = await mkdtemp(join(tmpdir(), "my-agent-verify-04-"));
const home = join(root, "home");
// Before anything from @my-agent/core is imported: `AGENT_HOME` is read at module load.
process.env.MY_AGENT_HOME = home;
const { bootServer } = await import("../../../packages/server/src/boot.ts");
const { modelsPath, settingsPath } = await import("@my-agent/core");
const { createFakeTransport, fakeAssistantMessage } = await import("../../../scripts/fake-transport.ts");

await writeFile(join(root, "README.md"), "# 默认模型验证\n");

/** Wait for a condition the server answers, so a write is never raced by the next assertion. */
async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
}

async function getModels(url: string): Promise<ModelOption[]> {
	const response = await fetch(`${url}/api/models`, { headers: { accept: "application/json" } });
	return ((await response.json()) as { models: ModelOption[] }).models;
}

async function getSettings(url: string): Promise<SettingsSnapshot> {
	const response = await fetch(`${url}/api/settings`, { headers: { accept: "application/json" } });
	return ((await response.json()) as { settings: SettingsSnapshot }).settings;
}

async function readModelsFile(): Promise<unknown[]> {
	const text = await readFile(modelsPath(home), "utf8");
	return (JSON.parse(text) as { models: unknown[] }).models;
}

const WANTED_LABELS = [
	"名称",
	"模型",
	"BASE URL",
	"API KEY",
	"上下文长度",
	"最大输出长度",
	"思考模式",
	"默认思考强度",
];

const fake = createFakeTransport();
fake.setResponses([fakeAssistantMessage("已收到：种下的默认模型这一行能发请求。")]);

const browser = await chromium.launch({
	executablePath: "C:/Users/a1368/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe",
	headless: true,
});
const outDir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/**
 * Open a window on a server and wait until its first boot has run to the point the model seat is
 * drawn: settings, the seeding decision, and the list all happen in that order, so a non-empty seat
 * means the decision has already been made.
 */
async function openWindow(url: string): Promise<Awaited<ReturnType<typeof browser.newPage>>> {
	const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
	page.on("pageerror", (error: Error) => process.stdout.write(`page error: ${error.message}\n`));
	await page.goto(url);
	await page.waitForSelector("textarea", { timeout: 15_000 });
	await page.waitForFunction(
		() => {
			const select = document.querySelector('select[aria-label="模型"]');
			return select instanceof HTMLSelectElement && select.value.length > 0;
		},
		undefined,
		{ timeout: 15_000 },
	);
	return page;
}

let server = await bootServer({ cwd: root, port: 0, api: fake.api });
let page = await openWindow(server.url);

// ------------------------------------------------------------- 1. an empty list gets seeded

process.stdout.write("\n04：空列表启动，窗口种下 deepseek-flash\n");
{
	// The seed write is the window's first model request, so waiting for the server to hold the row is
	// also waiting for the boot sequence to have reached it.
	const seeded = await waitUntil(async () => (await getModels(server.url)).length === 1);
	check("启动后列表里出现一行", seeded, JSON.stringify((await getModels(server.url)).map((row) => row.name)));

	const models = await getModels(server.url);
	const row = models[0];
	check(
		"名称与模型都是 deepseek-flash",
		row?.name === "deepseek-flash" && row.modelId === "deepseek-flash",
		JSON.stringify({ name: row?.name, modelId: row?.modelId }),
	);
	check("BASE URL 是 DeepSeek 的 Anthropic 端点", row?.baseUrl === "https://api.deepseek.com/anthropic", String(row?.baseUrl));
	check("上下文长度是 1,000,000", row?.contextWindow === 1_000_000, String(row?.contextWindow));
	check("最大输出长度是 384,000", row?.maxTokens === 384_000, String(row?.maxTokens));
	check("思考模式开着、默认强度是 high", row?.reasoning === true && row?.defaultThinkingLevel === "high", JSON.stringify({ reasoning: row?.reasoning, level: row?.defaultThinkingLevel }));
	check("密钥空着，留给用户填", row?.hasApiKey === false, String(row?.hasApiKey));

	const settings = await getSettings(server.url);
	check("settings 里落了「已种过」的标记", settings.defaultModelSeeded === true, String(settings.defaultModelSeeded));
	const onDisk = await readModelsFile();
	check("models.json 磁盘上就是这一行", onDisk.length === 1, JSON.stringify(onDisk));

	const seat = await page.locator('select[aria-label="模型"]').inputValue();
	check("输入框的模型座位已经落在这行上", seat === "deepseek-flash/deepseek-flash", seat);
}

// ------------------------------------------------------ 2. the form and its eight labels

process.stdout.write("\n04：设置 → 模型里是这一行，八个标签逐字一致\n");
{
	await page.locator(".settings-entry").click();
	await page.waitForSelector(".app-settings", { timeout: 10_000 });
	await page.locator(".settings-nav-item", { hasText: "模型" }).click();
	await page.waitForSelector(".settings-body .model-row", { timeout: 10_000 });

	const rows = page.locator(".settings-body .model-row");
	check("列表里只有这一行", (await rows.count()) === 1, String(await rows.count()));
	const headText = (await rows.first().locator(".model-row-head").innerText()).replace(/\s+/g, " ");
	check("行上写着名字与引用", headText.includes("deepseek-flash/deepseek-flash"), headText);

	await rows.first().locator(".model-row-head").click();
	const form = page.locator(".settings-body .model-form").first();
	await form.waitFor({ timeout: 10_000 });

	if (shots) await page.locator(".app-settings").screenshot({ path: join(outDir, "after-04-seeded.png") });
	const labels = await form.locator(".model-field").evaluateAll((fields: Element[]) =>
		fields.map(
			(field) =>
				field.querySelector(".settings-label")?.textContent ??
				field.querySelector(".model-check")?.textContent?.trim() ??
				"",
		),
	);
	check("新建/编辑表单八个字段齐全", labels.length === 8, JSON.stringify(labels));
	check("标签逐字是用户要的八个", JSON.stringify(labels) === JSON.stringify(WANTED_LABELS), JSON.stringify(labels));

	// Fill the key through the form, as the person would: this is the one thing the seed cannot do for
	// them, and the row has to be able to carry it afterwards.
	await form.locator('input[type="password"]').fill("sk-verify-04-not-a-provider-credential");
	await form.getByRole("button", { name: "保存" }).click();
	const keyed = await waitUntil(async () => (await getModels(server.url))[0]?.hasApiKey === true);
	check("在表单里填的密钥落到了这一行", keyed, String((await getModels(server.url))[0]?.hasApiKey));
	const kept = (await getModels(server.url))[0];
	check(
		"存密钥不改动这一行的其他字段",
		kept?.contextWindow === 1_000_000 && kept.maxTokens === 384_000 && kept.baseUrl === "https://api.deepseek.com/anthropic",
		JSON.stringify(kept),
	);
}

// ---------------------------------------------- 3. the seeded, keyed row can send a message

process.stdout.write("\n04：填了 key 的种子行走真实发送路径（脚本化传输）\n");
{
	await page.locator('[title="关闭设置"]').click();
	await page.locator("textarea").fill("用一句话确认你收到了。");
	await page.locator("textarea").press("Enter");
	// The scripted transport answers in one message; the sentence on screen is the run's own evidence.
	const answered = await page
		.waitForFunction(() => document.body.innerText.includes("种下的默认模型这一行能发请求"), undefined, { timeout: 30_000 })
		.then(() => true)
		.catch(() => false);
	check("请求发出去了", fake.state.callCount === 1, String(fake.state.callCount));
	check("回答落在转录里", answered);
}

// ---------------------------------------------------- 4. deleting the row is final in settings

process.stdout.write("\n04：删掉这一行\n");
{
	await page.locator(".settings-entry").click();
	await page.waitForSelector(".app-settings", { timeout: 10_000 });
	await page.locator(".settings-nav-item", { hasText: "模型" }).click();
	await page.waitForSelector(".settings-body .model-row", { timeout: 10_000 });
	await page.locator(".settings-body .model-row .model-row-del").first().click();
	await page.waitForSelector(".settings-body .model-confirm", { timeout: 10_000 });
	await page.locator(".settings-body .model-confirm .button.danger").click();

	const deleted = await waitUntil(async () => (await getModels(server.url)).length === 0);
	check("删除之后列表为空", deleted, JSON.stringify((await getModels(server.url)).map((row) => row.name)));
	await page.waitForSelector(".settings-body .settings-hint.empty", { timeout: 10_000 });
	check("面板说的是还没有模型", (await page.locator(".settings-body .settings-hint.empty").innerText()).includes("还没有模型"));
	check("磁盘上也没有行了", (await readModelsFile()).length === 0);
	const settings = await getSettings(server.url);
	check("「已种过」的标记仍然在", settings.defaultModelSeeded === true, String(settings.defaultModelSeeded));

	if (shots) await page.locator(".app-settings").screenshot({ path: join(outDir, "after-04-deleted.png") });
}

// --------------------------------------------------- 5. a restart does not plant it again

process.stdout.write("\n04：重启窗口，删掉的行不复活\n");
{
	await page.close();
	await server.close();

	server = await bootServer({ cwd: root, port: 0, api: fake.api });
	page = await openWindow(server.url);

	// The boot sequence is over when the seat is drawn; give the seeding decision the same beat the
	// first window had, then ask the server rather than the screen alone.
	await page.waitForTimeout(1_000);
	const models = await getModels(server.url);
	check("重启后列表仍然是空的", models.length === 0, JSON.stringify(models.map((row) => row.name)));
	const settings = await getSettings(server.url);
	check("标记还是「已种过」", settings.defaultModelSeeded === true, String(settings.defaultModelSeeded));
	const stored = JSON.parse(await readFile(settingsPath(home), "utf8")) as Record<string, unknown>;
	check("settings.json 里就写着 true", stored.defaultModelSeeded === true, JSON.stringify(stored.defaultModelSeeded));
	check("磁盘上的 models.json 仍然是空的", (await readModelsFile()).length === 0);

	const seat = await page.locator('select[aria-label="模型"]').inputValue();
	check("座位落在占位模型上，而不是复活的那一行", seat === "my-agent:unconfigured/no-model", seat);

	await page.locator(".settings-entry").click();
	await page.waitForSelector(".app-settings", { timeout: 10_000 });
	await page.locator(".settings-nav-item", { hasText: "模型" }).click();
	await page.waitForSelector(".settings-body .settings-hint.empty", { timeout: 10_000 });
	check("面板里也没有这一行", (await page.locator(".settings-body .model-row").count()) === 0);
}

await browser.close();
await server.close();
await rm(root, { recursive: true, force: true });

process.stdout.write(failures === 0 ? "\n04 ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
