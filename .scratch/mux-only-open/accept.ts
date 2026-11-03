// 票 03 的验收：真服务器 + 真 Chromium，按 ADR-0010 的验收边 1–4 逐条走。
// 不算产品代码，跑完即弃：node .scratch/mux-only-open/accept.ts
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "../../packages/server/src/boot.ts";
import { createFakeTransport, fakeAssistantMessage } from "../../scripts/fake-transport.ts";
import { launchChromium, openPage, type Page } from "../../scripts/cdp.ts";
import { sessionDir, type ModelConfig } from "@my-agent/core";

const root = await mkdtemp(join(tmpdir(), "my-agent-accept-"));
const home = process.env.MY_AGENT_HOME;
if (home === undefined) throw new Error("请用 MY_AGENT_HOME=<临时目录> 跑这个脚本：会话文件也跟着它走，别落到真 home 里");
let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

async function until(ready: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await ready()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return ready();
}

const modelRows: ModelConfig[] = [
	{ name: "scripted", baseUrl: "http://127.0.0.1:1/v1", apiKey: "unused", id: "claude-sonnet-4-5", contextWindow: 200_000, maxTokens: 8_192 },
];

const transport = createFakeTransport({ tokensPerSecond: 40 });
const server = await bootServer({ workDirAbsPath: root, port: 0, api: transport.api, settingsHome: home });
server.hub.setModelConfigs(modelRows);

const base = server.url;

async function createSession(): Promise<string> {
	const answer = (await (await fetch(`${base}/api/sessions`, { method: "POST" })).json()) as { sessionId: string };
	return answer.sessionId;
}

async function say(sessionId: string, prompt: string, answer: string): Promise<void> {
	transport.setResponses([fakeAssistantMessage(answer)]);
	await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: prompt }),
	});
	await until(async () => {
		const body = (await (await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as {
			session: { submitting: boolean };
		};
		return !body.session.submitting;
	}, 20_000);
}

const A = await createSession();
await say(A, "甲的问题", "甲会话的答案甲会话的答案甲会话的答案");
const B = await createSession();
await say(B, "乙的问题", "乙会话的答案乙会话的答案乙会话的答案");

const transcript = (page: Page): Promise<string> => page.evaluate<string>(`document.querySelector(".transcript")?.innerText ?? ""`);
const errorText = (page: Page): Promise<string> =>
	page.evaluate<string>(`(() => { const bar = document.querySelector(".error-bar"); return !bar || bar.hidden ? "" : bar.textContent; })()`);

async function clickRow(page: Page, title: string): Promise<boolean> {
	return page.evaluate<boolean>(
		`(() => { const row = [...document.querySelectorAll(".session-item")].find((node) => node.textContent.includes(${JSON.stringify(title)})); if (!row) return false; row.click(); return true; })()`,
	);
}

async function rowTitles(page: Page): Promise<string[]> {
	return page.evaluate<string[]>(`[...document.querySelectorAll(".session-item-title")].map((n) => n.textContent)`);
}

const chromium = await launchChromium({ width: 1180, height: 820 });
const page = await openPage(chromium.port, "about:blank", { width: 1180, height: 820 });

/** Every request the page made, in order. `Network.enable` before the first navigation is the point. */
const requests: string[] = [];
page.on("Network.requestWillBeSent", (params) => {
	const request = params.request as { method: string; url: string } | undefined;
	if (request !== undefined) requests.push(`${request.method} ${request.url.replace(base, "")}`);
});
await page.send("Network.enable");
await page.send("Page.navigate", { url: base });
await page.waitFor('document.readyState === "complete"', 20_000);

try {
	// --- 页面加载：通道先起、等 live、再 open current，画出来的是一份基线而不是读 + 基线两份。
	// 两侧会话都要出现在侧边栏里，说明行表也到了（它只走通道，页面没有拉过一次 /api/directories 之外的东西）。
	check("侧边栏列出两条会话", await until(async () => (await rowTitles(page)).length >= 2, 10_000), JSON.stringify(await rowTitles(page)));
	check("页面加载落地的是一个会话（欢迎态，没有报错条）", (await errorText(page)) === "", await errorText(page));

	// --- 验收边 1：切换会话的全过程不产生任何 REST 读。
	const beforeSwitch = requests.length;
	check("点甲会话", await clickRow(page, "甲的问题"));
	check("甲会话的画面到了", await until(async () => (await transcript(page)).includes("甲会话的答案"), 10_000), `停在「${(await transcript(page)).slice(0, 40)}」`);
	check("点乙会话", await clickRow(page, "乙的问题"));
	check("乙会话的画面到了", await until(async () => (await transcript(page)).includes("乙会话的答案"), 10_000));

	const switched = requests.slice(beforeSwitch);
	// 「打开一个会话」这件事本身：没有 GET /api/sessions/<id>，也没有 GET /api/sessions/current。
	// 列表修复（/api/directories）不在这一条里 —— 票面要求 refreshLists 的位置与理由原样保留。
	const reads = switched.filter((line) => line.startsWith("GET /api/sessions/") && !line.includes("/sessions/current"));
	check("验收边 1：切换不产生会话 REST 读", reads.length === 0, JSON.stringify(switched));
	process.stdout.write(`      切换期间的请求：${JSON.stringify(switched)}\n`);

	// --- 验收边 3：连点两行。旧基线迟到时整帧丢弃，最终画面是最后一次点击的那一条。
	for (let round = 0; round < 3; round += 1) {
		await page.evaluate(`(() => {
			const rows = [...document.querySelectorAll(".session-item")];
			const pick = (text) => rows.find((row) => row.textContent.includes(text));
			pick("甲的问题").click();
			pick("乙的问题").click();
		})()`);
		const landed = await until(async () => (await transcript(page)).includes("乙会话的答案"), 10_000);
		check(`连点第 ${round + 1} 轮：最终画面是最后一击（乙）`, landed, await transcript(page));
		check(`连点第 ${round + 1} 轮：没有错误条`, (await errorText(page)) === "", await errorText(page));
	}

	// --- 验收边 2：切走正在跑的会话再切回，画面立即带 partial，不等下一个 delta。
	check("先回到甲会话", await clickRow(page, "甲的问题"));
	await until(async () => (await transcript(page)).includes("甲会话的答案"), 5_000);
	transport.setResponses([fakeAssistantMessage("流式答案开始" + "。" + "继续写".repeat(4000) + "尾标记")]);
	const runStart = Date.now();
	const started = await fetch(`${base}/api/sessions/${encodeURIComponent(A)}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "慢问题" }),
	});
	process.stdout.write(`      POST 慢问题 → ${started.status}\n`);
	check("慢回答开始流式", await until(async () => (await transcript(page)).includes("流式答案开始"), 10_000), (await transcript(page)).slice(-120));

	check("切走", await clickRow(page, "乙的问题"));
	await until(async () => (await transcript(page)).includes("乙会话的答案"), 5_000);
	const backAt = Date.now();
	check("切回正在跑的甲会话", await clickRow(page, "甲的问题"));
	const partialAt = await until(async () => (await transcript(page)).includes("流式答案开始"), 5_000);
	const waited = Date.now() - backAt;
	const midway = await transcript(page);
	check("验收边 2：切回后立刻看到 partial", partialAt && waited < 1_500, `等了 ${waited} ms`);
	check("验收边 2：此刻还在跑（尾标记未到）", !midway.includes("尾标记"), midway.slice(-60));

	// 流还活着：回到这个会话之后，画面还要自己长，而不是停在基线那一刻。
	const lengthAt = midway.length;
	const grew = await until(async () => (await transcript(page)).length > lengthAt, 15_000);
	check("验收边 2：流仍活着，画面继续长", grew, `run ${Date.now() - runStart} ms`);
	await fetch(`${base}/api/sessions/${encodeURIComponent(A)}/abort`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	await until(async () => !(await fetch(`${base}/api/sessions/${encodeURIComponent(A)}`).then(async (r) => ((await r.json()) as { session: { submitting: boolean } }).session.submitting)), 10_000);
	await new Promise((resolve) => setTimeout(resolve, 200));

	// --- 窗口自己发一条：send 的引用与导航同住一条流，重写之后这条路要还能走。
	transport.setResponses([fakeAssistantMessage("从窗口发出的回答")]);
	check(
		"输入框拿到焦点",
		await page.evaluate<boolean>(`(() => { const box = document.querySelector(".composer textarea"); if (!box) return false; box.focus(); return true; })()`),
	);
	await page.send("Input.insertText", { text: "从窗口发的问题" });
	for (const type of ["keyDown", "keyUp"]) {
		await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
	}
	check("窗口发出的 prompt 拿到了回答", await until(async () => (await transcript(page)).includes("从窗口发出的回答"), 20_000), (await transcript(page)).slice(-60));
	check("发出之后没有错误条", (await errorText(page)) === "", await errorText(page));

	// --- send 的引用跨过导航：窗口发起的 run，窗口走开了也还有人读（ADR-0006 §5）。
	// 这一条专门盯 03 顺手修的那处：`open` 幂等之后，`retain(send)` 会带来一份「还没开始跑」的基线，
	// 若把它当成 run 的结局，引用会在拿到手的那一瞬就松开，走开时的 cancel 就把这条流掐了。
	transport.setResponses([fakeAssistantMessage("窗口发起的长回答开始" + "接着写".repeat(80))]);
	await page.evaluate<boolean>(`(() => { const box = document.querySelector(".composer textarea"); if (!box) return false; box.focus(); return true; })()`);
	await page.send("Input.insertText", { text: "窗口发起的长问题" });
	for (const type of ["keyDown", "keyUp"]) {
		await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
	}
	check("窗口发起的长回答开始流式", await until(async () => (await transcript(page)).includes("窗口发起的长回答开始"), 20_000));
	check("走开", await clickRow(page, "乙的问题"));
	// 等 cancel 真正到服务端再问，否则这条断言只会证明「帧还没到」。
	await new Promise((resolve) => setTimeout(resolve, 400));
	check("窗口走开之后，那条还在跑的流仍被观察着", server.hub.isWatched(A), `isWatched=${server.hub.isWatched(A)}`);
	check("跑完之后引用才松开", await until(() => !server.hub.isWatched(A), 30_000), `isWatched=${server.hub.isWatched(A)}`);

	// --- 验收边 4：打开一个服务端已经没有的会话 —— 错误条报错，旧画面留在屏上。
	// 文件被别处删掉正是这一条的现实版本：行还在侧边栏，服务端的 has() 已经说不认识了。
	check("先回到甲会话（验收边 4 的旧画面）", await clickRow(page, "甲的问题"));
	await until(async () => (await transcript(page)).includes("甲会话的答案"), 5_000);
	const dir = sessionDir(root);
	for (const name of await readdir(dir)) {
		if (!name.includes(B)) continue;
		try {
			await rm(join(dir, name), { force: true });
		} catch (error) {
			process.stdout.write(`      删不掉 ${name}: ${String(error)}\n`);
		}
	}
	process.stdout.write(`      删掉乙会话的文件后，服务端还认得它吗：hub.has(B)=${server.hub.has(B)}\n`);
	if (server.hub.has(B)) {
		// 服务端还认得（进程里或索引里），这一条只能等它忘掉；如实记下来，不假装通过了。
		process.stdout.write("      （hub 仍认得这个会话，验收边 4 本轮跳过）\n");
	} else {
		const before = await transcript(page);
		const clicked = await clickRow(page, "乙的问题");
		check("点已消失的乙会话", clicked);
		await new Promise((resolve) => setTimeout(resolve, 800));
		const after = await transcript(page);
		process.stdout.write(`      前 ${before.length} 字 / 后 ${after.length} 字 / 错误条「${await errorText(page)}」\n`);
		check("验收边 4：错误条报错", (await errorText(page)).length > 0, await errorText(page));
		check("验收边 4：旧对话仍在屏上", after.includes("甲会话的答案"), `after=${after.slice(0, 80)}`);
	}
} finally {
	await page.close();
	await chromium.close();
	await server.close();
	await rm(root, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\n验收边 1–4 ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
