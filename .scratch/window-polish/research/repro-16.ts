// 16 号的复现：真服务器 + 脚本化 transport + 本机 Chromium，走窗口自己的路
// （新建会话 → 输入 → Enter），在上一轮还在流式时发送第二条消息（排队形状），
// 在「echo 已落地、下一轮回答还没开始」的间隙里出图并读取 DOM 的计算样式。
//   node .scratch/window-polish/research/repro-16.ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { bootServer } from "../../../packages/server/src/boot.ts";
import { createFakeTransport, fakeAssistantMessage, type FakeTransport } from "../../../scripts/fake-transport.ts";
import { connect } from "../../../scripts/wire/client.ts";
import type { UserModel } from "@my-agent/core";

const { chromium } = createRequire(import.meta.url)(
	"C:/Users/a1368/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js",
);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

const root = await mkdtemp(join(tmpdir(), "my-agent-repro16-"));
// 第一答慢慢流（~2.5s），第二答用工厂推迟 5s 才开始——那 5s 就是「echo 已落地、
// 流式还在继续、但没有 assistant item 在写」的间隙，截图就打在这里。
const transport: FakeTransport = createFakeTransport({ tokensPerSecond: 120 });
const long = fakeAssistantMessage(
	"目录里没有代码，只有三个文件：1.jpg、2.jpg 和 Images.pdf。两个 JPG 大小接近，Images.pdf 体积约等于前两者之和，看起来像是把这两张图合并生成的 PDF。要做点什么？比如：打开这两张图看看内容、确认 PDF 里包含哪些页面、或者在这里初始化一个项目。告诉我下一步。".repeat(4),
);
const second = fakeAssistantMessage("这是第二轮的回答，它延迟了五秒才开始。");
transport.setResponses([
	long,
	async () => {
		await sleep(5_000);
		return second;
	},
]);

const server = await bootServer({ cwd: root, port: 0, api: transport.api });
server.hub.setUserModels(rows);
const wire = await connect(`${server.url.replace("http", "ws")}/mux`);

const outDir = import.meta.dirname ?? ".";
const executablePath = "C:/Users/a1368/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
// 页内探头：把浏览器这条 mux 连接收到的每一帧原样记在 window.__frames 上。
await page.addInitScript(() => {
	const Seen = window.WebSocket;
	const log: unknown[] = [];
	(window as unknown as { __frames: unknown[] }).__frames = log;
	function Patched(this: unknown, url: string, protocols?: string | string[]): void {
		const socket = new Seen(url, protocols);
		socket.addEventListener("message", (event: MessageEvent) => {
			log.push((event as MessageEvent).data);
		});
		return socket;
	}
	Patched.prototype = Seen.prototype;
	(window as unknown as { WebSocket: unknown }).WebSocket = Patched;
});
await page.goto(server.url);
await page.waitForSelector(".new-session", { timeout: 10_000 });
await page.click(".new-session");
await page.waitForSelector("textarea", { timeout: 10_000 });

const say = (line: string): void => process.stdout.write(`${line}\n`);
const t0 = Date.now();
const mark = (): string => `+${String(Date.now() - t0).padStart(5)}ms`;

await page.click(".new-session");
await page.waitForSelector("textarea", { timeout: 10_000 });

// 页面自己建的会话：从 REST 清单里把它的 id 找出来，让 wire 眼睛也订上它。
let sessionId = "";
for (let attempt = 0; attempt < 25 && sessionId === ""; attempt++) {
	const list = (await (await fetch(`${server.url}/api/workspaces`)).json()) as {
		workspaces?: { sessions?: { id: string; cwd: string }[] }[];
	};
	const flat = (list.workspaces ?? []).flatMap((group) => group.sessions ?? []);
	const hit = flat.find((row) => row.cwd === root);
	if (hit) sessionId = hit.id;
	else await sleep(200);
}
say(`${mark()} session=${sessionId}`);
if (sessionId !== "") await wire.open(sessionId);

// 第一条：正常发送，等它流起来。
await page.fill("textarea", "第一轮的问题");
await page.press("textarea", "Enter");
await sleep(1_000);
await page.screenshot({ path: join(outDir, "repro16-1-streaming.png") });
say("1 repro16-1-streaming.png（第一轮流式中）");

// 第二条：上一轮还在流式时按 Enter（排队/followUp 形状）。
await page.fill("textarea", "你有哪些工具");
await page.press("textarea", "Enter");

// 第一答约 2.5s 流完，echo 落地；第二答要等到 ~7.5s。在间隙正中出图。
await sleep(2_600);
await page.screenshot({ path: join(outDir, "repro16-2-gap.png") });
say("2 repro16-2-gap.png（echo 已落地、下一轮未开始的间隙）");

// 间隙里的 DOM 事实：节点顺序、最后一条 turn 的角色、光标伪元素、气泡字号。
const probe = await page.evaluate(() => {
	const sections = [...document.querySelectorAll<HTMLElement>(".transcript > section")];
	const order = sections.map((section) => {
		const body = section.querySelector<HTMLElement>(".turn-body");
		return {
			cls: section.className,
			role: section.dataset.role ?? "",
			text: (body?.textContent ?? "").slice(0, 24),
		};
	});
	const turns = [...document.querySelectorAll<HTMLElement>(".turn")];
	const last = turns.at(-1);
	const body = last?.querySelector<HTMLElement>(".turn-body");
	const para = body?.querySelector<HTMLElement>("p");
	const after = body ? getComputedStyle(body, "::after") : undefined;
	const assistantBody = document.querySelector<HTMLElement>(".turn:not([data-role='user']) .turn-body");
	const streaming = document.querySelector(".transcript")?.classList.contains("streaming") ?? false;
	return {
		order,
		containerStreaming: streaming,
		lastTurnRole: last?.dataset.role ?? "",
		lastTurnClass: last?.className ?? "",
		caret: after ? { content: after.content, width: after.width, height: after.height } : undefined,
		bubbleFontSize: body ? getComputedStyle(body).fontSize : "",
		bubbleParagraphFontSize: para ? getComputedStyle(para).fontSize : "",
		assistantFontSize: assistantBody ? getComputedStyle(assistantBody).fontSize : "",
		bubbleRect: body ? { w: body.getBoundingClientRect().width, h: body.getBoundingClientRect().height } : undefined,
		paraRect: para ? { w: para.getBoundingClientRect().width, h: para.getBoundingClientRect().height } : undefined,
	};
});
say(JSON.stringify(probe, null, 2));
await writeFile(join(outDir, "repro16-probe.json"), JSON.stringify(probe, null, 2));

// 同一时刻的 wire 帧：浏览器自己那条连接收到的帧，原样摊开。
{
	const raw = (await page.evaluate(() => (window as unknown as { __frames: string[] }).__frames)) as string[];
	const log = raw.map((text) => {
		let frame: { streamId?: unknown; item?: { type?: string; event?: { type?: string; message?: { role?: string; timestamp?: number } }; entryId?: string; messageTimestamp?: number; session?: { messages?: { role?: string; timestamp?: number }[] } }; end?: boolean };
		try {
			frame = JSON.parse(text);
		} catch {
			return "<unreadable>";
		}
		if (frame.streamId === null) return "connection-frame";
		const item = frame.item;
		if (item === undefined) return frame.end === true ? "end" : "<no item>";
		if (item.type === "event") {
			const event = item.event ?? {};
			const message = (event as { message?: { role?: string; timestamp?: number } }).message;
			return `event ${event.type} ${message?.role ?? ""}:${message?.timestamp ?? ""}`;
		}
		if (item.type === "baseline") {
			return `baseline [${(item.session?.messages ?? []).map((m) => `${m.role}:${m.timestamp}`).join(" ")}]`;
		}
		if (item.type === "entry") return `entry ${item.entryId} ts=${item.messageTimestamp}`;
		return String(item.type);
	});
	say(`page frames:\n${log.join("\n")}`);
}

// Node 侧 wire 帧：与浏览器平级的一只眼睛，作对照。
if (sessionId !== "") {
	const frames = wire.frames.filter((frame) => (frame as { streamId?: unknown }).streamId === sessionId);
	const log = frames.map((frame) => {
		const item = (frame as { item?: { type: string; event?: { type: string; message?: { role?: string; timestamp?: number } }; entryId?: string; messageTimestamp?: number; session?: { messages?: { role?: string; timestamp?: number }[] } } }).item;
		if (item === undefined) return JSON.stringify(frame).slice(0, 80);
		if (item.type === "event") {
			const event = item.event ?? {};
			const message = (event as { message?: { role?: string; timestamp?: number } }).message;
			return `event ${event.type} ${message?.role ?? ""}:${message?.timestamp ?? ""}`;
		}
		if (item.type === "baseline") {
			return `baseline [${(item.session?.messages ?? []).map((m) => `${m.role}:${m.timestamp}`).join(" ")}]`;
		}
		if (item.type === "entry") return `entry ${item.entryId} ts=${item.messageTimestamp}`;
		return item.type;
	});
	say(`wire frames:\n${log.join("\n")}`);
}

// 等第二轮真的开始并流完，确认恢复后的形状。
await sleep(4_500);
await page.screenshot({ path: join(outDir, "repro16-3-settled.png") });
say("3 repro16-3-settled.png（第二轮落定后）");

await browser.close();
await server.close();
say("done");
