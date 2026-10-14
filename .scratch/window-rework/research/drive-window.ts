// 真窗口驱动器（09 第 3 条的证据）：用真 Chromium（本机缓存）打开真服务器（live-window.ts）服务的
// 生产客户端 bundle，从输入框真的发一句话，然后在流式过程中采样 DOM——思考行、运行中的工具卡、
// 增量刷新的输出——并存两张截图。跑法：
//   node .scratch/window-rework/research/drive-window.ts <url>
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// playwright-core 装在托管 workspace 里（不进仓库、不进全局），所以按绝对路径 require。
const { chromium } = createRequire(import.meta.url)(
	"C:/Users/a1368/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js",
);

const url = process.argv[2] ?? "http://127.0.0.1:62117";
const outDir = await mkdtemp(join(tmpdir(), "my-agent-drive-"));
const executablePath = "C:/Users/a1368/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.goto(url);
await page.waitForSelector("textarea", { timeout: 10_000 });
// 启动是异步的（health → settings → models → refreshLists → openSession → mux.start），
// 等"跟随的会话"就位：发早了会得到"还没有挂上任何会话"。
await page.waitForTimeout(2_000);
await page.getByText("新建会话", { exact: true }).click();
await page.waitForTimeout(1_000);

const say = (line: string): void => process.stdout.write(`${line}\n`);
const sample = (): Promise<{ reasoning: number; reasoningPreview: string | null; tools: number; runningTools: number; outputLens: number[] }> =>
	page.evaluate(() => {
		const reasoning = document.querySelectorAll("details.reasoning");
		const tools = document.querySelectorAll("section.tool-group details.tool");
		const running = document.querySelectorAll("section.tool-group details.tool.running");
		const outputs = [...document.querySelectorAll("section.tool-group pre.tool-output")].map((n) => (n.textContent ?? "").length);
		const preview = document.querySelector("details.reasoning .reasoning-preview");
		return {
			reasoning: reasoning.length,
			reasoningPreview: preview?.textContent ?? null,
			tools: tools.length,
			runningTools: running.length,
			outputLens: outputs,
		};
	});

// 发送一句话：走真输入框、真 Enter。
await page.fill("textarea", "读一下 note.txt，告诉我里面有什么");
await page.press("textarea", "Enter");
say("prompt sent");

// 流式采样：每 300ms 采一次，共 ~24 次（脚本 transport 是 120 tokens/s，够看完整过程）。
const samples = [];
for (let i = 0; i < 24; i += 1) {
	await page.waitForTimeout(300);
	samples.push({ t: (i + 1) * 0.3, ...(await sample()) });
	if (i === 5) await page.screenshot({ path: join(outDir, "streaming.png") });
	if (i === 11) await page.screenshot({ path: join(outDir, "streaming-late.png") });
}

// 落定后的状态与截图（等待 run 结束：输入框的停止按钮消失）。
await page.waitForSelector("button.stop", { state: "detached", timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(500);
const final = await sample();
await page.screenshot({ path: join(outDir, "settled.png") });

say("samples:");
for (const s of samples) {
	say(
		`t=${s.t.toFixed(1)}s reasoning=${s.reasoning} preview="${(s.reasoningPreview ?? "").slice(0, 40)}" tools=${s.tools} running=${s.runningTools} outLen=[${s.outputLens.join(",")}]`,
	);
}
say(`final: reasoning=${final.reasoning} tools=${final.tools} running=${final.runningTools} outLen=[${final.outputLens.join(",")}]`);
say(`screenshots in ${outDir}`);
await writeFile(join(outDir, "samples.json"), JSON.stringify(samples, null, 2));

// 展开思考行，验证可折叠切换。
const details = page.locator("details.reasoning").first();
if ((await details.count()) > 0) {
	await details.locator("summary").click();
	await page.waitForTimeout(200);
	const open = await details.getAttribute("open");
	say(`expanded after click: open=${open !== null}`);
	await page.screenshot({ path: join(outDir, "expanded.png") });
}

await browser.close();
