// A live check that the browser client and the server actually agree: boots the real server, opens a
// real WebSocket to `/mux`, and drives it through the production `MuxClient` — the same class the
// window uses. So this is the seam the desktop shell runs on, not a mock of it.
// The last two sections drive a real run through the scripted transport, and a directory put aside and
// taken back, which is the one change no row frame can carry.
// No provider key is needed — where a run happens, the model is the scripted transport.
// Run with: node scripts/smoke-mux-live.ts
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
/** A scratch agent home, so the settings this smoke writes are not the machine's own. */
const home = await mkdtemp(join(tmpdir(), "my-agent-mux-live-home-"));
/** A scratch store, so the sessions this smoke writes are not the machine's own. */
const storeRoot = await mkdtemp(join(tmpdir(), "my-agent-mux-live-store-"));
setSessionsDir(storeRoot);
let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

/** Poll until `ready` holds, so no check guesses the timing of an async read. */
async function until(ready: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await ready()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return ready();
}

/** Send one prompt over REST, the way the window's composer does. */
async function postPrompt(base: string, sessionId: string, text: string): Promise<number> {
	const response = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
	});
	return response.status;
}

/** Whether the session's own snapshot says a run is in flight. */
async function submitting(base: string, sessionId: string): Promise<boolean> {
	const response = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}`);
	return ((await response.json()) as { session: { submitting: boolean } }).session.submitting;
}

/**
 * Whether this frame is the run's last word, in the same two places the window reads it.
 *
 * A copy of `main.ts`'s helper rather than an import, because `main.ts` touches the DOM and cannot
 * load here. It is the release signal `onStreamMessage` below mirrors.
 */
function settled(message: ServerMessage): boolean {
	if (message.type === "status") return !message.submitting;
	if (message.type === "baseline") return !message.session.submitting;
	return false;
}

/** The scripted model the run section drives. Its endpoint is never reached: the transport answers. */
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
/** One second: fast enough to keep the smoke short, slow enough that Windows scheduling noise
 * cannot starve the client's watchdog (its tolerance is three of these intervals). */
const heartbeatEveryMs = 1_000;
const server = await bootServer({ workDirAbsPath: root, port: 0, mux: { heartbeatIntervalMs: heartbeatEveryMs }, api: transport.api, settingsHome: home });
// Handed to the hub after boot, before any prompt: the one run section below needs a model to run.
server.hub.setModelConfigs(modelRows);

try {
	// Startup selects nothing now, so the session this smoke drives is the one an explicit creation
	// returned.
	const created = await fetch(`${server.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" } });
	check("驱动会话已创建", created.status === 201, String(created.status));
	const { sessionId } = await created.json() as { sessionId: string };

	// A session that nobody has spoken in has no file and so no row (ADR-0006 §3) — the sidebar lists
	// conversations, not intentions. One warm-up turn is what puts this session into the row store
	// every check below reads.
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
			// The window's own wiring, mirrored: a send's reference lives exactly as long as the run it
			// started, and a status that says the run settled is one of its exits. Without this the
			// reproduction below would not be the one the user hit.
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

	// The channel's own first frame is a heartbeat, so this is the real "connected and known good".
	check("收到第一帧心跳即 live", await until(() => client.channel === "live"), `got ${client.channel}`);
	check("心跳带服务端自己的间隔", items.some((i) => i.type === "heartbeat" && i.everyMs === heartbeatEveryMs), JSON.stringify(items));

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
	const refused = rows.loadFrom([{ workDirAbsPath: root, sessions: [] }], true);
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

	// ---------------------------------------------------------------------------------------------
	// The reported bug: a run ends, the server reaps the host it was running and ends the stream,
	// and the pane never left the session. A second prompt must reach this connection again.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("run 结束后，同一会话的下一次 prompt 必须重新收到帧\n");

	const framesFor = (): number => messages.filter((m) => m.sessionId === sessionId).length;

	// Run 1: the window takes the pane's reference and a send's, posts, watches the answer, and the
	// server ends the stream once the host it was running goes away. The pane is still pointing at
	// the session throughout — which is exactly the state the old client could not get out of.
	transport.setResponses([fakeAssistantMessage("first answer")]);
	const beforeFirst = framesFor();
	client.retain(sessionId, "send");
	check("第一条 prompt 被接受", (await postPrompt(server.url, sessionId, "第一条")) === 202);
	check("第一条 prompt 的帧到达了", await until(() => framesFor() > beforeFirst, 10_000), JSON.stringify(messages.slice(beforeFirst)));
	check("run 结束后服务端把这条流判终", await until(() => ended.includes(sessionId), 10_000), JSON.stringify(ended));

	// Run 2: the same session, a new send's reference, and the pane still holding it. Nothing about
	// the window changed, so the frames must arrive exactly as they did the first time.
	const beforeSecond = framesFor();
	transport.setResponses([fakeAssistantMessage("second answer")]);
	client.retain(sessionId, "send");
	check("第二条 prompt 被接受", (await postPrompt(server.url, sessionId, "第二条")) === 202);
	check("第二条 prompt 也必须再次收到帧", await until(() => framesFor() > beforeSecond, 10_000), JSON.stringify(messages.slice(beforeSecond)));

	// ---------------------------------------------------------------------------------------------
	// A directory put aside leaves the *list*, which is the one change no row frame can carry: no row
	// changed, so the server re-sends the overview — the same frame a connection opens on. Both
	// directions matter and both are checked against the row table the window actually keeps.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("被搁置的目录离开概览，回来时也回到概览\n");

	const aside = join(root, "aside");
	await mkdir(aside, { recursive: true });

	/** The client's own row table, as `main.ts` feeds it: the newest overview, then the rows after it. */
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
	// The same lifecycle rule the warm-up above follows: an unspoken session has no file, so the
	// directory does not exist either — one prompt is what makes both tables know it.
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

	// And back: the transcripts and the folder were never touched, so a new session in that directory
	// is the user saying they want it listed again.
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
	// The working directory and the scratch store: a session that is created and never cleaned
	// would otherwise land in the real agent home on every run.
	await rm(root, { recursive: true, force: true });
	await rm(storeRoot, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? "\nmux live ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;