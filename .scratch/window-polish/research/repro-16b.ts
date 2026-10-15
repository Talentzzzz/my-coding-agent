// 16 号的第二只探针：同一出图路径，再加一条 Node 侧的 wire 连接订阅同一会话，
// 把浏览器看到的帧按到达顺序全部记下来——定位「重排」到底发生在哪一帧之后。
//   node .scratch/window-polish/research/repro-16b.ts
import { mkdtemp } from "node:fs/promises";
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

const root = await mkdtemp(join(tmpdir(), "my-agent-repro16b-"));
const transport: FakeTransport = createFakeTransport({ tokensPerSecond: 120 });
const long = fakeAssistantMessage("第一答。".repeat(200));
const second = fakeAssistantMessage("第二答。".repeat(30));
transport.setResponses([
	long,
	async () => {
		await sleep(5_000);
		return second;
	},
]);

const server = await bootServer({ cwd: root, port: 0, api: transport.api });
server.hub.setUserModels(rows);

// Node 侧 wire 订阅者：与浏览器平级的一只眼睛。
const wire = await connect(`${server.url.replace("http", "ws")}/mux`);

const outDir = import.meta.dirname ?? ".";
const executablePath = "C:/Users/a1368/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
await page.goto(server.url);
await page.waitForSelector(".new-session", { timeout: 10_000 });

const say = (line: string): void => process.stdout.write(`${line}\n`);
const t0 = Date.now();
const mark = (): string => `+${String(Date.now() - t0).padStart(5)}ms`;

await page.click(".new-session");
await page.waitForSelector("textarea", { timeout: 10_000 });

// 页面自己建的会话：从 REST 清单里把它的 id 找出来（本目录下唯一的会话）。
let sessionId = "";
for (let attempt = 0; attempt < 20 && sessionId === ""; attempt++) {
	const list = (await (await fetch(`${server.url}/api/workspaces`)).json()) as {
		workspaces?: { sessions?: { id: string; cwd: string }[] }[];
	}[];
	const flat = (list.workspaces ?? []).flatMap((group) => group.sessions ?? []);
	const hit = flat.find((row) => row.cwd === root);
	if (hit) sessionId = hit.id;
	else await sleep(200);
}
say(`${mark()} session=${sessionId}`);
await wire.open(sessionId);

// 等 composer 可用（通道 live），再发送第一条。
await page.waitForFunction(() => {
	const area = document.querySelector("textarea");
	return area !== null && area.disabled === false;
}, { timeout: 15_000 });
await page.fill("textarea", "第一轮的问题");
await page.press("textarea", "Enter");
say(`${mark()} sent #1`);
await sleep(1_200);
await page.fill("textarea", "你有哪些工具");
await page.press("textarea", "Enter");
say(`${mark()} sent #2 (mid-stream)`);

// 间隙中读 DOM 顺序。
await sleep(2_600);
const order = await page.evaluate(() =>
	[...document.querySelectorAll<HTMLElement>(".transcript > section")].map(
		(section) => `${section.className.split(" ").slice(0, 2).join(".")}:${(section.textContent ?? "").slice(0, 12)}`,
	),
);
say(`${mark()} DOM order: ${JSON.stringify(order, null, 1)}`);

await sleep(5_000);
const settled = await page.evaluate(() =>
	[...document.querySelectorAll<HTMLElement>(".transcript > section")].map(
		(section) => `${section.className.split(" ").slice(0, 2).join(".")}:${(section.textContent ?? "").slice(0, 12)}`,
	),
);
say(`${mark()} DOM settled: ${JSON.stringify(settled, null, 1)}`);

// 帧日志：wire 眼里的完整到达顺序。
const frames = wire.frames.filter((frame) => (frame as { streamId?: unknown }).streamId === sessionId);
const log = frames.map((frame) => {
	const item = (frame as { item?: { type: string; event?: { type: string; message?: { role?: string; timestamp?: number } }; session?: { messages?: unknown[] }; entryId?: string; messageTimestamp?: number } }).item;
	if (item === undefined) return JSON.stringify(frame).slice(0, 100);
	if (item.type === "event") {
		const event = item.event ?? {};
		const message = (event as { message?: { role?: string; timestamp?: number; content?: unknown } }).message;
		const text = typeof message?.content === "string"
			? message.content.slice(0, 10)
			: Array.isArray(message?.content)
				? message.content.map((block) => (block as { type?: string }).type).join(",")
				: "";
		return `event ${event.type} ${message?.role ?? ""}:${message?.timestamp ?? ""} [${text}]`;
	}
	if (item.type === "baseline") {
		const messages = (item.session?.messages ?? []) as { role?: string; timestamp?: number }[];
		return `baseline messages=${messages.map((m) => `${m.role}:${m.timestamp}`).join(" ")}`;
	}
	if (item.type === "entry") return `entry ${item.entryId} ts=${item.messageTimestamp}`;
	if (item.type === "status") {
		const record = item as unknown as { submitting?: boolean; queued?: number };
		return `status submitting=${record.submitting} queued=${record.queued}`;
	}
	return item.type;
});
say(`\nwire frames (${log.length}):\n${log.join("\n")}`);

await browser.close();
await wire.close();
await server.close();
say("\ndone");
