// 一次活体检查：浏览器客户端与服务器真的达成一致——启动真服务器，对 `/mux` 打开真 WebSocket，
// 并经由生产用的 `MuxClient` 驱动它——正是窗口用的那个类。所以这是桌面外壳运行所依赖的接缝，
// 不是它的 mock。
// 最后两节经由剧本化 transport 驱动一次真实的 run，以及一个目录被搁置又被收回——那是任何行帧
// 都携带不了的唯一一种变化。
// 无需 provider key——有 run 发生的地方，模型就是剧本化 transport。
// 运行：node scripts/smoke-mux-live.ts
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "../packages/server/src/boot.ts";
import { MuxClient, browserSocket, type MuxHandlers } from "../packages/web/src/client.ts";
import { SessionRows } from "../packages/web/src/rows.ts";
import { createFakeTransport, fakeAssistantMessage } from "./fake-transport.ts";
import type { ConnectionItem, ServerMessage } from "@my-agent/core/protocol";
import { setSessionsDir, type ModelConfig } from "@my-agent/core";

const root = await mkdtemp(join(tmpdir(), "my-agent-mux-live-"));
/** 一个临时 agent home，本 smoke 写的设置不是机器自己的。 */
const home = await mkdtemp(join(tmpdir(), "my-agent-mux-live-home-"));
/** 一个临时 store，本 smoke 写的 session 不是机器自己的。 */
const storeRoot = await mkdtemp(join(tmpdir(), "my-agent-mux-live-store-"));
setSessionsDir(storeRoot);
let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

/** 轮询直到 `ready` 成立，任何检查都不猜测异步读取的时机。 */
async function until(ready: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await ready()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return ready();
}

/** 按 REST 发一条 prompt，与窗口 composer 的做法一致。 */
async function postPrompt(base: string, sessionId: string, text: string): Promise<number> {
	const response = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
	});
	return response.status;
}

/** session 自己的快照是否说有一次 run 在途。 */
async function submitting(base: string, sessionId: string): Promise<boolean> {
	const response = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}`);
	return ((await response.json()) as { session: { submitting: boolean } }).session.submitting;
}

/**
 * 这一帧是否是 run 的最后话语，与窗口读它的两个位置相同。
 *
 * 是 `main.ts` 那个助手的一份副本而不是 import，因为 `main.ts` 触碰 DOM、无法在这里加载。
 * 它正是下面 `onStreamMessage` 镜像的那个释放信号。
 */
function settled(message: ServerMessage): boolean {
	if (message.type === "status") return !message.submitting;
	if (message.type === "baseline") return !message.session.submitting;
	return false;
}

/** run 那一节驱动的剧本化模型。它的端点永远不会被拨通：transport 自己应答。 */
const modelRows: ModelConfig[] = [
	{
		name: "scripted",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "unused-by-the-scripted-transport",
		id: "claude-sonnet-4-5",
		contextWindow: 200_000,
		maxTokens: 8_192,
	},
];

process.stdout.write("\n真服务器 + 真 WebSocket + 生产的 MuxClient\n");

const transport = createFakeTransport({ tokensPerSecond: 400 });
/** 一秒：快到让 smoke 不冗长，慢到 Windows 的调度噪声饿不死客户端的 watchdog（它的容忍是
 * 这个间隔的三次）。 */
const heartbeatEveryMs = 1_000;
const server = await bootServer({ workDirAbsPath: root, port: 0, mux: { heartbeatIntervalMs: heartbeatEveryMs }, api: transport.api, settingsHome: home });
// 启动后、任何 prompt 之前交给 hub：下面那一节 run 需要一个可供运行的模型。
server.hub.setModelConfigs(modelRows);

try {
	// 启动时现在不选任何东西，所以本 smoke 驱动的 session 是显式创建返回的那个。
	const created = await fetch(`${server.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" } });
	check("驱动会话已创建", created.status === 201, String(created.status));
	const { sessionId } = await created.json() as { sessionId: string };

	// 无人开口的 session 没有文件、因此也没有行（ADR-0006 §3）——侧栏列出的是对话，不是意图。
	// 一轮热身正是把这个 session 放进下面每个检查都要读的行存储的动作。
	transport.setResponses([fakeAssistantMessage("warm-up answer")]);
	check("开场 prompt 被接受", (await postPrompt(server.url, sessionId, "开场")) === 202);
	check("开场 run 落定了", await until(async () => (await submitting(server.url, sessionId)) === false));

	const channels: string[] = [];
	const items: ConnectionItem[] = [];
	const messages: { sessionId: string; type: string }[] = [];
	const ended: string[] = [];
	const errors: string[] = [];

	const client: MuxClient = new MuxClient(
		{
			onChannel: (state) => channels.push(state),
			onConnectionItem: (item) => items.push(item),
			// 与窗口自身的接线互为镜像：一个 send 的引用活得恰好与它启动的那次 run 一样久，一条
			// 说 run 已落定的 status 就是它的出口之一。没有这个，下面的复现就不是用户撞到的那个。
			onStreamMessage: (id, message: ServerMessage) => {
				messages.push({ sessionId: id, type: message.type });
				if (settled(message)) client.release(id, "send");
			},
			onStreamEnd: (id) => {
				ended.push(id);
				client.release(id, "send");
			},
			onStreamError: (id, message) => {
				errors.push(`${id}:${message}`);
				if (id !== "") client.release(id, "send");
			},
		} satisfies MuxHandlers,
		{ url: server.url.replace("http", "ws") + "/mux", socket: browserSocket(server.url.replace("http", "ws") + "/mux") },
	);
	client.start();

	// 通道自己的第一帧是心跳，所以这才是真的"已连接且确认无恙"。
	check("收到第一帧心跳即 live", await until(() => client.channel === "live"), `got ${client.channel}`);
	check("心跳带服务端自己的间隔", items.some((i) => i.type === "heartbeat" && i.everyMs === heartbeatEveryMs), JSON.stringify(items));

	// 行表不订阅任何东西就到达连接座位——概览存在的全部理由正是一行在没人看着时不得冻结。
	await until(() => items.some((i) => i.type === "sessions"));
	const table = items.find((i) => i.type === "sessions");
	check("未订阅任何会话也收到整表", table?.type === "sessions" && table.sessions.some((r) => r.id === sessionId), JSON.stringify(table));
	check("行带 modified/running/pending", table?.type === "sessions" && table.sessions.every((r) => typeof r.modified === "number" && typeof r.running === "boolean" && typeof r.pending === "number"));

	// 订阅是一次 `open`，应答是那条流上的一份 baseline——设计要求的原子对，中间不存在
	// "已订阅但还没 baseline"的状态。
	client.retain(sessionId, "pane");
	check("open 之后拿到基线", await until(() => messages.some((m) => m.sessionId === sessionId && m.type === "baseline")), JSON.stringify(messages));
	check("这条流不再报错", errors.filter((e) => e.startsWith(sessionId)).length === 0, JSON.stringify(errors));

	// 行存储收下通道的整表，并在通道持有它期间拒收 REST 列表。
	const rows = new SessionRows();
	for (const item of items) {
		if (item.type === "sessions") rows.replaceAll(item.sessions);
		if (item.type === "session_row") rows.put(item.session);
	}
	check("行 store 拿到了这个会话", rows.get(sessionId) !== undefined, JSON.stringify(rows.list().map((r) => r.id)));
	const refused = rows.loadFrom([{ workDirAbsPath: root, sessions: [] }], true);
	check("通道 live 时 REST 列表被拒收", refused === false && rows.get(sessionId) !== undefined, `refused=${refused}`);

	// 取消按设计是沉默的：客户端要求停止接收，所以一个回执会是它刚刚说过不要的那条流上的一帧。
	// 要紧的是条目随之而去、客户端不再把这条流当作被监视——而不是有什么回来。
	client.release(sessionId, "pane");
	await new Promise((resolve) => setTimeout(resolve, 200));
	check("cancel 之后不再持有这个会话", !client.isRetained(sessionId) && !client.isWatching(sessionId));
	check("cancel 不要求任何回执", !ended.includes(sessionId), JSON.stringify(ended));

	// 引用消失后的重新订阅是一次新的手势，会拿到一份新基线。
	client.retain(sessionId, "pane");
	const before = messages.filter((m) => m.sessionId === sessionId && m.type === "baseline").length;
	check("重新订阅又拿到一份基线", await until(() => messages.filter((m) => m.sessionId === sessionId && m.type === "baseline").length > before), JSON.stringify(messages));

	// 一个什么都不是的 session id 在帧上被应答，而不是用状态码，因为通道不再有按订阅的应答。
	const beforeErrors = errors.length;
	client.retain("不存在的会话", "pane");
	check("订阅不存在的会话在帧上被拒绝", await until(() => errors.length > beforeErrors), JSON.stringify(errors));
	check("并且那条流被结束", await until(() => ended.includes("不存在的会话")), JSON.stringify(ended));

	// ---------------------------------------------------------------------------------------------
	// 报告的 bug：一次 run 结束，server reap 掉承载它的 host 并结束这条流，而窗格从未离开这个
	// session。第二次 prompt 必须再次到达这条连接。
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("run 结束后，同一会话的下一次 prompt 必须重新收到帧\n");

	const framesFor = (): number => messages.filter((m) => m.sessionId === sessionId).length;

	// Run 1：窗口拿走窗格的引用和一次 send 的引用，发帖，看着回答，承载它的 host 消失后 server
	// 结束这条流。窗格全程指着这个 session——这正是旧客户端出不来状态。
	transport.setResponses([fakeAssistantMessage("first answer")]);
	const beforeFirst = framesFor();
	client.retain(sessionId, "send");
	check("第一条 prompt 被接受", (await postPrompt(server.url, sessionId, "第一条")) === 202);
	check("第一条 prompt 的帧到达了", await until(() => framesFor() > beforeFirst, 10_000), JSON.stringify(messages.slice(beforeFirst)));
	check("run 结束后服务端把这条流判终", await until(() => ended.includes(sessionId), 10_000), JSON.stringify(ended));

	// Run 2：同一个 session、新的一次 send 引用、窗格仍然持有它。窗口没有任何变化，所以帧必须
	// 与第一次分毫不差地到达。
	const beforeSecond = framesFor();
	transport.setResponses([fakeAssistantMessage("second answer")]);
	client.retain(sessionId, "send");
	check("第二条 prompt 被接受", (await postPrompt(server.url, sessionId, "第二条")) === 202);
	check("第二条 prompt 也必须再次收到帧", await until(() => framesFor() > beforeSecond, 10_000), JSON.stringify(messages.slice(beforeSecond)));

	// ---------------------------------------------------------------------------------------------
	// 一个被搁置的目录离开*列表*，那是任何行帧都携带不了的唯一一种变化：没有一行变了，所以
	// server 重发概览——与连接打开时同一帧。两个方向都重要，也都对着窗口实际保有的行表核对。
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("被搁置的目录离开概览，回来时也回到概览\n");

	const aside = join(root, "aside");
	await mkdir(aside, { recursive: true });

	/** 客户端自己的行表，按 `main.ts` 喂它的方式：最新的概览，随后的各行。 */
	const rowTable = (): SessionRows => {
		const store = new SessionRows();
		for (const item of items) {
			if (item.type === "sessions") store.replaceAll(item.sessions);
			if (item.type === "session_row") store.put(item.session);
		}
		return store;
	};
	const overviews = (): number => items.filter((item) => item.type === "sessions").length;
	const postSession = (workDirAbsPath: string): Promise<Response> =>
		fetch(`${server.url}/api/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ workDirAbsPath }),
		});
	const restDirectories = async (): Promise<string[]> =>
		((await (await fetch(`${server.url}/api/directories`)).json()) as { directories: { workDirAbsPath: string }[] }).directories.map((group) => group.workDirAbsPath);

	const first = (await (await postSession(aside)).json()) as { sessionId: string };
	// 与上面热身遵循的同一条生命周期规则：无人开口的 session 没有文件，目录也不存在——一条
	// prompt 是让两张表都知道它的动作。
	transport.setResponses([fakeAssistantMessage("aside answer")]);
	check("新目录里的开场 prompt 被接受", (await postPrompt(server.url, first.sessionId, "让目录落盘")) === 202);
	check("新目录的行到达了概览", await until(() => rowTable().get(first.sessionId) !== undefined), JSON.stringify(rowTable().list().map((row) => row.workDirAbsPath)));
	check("它也被 REST 列表列着", (await restDirectories()).includes(aside), JSON.stringify(await restDirectories()));

	const beforeHide = overviews();
	const hidden = await fetch(`${server.url}/api/directories/hide`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ workDirAbsPath: aside }),
	});
	check("搁置一个目录被接受 (200)", hidden.status === 200, `status=${hidden.status}`);
	check("服务端因此重发了一份概览", await until(() => overviews() > beforeHide), `overviews=${overviews()}`);
	check("行表里不再有这个目录的任何一行", rowTable().list().every((row) => row.workDirAbsPath !== aside), JSON.stringify(rowTable().list().map((row) => row.workDirAbsPath)));
	check("REST 列表与概览说的是同一件事", !(await restDirectories()).includes(aside), JSON.stringify(await restDirectories()));

	// 收回来：transcript 与文件夹从未被动过，所以在那个目录里新建一次 session 就是用户说想让它
	// 再出现在列表里。
	const beforeBack = overviews();
	const reborn = await postSession(aside);
	check("在搁置的目录里新建会话被接受 (201)", reborn.status === 201, `status=${reborn.status}`);
	check("服务端又重发了一份概览", await until(() => overviews() > beforeBack), `overviews=${overviews()}`);
	check("那个目录回到了行表里", rowTable().list().some((row) => row.workDirAbsPath === aside), JSON.stringify(rowTable().list().map((row) => row.workDirAbsPath)));
	check("REST 列表也把它列回来了", (await restDirectories()).includes(aside), JSON.stringify(await restDirectories()));

	client.close();
	check("关掉之后不再有状态变化", channels.at(-1) !== undefined);
} finally {
	await server.close();
	// 工作目录与临时 store：一个被创建却从不清理的 session 否则会每次运行都落进真实的 agent home。
	await rm(root, { recursive: true, force: true });
	await rm(storeRoot, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nmux live ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;