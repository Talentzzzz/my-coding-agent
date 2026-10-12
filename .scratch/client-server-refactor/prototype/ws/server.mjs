// 票 17 的探针服务器：不依赖 `ws`，手写 RFC6455 握手与最小帧编解码。
// 目的：在浏览器/Electron 侧观察真实的 close code、pong 往返、连接池上限。
//
// 用法：node server.mjs [--port 0] [--ping-ms 2000] [--log <file>]
// 每个事件写一行 JSON 到 stdout（和 --log 文件）。
//
// HTTP 面：
//   GET /                 一页空白 HTML（Electron loadURL 的落点）
//   GET /health           200 "ok"
//   GET /pings?n=1        立刻给所有连接发 n 个 Ping（观察浏览器是否自动回 pong）
//   GET /say?text=...     给所有连接发一条 text 帧
//   GET /close?code=&reason=  给所有连接发 Close 帧
//   GET /stats            连接的 JSON 摘要
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? fallback : argv[i + 1];
};

const PING_MS = Number(arg("ping-ms", 0));
const LOG_FILE = arg("log", undefined);
const startedAt = Date.now();

if (LOG_FILE !== undefined) writeFileSync(LOG_FILE, "");

const log = (event, fields = {}) => {
	const line = JSON.stringify({ t: Date.now() - startedAt, event, ...fields });
	process.stdout.write(`${line}\n`);
	if (LOG_FILE !== undefined) appendFileSync(LOG_FILE, `${line}\n`);
};

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** 连接的模型：握手之后我们自己解析帧。 */
class Conn {
	constructor(id, socket) {
		this.id = id;
		this.socket = socket;
		this.buffer = Buffer.alloc(0);
		this.pingSeq = 0;
		this.pendingPings = new Map();
		this.closed = false;
		this.openedAt = Date.now() - startedAt;
	}

	send(opcode, payload = Buffer.alloc(0)) {
		if (this.closed || this.socket.destroyed) return;
		const len = payload.length;
		let header;
		if (len < 126) {
			header = Buffer.from([0x80 | opcode, len]);
		} else if (len < 65536) {
			header = Buffer.alloc(4);
			header[0] = 0x80 | opcode;
			header[1] = 126;
			header.writeUInt16BE(len, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x80 | opcode;
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(len), 2);
		}
		this.socket.write(Buffer.concat([header, payload]));
	}

	text(value) {
		this.send(0x1, Buffer.from(value, "utf8"));
	}

	/** 直接写一段原始字节（用来造协议违规）。 */
	raw(bytes) {
		if (this.closed || this.socket.destroyed) return;
		this.socket.write(Buffer.from(bytes));
	}

	ping() {
		const seq = ++this.pingSeq;
		this.pendingPings.set(seq, Date.now());
		this.send(0x9, Buffer.from(String(seq), "utf8"));
	}

	close(code, reason) {
		const reasonBuf = Buffer.from(reason ?? "", "utf8");
		const payload = Buffer.alloc(2 + reasonBuf.length);
		payload.writeUInt16BE(code, 0);
		reasonBuf.copy(payload, 2);
		this.closeFrameSent = true;
		this.send(0x8, payload);
	}
}

let nextId = 0;
/** @type {Map<number, Conn>} */
const conns = new Map();

const onFrame = (conn, fin, opcode, payload) => {
	if (opcode === 0x9) {
		// 收到客户端 ping：按规范回 pong（回显 payload）。
		conn.send(0xa, payload);
		log("ping-from-client", { id: conn.id, len: payload.length });
		return;
	}
	if (opcode === 0xa) {
		const seq = Number(payload.toString("utf8"));
		const sentAt = conn.pendingPings.get(seq);
		conn.pendingPings.delete(seq);
		log("pong-from-client", {
			id: conn.id,
			seq,
			payload: payload.toString("utf8"),
			rttMs: sentAt === undefined ? null : Date.now() - sentAt,
		});
		return;
	}
	if (opcode === 0x8) {
		const code = payload.length >= 2 ? payload.readUInt16BE(0) : null;
		const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
		log("close-frame-from-client", { id: conn.id, code, reason, fin });
		// 关闭握手：只有在本端还没发过 Close 帧时才回一个（RFC6455 §5.5.1 之后不得再发帧）。
		if (!conn.closeFrameSent) conn.send(0x8, payload.subarray(0, 2));
		conn.closed = true;
		conn.socket.end();
		return;
	}
	if (opcode === 0x1 || opcode === 0x2) {
		const text = payload.toString("utf8");
		// 上行命令协议：让渲染器不必走 fetch（file:// 页面发 fetch 是跨源）。命令不记日志，
		// 只记它造成的效果。
		if (opcode === 0x1 && text.startsWith("{")) {
			let cmd;
			try {
				cmd = JSON.parse(text);
			} catch {
				cmd = undefined;
			}
			if (cmd !== undefined && typeof cmd.cmd === "string") {
				if (cmd.cmd === "close") {
					log("cmd-close", { id: conn.id, code: cmd.code, reason: cmd.reason });
					conn.close(Number(cmd.code ?? 1000), String(cmd.reason ?? ""));
					return;
				}
				if (cmd.cmd === "destroy") {
					log("cmd-destroy", { id: conn.id });
					conn.closed = true;
					conn.socket.destroy();
					return;
				}
				// 以下四条各造一种协议违规，用来观察浏览器 error/close 的语义。
				if (cmd.cmd === "badopcode") {
					conn.raw([0x83, 0x00]); // FIN + opcode 0x3（保留/非法）
					log("cmd-badopcode", { id: conn.id });
					return;
				}
				if (cmd.cmd === "rsv1") {
					conn.raw([0xc1, 0x02, 0x68, 0x69]); // RSV1 置位但没协商扩展
					log("cmd-rsv1", { id: conn.id });
					return;
				}
				if (cmd.cmd === "badutf8") {
					conn.raw([0x81, 0x03, 0xff, 0xfe, 0xfd]); // text 帧里的非法 UTF-8
					log("cmd-badutf8", { id: conn.id });
					return;
				}
				if (cmd.cmd === "badclose") {
					conn.raw([0x88, 0x02, 0x03, 0xed]); // close 帧里 code 1005（不得上线）
					log("cmd-badclose", { id: conn.id, code: 1005 });
					conn.closeFrameSent = true;
					return;
				}
				if (cmd.cmd === "ping") {
					for (let i = 0; i < Number(cmd.n ?? 1); i += 1) conn.ping();
					return;
				}
				if (cmd.cmd === "stats") {
					conn.text(
						JSON.stringify({
							cmd: "stats",
							at: Date.now() - startedAt,
							connections: conns.size,
							peak,
							upgradeAttempts,
							upgradeRejected,
						}),
					);
					return;
				}
				if (cmd.cmd === "echo") {
					conn.text(JSON.stringify({ echo: cmd.text, at: Date.now() - startedAt }));
					return;
				}
			}
		}
		log("message-from-client", { id: conn.id, opcode, bytes: payload.length, text: text.slice(0, 400) });
		// 回显：让页面能测往返，也能看到服务端视角的字节数。
		conn.text(JSON.stringify({ echo: text.slice(0, 400), at: Date.now() - startedAt }));
		return;
	}
	log("frame-from-client", { id: conn.id, opcode, bytes: payload.length, fin });
};

const consume = (conn, chunk) => {
	conn.buffer = Buffer.concat([conn.buffer, chunk]);
	for (;;) {
		const buf = conn.buffer;
		if (buf.length < 2) return;
		const fin = (buf[0] & 0x80) !== 0;
		const opcode = buf[0] & 0x0f;
		const masked = (buf[1] & 0x80) !== 0;
		let len = buf[1] & 0x7f;
		let offset = 2;
		if (len === 126) {
			if (buf.length < 4) return;
			len = buf.readUInt16BE(2);
			offset = 4;
		} else if (len === 127) {
			if (buf.length < 10) return;
			len = Number(buf.readBigUInt64BE(2));
			offset = 10;
		}
		let maskKey;
		if (masked) {
			if (buf.length < offset + 4) return;
			maskKey = buf.subarray(offset, offset + 4);
			offset += 4;
		}
		if (buf.length < offset + len) return;
		const payload = Buffer.from(buf.subarray(offset, offset + len));
		if (masked && maskKey) {
			for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
		}
		conn.buffer = buf.subarray(offset + len);
		onFrame(conn, fin, opcode, payload);
		if (conn.closed) return;
	}
};

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	res.setHeader("access-control-allow-origin", "*");
	if (url.pathname === "/health") {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("ok");
		return;
	}
	if (url.pathname === "/pings") {
		const n = Number(url.searchParams.get("n") ?? "1");
		for (let i = 0; i < n; i += 1) for (const c of conns.values()) c.ping();
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ pinged: conns.size, times: n }));
		return;
	}
	if (url.pathname === "/say") {
		const text = url.searchParams.get("text") ?? "";
		for (const c of conns.values()) c.text(text);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ sent: conns.size }));
		return;
	}
	if (url.pathname === "/close") {
		const code = Number(url.searchParams.get("code") ?? "1000");
		const reason = url.searchParams.get("reason") ?? "";
		for (const c of conns.values()) c.close(code, reason);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ closing: conns.size, code, reason }));
		return;
	}
	if (url.pathname === "/destroy") {
		const n = conns.size;
		for (const c of conns.values()) {
			c.closed = true;
			c.socket.destroy();
		}
		log("destroy-all", { count: n });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ destroyed: n }));
		return;
	}
	if (url.pathname === "/stats") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				connections: conns.size,
				peak: peak,
				ids: [...conns.keys()],
				upgradeAttempts,
				rejected: upgradeRejected,
			}),
		);
		return;
	}
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end("<!doctype html><meta charset=utf-8><title>ws probe</title><body>ws probe</body>");
});

let peak = 0;
let upgradeAttempts = 0;
let upgradeRejected = 0;

server.on("upgrade", (req, socket, head) => {
	upgradeAttempts += 1;
	const path = req.url ?? "/";
	if (!path.startsWith("/ws")) {
		// 非 /ws 的 upgrade：用 HTTP 404 拒绝（观察浏览器握手失败时的 error/close）。
		upgradeRejected += 1;
		log("upgrade-rejected", { path, total: upgradeAttempts });
		socket.write("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
		socket.destroy();
		return;
	}
	const key = req.headers["sec-websocket-key"];
	if (typeof key !== "string") {
		upgradeRejected += 1;
		socket.destroy();
		return;
	}
	const accept = createHash("sha1").update(key + GUID).digest("base64");
	socket.write(
		"HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
	);
	const id = ++nextId;
	const conn = new Conn(id, socket);
	conns.set(id, conn);
	peak = Math.max(peak, conns.size);
	log("upgrade", { id, path: req.url, total: conns.size, peak, remotePort: socket.remotePort });
	if (head.length > 0) consume(conn, head);
	socket.on("data", (chunk) => consume(conn, chunk));
	const drop = (why) => {
		if (!conns.has(id)) return;
		conns.delete(id);
		log("socket-end", { id, why, remaining: conns.size, aliveMs: Date.now() - startedAt - conn.openedAt });
	};
	socket.on("close", () => drop("close"));
	socket.on("end", () => drop("end"));
	socket.on("error", (error) => {
		log("socket-error", { id, message: error.message, code: error.code });
		drop("error");
	});
});

if (PING_MS > 0) {
	setInterval(() => {
		for (const c of conns.values()) c.ping();
	}, PING_MS).unref();
}

// 应用层帧的固定节奏：观察隐藏窗口里"渲染器是否还在消费 WS 数据"。
const SAY_MS = Number(arg("say-ms", 0));
if (SAY_MS > 0) {
	let seq = 0;
	const timer = setInterval(() => {
		seq += 1;
		for (const c of conns.values()) c.text(JSON.stringify({ tick: seq, at: Date.now() - startedAt }));
	}, SAY_MS);
	if (arg("say-keepalive", "0") === "0") timer.unref();
}

const port = Number(arg("port", 0));
server.listen(port, "127.0.0.1", () => {
	const addr = server.address();
	log("listening", { port: addr.port, pingMs: PING_MS });
	// 让脚本能读到端口。
	process.stdout.write(`PORT=${addr.port}\n`);
});

process.on("SIGTERM", () => {
	log("sigterm", { connections: conns.size });
	for (const c of conns.values()) c.socket.destroy();
	server.close(() => process.exit(0));
});
