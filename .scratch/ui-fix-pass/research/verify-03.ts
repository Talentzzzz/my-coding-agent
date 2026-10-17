// Ticket 03 (streaming jank), checked in a real browser.
//
// The acceptance is what a window does while a long answer streams into a long conversation: no
// main-thread task over 50 ms, stable frame spacing, and content that arrives continuously rather
// than stopping and then dumping. None of that needs a provider key: the server is booted against a
// scripted transport (`scripts/fake-transport.ts`), and the conversation is seeded as a session file
// with 210 messages by default (`--messages 800` for a deeper one), so the history is the size the
// ticket names on the first frame.
//
//   npm run build:web && node .scratch/ui-fix-pass/research/verify-03.ts [--shots]
//
// The measurement is the browser's own: `PerformanceObserver { entryTypes: ["longtask"] }` for the
// blocking work DevTools' Performance panel shows as red, `requestAnimationFrame` timestamps for the
// frame cadence, and a sampler on the live answer's text for the "did it move" question. The
// renderer's cumulative counters (`Performance.getMetrics`) are printed beside them: they are what
// separates a draw that is proportional to the delta from one that is proportional to the
// conversation, and that difference grows with `--messages`.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { UserModel } from "@my-agent/core";

const shots = process.argv.includes("--shots");
const messagesAt = process.argv.indexOf("--messages");
const MESSAGES = messagesAt === -1 ? 210 : Number(process.argv[messagesAt + 1]);
const { chromium } = createRequire(import.meta.url)(
	"C:/Users/a1368/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js",
);

let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

const root = await mkdtemp(join(tmpdir(), "my-agent-verify-03-"));
process.env.MY_AGENT_HOME = join(root, "home");
const { bootServer } = await import("../../../packages/server/src/boot.ts");
const { CURRENT_SESSION_VERSION, sessionPath, workspaceDir } = await import("@my-agent/core");
const { createFakeTransport, fakeAssistantMessage } = await import("../../../scripts/fake-transport.ts");

/**
 * A conversation `MESSAGES` deep, written the way the store writes it.
 *
 * The header and every entry are the plain lines `loadEntriesFromFile` parses; nothing here is a
 * shortcut through the API, which is the point — the window must open this the way it opens any
 * other old conversation, with the same snapshot replay and the same deferred draw.
 */
const SESSION_ID = "stream-jank";
const sessionCwd = root.replaceAll("\\", "/");
const stampBase = Date.now() - MESSAGES * 1_500;

function messageLine(id: string, parentId: string | null, timestamp: number, message: unknown): string {
	return JSON.stringify({ type: "message", id, parentId, timestamp: new Date(timestamp).toISOString(), message });
}

const lines: string[] = [
	JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: SESSION_ID,
		timestamp: new Date(stampBase).toISOString(),
		cwd: sessionCwd,
	}),
];
let parentId: string | null = null;
for (let round = 0; round < MESSAGES / 2; round += 1) {
	const stamp = stampBase + round * 3_000;
	const userId = `e-u${round}`;
	const assistantId = `e-a${round}`;
	lines.push(
		messageLine(userId, parentId, stamp, {
			role: "user",
			content: [{ type: "text", text: `第 ${round + 1} 轮问题：这一处的设计为什么是这样？` }],
			timestamp: stamp,
		}),
	);
	parentId = userId;
	lines.push(
		messageLine(assistantId, parentId, stamp + 1_000, {
			role: "assistant",
			api: "anthropic-messages",
			model: "claude-sonnet-4-5",
			content: [
				{
					type: "text",
					text:
						`第 ${round + 1} 轮回答。这里是一段历史正文，用来让转录有真实的分量：` +
						"它包含若干段落、一个列表和一点行内标记，这样每一屏都真的需要排版。\n\n" +
						"- 第一点：输入从输入框进入\n- 第二点：事件从常驻通道回来\n- 第三点：转录只改变化了的那一条\n\n" +
						"最后一段收束这一轮，长度刚好够把它画成一个普通段落。",
				},
			],
			usage: { input: 900, output: 220, cacheRead: 0, cacheWrite: 0, totalTokens: 1_120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: stamp + 1_000,
		}),
	);
	parentId = assistantId;
}
await mkdir(workspaceDir(sessionCwd), { recursive: true });
await writeFile(sessionPath(workspaceDir(sessionCwd), SESSION_ID, new Date(stampBase).toISOString()), `${lines.join("\n")}\n`, "utf8");
await writeFile(join(root, "README.md"), "# 流式卡顿验证\n");

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

/**
 * One long answer, split into paragraphs so its Markdown tail stays a paragraph.
 *
 * Estimated tokens are `length / 4`, and the fake transport paces one chunk per token estimate. At
 * 1,500 tokens a second this lands a delta every ~5 ms — several per display refresh — for about
 * six seconds, which is the window the ticket asks to record.
 */
function longAnswer(): string {
	const parts: string[] = [];
	for (let index = 0; index < 110; index += 1) {
		parts.push(
			`第 ${index + 1} 段：这是流式验证用的正文，包含**加粗**、\`行内代码\` 与中文标点，` +
				"段落长度足够让每一帧都有真实的排版工作，但不至于让单段解析成为瓶颈。",
		);
	}
	parts.push("```ts\n" + Array.from({ length: 24 }, (_unused, index) => `const value${index} = ${index};`).join("\n") + "\n```");
	parts.push("结尾：以上是这段流式内容的最后一句。");
	return parts.join("\n\n");
}

const answer = longAnswer();
const fake = createFakeTransport({ tokensPerSecond: 1_200, tokenSize: { min: 5, max: 9 } });
fake.setResponses([fakeAssistantMessage(answer)]);

const server = await bootServer({
	cwd: root,
	port: 0,
	sessionId: SESSION_ID,
	model: "scripted/claude-sonnet-4-5",
	api: fake.api,
});
server.hub.setUserModels(rows);

const browser = await chromium.launch({
	executablePath: "C:/Users/a1368/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe",
	headless: true,
});
const outDir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
page.on("pageerror", (error: Error) => process.stdout.write(`page error: ${error.message}\n`));

const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");

/**
 * The renderer's own counters, as DevTools' Performance panel reads them.
 *
 * The gates below are long tasks and frame cadence, and at these sizes neither implementation comes
 * near 50 ms: the draw this ticket is about cost about a tenth of a millisecond. What does separate
 * the two, and what the ticket's claim actually is, is how much script time the *same answer* costs.
 * A draw proportional to the conversation grows with `--messages`; a draw proportional to the delta
 * does not. `ScriptDuration` is the number to watch.
 *
 * `LayoutCount` is printed beside it and is *not* evidence: measured on both implementations it came
 * out the same (about 350 layouts either way). At this delta rate — one every ~10 ms into an
 * unthrottled, headless frame loop — both versions lay out about once per painted frame, and the
 * old path's forced reflow (a `scrollHeight` read after a write, once per delta) buys no layout the
 * paint would not have paid for anyway. What it costs is CPU, which is the `ScriptDuration` delta.
 * Saying so here is cheaper than rediscovering it next time.
 *
 * `Performance.getMetrics` is cumulative for the page, so a run is priced by the difference between
 * a reading taken as the prompt is sent and one taken as the run settles.
 */
type Metrics = Readonly<Record<string, number>>;

async function readMetrics(): Promise<Metrics> {
	const { metrics } = await cdp.send("Performance.getMetrics");
	return Object.fromEntries(metrics.map((entry: { name: string; value: number }) => [entry.name, entry.value]));
}

await page.goto(server.url);
await page.waitForSelector("textarea", { timeout: 15_000 });
await page.waitForFunction((wanted) => document.querySelectorAll(".turn").length >= wanted, MESSAGES, { timeout: 60_000 });
await page.waitForTimeout(1_000);

process.stdout.write(`\n03：${answer.length} 字的回答流进 ${MESSAGES} 条的会话\n`);
{
	const history = await page.locator(".turn").count();
	check("历史已在屏幕上", history === MESSAGES, `${history}`);

	// Start measuring only once the conversation is drawn and idle: the initial deferred draw is
	// ticket 05's cost, not this one.
	await page.evaluate(() => {
		const probe = {
			running: true,
			tasks: [] as { start: number; duration: number }[],
			frames: [] as number[],
			samples: [] as { at: number; length: number }[],
			stop: () => {},
		};
		(window as unknown as { __probe: typeof probe }).__probe = probe;
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) probe.tasks.push({ start: entry.startTime, duration: entry.duration });
		}).observe({ entryTypes: ["longtask"] });
		const frame = (now: number): void => {
			if (!probe.running) return;
			probe.frames.push(now);
			requestAnimationFrame(frame);
		};
		requestAnimationFrame(frame);
		const sampler = window.setInterval(() => {
			const bodies = document.querySelectorAll(".turn.assistant .turn-body");
			const last = bodies[bodies.length - 1];
			probe.samples.push({ at: performance.now(), length: last ? (last.textContent ?? "").length : 0 });
		}, 80);
		probe.stop = () => {
			probe.running = false;
			window.clearInterval(sampler);
		};
	});

	// The prompt goes in as a person would send it: the run's frames are what the probe is for.
	await page.locator("textarea").fill("请用一段长回答说明流式渲染的代价。");
	const before = await readMetrics();
	const pressed = Date.now();
	await page.locator("textarea").press("Enter");
	await page.waitForSelector(".runtime", { timeout: 15_000 });
	const started = Date.now();
	// The run is over when the ticking line leaves — that is the streaming flip the transcript sees.
	await page.waitForSelector(".runtime", { state: "detached", timeout: 60_000 });
	const settled = Date.now();
	const after = await readMetrics();

	const probe = await page.evaluate(() => {
		const current = (window as unknown as { __probe: { stop: () => void; tasks: { start: number; duration: number }[]; frames: number[]; samples: { at: number; length: number }[] } }).__probe;
		current.stop();
		return { tasks: current.tasks, frames: current.frames, samples: current.samples };
	});

	// The window the run occupied, from the probe's own clock rather than the harness's.
	const firstFrame = probe.frames[0] ?? 0;
	const lastFrame = probe.frames.at(-1) ?? 0;
	const interval = (probe.frames.slice(1).map((at, index) => at - probe.frames[index]!) as number[]).sort((a, b) => a - b);
	const p95 = interval[Math.min(interval.length - 1, Math.floor(interval.length * 0.95))] ?? 0;
	const maxGap = interval.at(-1) ?? 0;
	const long = probe.tasks.filter((task) => task.duration > 50);
	const worst = probe.tasks.reduce((most, task) => Math.max(most, task.duration), 0);

	process.stdout.write(
		`     运行 ${((settled - started) / 1000).toFixed(1)}s（发出到首个 delta ${started - pressed}ms），${fake.state.callCount} 次请求，采样 ${probe.samples.length} 次，帧 ${probe.frames.length} 个\n`,
	);
	process.stdout.write(
		`     长任务(>50ms) ${long.length} 个，最长 ${worst.toFixed(1)}ms；帧间隔 p95 ${p95.toFixed(1)}ms，最大 ${maxGap.toFixed(1)}ms\n`,
	);

	check("主线程没有超过 50ms 的长任务", long.length === 0, `${long.length} 个：${long.map((task) => task.duration.toFixed(1)).join(", ")}`);
	// Headless Chromium still hits the compositor's 60Hz beat; a spike here is a frame the reader
	// would have seen as a stutter. The allowance covers scheduling noise, not a dropped half second.
	check("帧间隔 p95 在 40ms 之内", p95 < 40, `${p95.toFixed(1)}ms`);
	check("没有超过 200ms 的空档", maxGap < 200, `${maxGap.toFixed(1)}ms`);

	// Diagnostic, not a gate: this is the pair of numbers that tells the two implementations apart.
	// "Per token" and "per paint" differ by the number of deltas in a frame, which a run of 1,200
	// tokens a second makes several times over.
	const counted = (name: string): number => (after[name] ?? 0) - (before[name] ?? 0);
	const ms = (seconds: number): string => `${(seconds * 1000).toFixed(0)}ms`;
	process.stdout.write(
		`     运行期间（诊断）：脚本 ${ms(counted("ScriptDuration"))} / 任务 ${ms(counted("TaskDuration"))}，` +
			`布局 ${counted("LayoutCount")} 次 ${ms(counted("LayoutDuration"))}，` +
			`样式重算 ${counted("RecalcStyleCount")} 次 ${ms(counted("RecalcStyleDuration"))}\n`,
	);

	// The "stops, then dumps" symptom: the answer's text is unchanged for a long stretch and then
	// jumps. A delta lands every few milliseconds, so a run of unchanged samples is a stall.
	//
	// Only while the answer is still arriving: once the last token is in, the text stops by
	// definition until the run settles, and counting that tail as a stall would fail any window that
	// was sampled a little past the end.
	const answerSamples = probe.samples.filter((sample) => sample.length > 0);
	const grew = (index: number): boolean =>
		index > 0 && answerSamples[index]!.length > answerSamples[index - 1]!.length;
	let lastGrowth = -1;
	for (let index = 1; index < answerSamples.length; index += 1) if (grew(index)) lastGrowth = index;
	const stalls: number[] = [];
	let run = 1;
	for (let index = 1; index <= lastGrowth; index += 1) {
		run = grew(index) ? 1 : run + 1;
		stalls.push(run);
	}
	const longestStall = stalls.length === 0 ? 0 : Math.max(...stalls);
	const growth = answerSamples.filter((_sample, index) => grew(index)).length;
	process.stdout.write(`     正文样本 ${answerSamples.length} 个，其中增长 ${growth} 次，最长静止 ${longestStall} 个样本\n`);
	check("正文在持续变长", growth > 30, `${growth}`);
	check("正文没有长时间停住", longestStall <= 4, `静止 ${longestStall} 个 80ms 样本`);

	// Nothing may be left behind when the ticking line goes: a run that ended early would look calm
	// and would still be a bug. The answer's last sentence is the test — its text is written straight
	// through by the Markdown renderer, so it survives whatever the body does with blank lines.
	const landed = await page.evaluate(() => {
		const bodies = document.querySelectorAll(".turn.assistant .turn-body");
		return bodies[bodies.length - 1]?.textContent ?? "";
	});
	check("整段回答都到了屏幕上", landed.includes("结尾：以上是这段流式内容的最后一句。"), `${landed.length} 字`);

	if (shots) await page.locator(".transcript").screenshot({ path: join(outDir, "after-03-streamed.png") });
	process.stdout.write(`     探测窗口 ${(lastFrame - firstFrame).toFixed(0)}ms，请求 ${fake.state.callCount}\n`);
}

await browser.close();
await server.close();
await rm(root, { recursive: true, force: true });

process.stdout.write(failures === 0 ? "\n03 ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
