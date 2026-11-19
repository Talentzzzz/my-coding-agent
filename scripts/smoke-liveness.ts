// Liveness 冒烟测试：客户端不发请求也能发现连接已死。它驱动*生产*连接层——正是窗口运行的那个
// `MuxClient`，不是重写的 watchdog（断言 watchdog 的副本只能证明副本没问题）——经由一条可以
// 假死的中继对着真服务器，断言完整弧线：第一帧上判活、在服务器心跳自己许诺的容忍度内判死、
// 重连、再经一份新基线收敛。
//
//   node scripts/smoke-liveness.ts
//
// 中继是这个装置承重的一半：黑屏期间它继续*读*服务端、把字节丢掉，于是"服务端一直在说话"的
// 证据就是中继自己的丢字节计数器，被测的正是客户端的读超时——而不是服务端的停滞策略，那个
// 有自己的 smoke。无需 provider key：被监视的 session 出生时要跑一轮（ADR-0021），那轮由剧本化
// transport 在本机作答，此后它一整场都不再运行。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer, type BootedServer } from "../packages/server/src/boot.ts";
import { MuxClient, type ChannelState, type MuxSocket, type MuxSocketFactory, type MuxSocketHandlers } from "../packages/web/src/client.ts";
import { faultyProxy, type FaultyProxy } from "./wire/proxy.ts";
import { until } from "./wire/client.ts";
import { createFakeTransport, fakeAssistantMessage } from "./fake-transport.ts";
import { setSessionsDir, type ModelConfig, type ServerMessage } from "@my-agent/core";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

/**
 * 浏览器的 socket，跑在 Node 自带的全局 `WebSocket` 上。这是生产层与本运行时之间唯一的适配器
 * ——与浏览器相同的三个事件、两个方法。
 */
function nodeSocket(url: string): MuxSocketFactory {
	return (handlers: MuxSocketHandlers): MuxSocket => {
		const webSocket = new WebSocket(url);
		webSocket.addEventListener("open", () => handlers.onOpen());
		webSocket.addEventListener("message", (event) => handlers.onMessage(String(event.data)));
		webSocket.addEventListener("close", () => handlers.onClose());
		webSocket.addEventListener("error", () => handlers.onError());
		return {
			send: (text) => webSocket.send(text),
			close: (code, reason) => webSocket.close(code, reason),
		};
	};
}

/** 断言要回读的一切，集中在一处。 */
interface Observed {
	channels: { state: ChannelState; at: number }[];
	heartbeats: number;
	baselines: ServerMessage[];
	ended: string[];
	errors: { sessionId: string; message: string }[];
}

const root = await mkdtemp(join(tmpdir(), "my-agent-liveness-"));
/** 一个临时 agent home，本 smoke 写的设置不是机器自己的。 */
const home = await mkdtemp(join(tmpdir(), "my-agent-liveness-home-"));
/** 一个临时 store，本 smoke 出生的会话不是机器自己的。 */
const storeRoot = await mkdtemp(join(tmpdir(), "my-agent-liveness-store-"));
setSessionsDir(storeRoot);

/** 出生那一轮驱动的剧本化模型。它的端点永远不会被拨通：transport 自己应答。 */
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

/** session 自己的快照是否说有一次 run 在途——判断出生那一轮何时落定用。 */
async function running(base: string, sessionId: string): Promise<boolean> {
	const response = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}`);
	return ((await response.json()) as { session: { running: boolean } }).session.running;
}

// 心跳间隔是本 smoke 的整个时钟：服务器每 50 ms 说一次话，客户端容忍其中三次（它自己的规则，
// 由 `everyMs` 推得），两个数字都远小于下方的断言窗口。
const transport = createFakeTransport();
const server: BootedServer = await bootServer({ workDirAbsPath: root, port: 0, mux: { heartbeatIntervalMs: 50 }, chatTransport: transport.chatTransport, settingsHome: home });
// 出生请求需要一行模型（ADR-0021：它自带第一条消息，于是那一轮当场开跑）。
server.sessionHub.setModelConfigs(modelRows);
const proxy: FaultyProxy = await faultyProxy(new URL(server.url));

const observed: Observed = { channels: [], heartbeats: 0, baselines: [], ended: [], errors: [] };
/** 窗格监视的 session，服务器指名它的落地 session 后设置。 */
let watchId = "";
const muxClient = new MuxClient(
	{
		onChannel: (state) => observed.channels.push({ state, at: Date.now() }),
		onConnectionItem: (item) => {
			if (item.type === "heartbeat") observed.heartbeats += 1;
		},
		onStreamMessage: (sessionId, message) => {
			if (message.type === "baseline" && sessionId === watchId) observed.baselines.push(message);
		},
		onStreamEnd: (sessionId) => observed.ended.push(sessionId),
		onStreamError: (sessionId, message) => observed.errors.push({ sessionId, message }),
	},
	{
		url: proxy.url,
		socket: nodeSocket(proxy.url),
		// 心跳前回退只管辖第一声心跳报出自己的间隔之前那段；对一台握手后 50 ms 内就开口的
		// 服务器，一秒已经很宽裕。
		watchdogTimeoutMs: 1_000,
		readyTimeoutMs: 5_000,
		log: () => {},
	},
);

try {
	// 启动时现在不选任何东西，所以本 smoke 监视的 session 是显式创建返回的那个。出生请求自带第一条
	// 消息（ADR-0021），所以它当场跑一轮；等那一轮落定，它此后一整场都安静——本节要看的是心跳，
	// 不是运行。
	transport.setResponses([fakeAssistantMessage("warm-up answer")]);
	const created = await fetch(`${server.url}/api/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "开场" }),
	});
	check("the watched session was created", created.status === 201, String(created.status));
	watchId = ((await created.json()) as { sessionId: string }).sessionId;
	check(
		"its birth run settled before the window opens",
		await until(async () => (await running(server.url, watchId)) === false, 5_000),
	);

	// -----------------------------------------------------------------------------
	// 1. 活是被证明的，不是被假设的：通道在第一帧上判活，而不是在握手上。
	// -----------------------------------------------------------------------------
	process.stdout.write("the channel proves itself with the server's first frame\n");

	muxClient.start();
	muxClient.retain(watchId, "pane");
	check("the channel reached live", await until(() => muxClient.channel === "live", 3_000), JSON.stringify(observed.channels));
	check("and heartbeats were already arriving", observed.heartbeats > 0, String(observed.heartbeats));
	check("the watched session's baseline arrived", await until(() => observed.baselines.length === 1, 3_000), String(observed.baselines.length));

	// -----------------------------------------------------------------------------
	// 2. 黑屏：服务器一直在说话，客户端什么都听不到，而判它死的是客户端自己——在心跳自己
	//    许诺的容忍度之内。
	// -----------------------------------------------------------------------------
	process.stdout.write("a connection that stops speaking is declared dead without a request\n");

	const liveAt = observed.channels.find((entry) => entry.state === "live")?.at ?? Date.now();
	proxy.blackout(true);
	const died = await until(() => muxClient.channel === "down", 2_000);
	const downAt = observed.channels.find((entry) => entry.state === "down")?.at ?? 0;
	check("the channel was declared down", died, JSON.stringify(observed.channels));
	check(
		"within three of the heartbeats it was promised, plus margin for the runtime",
		died && downAt - liveAt < 3 * 50 + 1_500,
		`${downAt - liveAt} ms`,
	);
	check(
		"the server was talking the whole time — the relay threw real bytes away",
		proxy.dropped.bytes > 0,
		`${proxy.dropped.bytes} bytes dropped`,
	);
	check("and no request was sent to find any of this out", observed.errors.length === 0, JSON.stringify(observed.errors));

	// -----------------------------------------------------------------------------
	// 3. 中继松手：客户端自己重连，按引用重开它仍想要的东西，视图被 session 现在的样子整体
	//    替换。
	// -----------------------------------------------------------------------------
	process.stdout.write("the reconnect re-opens what the window still wants\n");

	proxy.blackout(false);
	check("a second connection arrived at the relay", await until(() => proxy.connections === 2, 5_000), String(proxy.connections));
	check("and the channel proved itself live again", await until(() => muxClient.channel === "live", 3_000), JSON.stringify(observed.channels));

	// 订阅表是有意要在断连中存活的，于是重连重开了窗格的 session，服务器以第二份基线作答
	// ——视图被整体替换，既不是追加，也不是留着它记住的任何东西。
	check("the session's stream was re-opened with a fresh baseline", await until(() => observed.baselines.length === 2, 3_000), String(observed.baselines.length));
	check("the re-opened stream was not ended behind the window's back", observed.ended.length === 0, JSON.stringify(observed.ended));

	muxClient.close();
} finally {
	await proxy.close();
	await server.close();
	await rm(root, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
	await rm(storeRoot, { recursive: true, force: true });
	process.stdout.write(failures === 0 ? "\nliveness ok\n" : `\n${failures} failure(s)\n`);
	process.exitCode = failures === 0 ? 0 : 1;
}
