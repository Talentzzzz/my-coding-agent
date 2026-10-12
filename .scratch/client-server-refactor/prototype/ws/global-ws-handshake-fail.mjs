// 票 17：undici 的握手失败到底会不会 fire `close`？两台 Node 上各等 15 秒。
// 用法：node global-ws-handshake-fail.mjs [--port <有一个 http 服务器在听的端口>]
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const t0 = Date.now();
const log = (event, fields = {}) =>
	process.stdout.write(`${JSON.stringify({ t: Date.now() - t0, event, ...fields })}\n`);
log("versions", { node: process.version, undici: process.versions.undici });

const port = await new Promise((resolve) => {
	const probe = createServer();
	probe.listen(0, "127.0.0.1", () => {
		const p = probe.address().port;
		probe.close(() => resolve(p));
	});
});
const child = spawn(process.execPath, [join(HERE, "server.mjs"), "--port", String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 700));

const observe = async (label, url, waitMs) => {
	const events = [];
	const ws = new WebSocket(url);
	ws.addEventListener("open", () => events.push({ kind: "open", t: Date.now() - t0 }));
	ws.addEventListener("error", (event) => events.push({ kind: "error", t: Date.now() - t0, message: event.message ?? "" }));
	ws.addEventListener("close", (event) =>
		events.push({ kind: "close", t: Date.now() - t0, code: event.code, reason: event.reason, wasClean: event.wasClean }),
	);
	const samples = [];
	// 等 waitMs，中途取点。
	const marks = [];
	const start = Date.now();
	for (const at of [500, 2000, 5000, 10000, waitMs]) {
		const remaining = at - (Date.now() - start);
		if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
		marks.push({ at, readyState: ws.readyState, events: events.length });
	}
	log(label, { marks, events, finalReadyState: ws.readyState });
	try {
		ws.close();
	} catch {}
	await new Promise((r) => setTimeout(r, 200));
};

await observe("refused-tcp", "ws://127.0.0.1:9/ws", 15000);
await observe("handshake-404", `ws://127.0.0.1:${port}/health`, 15000);
child.kill();
log("done", {});
