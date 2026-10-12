// 票 17 的 Node 侧探针 3：`ws` 的写侧表面 —— socket 高水位、bufferedAmount 记什么、
// send() 回调什么时候来、write() 返回 false 之后 ws 会不会停。
//
// 用法：node ws-backpressure.mjs --ws-path <ws 包目录> [--frame-bytes 4096] [--frames 200] [--stall-ms 4000]
// 装置：服务端用 ws 起一条连接；客户端用裸 net.Socket 完成一次真握手然后**暂停读取**
// （所以不需要 ws 客户端，也就没有"客户端自己缓冲"的干扰）。
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? fallback : argv[i + 1];
};
const WS_PATH = arg("ws-path", undefined);
const FRAME_BYTES = Number(arg("frame-bytes", "4096"));
const FRAMES = Number(arg("frames", "200"));
const STALL_MS = Number(arg("stall-ms", "4000"));
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const t0 = Date.now();
const log = (event, fields = {}) =>
	process.stdout.write(`${JSON.stringify({ t: Date.now() - t0, event, ...fields })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wsMod = await import(
	WS_PATH === undefined ? "ws" : pathToFileURL(`${WS_PATH}/index.js`).href
);
const { WebSocketServer } = wsMod.default ?? wsMod;

const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer });
let serverSocket = null;
wss.on("connection", (socket) => {
	serverSocket = socket;
});

await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
const port = httpServer.address().port;
log("listening", { port });

// 客户端：手写握手，然后 pause() —— 一个真的"不读的对端"，且它自己的缓冲不参与记账。
const client = connect(port, "127.0.0.1");
await new Promise((r) => client.on("connect", r));
client.write(
	"GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		`Sec-WebSocket-Key: ${Buffer.from("0123456789abcdef").toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
);
await new Promise((resolve, reject) => {
	client.once("data", (chunk) => {
		const text = chunk.toString("latin1");
		if (!text.startsWith("HTTP/1.1 101")) reject(new Error(`handshake failed: ${text.slice(0, 80)}`));
		else resolve();
	});
});
await sleep(200);
const socket = serverSocket;

// 让服务端 socket 的每一次 write 都留下返回值与缓冲水位。
const writes = [];
const rawSocket = socket._socket;
const originalWrite = rawSocket.write.bind(rawSocket);
rawSocket.write = (chunk, encoding, cb) => {
	const before = rawSocket._writableState.length;
	const result = originalWrite(chunk, encoding, cb);
	writes.push({
		t: Date.now() - t0,
		bytes: typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length,
		returned: result,
		writableLengthBefore: before,
		writableLengthAfter: rawSocket._writableState.length,
	});
	return result;
};

log("hwm", {
	writableHighWaterMark: rawSocket.writableHighWaterMark,
	readableHighWaterMark: rawSocket.readableHighWaterMark,
	constructor: rawSocket.constructor.name,
	wsSocketHasHighWaterMarkOption: "highWaterMark" in (socket._socket._writableState ?? {}) ? undefined : false,
});

// 走应用层 send 路径：长度接近但不超过 HWM/帧，方便看写入何时被拒。
const payload = "x".repeat(FRAME_BYTES);
const callbacks = [];
client.pause(); // 对端停止读取
log("client-paused", {});

const marks = [];
// --flood-ms > 0 时改成"持续灌"：一直写，直到跑满时间或缓冲越过 --cap-mb（防内存失控）。
const FLOOD_MS = Number(arg("flood-ms", "0"));
const CAP_MB = Number(arg("cap-mb", "300"));
const floodStart = Date.now();
let hitCap = false;
for (let i = 1; i <= FRAMES; i += 1) {
	const frameBytesBefore = rawSocket._writableState.length;
	socket.send(payload, (error) => {
		callbacks.push({ i, t: Date.now() - t0, error: error ? String(error) : null });
	});
	// 只有长度真的变了才额外记一条：`send()` 之后长度与之前不同，说明这一帧已经进了缓冲。
	const frameBytesAfter = rawSocket._writableState.length;
	if (FLOOD_MS > 0) {
		if (Date.now() - floodStart > FLOOD_MS) break;
		if (rawSocket._writableState.length > CAP_MB * 1048576) {
			hitCap = true;
			break;
		}
	}
	if (i % 10 === 0 || frameBytesAfter !== frameBytesBefore) {
		marks.push({
			i,
			t: Date.now() - t0,
			bufferedAmount: socket.bufferedAmount,
			writableLength: rawSocket._writableState.length,
			wsBufferedBytes: socket._sender._bufferedBytes,
			callbacksFired: callbacks.length,
			lastWriteReturned: writes.length > 0 ? writes[writes.length - 1].returned : null,
			heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
			rssMb: Math.round(process.memoryUsage().rss / 1048576),
		});
	}
}
log("sent", { frames: marks.length > 0 ? marks[marks.length - 1].i : 0, frameBytes: FRAME_BYTES, callbacksFired: callbacks.length, hitCap, floodMs: FLOOD_MS });
// 密集写循环期间的采样（看 write() 什么时候开始返回 false、缓冲涨到哪）。
log("marks", {
	first: marks[0],
	mid: marks[Math.floor(marks.length / 2)],
	last: marks[marks.length - 1],
	firstFalseAtWrite: writes.findIndex((w) => w.returned === false),
	totalWrites: writes.length,
	writesWithFalseReturn: writes.filter((w) => w.returned === false).length,
});

// 采样：对端（Node 流）已 pause，但内核接收缓冲还会吃一段。看缓冲是"排空"还是"单调涨"。
const timeline = [];
for (let i = 0; i < Math.ceil(STALL_MS / 500); i += 1) {
	await sleep(500);
	timeline.push({
		at: Date.now() - t0,
		bufferedAmount: socket.bufferedAmount,
		writableLength: rawSocket._writableState.length,
		callbacksFired: callbacks.length,
		rssMb: Math.round(process.memoryUsage().rss / 1048576),
	});
}
log("timeline", { timeline });
log("after-stall", {
	bufferedAmount: socket.bufferedAmount,
	writableLength: rawSocket._writableState.length,
	wsBufferedBytes: socket._sender._bufferedBytes,
	callbacksFired: callbacks.length,
	writesWithFalseReturn: writes.filter((w) => w.returned === false).length,
	totalWrites: writes.length,
	firstFalseAtWrite: writes.findIndex((w) => w.returned === false),
	readyState: socket.readyState,
	rssMb: Math.round(process.memoryUsage().rss / 1048576),
});

// 对端开始读之后：回调是不是补上来了？
client.resume();
await sleep(1500);
log("after-resume", {
	bufferedAmount: socket.bufferedAmount,
	writableLength: rawSocket._writableState.length,
	callbacksFired: callbacks.length,
	readyState: socket.readyState,
});

// terminate() 与 close() 的差别
socket.terminate();
await sleep(300);
log("after-terminate", { readyState: socket.readyState, destroyed: rawSocket.destroyed });
client.destroy();
httpServer.close();
await sleep(100);
log("done", {});
