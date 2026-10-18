// 票 05 的量具：真窗口 + 真服务端 + 真 transport，同一段 8k 字回答的两种形状（一整段 vs 有空行），
// 量流式期间的**主线程长任务**、**帧间隔 p50/p95/max**、CDP 的 LayoutCount / RecalcStyleCount /
// TaskDuration。
//
//   node .scratch/ui-fix-pass-2/research/measure-window.mjs --label before
//
// 假供应商（fake-anthropic.mjs）按固定节拍吐 SSE，所以两次运行、两种形状的节拍完全一样。
// 结果写 research/window-measure-<label>.json。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchChromium, openPage } from "../../../scripts/cdp.ts";
import { startFakeAnthropic } from "./fake-anthropic.mjs";

const repo = resolve(process.cwd());
const here = join(repo, ".scratch", "ui-fix-pass-2", "research");
const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "run";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const CHARS = 8_000;
const PARAGRAPH = "这是一段用来测量流式渲染的回答，它足够长，长到后半段每来一个 token 都值得算一次账；句子本身没有换行，所以一整段就是一个块。";

function reply(blankLines) {
	const base = PARAGRAPH.repeat(Math.ceil(CHARS / PARAGRAPH.length)).slice(0, CHARS);
	if (!blankLines) return base;
	// The same characters, cut into paragraphs: the contrast the ticket asks for is "one block that
	// grows to 8k" against "many blocks that each stay small".
	const parts = [];
	for (let index = 0; index < base.length; index += 120) parts.push(base.slice(index, index + 120));
	return parts.join("\n\n").slice(0, CHARS);
}

const OBSERVER = `(() => {
	const stats = { longTasks: [], frames: [], streaming: { running: false, startedAt: 0, endedAt: 0 } };
	window.__bench = stats;
	try {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) stats.longTasks.push(entry.duration);
		}).observe({ entryTypes: ["longtask"] });
	} catch {}
	const read = () => {
		const on = document.querySelector(".transcript")?.classList.contains("streaming") === true;
		if (on === stats.streaming.running) return;
		stats.streaming.running = on;
		if (on) stats.streaming.startedAt = performance.now();
		else stats.streaming.endedAt = performance.now();
	};
	// Sampled from the frame loop rather than from a MutationObserver: the frame is already the
	// clock this harness trusts, and observing the document at document start is not guaranteed to
	// have an element to observe.
	const tick = (at) => {
		stats.frames.push(at);
		read();
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
})();`;

function freePort() {
	return new Promise((done, fail) => {
		const probe = createServer();
		probe.once("error", fail);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			probe.close(() => done(address.port));
		});
	});
}

function percentile(values, fraction) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

// The window has to be rebuilt: `dist` is what the server serves.
console.log("building the window…");
const build = spawn(process.execPath, [join(repo, "packages", "web", "node_modules", "vite", "bin", "vite.js"), "build"], {
	cwd: join(repo, "packages", "web"),
	stdio: "inherit",
});
await new Promise((done) => build.once("exit", done));

const provider = await startFakeAnthropic([
	{ text: reply(false), chunkChars: 4, everyMs: 2 },
	{ text: reply(true), chunkChars: 4, everyMs: 2 },
]);

const home = mkdtempSync(join(tmpdir(), "mca-window-bench-"));
mkdirSync(join(home, "sessions"), { recursive: true });
// The store's file shape, not a bare array: a bare array reads as no rows, the window then plants
// its keyless built-in row, and the session sends to DeepSeek instead of the fake endpoint.
writeFileSync(
	join(home, "models.json"),
	`${JSON.stringify({
		models: [
			{
				name: "bench",
				baseUrl: provider.url,
				apiKey: "bench-key-not-a-secret",
				modelId: "bench",
				contextWindow: 200_000,
				maxTokens: 8_192,
				reasoning: false,
			},
		],
	}, null, "\t")}\n`,
);

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(
	process.execPath,
	["packages/server/src/main.ts", "--port", String(port), "--cwd", repo, "--model", "bench/bench"],
	{ cwd: repo, env: { ...process.env, MY_AGENT_HOME: home }, stdio: "ignore" },
);

async function waitForHealth() {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`${base}/api/health`)).ok) return;
		} catch {
			// not listening yet
		}
		await sleep(100);
	}
	throw new Error("服务端没有起来");
}

const METRICS = ["LayoutCount", "RecalcStyleCount", "TaskDuration", "ScriptDuration"];

let browser;
const report = { label, generatedAt: new Date().toISOString(), scenarios: [] };
try {
	await waitForHealth();
	browser = await launchChromium({ width: 1280, height: 820 });
	const page = await openPage(browser.port, base, { width: 1280, height: 820, initScript: OBSERVER });
	await page.waitFor('document.querySelector(".composer textarea") !== null', 20_000);
	await page.send("Performance.enable");
	const profiling = process.argv.includes("--profile");
	if (profiling) {
		await page.send("Profiler.enable");
		await page.send("Profiler.setSamplingInterval", { interval: 500 });
	}
	page.on("Runtime.exceptionThrown", (params) => {
		const details = params.exceptionDetails;
		console.log("page exception:", details?.exception?.description ?? details?.text ?? params);
	});
	page.on("Runtime.consoleAPICalled", (params) => {
		const args = params.args ?? [];
		if (params.type === "error" || params.type === "warning") console.log(`page ${params.type}:`, args.map((arg) => arg.value ?? arg.description).join(" "));
	});

	const metrics = async () => {
		const answer = await page.send("Performance.getMetrics");
		return Object.fromEntries(answer.metrics.filter((entry) => METRICS.includes(entry.name)).map((entry) => [entry.name, entry.value]));
	};

	const describe = () =>
		page.evaluate(`(() => ({
			turns: document.querySelectorAll(".turn").length,
			rows: document.querySelectorAll(".session-item").length,
			current: document.querySelectorAll('.session-item[aria-current="true"]').length,
			title: document.querySelector(".header-title h1")?.textContent ?? "",
			error: document.querySelector(".error-bar")?.textContent ?? "",
		}))()`);

	/** The window has opened a session: the sidebar marks the row it is on. */
	const waitReady = async () => {
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			if (await page.evaluate('document.querySelectorAll(\'.session-item[aria-current="true"]\').length > 0')) return;
			await sleep(100);
		}
		throw new Error(`窗口没有挂上会话：${JSON.stringify(await describe())}`);
	};

	for (const [index, scenario] of [
		{ name: "long-paragraph", blankLines: false },
		{ name: "split-paragraphs", blankLines: true },
	].entries()) {
		if (index > 0) {
			// A fresh session, so the second scenario's transcript starts empty: the cost under test is
			// the answer being written, not the history above it.
			await page.click(".new-session");
			await page.waitFor('document.querySelectorAll(".turn").length === 0', 10_000);
			await sleep(600);
		}
		await waitReady();
		await page.evaluate(
			"window.__bench.longTasks.length = 0; window.__bench.frames.length = 0; window.__bench.streaming = { running: false, startedAt: 0, endedAt: 0 };",
		);
		const before = await metrics();
		if (profiling && index === 0) await page.send("Profiler.start");

		const sent = await page.evaluate(`(() => {
			const box = document.querySelector(".composer textarea");
			box.value = "写一段长回答";
			box.dispatchEvent(new Event("input", { bubbles: true }));
			document.querySelector(".composer .button.primary")?.click();
			return true;
		})()`);
		if (!sent) throw new Error("发送按钮没找到");
		await page.waitFor('document.querySelectorAll(".turn").length > 0', 15_000);

		// The transcript wears `streaming` for exactly as long as a run is in flight — the same class
		// the caret keys on — and the observer records both ends, so a fast run cannot slip past a poll.
		await page.waitFor("window.__bench.streaming.startedAt > 0", 15_000);
		await page.waitFor("window.__bench.streaming.endedAt > 0", 90_000);
		const streaming = await page.evaluate("window.__bench.streaming");
		const elapsed = Math.round(streaming.endedAt - streaming.startedAt);
		// Read the frame and long-task windows before the idle tail, so they describe the run.
		const stats = await page.evaluate("({ longTasks: window.__bench.longTasks, frames: window.__bench.frames })");
		// A run that never streamed — a wrong model, a refused send — produces a short transcript and a
		// flattering report. The answer's drawn length is the one fact that tells the two apart, so the
		// scenario refuses to be written when it is short.
		const drawnChars = await page.evaluate(`(() => {
			const answers = document.querySelectorAll(".turn.assistant .turn-body");
			return answers.length === 0 ? 0 : answers[answers.length - 1].textContent.length;
		})()`);
		const error = await page.evaluate('document.querySelector(".error-bar")?.textContent ?? ""');
		await sleep(500);
		const after = await metrics();
		if (profiling && index === 0) {
			const { profile } = await page.send("Profiler.stop");
			writeFileSync(join(here, `profile-${label}.cpuprofile`), JSON.stringify(profile));
			console.log(`wrote profile-${label}.cpuprofile`);
		}

		const gaps = [];
		for (let at = 1; at < stats.frames.length; at += 1) gaps.push(stats.frames[at] - stats.frames[at - 1]);

		// What the transcript should hold: every character of the source except the blank lines that
		// only separate blocks (`textContent` of adjacent `<p>`s has no separator of its own).
		const answer = reply(scenario.blankLines);
		const expectedChars = answer.replace(/\n\n/g, "").length;

		const scenarioReport = {
			name: scenario.name,
			answerChars: answer.length,
			expectedChars,
			drawnChars,
			...(error.length === 0 ? {} : { error }),
			durationMs: elapsed,
			frames: stats.frames.length,
			frameGap: {
				p50: +percentile(gaps, 0.5).toFixed(2),
				p95: +percentile(gaps, 0.95).toFixed(2),
				max: +(gaps.length === 0 ? 0 : Math.max(...gaps)).toFixed(2),
				over32: gaps.filter((gap) => gap > 32).length,
			},
			longTasks: {
				count: stats.longTasks.length,
				totalMs: +stats.longTasks.reduce((total, value) => total + value, 0).toFixed(1),
				maxMs: +(stats.longTasks.length === 0 ? 0 : Math.max(...stats.longTasks)).toFixed(1),
			},
			layoutCount: after.LayoutCount - before.LayoutCount,
			recalcStyleCount: after.RecalcStyleCount - before.RecalcStyleCount,
			taskDurationMs: +((after.TaskDuration - before.TaskDuration) * 1000).toFixed(1),
			scriptDurationMs: +((after.ScriptDuration - before.ScriptDuration) * 1000).toFixed(1),
		};
		report.scenarios.push(scenarioReport);

		console.log(`\n${scenario.name}（${scenarioReport.answerChars} 字，${elapsed} ms）`);
		console.log(`  画出 ${drawnChars}/${expectedChars} 字${error.length === 0 ? "" : `；错误：${error}`}`);
		console.log(`  帧 ${scenarioReport.frames}；间隔 p50 ${scenarioReport.frameGap.p50} ms，p95 ${scenarioReport.frameGap.p95} ms，max ${scenarioReport.frameGap.max} ms，>32ms ${scenarioReport.frameGap.over32} 次`);
		console.log(`  长任务 ${scenarioReport.longTasks.count} 次，合计 ${scenarioReport.longTasks.totalMs} ms，最长 ${scenarioReport.longTasks.maxMs} ms`);
		console.log(`  Layout ${scenarioReport.layoutCount}，RecalcStyle ${scenarioReport.recalcStyleCount}，任务 ${scenarioReport.taskDurationMs} ms，脚本 ${scenarioReport.scriptDurationMs} ms`);

		if (drawnChars !== expectedChars) {
			throw new Error(`${scenario.name} 没有画全：画出 ${drawnChars}/${expectedChars} 字${error.length === 0 ? "" : `，错误：${error}`}`);
		}
	}

	const out = join(here, `window-measure-${label}.json`);
	writeFileSync(out, `${JSON.stringify(report, null, "\t")}\n`);
	console.log(`\nwrote ${out}`);
} finally {
	await browser?.close();
	server.kill();
	await provider.close();
	rmSync(home, { recursive: true, force: true });
}
