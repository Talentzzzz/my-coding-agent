// 票 05 的量具驱动：把 research/measure-render/ 用生产客户端那份 Vite 构建出来，起一个静态服务器，
// 用真 Chromium 打开，逐个配置跑「尾块就地补 / 尾块每帧重建」×「一整段长段落 / 空行分段」；
// 每条满跑前后各读一次 Performance.getMetrics，长任务由页面加载前装好的 PerformanceObserver 计数。
//
//   node .scratch/ui-fix-pass-2/research/measure-render.mjs
//
// 结果：控制台一张表，外加 research/render-measure.json。
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { launchChromium, openPage } from "../../../scripts/cdp.ts";

const repo = resolve(process.cwd());
const here = join(repo, ".scratch", "ui-fix-pass-2", "research");
const dir = join(here, "measure-render");
const dist = join(dir, "dist");
const vite = join(repo, "packages", "web", "node_modules", "vite", "bin", "vite.js");

if (!existsSync(vite)) throw new Error(`找不到 Vite：${vite}`);
console.log("building the measure page…");
// Flags rather than a config file: Vite copies a config into `node_modules/.vite-temp` and imports
// `vite` from there, which resolves against the repo root, where Vite is not installed — the CLI
// entry point it is already running under needs no such import.
const built = spawnSync(process.execPath, [vite, "build", dir, "--base", "./", "--outDir", "dist", "--emptyOutDir"], {
	cwd: join(repo, "packages", "web"),
	encoding: "utf8",
});
if (built.status !== 0) {
	process.stderr.write(built.stdout ?? "");
	process.stderr.write(built.stderr ?? "");
	throw new Error(`构建失败（${built.status}）`);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };
const server = createServer((request, response) => {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	const file = join(dist, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
	if (!existsSync(file) || !statSync(file).isFile()) {
		response.writeHead(404).end("not found");
		return;
	}
	response.writeHead(200, { "content-type": TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" });
	createReadStream(file).pipe(response);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}/`;

// 装在文档之前：事后装的观察者看不到它自己装好之前的长任务。
const initScript = `window.__longTasks = 0; new PerformanceObserver((list) => { window.__longTasks += list.getEntries().length; }).observe({ type: "longtask", buffered: true });`;

const CONFIGS = [
	{ strategy: "patch", shape: "solid", label: "补写 · 一整段" },
	{ strategy: "legacy", shape: "solid", label: "重建 · 一整段" },
	{ strategy: "patch", shape: "spaced", label: "补写 · 空行分段" },
	{ strategy: "legacy", shape: "spaced", label: "重建 · 空行分段" },
];

let browser;
try {
	browser = await launchChromium({ width: 1000, height: 700 });
	const page = await openPage(browser.port, url, { width: 1000, height: 700, initScript });
	await page.waitFor("window.__ready === true", 20_000);
	await page.send("Performance.enable");

	const metrics = async () => {
		const answer = await page.send("Performance.getMetrics");
		return Object.fromEntries(
			answer.metrics
				.filter((entry) => ["ScriptDuration", "TaskDuration", "LayoutCount", "RecalcStyleCount"].includes(entry.name))
				.map((entry) => [entry.name, entry.value]),
		);
	};
	const longTasks = async () => page.evaluate("window.__longTasks");

	// 每条配置先热一小段，让满跑不为首次 JIT 买单。
	for (const config of CONFIGS) await page.evaluate(`window.__run('${config.strategy}', '${config.shape}', 60)`);

	const results = [];
	for (const config of CONFIGS) {
		const before = await metrics();
		const tasksBefore = await longTasks();
		const stats = await page.evaluate(`window.__run('${config.strategy}', '${config.shape}')`);
		await new Promise((done) => setTimeout(done, 100));
		const after = await metrics();
		const tasksAfter = await longTasks();
		const delta = Object.fromEntries(
			Object.keys(after).map((key) => [key, Number((after[key] - (before[key] ?? 0)).toFixed(6))]),
		);
		results.push({ ...config, ...stats, performance: delta, longTasks: tasksAfter - tasksBefore });
	}

	const ms = (value) => `${value.toFixed(1)}`;
	console.log(`\n${results[0].frames} 帧 × ${CONFIGS.length} 配置 · ${results[0].answerChars} 字回答 · ${await page.evaluate("navigator.userAgent")}\n`);
	console.log("配置                脚本总计   每帧 p95   帧间隔 p95   Layout  Style   任务(CDP)   长任务");
	for (const entry of results) {
		const cells = [
			entry.label.padEnd(10),
			`${ms(entry.workTotalMs)} ms`.padStart(10),
			`${ms(entry.workP95Ms)} ms`.padStart(10),
			`${ms(entry.intervalP95Ms)} ms`.padStart(11),
			String(Math.round(entry.performance.LayoutCount)).padStart(8),
			String(Math.round(entry.performance.RecalcStyleCount)).padStart(7),
			`${(entry.performance.TaskDuration * 1000).toFixed(0)} ms`.padStart(11),
			String(entry.longTasks).padStart(6),
		];
		console.log(`  ${cells.join("  ")}`);
	}

	const out = join(here, "render-measure.json");
	writeFileSync(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, "\t")}\n`);
	console.log(`\nwrote ${out}`);
} finally {
	await browser?.close();
	await new Promise((done) => server.close(done));
}
