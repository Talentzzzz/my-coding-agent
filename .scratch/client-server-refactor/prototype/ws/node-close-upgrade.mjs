// 票 17 的 Node 侧探针 1：`server.close()` / `closeAllConnections()` 对 upgrade 之后的
// socket 的记账。两条路线各测一遍：
//   A. 纯 node:http —— upgrade 事件里自己写 101，socket 常驻
//   B. `ws` 的 WebSocketServer —— 同样的常驻连接
//
// 用法：node node-close-upgrade.mjs [--mode raw|ws|both] [--wait-ms 3000] [--ws-path <ws 包目录>]
// 输出：每个阶段一行 JSON（相对启动的毫秒数）。
const argv = process.argv.slice(2);
import { pathToFileURL } from "node:url";
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? fallback : argv[i + 1];
};
const MODE = arg("mode", "both");
const WAIT_MS = Number(arg("wait-ms", "3000"));
const WS_PATH = arg("ws-path", undefined);
// Windows 上动态 import 一个绝对路径必须写成 file:// URL。
const wsSpecifier = (file) =>
	WS_PATH === undefined ? "ws" : pathToFileURL(`${WS_PATH}/${file}`).href;

const t0 = Date.now();
const log = (event, fields = {}) =>
	process.stdout.write(`${JSON.stringify({ t: Date.now() - t0, event, ...fields })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 等着看某个条件会不会在预算内发生；返回实际发生时的耗时（或 null）。
const watch = async (label, predicate, budgetMs) => {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		if (predicate()) {
			log(label, { at: Date.now() - t0 });
			return true;
		}
		if (Date.now() > deadline) {
			log(`${label}-TIMEOUT`, { budgetMs });
			return false;
		}
		await sleep(20);
	}
};

// ---------- A. 纯 node:http ----------
async function rawMode() {
	const { createServer } = await import("node:http");
	const { createHash } = await import("node:crypto");
	const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
	let upgraded = 0;
	let upgradedClosed = 0;
	let upgradeSocketRef = null;
	const server = createServer((_req, res) => {
		res.writeHead(200);
		res.end("ok");
	});
	server.on("upgrade", (req, socket) => {
		upgraded += 1;
		upgradeSocketRef = socket;
		const accept = createHash("sha1").update(String(req.headers["sec-websocket-key"]) + GUID).digest("base64");
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		socket.on("close", () => {
			upgradedClosed += 1;
			log("raw.upgraded-socket-close", { upgradedClosed });
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	log("raw.listening", { port });

	// 客户端：一条裸 TCP 连接，自己发握手请求。
	const { connect } = await import("node:net");
	const client = connect(port, "127.0.0.1");
	await new Promise((r) => client.on("connect", r));
	client.write(
		"GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
			`Sec-WebSocket-Key: ${Buffer.from("0123456789abcdef").toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
	);
	await sleep(300);
	log("raw.handshake-done", { upgraded, socketDestroyed: upgradeSocketRef?.destroyed ?? null });

	let closeCallbackAt = null;
	server.close(() => {
		closeCallbackAt = Date.now() - t0;
		log("raw.SERVER-CLOSE-CALLBACK", { at: closeCallbackAt, upgradedClosed });
	});
	log("raw.server.close()-called", { connections: upgraded });
	await sleep(WAIT_MS);
	log("raw.after-close-wait", {
		closeCallbackAt,
		upgradedClosed,
		socketDestroyed: upgradeSocketRef?.destroyed ?? null,
		serverListening: server.listening,
	});

	// 现在试 closeAllConnections()
	server.closeAllConnections();
	log("raw.closeAllConnections()-called", {});
	await watch("raw.upgraded-socket-close-after-closeAllConnections", () => upgradedClosed > 0, 3000);
	log("raw.after-closeAllConnections", {
		closeCallbackAt,
		upgradedClosed,
		socketDestroyed: upgradeSocketRef?.destroyed ?? null,
		clientDestroyed: client.destroyed,
	});
	client.destroy();
	await sleep(200);
}

// ---------- B. ws ----------
async function wsMode() {
	const wsMod = await import(wsSpecifier("index.js"));
	const { WebSocketServer } = wsMod.default ?? wsMod;
	const server = new (await import("node:http")).createServer((_req, res) => {
		res.writeHead(200);
		res.end("ok");
	});
	const wss = new WebSocketServer({ server });
	let closeEvents = 0;
	let lastSocket = null;
	wss.on("connection", (socket) => {
		lastSocket = socket;
		socket.on("close", () => {
			closeEvents += 1;
			log("ws.socket-close-event", { closeEvents });
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	log("ws.listening", { port });

	const wsClientMod = await import(wsSpecifier("wrapper.mjs"));
	const { WebSocket } = wsClientMod.default ?? wsClientMod;
	const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	await new Promise((resolve, reject) => {
		client.on("open", resolve);
		client.on("error", reject);
	});
	await sleep(200);
	log("ws.handshake-done", {
		upgradedSockets: wss.clients.size,
		socketWritableHwm: lastSocket?._socket?.writableHighWaterMark,
		socketReadableHwm: lastSocket?._socket?.readableHighWaterMark,
		socketConstructor: lastSocket?._socket?.constructor?.name,
	});

	let closeCallbackAt = null;
	server.close(() => {
		closeCallbackAt = Date.now() - t0;
		log("ws.SERVER-CLOSE-CALLBACK", { at: closeCallbackAt, closeEvents });
	});
	log("ws.server.close()-called", {});
	await sleep(WAIT_MS);
	log("ws.after-close-wait", {
		closeCallbackAt,
		closeEvents,
		serverListening: server.listening,
		clientReadyState: client.readyState,
	});

	server.closeAllConnections();
	log("ws.closeAllConnections()-called", {});
	await watch("ws.socket-close-after-closeAllConnections", () => closeEvents > 0, 3000);
	log("ws.after-closeAllConnections", { closeCallbackAt, closeEvents, clientReadyState: client.readyState });
	try {
		client.terminate();
	} catch {}
	await sleep(200);
}

if (MODE === "raw" || MODE === "both") await rawMode();
if (MODE === "ws" || MODE === "both") await wsMode();
log("done", {});
