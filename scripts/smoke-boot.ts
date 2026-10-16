// Boot smoke test: start the server the way the desktop shell does — in-process, on an assigned
// port — and check what a shell depends on: the client is served, the API answers, the landing
// session is the one the server says it is, and closing actually closes.
//
//   node scripts/smoke-boot.ts
//
// The last two sections are the shutdown evidence the resident transport needs (ticket 15, §4):
// `close()` returning is necessary but not sufficient, because a listener that refuses new
// connections is not a process that exited. So this script asserts both halves — `close()` returns
// with the worst case in residence (a window's connection watching a run parked on an approval no
// one will ever answer), and then the script **ends by itself**: the only `process.exit` in the file
// sits behind an unref'd watchdog, which fires only if something leaked a handle and kept the event
// loop alive. An explicit exit would mask exactly that leak, so there is none.
//
// The child-process half runs a real `main.ts` and terminates it with a resident connection open.
// Its honest limit, written down: `main.ts`'s own shutdown handler ends with `process.exit(0)`, so
// this proves the shell can put the server down — not that the event loop drains by itself. Only
// the in-process half above proves that.
//
// The agent home is the script's own scratch directory, created before the first app module is
// imported: `AGENT_HOME` is resolved once, at import time, from `MY_AGENT_HOME`, which is why every
// app import below is dynamic. Booting against the machine's real home made this smoke read the
// user's `models.json` — zero rows there put the landing session on the placeholder model, which
// never sends anything, so the run below never reached its tool call and the approval never arrived
// (ticket 10: red on 2026-10-16, green the same afternoon, code untouched in between). It also
// wrote every run's session file into the real home's `sessions/`. Both leaks are gone: the model
// list is this script's own one-row file, and the home is removed with the workspaces at the end.
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import type { BootedServer } from "../packages/server/src/boot.ts";
import type { WireClient } from "./wire/client.ts";

// The scratch home, then the env it rides on, then — and only then — the app modules. The row needs
// no key: the fake transport below never dials the endpoint a row names.
const agentHome = mkdtempSync(join(tmpdir(), "my-agent-boot-home-"));
writeFileSync(
	join(agentHome, "models.json"),
	`${JSON.stringify({ models: [{ name: "boot-fake", baseUrl: "http://127.0.0.1:9", modelId: "boot-fake" }] }, null, "\t")}\n`,
	"utf8",
);
process.env.MY_AGENT_HOME = agentHome;

const { bootServer } = await import("../packages/server/src/boot.ts");
const { connect, until } = await import("./wire/client.ts");
const { createFakeTransport, fakeAssistantMessage, fakeToolCall } = await import("./fake-transport.ts");

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function request(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; payload: unknown }> {
	const headers: Record<string, string> = { accept: "application/json" };
	if (body !== undefined) headers["content-type"] = "application/json";
	const response = await fetch(`${base}${path}`, {
		method,
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	return { status: response.status, payload: text.length === 0 ? undefined : (JSON.parse(text) as unknown) };
}

/** One free port, taken and released: `main.ts` refuses `--port 0`, so the child needs a real one. */
async function freePort(): Promise<number> {
	const probe = createTcpServer();
	await new Promise<void>((listen) => probe.listen(0, "127.0.0.1", listen));
	const port = (probe.address() as { port: number }).port;
	await new Promise<void>((close) => probe.close(() => close()));
	return port;
}

// The desktop shell boots against the machine's own home; this script boots against the scratch
// home above, because what the shell needs from the boot path must not depend on what the machine
// happens to have in it. The workspaces are scratch directories too — nothing here writes a session
// into the repo, or anywhere outside the two scratch trees. The scripted transport rides the boot
// path itself: the worst case below needs a run parked on an approval, and a provider key must not
// be the price of one.
const workspace = await mkdtemp(join(tmpdir(), "my-agent-boot-"));
const fake = createFakeTransport();
fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" }))]);
const server: BootedServer = await bootServer({ cwd: workspace, port: 0, api: fake.api });

try {
	process.stdout.write(`booted on ${server.url} (port ${server.port})\n`);

	const health = await fetch(`${server.url}/api/health`);
	console.log(`health ${health.status} ${await health.text()}`);

	const index = await fetch(server.url);
	const html = await index.text();
	console.log(
		`index ${index.status} ${index.headers.get("content-type")} ${html.length} bytes, has #app: ${html.includes('id="app"')}`,
	);

	const models = await fetch(`${server.url}/api/models`);
	const body = (await models.json()) as { models?: unknown[] };
	console.log(`models ${models.status} count=${body.models?.length ?? 0}`);

	// The landing session is the server's decision, not the client's: the pinned session must be the
	// one the lane serves, which is what makes `--session` (and MY_AGENT_SESSION) visible in the UI.
	// The old SSE form read this off the first stream frame; the mux form is the lane's first frame,
	// and the connection-level frames — heartbeat, overview — never count as it.
	const landing = await fetch(`${server.url}/api/sessions/current`);
	const { sessionId } = (await landing.json()) as { sessionId: string };
	const hubId = await server.hub.currentSessionId();
	console.log(`current ${landing.status} sessionId=${sessionId} hub=${hubId} agrees=${sessionId === hubId}`);

	const wire: WireClient = await connect(`${server.url.replace("http", "ws")}/mux`);
	const baseline = await wire.open(sessionId);
	check("the lane serves the landing session", baseline.id === sessionId, `baseline=${baseline.id} landing=${sessionId}`);
	check("a fresh workspace opens an empty session", baseline.messages.length === 0, String(baseline.messages.length));

	// ---------------------------------------------------------------------------------------------
	// The worst case for shutdown, assembled for real: a window's connection watching a run parked on
	// an approval nobody will answer. The scripted transport makes the tool call; the approval gate
	// holds the run; nothing anywhere will ever resolve it.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("shutdown with the worst case in residence\n");

	// The bench holds a claim of its own across the gate-setting PATCH below, the way `smoke-mux` and
	// `smoke-stream` do wherever a check needs the host to outlive a request. Nothing subtle: the
	// PATCH takes a claim for the length of one write and gives it straight back, and a session whose
	// claims reach zero is reaped — which ends the lane watching it, by design (the claim decides how
	// long a session lives, and a subscription takes none). Reaping that transient host under the lane
	// would leave the worst case without its window, so the bench is the claim-holder here; the run's
	// own claim then carries the parked approval to the end.
	const bench = await server.hub.claim(sessionId);

	const turned = await request(server.url, "PATCH", `/api/sessions/${encodeURIComponent(sessionId)}`, {
		approval: { read: true },
	});
	check("the read tool was put behind the approval gate", turned.status === 200, String(turned.status));

	const accepted = await request(server.url, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
		text: "read the notes",
	});
	check("the prompt was accepted", accepted.status === 202, String(accepted.status));
	check(
		"the run parked on the approval",
		await until(
			() => wire.items(sessionId).some((message) => message.type === "approval_request"),
			10_000,
		),
		JSON.stringify(wire.items(sessionId).map((message) => message.type)),
	);
	const parked = ((await request(server.url, "GET", `/api/sessions/${encodeURIComponent(sessionId)}`)).payload as {
		session: { pendingApprovals: unknown[] };
	}).session;
	check("and the session is genuinely waiting for an answer", parked.pendingApprovals.length === 1, JSON.stringify(parked.pendingApprovals));

	const started = Date.now();
	await server.close();
	check("close() returned with the worst case in residence", Date.now() - started < 5_000, `${Date.now() - started} ms`);
	// The answer nobody gave was denied on the way down, and the run with it: nothing is left waiting.
	check("nothing is left running", server.hub.live.length === 0, server.hub.live.join(","));

	// A closed listener must refuse connections, or a shell would leak a server every time it restarts.
	try {
		await fetch(server.url);
		check("the listener refuses connections after close", false, "still answering");
	} catch {
		check("the listener refuses connections after close", true);
	}
	await wire.close().catch(() => {});

	// ---------------------------------------------------------------------------------------------
	// The child-process half: a real `main.ts`, a resident connection held open against it, and a
	// termination that must arrive. See the header for what this half does and does not prove.
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a real server process goes down with a connection attached\n");

	const childWorkspace = await mkdtemp(join(tmpdir(), "my-agent-boot-child-"));
	const port = await freePort();
	const child = spawn(
		process.execPath,
		[join("packages", "server", "src", "main.ts"), "--cwd", childWorkspace, "--port", String(port)],
		{
			stdio: "ignore",
			env: {
				...process.env,
				// Explicit, never inherited-by-luck: the child must read the same models the parent saw.
				MY_AGENT_HOME: process.env.MY_AGENT_HOME ?? join(homedir(), ".my-agent"),
			},
		},
	);
	const childBase = `http://127.0.0.1:${port}`;
	// Readiness is polled off /api/health, never parsed out of a child's stdout (its shutdown handler
	// owns that stream, and stdio parsing is its own pile of trouble).
	let healthy = false;
	{
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			try {
				if ((await fetch(`${childBase}/api/health`)).ok) {
					healthy = true;
					break;
				}
			} catch {
				// not up yet
			}
			await sleep(100);
		}
	}
	check("the child answered /api/health", healthy);

	let childSocket: WebSocket | undefined;
	if (healthy) {
		childSocket = new WebSocket(`${childBase.replace("http", "ws")}/mux`);
		const opened = await new Promise<boolean>((resolve) => {
			childSocket?.addEventListener("open", () => resolve(true));
			childSocket?.addEventListener("error", () => resolve(false));
			setTimeout(() => resolve(false), 5_000);
		});
		check("a resident connection was opened against the child", opened);

		const exited = new Promise<boolean>((resolve) => {
			child.once("exit", () => resolve(true));
		});
		// On POSIX this rides into main.ts's own SIGTERM handler; on Windows the request terminates the
		// child outright — either way the exit must arrive, which is the part a shell depends on.
		child.kill("SIGTERM");
		check("the child exited with a connection attached", await Promise.race([exited, sleep(5_000).then(() => false)]));
		childSocket.close();
	}
	await rm(childWorkspace, { recursive: true, force: true }).catch(() => {});
} finally {
	await rm(workspace, { recursive: true, force: true }).catch(() => {});
	await rm(agentHome, { recursive: true, force: true }).catch(() => {});
}

// The natural-exit watchdog, last thing in the file: everything above has been torn down, so the
// event loop should drain and the process should exit on its own — before this unref'd timer, which
// does not hold the loop open, ever fires. If it fires, something leaked a handle: say so loudly and
// fail, because a smoke that ends only because it was told to has proven nothing about shutdown.
setTimeout(() => {
	process.stdout.write("\nFAIL the process did not exit on its own — a handle leaked somewhere above\n");
	// Say what is still holding the loop, so the next occurrence names its handle instead of only
	// announcing that one exists. Types only — Node offers no portable handle identity here — but a
	// leak that reports "TCPSocketWrap" is one that can be hunted; ticket 10's second half is still
	// unreproduced, and this is the net it leaves behind for it.
	const resources = [...new Set(process.getActiveResourcesInfo())].join(", ");
	process.stdout.write(`still-active resources: ${resources}\n`);
	process.exit(1);
}, 5_000).unref();

process.stdout.write(failures === 0 ? "\nboot ok\n" : `\n${failures} failure(s)\n`);
process.exitCode = failures === 0 ? 0 : 1;
