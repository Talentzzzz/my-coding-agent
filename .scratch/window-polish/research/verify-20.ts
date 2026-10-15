// 20 号的核验：真服务器 + 脚本化 transport + 本机 Chromium。同一条形状（一条新建会话里
// 「发送 → 流式中再发送」，followUp），两条会读到「运行中基线」的路：
//   A 落定之后重新打开这个会话——新页面 → GET current → 读快照 → 新订阅 → 新基线；
//   B 运行当中重载页面——读数就发生在 store 还没写完的时候（这也正是 16 号在页内抓到
//     `baseline [user:U1 user:U2]` 的那个时刻）。
// 两条都要读 DOM 顺序，并与其时刻的 store 顺序对照。
//   node .scratch/window-polish/research/verify-20.ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { SessionManager, type UserModel } from "@my-agent/core";
import type { ServerMessage } from "@my-agent/core/protocol";
import { bootServer } from "../../../packages/server/src/boot.ts";
import { createFakeTransport, fakeAssistantMessage, type FakeTransport } from "../../../scripts/fake-transport.ts";
import { connect, type WireClient } from "../../../scripts/wire/client.ts";

const { chromium } = createRequire(import.meta.url)(
	"C:/Users/a1368/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js",
);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

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

const outDir = import.meta.dirname ?? ".";
const executablePath = "C:/Users/a1368/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const browser = await chromium.launch({ executablePath, headless: true });

/** 页内探头：把这条 mux 连接收到的每一帧连信封一起记下来。 */
async function withProbe(page: import("playwright-core").Page): Promise<void> {
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
}

/** 页面上读出来的顺序：每行是 `角色:前若干字`。 */
async function domOrder(page: import("playwright-core").Page): Promise<string[]> {
	return page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>(".transcript > section")].map((section) => {
			const role = section.className.includes("user") ? "user" : "assistant";
			const text = (section.querySelector<HTMLElement>(".turn-body")?.textContent ?? "").replace(/\s+/g, " ").trim();
			return `${role}:${text.slice(0, 12)}`;
		}),
	);
}

/** 一次订阅在页面上收到的帧，按 `流:类型` 写出来——用来数基线、看 `end` 落在哪一帧之后。 */
async function pageFrames(page: import("playwright-core").Page): Promise<string[]> {
	const raw = (await page.evaluate(() => (window as unknown as { __frames: string[] }).__frames)) as string[];
	return raw.map((text) => {
		let frame: { streamId?: string | null; item?: { type?: string }; end?: boolean; error?: { message?: string } };
		try {
			frame = JSON.parse(text);
		} catch {
			return "<unreadable>";
		}
		const stream = frame.streamId === null ? "conn" : String(frame.streamId).slice(0, 8);
		if (frame.error !== undefined) return `${stream}:error(${frame.error.message ?? ""})`;
		if (frame.end === true) return `${stream}:end`;
		return `${stream}:${frame.item?.type ?? "<no item>"}`;
	});
}

/** 等这条流上出现第一个满足 `match` 的新帧。 */
async function waitFresh(
	wire: WireClient,
	sessionId: string,
	from: number,
	match: (m: ServerMessage) => boolean,
	ms = 20_000,
): Promise<boolean> {
	const deadline = Date.now() + ms;
	for (;;) {
		if (wire.items(sessionId).slice(from).some(match)) return true;
		if (Date.now() > deadline) return false;
		await sleep(20);
	}
}

/** 页面自己建的会话：从 REST 清单里把它的 id 找出来，让 wire 眼睛也订上它。 */
async function sessionOf(url: string, root: string): Promise<string> {
	for (let attempt = 0; attempt < 25; attempt++) {
		const list = (await (await fetch(`${url}/api/workspaces`)).json()) as {
			workspaces?: { sessions?: { id: string; cwd: string }[] }[];
		};
		const flat = (list.workspaces ?? []).flatMap((group) => group.sessions ?? []);
		const hit = flat.find((row) => row.cwd === root);
		if (hit) return hit.id;
		await sleep(200);
	}
	return "";
}

/** 会话此刻的 store 顺序，读的是 REST 快照（= 基线重放要读的那份东西）。 */
async function storeOrder(url: string, sessionId: string): Promise<string[]> {
	const store = (await (await fetch(`${url}/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as {
		session?: { messages?: { role?: string; content?: unknown }[] };
	};
	return (store.session?.messages ?? []).map((message) => {
		const blocks = Array.isArray(message.content) ? message.content : [];
		const text = blocks
			.map((block) => (typeof (block as { text?: unknown }).text === "string" ? String((block as { text: string }).text) : ""))
			.join("");
		return `${message.role ?? "?"}:${text.slice(0, 12)}`;
	});
}

/** store 文件本身：每条 entry 的 kind / 消息角色 / 自己的 id / parentId，按文件序。 */
async function fileShape(sessionId: string): Promise<string[]> {
	const path = SessionManager.findAnywhere(sessionId);
	if (path === undefined) return [];
	const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0);
	return lines.map((line) => {
		const entry = JSON.parse(line) as {
			type?: string;
			id?: string;
			parentId?: string | null;
			message?: { role?: string; timestamp?: number };
		};
		const kind = entry.type === "message" ? `message:${entry.message?.role ?? "?"}` : (entry.type ?? "?");
		const parent = entry.parentId === null || entry.parentId === undefined ? "null" : String(entry.parentId).slice(0, 6);
		return `${kind} <- ${parent}`;
	});
}

/**
 * 一条形状：新建会话 → 发第一条 → 运行中发第二条 → 等整轮落定 → 读 DOM。
 *
 * `reloadMidRun` 决定读数的那一刻：true 是运行当中重载页面（store 还没写完），false 是落定之后
 * 开一个新页面（store 已经写完，基线重放整份记录）。
 */
async function scenario(label: string, reloadMidRun: boolean): Promise<void> {
	process.stdout.write(`\n${label}\n`);
	const root = await mkdtemp(join(tmpdir(), "my-agent-verify20-"));
	const transport: FakeTransport = createFakeTransport({ tokensPerSecond: 200 });
	// 第一答长到够在它流式当中发第二条（~1800 字 → 约 1.8 s）；第二答推迟 0.8 s 才开始。
	transport.setResponses([
		fakeAssistantMessage("第一轮的回答。".repeat(300)),
		async () => {
			await sleep(800);
			return fakeAssistantMessage("第二轮的回答。");
		},
	]);
	const server = await bootServer({ cwd: root, port: 0, api: transport.api });
	server.hub.setUserModels(rows);
	const wire: WireClient = await connect(`${server.url.replace("http", "ws")}/mux`);

	const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
	await withProbe(page);
	await page.goto(server.url);
	await page.waitForSelector(".new-session", { timeout: 10_000 });
	await page.click(".new-session");
	await page.waitForSelector("textarea", { timeout: 10_000 });

	const sessionId = await sessionOf(server.url, root);
	check(`${label}：页面建出了会话`, sessionId !== "");
	if (sessionId === "") return;
	await wire.open(sessionId);
	const baselineAt = wire.items(sessionId).length;

	// 第一条：发出去，等它真的流起来。
	await page.fill("textarea", "第一轮的问题");
	const beforeFirst = wire.items(sessionId).length;
	await page.press("textarea", "Enter");
	check(
		`${label}：第一轮开始流式`,
		await waitFresh(
			wire,
			sessionId,
			beforeFirst,
			(message) => message.type === "status" && (message as { submitting?: boolean }).submitting === true,
			10_000,
		),
	);

	// 第二条：还在流式时按 Enter（窗口对 Enter 用的就是 followUp 形状）。
	await page.fill("textarea", "你有哪些工具");
	const beforeSecond = wire.items(sessionId).length;
	await page.press("textarea", "Enter");
	const acceptedMidRun = await waitFresh(
		wire,
		sessionId,
		beforeSecond,
		(message) => message.type === "status" && ((message as { queued?: number }).queued ?? 0) >= 1,
		10_000,
	);
	// 复现的前提：没在运行中接受，后面读到的顺序就证明不了什么。
	check(`${label}：第二条是在运行中接受的（排队深度 >= 1）`, acceptedMidRun);

	if (reloadMidRun) {
		// 就在这一刻重载：store 里此刻还没有第一条回答。
		const midRun = await storeOrder(server.url, sessionId);
		process.stdout.write(`${label}：重载那一刻的 store ${JSON.stringify(midRun)}\n`);
		await page.reload();
		await page.waitForSelector("textarea", { timeout: 10_000 });
	}

	// 等整轮落定：两个回合都在同一次运行里（followUp 由那一轮自己取走），出现 `agent_end` 就是末尾。
	check(
		`${label}：整轮在 40 s 内落定`,
		await waitFresh(
			wire,
			sessionId,
			baselineAt,
			(message) => message.type === "event" && (message as { event?: { type?: string } }).event?.type === "agent_end",
			40_000,
		),
	);
	await waitFresh(
		wire,
		sessionId,
		baselineAt,
		(message) => message.type === "status" && (message as { submitting?: boolean }).submitting === false,
		10_000,
	);
	await sleep(400);

	// 读 DOM 的那一页：重载形状用同一页（它已经重新订阅过），重开形状开一张新页（新订阅、新基线）。
	const reader = reloadMidRun
		? page
		: await (async () => {
				const fresh = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
				await withProbe(fresh);
				await fresh.goto(server.url);
				return fresh;
			})();
	await reader.waitForSelector(".transcript > section", { timeout: 10_000 });
	await sleep(600);

	const order = await domOrder(reader);
	const store = await storeOrder(server.url, sessionId);
	const shape = await fileShape(sessionId);
	await reader.screenshot({ path: join(outDir, `verify20-${reloadMidRun ? "midrun" : "reopen"}.png`) });
	process.stdout.write(`${label}：DOM ${JSON.stringify(order)}\n`);
	process.stdout.write(`${label}：store ${JSON.stringify(store)}\n`);
	process.stdout.write(`${label}：file\n${shape.map((line) => `  ${line}`).join("\n")}\n`);
	process.stdout.write(`${label}：frames ${JSON.stringify(await pageFrames(reader))}\n`);

	// 期望：问 → 答 → 问 → 答。中途发的那条必须落在它打断的那条回答**之后**。
	check(`${label}：第一项是第一轮的问题`, order[0]?.startsWith("user:第一轮的问题") === true, order[0] ?? "");
	check(`${label}：第二项是它自己的回答，气泡没有插进来`, order[1]?.startsWith("assistant:第一轮的回答") === true, order[1] ?? "");
	check(`${label}：第三项才是中途发的那条`, order[2]?.startsWith("user:你有哪些工具") === true, order[2] ?? "");
	check(`${label}：第四项是第二轮的回答`, order[3]?.startsWith("assistant:第二轮的回答") === true, order[3] ?? "");
	check(`${label}：一共四项`, order.length === 4, JSON.stringify(order));
	check(`${label}：DOM 顺序与 store 顺序一致`, JSON.stringify(order) === JSON.stringify(store), `dom=${JSON.stringify(order)} store=${JSON.stringify(store)}`);
	check(
		`${label}：store 里那条用户消息排在它打断的回答之后`,
		store.findIndex((line) => line.startsWith("user:你有哪些工具")) === 2 && store[1]?.startsWith("assistant:") === true,
		JSON.stringify(store),
	);

	if (reader !== page) await reader.close();
	await page.close();
	await wire.close();
	await server.close();
}

await scenario("A 落定后重新打开", false);
await scenario("B 运行中重载页面", true);

await browser.close();
process.stdout.write(failures === 0 ? "\nverify-20 ok\n" : `\n${failures} verify-20 checks failed\n`);
process.exit(failures === 0 ? 0 : 1);
