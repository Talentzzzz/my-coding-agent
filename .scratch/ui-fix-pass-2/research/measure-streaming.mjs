// 票 04 的量具驱动：把 research/measure/ 用生产客户端那份 Vite 构建出来，起一个静态服务器，
// 用真 Chromium 打开，再通过 CDP 让页面分别跑「旧帧 / 新帧」两条路径；两条路径前后各读一次
// Performance.getMetrics，把 CDP 自己的计数一并记下来。
//
//   node .scratch/ui-fix-pass-2/research/measure-streaming.mjs
//
// 结果：控制台一张按答案进度分的表，外加 research/streaming-measure.json。
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { launchChromium, openPage } from "../../../scripts/cdp.ts";

const repo = resolve(process.cwd());
const here = join(repo, ".scratch", "ui-fix-pass-2", "research");
const dir = join(here, "measure");
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

let browser;
try {
	browser = await launchChromium({ width: 1000, height: 700 });
	const page = await openPage(browser.port, url, { width: 1000, height: 700 });
	await page.waitFor("window.__ready === true", 20_000);
	await page.send("Performance.enable");

	const metrics = async () => {
		const answer = await page.send("Performance.getMetrics");
		return Object.fromEntries(answer.metrics.filter((entry) => ["ScriptDuration", "TaskDuration", "LayoutCount", "RecalcStyleCount", "JSHeapUsedSize"].includes(entry.name)).map((entry) => [entry.name, entry.value]));
	};

	// Warm up both paths once, so the timed runs are not paying for first-call JIT.
	await page.evaluate("window.__run('old')");
	await page.evaluate("window.__run('new')");

	const beforeOld = await metrics();
	const old = await page.evaluate("window.__run('old')");
	await new Promise((done) => setTimeout(done, 100));
	const afterOld = await metrics();
	const beforeNew = await metrics();
	const updated = await page.evaluate("window.__run('new')");
	await new Promise((done) => setTimeout(done, 100));
	const afterNew = await metrics();

	const delta = (before, after) =>
		Object.fromEntries(Object.keys(after).map((key) => [key, Number((after[key] - (before[key] ?? 0)).toFixed(6))]));

	const report = {
		generatedAt: new Date().toISOString(),
		browser: await page.evaluate("navigator.userAgent"),
		answerChars: updated.answerChars,
		frames: updated.frames,
		old: { ...old, performance: delta(beforeOld, afterOld) },
		new: { ...updated, performance: delta(beforeNew, afterNew) },
	};

	const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
	const ms = (value) => `${value.toFixed(1)} ms`;
	console.log(`\n${report.frames} 帧 / ${report.answerChars} 字；${report.browser}\n`);
	console.log("                   旧（整条消息 × 2）          新（只有 delta）");
	console.log(`  总字节           ${kb(old.bytes).padStart(12)}                 ${kb(updated.bytes).padStart(12)}`);
	console.log(`  最大单帧         ${kb(old.peakBytes).padStart(12)}                 ${kb(updated.peakBytes).padStart(12)}`);
	console.log(`  JSON.parse 总计  ${ms(old.parseMs).padStart(12)}                 ${ms(updated.parseMs).padStart(12)}`);
	console.log(`  重算/归并 总计   ${ms(old.reduceMs).padStart(12)}                 ${ms(updated.reduceMs).padStart(12)}`);
	console.log(`  任务时长(CDP)    ${ms(report.old.performance.TaskDuration * 1000).padStart(12)}                 ${ms(report.new.performance.TaskDuration * 1000).padStart(12)}`);

	console.log("\n按答案进度（每格 = 一段帧的均值）:");
	console.log("  #   答案字数    旧帧字节   新帧字节   旧 parse  新 parse   旧重算    新归并");
	const rows = old.buckets.map((bucket, index) => {
		const next = updated.buckets[index];
		const frames = Math.max(1, bucket.to - bucket.from + 1);
		return {
			index: index + 1,
			answerChars: next.answerChars,
			oldBytes: Math.round(bucket.bytes / frames),
			newBytes: Math.round(next.bytes / frames),
			oldParse: +(bucket.parseMs / frames).toFixed(4),
			newParse: +(next.parseMs / frames).toFixed(4),
			oldReduce: +(bucket.reduceMs / frames).toFixed(4),
			newReduce: +(next.reduceMs / frames).toFixed(4),
		};
	});
	for (const row of rows) {
		console.log(
			`  ${String(row.index).padEnd(3)} ${String(row.answerChars).padStart(8)}  ${String(row.oldBytes).padStart(9)}  ${String(row.newBytes).padStart(9)}  ${String(row.oldParse).padStart(8)}  ${String(row.newParse).padStart(8)}  ${String(row.oldReduce).padStart(8)}  ${String(row.newReduce).padStart(8)}`,
		);
	}

	report.curve = rows;
	const out = join(here, "streaming-measure.json");
	writeFileSync(out, `${JSON.stringify(report, null, "\t")}\n`);
	console.log(`\nwrote ${out}`);
} finally {
	await browser?.close();
	await new Promise((done) => server.close(done));
}
