// A live check that the browser client and the server actually agree: boots the real server, opens a
// real WebSocket to `/mux`, and drives it through the production `MuxClient` — the same class the
// window uses. So this is the seam the desktop shell runs on, not a mock of it.
// Nothing reaches a model, so no provider key is needed.
// Run with: node scripts/smoke-mux-live.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "../packages/server/src/boot.ts";
import { MuxClient, browserSocket, type MuxHandlers } from "../packages/web/src/client.ts";
import { SessionRows } from "../packages/web/src/rows.ts";
import type { ConnectionItem, ServerMessage } from "@my-agent/core/protocol";

const root = await mkdtemp(join(tmpdir(), "my-agent-mux-live-"));
let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

/** Poll until `ready` holds, so no check guesses the timing of an async read. */
async function until(ready: () => boolean, ms = 5_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (ready()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return ready();
}

process.stdout.write("\n真服务器 + 真 WebSocket + 生产的 MuxClient\n");

const server = await bootServer({ cwd: root, port: 0, mux: { heartbeatIntervalMs: 60 } });

try {
	const { sessionId } = await (await fetch(`${server.url}/api/sessions/current`)).json() as { sessionId: string };

	const channels: string[] = [];
	const items: ConnectionItem[] = [];
	const messages: { sessionId: string; type: string }[] = [];
	const ended: string[] = [];
	const errors: string[] = [];

	const client = new MuxClient(
		{
			onChannel: (state) => channels.push(state),
			onConnectionItem: (item) => items.push(item),
			onStreamMessage: (id, message: ServerMessage) => messages.push({ sessionId: id, type: message.type }),
			onStreamEnd: (id) => ended.push(id),
			onStreamError: (id, message) => errors.push(`${id}:${message}`),
		} satisfies MuxHandlers,
		{ url: server.url.replace("http", "ws") + "/mux", socket: browserSocket(server.url.replace("http", "ws") + "/mux") },
	);
	client.start();

	// The channel's own first frame is a heartbeat, so this is the real "connected and known good".
	check("收到第一帧心跳即 live", await until(() => client.channel === "live"), `got ${client.channel}`);
	check("心跳带服务端自己的间隔", items.some((i) => i.type === "heartbeat" && i.everyMs === 60), JSON.stringify(items));

	// The row table arrives on the connection seat with no subscription at all — the whole reason the
	// overview exists is that a row must not freeze when nobody is watching.
	await until(() => items.some((i) => i.type === "sessions"));
	const table = items.find((i) => i.type === "sessions");
	check("未订阅任何会话也收到整表", table?.type === "sessions" && table.sessions.some((r) => r.id === sessionId), JSON.stringify(table));
	check("行带 modified/running/pending", table?.type === "sessions" && table.sessions.every((r) => typeof r.modified === "number" && typeof r.running === "boolean" && typeof r.pending === "number"));

	// Subscribing is one `open`, and the answer is a baseline on that stream — the atomic pair the
	// design requires, with no "subscribed but no baseline yet" state in between.
	client.retain(sessionId, "pane");
	check("open 之后拿到基线", await until(() => messages.some((m) => m.sessionId === sessionId && m.type === "baseline")), JSON.stringify(messages));
	check("这条流不再报错", errors.filter((e) => e.startsWith(sessionId)).length === 0, JSON.stringify(errors));

	// The row store takes the channel's table and refuses a REST listing while the channel owns it.
	const rows = new SessionRows();
	for (const item of items) {
		if (item.type === "sessions") rows.replaceAll(item.sessions);
		if (item.type === "session_row") rows.put(item.session);
	}
	check("行 store 拿到了这个会话", rows.get(sessionId) !== undefined, JSON.stringify(rows.list().map((r) => r.id)));
	const refused = rows.loadFrom([{ cwd: root, sessions: [] }], true);
	check("通道 live 时 REST 列表被拒收", refused === false && rows.get(sessionId) !== undefined, `refused=${refused}`);

	// Cancelling is silent by design: the client asked to stop receiving, so a reply would be a frame
	// on a stream it has just said it does not want. What matters is that the entry goes with it and
	// the client stops calling the stream watched — not that anything comes back.
	client.release(sessionId, "pane");
	await new Promise((resolve) => setTimeout(resolve, 200));
	check("cancel 之后不再持有这个会话", !client.isRetained(sessionId) && !client.isWatching(sessionId));
	check("cancel 不要求任何回执", !ended.includes(sessionId), JSON.stringify(ended));

	// Re-subscribing after the reference went away is a fresh gesture, and gets a fresh baseline.
	client.retain(sessionId, "pane");
	const before = messages.filter((m) => m.sessionId === sessionId && m.type === "baseline").length;
	check("重新订阅又拿到一份基线", await until(() => messages.filter((m) => m.sessionId === sessionId && m.type === "baseline").length > before), JSON.stringify(messages));

	// A session id that names nothing is answered on the frame rather than by a status code, because
	// the channel no longer has a per-subscription response.
	const beforeErrors = errors.length;
	client.retain("不存在的会话", "pane");
	check("订阅不存在的会话在帧上被拒绝", await until(() => errors.length > beforeErrors), JSON.stringify(errors));
	check("并且那条流被结束", await until(() => ended.includes("不存在的会话")), JSON.stringify(ended));

	client.close();
	check("关掉之后不再有状态变化", channels.at(-1) !== undefined);
} finally {
	await server.close();
	await rm(root, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nmux live ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;