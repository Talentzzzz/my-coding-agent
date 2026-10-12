// 票 17 的 Node 侧探针 2：Node ≥22 的全局 `WebSocket`（undici）在 22.19 与 24.15 上的行为。
// 冒烟（票 15）要用它，所以这里要的是"它到底暴露什么、报什么"。
//
// 用法：node global-ws.mjs [--port <探针服务器端口>]
// 需要先用 prototype/ws/server.mjs 起一个探针服务器；本脚本自己起一个（同目录）。
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out", "global-ws");
// 本脚本可以单独跑（不经 run.mjs），所以自己保证输出目录存在。
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (event, fields = {}) =>
	process.stdout.write(`${JSON.stringify({ t: Date.now() - t0, event, ...fields })}\n`);

log("versions", {
	node: process.version,
	undici: process.versions.undici,
	v8: process.versions.v8,
});

// 1) API 表面
log("typeof", { WebSocket: typeof globalThis.WebSocket });
const proto = WebSocket.prototype;
log("prototype", {
	names: Object.getOwnPropertyNames(proto).sort(),
	statics: Object.getOwnPropertyNames(WebSocket).sort(),
	CONNECTING: WebSocket.CONNECTING,
	OPEN: WebSocket.OPEN,
	CLOSING: WebSocket.CLOSING,
	CLOSED: WebSocket.CLOSED,
});
const instance = Object.create(proto);
try {
	new WebSocket("not-a-url");
} catch (error) {
	log("bad-url-throws", { name: error.name, message: error.message });
}
log("instance-keys", { names: Object.getOwnPropertyNames(instance).sort() });

// 2) 起探针服务器
const port = await new Promise((resolve) => {
	const probe = createServer();
	probe.listen(0, "127.0.0.1", () => {
		const p = probe.address().port;
		probe.close(() => resolve(p));
	});
});
const SERVER_LOG = join(OUT, `server-${process.version.replaceAll(".", "_")}.log`);
const serverLog = SERVER_LOG;
const child = spawn(
	process.execPath,
	[join(HERE, "server.mjs"), "--port", String(port), "--log", serverLog, "--ping-ms", "150"],
	{ stdio: "ignore" },
);
const waitFor = async (predicate, ms) => {
	const deadline = Date.now() + ms;
	for (;;) {
		if (predicate()) return true;
		if (Date.now() > deadline) return false;
		await new Promise((r) => setTimeout(r, 50));
	}
};
await waitFor(() => existsSync(serverLog) && readFileSync(serverLog, "utf8").includes('"listening"'), 5000);
const url = `ws://127.0.0.1:${port}/ws`;

const once = (ws, kind, ms) =>
	new Promise((resolve) => {
		const timer = setTimeout(() => resolve({ kind: "timeout", ms }), ms);
		ws.addEventListener(kind, (event) => {
			clearTimeout(timer);
			resolve({
				kind,
				code: event.code,
				reason: event.reason,
				wasClean: event.wasClean,
				message: event.message,
				error: event.error ? String(event.error) : undefined,
			});
		});
	});

// 3) 基本往返 + 服务端 ping 是否被自动回 pong
{
	const ws = new WebSocket(url);
	await once(ws, "open", 3000);
	ws.send(JSON.stringify({ cmd: "echo", text: "hello" }));
	const message = await new Promise((resolve) => {
		ws.addEventListener("message", (event) => resolve(String(event.data)));
		setTimeout(() => resolve("timeout"), 2000);
	});
	log("echo", { message });
	await new Promise((r) => setTimeout(r, 600)); // 让服务端 ping 两三次
	log("after-pings", { readyState: ws.readyState, bufferedAmount: ws.bufferedAmount });
	// 有任何 ping/pong 的钩子吗？
	const pongProps = [
		"onping",
		"onpong",
		"ping",
		"pong",
		"socket",
		"_socket",
		"addEventListener-ping",
	].map((key) => ({ key, present: key in ws }));
	log("liveness-hooks", { pongProps, hasSocket: "socket" in ws, hasPing: typeof ws.ping });
	ws.close(4000, "reconnect requested");
	const closed = await once(ws, "close", 3000);
	log("client-close-4000", closed);
}

// 4) 服务端关：1013 的送达
{
	const ws = new WebSocket(url);
	await once(ws, "open", 3000);
	const events = [];
	ws.addEventListener("error", () => events.push("error"));
	ws.addEventListener("close", (event) => events.push(`close:${event.code}/${event.reason}/${event.wasClean}`));
	ws.send(JSON.stringify({ cmd: "close", code: 1013, reason: "try again later" }));
	await new Promise((r) => setTimeout(r, 800));
	log("server-close-1013", { events, readyState: ws.readyState });
}

// 5) 服务端 destroy（异常关闭）
{
	const ws = new WebSocket(url);
	await once(ws, "open", 3000);
	const events = [];
	ws.addEventListener("error", () => events.push("error"));
	ws.addEventListener("close", (event) => events.push(`close:${event.code}/${event.reason}/${event.wasClean}`));
	ws.send(JSON.stringify({ cmd: "destroy" }));
	await new Promise((r) => setTimeout(r, 800));
	log("server-destroy", { events, readyState: ws.readyState });
}

// 6) 协议违规：服务端发非法 opcode
{
	const ws = new WebSocket(url);
	await once(ws, "open", 3000);
	const events = [];
	ws.addEventListener("error", (event) => events.push(`error:${event.message ?? ""}`));
	ws.addEventListener("close", (event) => events.push(`close:${event.code}/${event.reason}/${event.wasClean}`));
	ws.send(JSON.stringify({ cmd: "badopcode" }));
	await new Promise((r) => setTimeout(r, 800));
	log("protocol-badopcode", { events, readyState: ws.readyState });
}

// 7) 客户端非法 close code
{
	const ws = new WebSocket(url);
	await once(ws, "open", 3000);
	for (const code of [1001, 1234, 5000, 1005]) {
		let threw = null;
		try {
			ws.close(code, "x");
		} catch (error) {
			threw = { name: error.name, message: error.message };
		}
		log("client-close-invalid", { code, threw, readyState: ws.readyState });
	}
	ws.close();
	await new Promise((r) => setTimeout(r, 500));
}

// 8) 连不上 / 握手失败
{
	const ws = new WebSocket("ws://127.0.0.1:9/ws");
	const events = [];
	ws.addEventListener("error", (event) => events.push(`error:${event.message ?? ""}`));
	ws.addEventListener("close", (event) => events.push(`close:${event.code}/${event.reason}/${event.wasClean}`));
	await new Promise((r) => setTimeout(r, 1500));
	log("refused", { events, readyState: ws.readyState });
}
{
	const ws = new WebSocket(`ws://127.0.0.1:${port}/health`);
	const events = [];
	ws.addEventListener("error", (event) => events.push(`error:${event.message ?? ""}`));
	ws.addEventListener("close", (event) => events.push(`close:${event.code}/${event.reason}/${event.wasClean}`));
	await new Promise((r) => setTimeout(r, 1500));
	log("handshake-404", { events, readyState: ws.readyState });
}

child.kill();
await new Promise((r) => setTimeout(r, 200));
const lines = readFileSync(serverLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const pongs = lines.filter((line) => line.event === "pong-from-client");
log("server-side", {
	upgrades: lines.filter((l) => l.event === "upgrade").length,
	pongs: pongs.length,
	pongRttMs: pongs.slice(0, 8).map((p) => p.rttMs),
	closeFramesFromClient: lines
		.filter((l) => l.event === "close-frame-from-client")
		.map((l) => ({ code: l.code, reason: l.reason })),
	serverLog,
});
log("done", {});
