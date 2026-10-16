// 06 号第 5 条的实测：`.settings-overlay` 的 backdrop-filter: blur(2px) 在软件合成下值不值得留。
//
// 背景（map Notes + ADR-0004）：这台机器上 GPU 进程从未被观察到活着，整窗走软件合成。面板开着时，
// 背后一旦有内容动（流式输出、transcript 自动滚动），overlay 的背板每帧都要重新采样、重新糊一遍。
//
// 方法：bootServer + headless Chromium（软件光栅，与本机 Electron 现状同构），在页面里对**同一
// 尺寸的画布**做 `ctx.filter = "blur(2px)"` 的 drawImage 微基准——这正是 backdrop-filter 在软件
// 光栅下执行的同一个 Skia 原语。每次绘制后 `getImageData` 强制冲刷（drawImage 是异步入队的，
// 不冲刷量到的只是入队时间）。报"无 filter 全视口重画"与"加 blur(2px)"两个每帧均值与差值。
//
// 前四次尝试全部作废，原因记录在案，后来的人别再走：
//   1. rAF 帧距（headless）：rAF 回调不驱动真正的合成帧，三种态逐帧相同，量到的是调度间隔；
//   2. rAF 帧距（有头 + --disable-gpu + --disable-frame-rate-limit）：帧距是回调调度不是 paint，
//      blur 开关的数字互相矛盾（探针在独立合成层上时更是空转）；
//   3. CDP HeadlessExperimental.beginFrame：这个域在新版 Chromium 里已被移除（协议报 wasn't found）；
//   4. CDP Tracing（devtools.timeline）：这个 Chromium 的事件名变了（RasterTask/Commit，没有
//      Paint/Rasterize），且 headless 合成器把帧合并得厉害，per-frame 平均不可靠。
//   node .scratch/window-repair/research/overlay-blur.ts
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

const root = await mkdtemp(join(tmpdir(), "my-agent-blur-"));
const server = await bootServer({ cwd: root, port: 0 });
server.hub.setUserModels(rows);

const executablePath = "C:/Users/a1368/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath, headless: true });
try {
	for (const [width, height] of [
		[1280, 860], // 本机桌面窗口的实测大小
		[1920, 1080], // 更大面积：blur 的成本随面积长，放大了看
	]) {
		say(`viewport ${width}x${height}`);
		const page = await browser.newPage({ viewport: { width, height }, colorScheme: "dark" });
		await page.goto(server.url);
		await page.waitForSelector("textarea", { timeout: 10_000 });
		const result = await page.evaluate(async ({ w, h }: { w: number; h: number }) => {
			const src = document.createElement("canvas");
			src.width = w;
			src.height = h;
			const sctx = src.getContext("2d")!;
			// 背板要有东西可糊：300 块随机色块，近似流式中的 transcript。
			for (let i = 0; i < 300; i += 1) {
				sctx.fillStyle = `hsl(${(i * 37) % 360},80%,60%)`;
				sctx.fillRect(Math.random() * w, Math.random() * h, 140, 90);
			}
			const dst = document.createElement("canvas");
			dst.width = w;
			dst.height = h;
			const dctx = dst.getContext("2d")!;
			const run = (filter: string, times: number): number => {
				const t0 = performance.now();
				for (let i = 0; i < times; i += 1) {
					dctx.clearRect(0, 0, w, h);
					dctx.filter = filter;
					dctx.drawImage(src, 0, 0);
					// drawImage 是异步入队的；读一个像素把这一帧强制光栅出来，否则量到的只是入队。
					dctx.getImageData(0, 0, 1, 1);
				}
				return (performance.now() - t0) / times;
			};
			run("blur(2px)", 10); // 热身
			const blur = run("blur(2px)", 50);
			const plain = run("none", 50);
			return { blur, plain };
		}, { w: width, h: height });
		say(
			`  无 filter 全视口重画 ${result.plain.toFixed(2)}ms/帧  blur(2px) ${result.blur.toFixed(2)}ms/帧  blur 自身 ${(result.blur - result.plain).toFixed(2)}ms/帧`,
		);
		await page.close();
	}
} finally {
	await browser.close();
	await server.close();
}
