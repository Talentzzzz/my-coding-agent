// 票 17 的探针服务器之二：这次用 `ws` 包本身，回答"服务端用 ws 时看到什么"。
// 上行命令协议与 server.mjs 相同（close / destroy / ping / stats / echo），
// 所以渲染器那套场景可以原样跑在它上面。
//
// 用法：node ws-server.mjs --ws-path <ws 包目录> --port 0 --log <file>
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? fallback : argv[i + 1];
};
const WS_PATH = arg("ws-path", undefined);
const PORT = Number(arg("port", "0"));
const LOG_FILE = arg("log", undefined);
const t0 = Date.now();
if (LOG_FILE !== undefined) writeFileSync(LOG_FILE, "");
const log = (event, fields = {}) => {
	const line = JSON.stringify({ t: Date.now() - t0, event, ...fields });
	process.stdout.write(`${line}\n`);
	if (LOG_FILE !== undefined) appendFileSync(LOG_FILE, `${line}\n`);
};

const wsMod = await import(WS_PATH === undefined ? "ws" : pathToFileURL(`${WS_PATH}/index.js`).href);
const { WebSocketServer } = wsMod.default ?? wsMod;

const server = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("ok");
});
const wss = new WebSocketServer({ server });
let peak = 0;
const live = new Set();

wss.on("connection", (socket, req) => {
	live.add(socket);
	peak = Math.max(peak, live.size);
	const id = live.size;
	log("connection", { id, path: req.url, total: live.size, peak });
	socket.on("close", (code, reason) => {
		live.delete(socket);
		log("ws-close-event", {
			id,
			code,
			reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason ?? ""),
			remaining: live.size,
		});
	});
	socket.on("error", (error) => log("ws-error-event", { id, message: error.message }));
	socket.on("pong", (data) => log("ws-pong-event", { id, data: data.toString("utf8") }));
	socket.on("message", (data, isBinary) => {
		const text = data.toString("utf8");
		let cmd;
		try {
			cmd = JSON.parse(text);
		} catch {
			cmd = undefined;
		}
		if (cmd !== undefined && typeof cmd.cmd === "string") {
			if (cmd.cmd === "close") {
				log("cmd-close", { id, code: cmd.code, reason: cmd.reason });
				socket.close(Number(cmd.code ?? 1000), String(cmd.reason ?? ""));
				return;
			}
			if (cmd.cmd === "destroy") {
				log("cmd-destroy", { id });
				socket.terminate();
				return;
			}
			if (cmd.cmd === "ping") {
				socket.ping();
				return;
			}
			if (cmd.cmd === "stats") {
				socket.send(
					JSON.stringify({
						cmd: "stats",
						connections: live.size,
						peak,
						hwm: socket._socket?.writableHighWaterMark,
						bufferedAmount: socket.bufferedAmount,
					}),
				);
				return;
			}
			if (cmd.cmd === "echo") {
				socket.send(JSON.stringify({ echo: cmd.text, at: Date.now() - t0 }));
				return;
			}
		}
		log("message", { id, isBinary, bytes: data.length, text: text.slice(0, 200) });
		socket.send(JSON.stringify({ echo: text.slice(0, 200), at: Date.now() - t0 }));
	});
});

server.listen(PORT, "127.0.0.1", () => {
	const addr = server.address();
	log("listening", { port: addr.port, impl: "ws", version: (wsMod.default ?? wsMod).WebSocket?.name });
	process.stdout.write(`PORT=${addr.port}\n`);
});

process.on("SIGTERM", () => {
	for (const socket of live) socket.terminate();
	server.close(() => process.exit(0));
});
