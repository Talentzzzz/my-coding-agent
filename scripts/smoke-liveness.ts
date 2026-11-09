// Liveness smoke test: the client discovers a dead connection without sending a request. It drives
// the *production* connection layer — the very `MuxClient` the window runs, not a rewritten watchdog
// (asserting a copy of the watchdog would prove the copy) — against the real server through a relay
// that can go silent, and asserts the whole arc: live on the first frame, dead within the tolerance
// the server's own heartbeat names, reconnected, and converged again by a fresh baseline.
//
//   node scripts/smoke-liveness.ts
//
// The relay is the load-bearing half of the rig: during a blackout it keeps *reading* the server and
// throws the bytes away, so the proof that "the server was talking all along" is the relay's own
// dropped-byte counter, and what is being tested is the client's read timeout — not the server's
// stall policy, which has its own smoke. No provider key is needed: the watched session never runs.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer, type BootedServer } from "../packages/server/src/boot.ts";
import { MuxClient, type ChannelState, type MuxSocket, type MuxSocketFactory, type MuxSocketHandlers } from "../packages/web/src/client.ts";
import { faultyProxy, type FaultyProxy } from "./wire/proxy.ts";
import { until } from "./wire/client.ts";
import type { ServerMessage } from "@my-agent/core";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

/**
 * The browser's socket, over Node's own global `WebSocket`. This is the one adapter between the
 * production layer and this runtime — the same three events and two methods the browser offers.
 */
function nodeSocket(url: string): MuxSocketFactory {
	return (handlers: MuxSocketHandlers): MuxSocket => {
		const socket = new WebSocket(url);
		socket.addEventListener("open", () => handlers.onOpen());
		socket.addEventListener("message", (event) => handlers.onMessage(String(event.data)));
		socket.addEventListener("close", () => handlers.onClose());
		socket.addEventListener("error", () => handlers.onError());
		return {
			send: (text) => socket.send(text),
			close: (code, reason) => socket.close(code, reason),
		};
	};
}

/** Everything the assertions read back, in one place. */
interface Observed {
	channels: { state: ChannelState; at: number }[];
	heartbeats: number;
	baselines: ServerMessage[];
	ended: string[];
	errors: { sessionId: string; message: string }[];
}

const root = await mkdtemp(join(tmpdir(), "my-agent-liveness-"));

// The heartbeat interval is the whole clock of this smoke: the server speaks every 50 ms, the client
// tolerates three of those (its own rule, derived from `everyMs`), and both numbers stay far inside
// the assertion windows below.
const server: BootedServer = await bootServer({ workDirAbsPath: root, port: 0, mux: { heartbeatIntervalMs: 50 } });
const proxy: FaultyProxy = await faultyProxy(new URL(server.url));

const observed: Observed = { channels: [], heartbeats: 0, baselines: [], ended: [], errors: [] };
/** The session the pane watches, set once the server has named its landing session. */
let watchId = "";
const client = new MuxClient(
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
		// The pre-heartbeat fallback only governs the stretch before the first heartbeat names its
		// interval; one second is generous for a server that speaks within 50 ms of the handshake.
		watchdogTimeoutMs: 1_000,
		readyTimeoutMs: 5_000,
		log: () => {},
	},
);

try {
	// Startup selects nothing now, so the session this smoke watches is the one an explicit creation
	// returned — the watched session never runs, so the transport stays unscripted.
	const created = await fetch(`${server.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" } });
	check("the watched session was created", created.status === 201, String(created.status));
	watchId = ((await created.json()) as { sessionId: string }).sessionId;

	// ---------------------------------------------------------------------------------------------
	// 1. Live is proven, not assumed: the channel goes live on the first frame, not the handshake.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("the channel proves itself with the server's first frame\n");

	client.start();
	client.retain(watchId, "pane");
	check("the channel reached live", await until(() => client.channel === "live", 3_000), JSON.stringify(observed.channels));
	check("and heartbeats were already arriving", observed.heartbeats > 0, String(observed.heartbeats));
	check("the watched session's baseline arrived", await until(() => observed.baselines.length === 1, 3_000), String(observed.baselines.length));

	// ---------------------------------------------------------------------------------------------
	// 2. The blackout: the server keeps talking, the client hears nothing, and the client is the one
	//    that calls it dead — within the tolerance the heartbeat itself named.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a connection that stops speaking is declared dead without a request\n");

	const liveAt = observed.channels.find((entry) => entry.state === "live")?.at ?? Date.now();
	proxy.blackout(true);
	const died = await until(() => client.channel === "down", 2_000);
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

	// ---------------------------------------------------------------------------------------------
	// 3. The relay lets go: the client reconnects on its own, re-opens what it still wants by
	//    reference, and the view is replaced by what the session looks like now.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("the reconnect re-opens what the window still wants\n");

	proxy.blackout(false);
	check("a second connection arrived at the relay", await until(() => proxy.connections === 2, 5_000), String(proxy.connections));
	check("and the channel proved itself live again", await until(() => client.channel === "live", 3_000), JSON.stringify(observed.channels));

	// The subscription table survived the drop on purpose, so the reconnect re-opened the pane's
	// session and the server answered with a second baseline — the view is replaced whole, not
	// appended to and not left showing whatever it remembered.
	check("the session's stream was re-opened with a fresh baseline", await until(() => observed.baselines.length === 2, 3_000), String(observed.baselines.length));
	check("the re-opened stream was not ended behind the window's back", observed.ended.length === 0, JSON.stringify(observed.ended));

	client.close();
} finally {
	await proxy.close();
	await server.close();
	await rm(root, { recursive: true, force: true });
	process.stdout.write(failures === 0 ? "\nliveness ok\n" : `\n${failures} failure(s)\n`);
	process.exitCode = failures === 0 ? 0 : 1;
}
