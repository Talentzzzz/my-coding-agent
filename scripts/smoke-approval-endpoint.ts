// The approvals endpoint's contract at the REST face: an answerable id is a 200 and reaches the
// session and the answers listener; an id nothing is waiting on is a 409 — and a refused attempt is
// recorded nowhere, not even in the listener the mux reports settlements from. The order the endpoint
// answers in is the part that silently breaks the settlement frames if it is violated, so the read-only
// check, the listener, and the session's own answer are each asserted in that order.
//
//   node scripts/smoke-approval-endpoint.ts
//
// No provider key is needed: the scripted transport parks the run at the gate. The stream-level half
// of the approval story — who sees the request, who hears the settlement — belongs to the mux
// conversion of smoke-approval.ts; this script pins only what the endpoint itself answers.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../packages/server/src/http.ts";
import { SessionHub } from "../packages/server/src/hub.ts";
import { SessionController, SystemController } from "../packages/server/src/controllers/sessions.ts";
import { createRoutes } from "../packages/server/src/controllers/routes.ts";
import { Router } from "../packages/server/src/http/routing.ts";
import { createFakeTransport, fakeAssistantMessage, fakeToolCall } from "./fake-transport.ts";
import { mountSession } from "./mount-session.ts";
import { inMemorySettingsState, type ModelConfig, workspaceDir } from "@my-agent/core";

const PORT = 8094;
const root = await mkdtemp(join(tmpdir(), "my-agent-approval-endpoint-"));
let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
	process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : ` ${detail}`}\n`);
	if (!ok) failures += 1;
}

const watchdog = setTimeout(() => {
	process.stdout.write("\nFAIL the approval endpoint checks did not settle within 60 s\n");
	process.exit(1);
}, 60_000);

const rows: ModelConfig[] = [
	{
		name: "anthropic",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "unused-by-the-scripted-transport",
		id: "claude-sonnet-4-5",
		contextWindow: 200_000,
		maxTokens: 8_192,
	},
];
const modelName = "anthropic";

// The scripted transport stands in for the model: a tool call that parks at the gate, then the text
// that ends the run once the answer arrives. The hub's one orchestrator is built over it, so every
// session this server runs sends through it.
const fake = createFakeTransport();
fake.setResponses([
	fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })),
	fakeAssistantMessage("done"),
]);
const hub = new SessionHub({ absCwd: root, approvalGraceMs: 60_000, api: fake.api, modelsHome: join(root, "agent-home") });
hub.setModelConfigs(rows);

// Mounted the way `SessionHub.open()` mounts one — the entry seeded with this smoke's own settings
// bag, which is what puts `read` behind the gate — so the controller claims through the real hub.
const { id: sessionId } = await mountSession(hub, {
	root,
	model: modelName,
	settings: inMemorySettingsState({ approval: { read: true } }),
});
const session = hub.agent;

// The spy is the whole point of building the controller by hand: the listener is what the mux's
// answers table is fed through, so "the refused attempt reached nothing" is asserted right here.
const remembered: { sessionId: string; toolCallId: string; approved: boolean }[] = [];
const router = new Router(
	createRoutes({
		system: new SystemController(hub),
		sessions: new SessionController(hub, {
			onApproval: (sessionId, toolCallId, approved) => remembered.push({ sessionId, toolCallId, approved }),
		}),
	}),
);
const handle = await createServer({ router, clientDir: "packages/web/dist" });
await new Promise<void>((listen) => handle.server.listen(PORT, "127.0.0.1", listen));

const base = `http://127.0.0.1:${PORT}`;

async function request(method: string, path: string, body?: unknown): Promise<{ status: number; payload: unknown }> {
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(ready: () => boolean, ms = 5_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (ready()) return true;
		await sleep(10);
	}
	return ready();
}

try {
	const accepted = await request("POST", `/api/sessions/${sessionId}/messages`, { text: "read the notes" });
	check("the prompt was accepted", accepted.status === 202, `status ${accepted.status}`);

	const pending = await until(() => session.snapshot(sessionId).pendingApprovals.length === 1);
	check("the run parked at the approval", pending, JSON.stringify(session.snapshot(sessionId).pendingApprovals));
	const toolCallId = session.snapshot(sessionId).pendingApprovals[0]?.toolCallId ?? "";

	// The refusal half: an id nothing is waiting on is a conflict, and neither the answers listener
	// nor the session hears about the attempt.
	const unknown = await request("POST", `/api/sessions/${sessionId}/approvals/no-such-call`, { approved: true });
	check("an unknown toolCallId is a conflict", unknown.status === 409, `status ${unknown.status} ${JSON.stringify(unknown.payload)}`);
	check("the refusal says what was refused", JSON.stringify(unknown.payload).includes("not a pending approval"), JSON.stringify(unknown.payload));
	check("a refused answer was recorded nowhere", remembered.length === 0, JSON.stringify(remembered));
	check("the run is still parked", session.snapshot(sessionId).pendingApprovals.length === 1, JSON.stringify(session.snapshot(sessionId).pendingApprovals));

	const denied = await request("POST", `/api/sessions/${sessionId}/approvals/no-such-call`, { approved: false });
	check("the refusal does not depend on the answer's direction", denied.status === 409, `status ${denied.status}`);

	// The answer half: the real id is accepted, reaches the listener with the session's own identity,
	// and reaches the session — the run carries on to its answer.
	const answered = await request("POST", `/api/sessions/${sessionId}/approvals/${encodeURIComponent(toolCallId)}`, {
		approved: true,
	});
	check("the real answer was accepted", answered.status === 200, `status ${answered.status} ${JSON.stringify(answered.payload)}`);
	check(
		"and it reached the listener exactly once, with the session it was given on",
		remembered.length === 1 && remembered[0]?.sessionId === sessionId && remembered[0]?.toolCallId === toolCallId && remembered[0]?.approved === true,
		JSON.stringify(remembered),
	);

	check(
		"the run finished after the answer",
		await until(() => !session.snapshot(sessionId).submitting, 8_000),
		String(session.snapshot(sessionId).submitting),
	);
	check("the tool ran", JSON.stringify(session.snapshot(sessionId).messages).includes("notes.txt"), "");
	check("and the closing answer is there", session.snapshot(sessionId).messages.some((message) => JSON.stringify(message).includes("done")), "");

	// Answered once, it is no longer answerable: the same request now conflicts too.
	const twice = await request("POST", `/api/sessions/${sessionId}/approvals/${encodeURIComponent(toolCallId)}`, {
		approved: true,
	});
	check("an already-settled id is a conflict too", twice.status === 409, `status ${twice.status} ${JSON.stringify(twice.payload)}`);
	check("and the settled answer was not recorded twice", remembered.length === 1, JSON.stringify(remembered));
} finally {
	clearTimeout(watchdog);
	await hub.close();
	await handle.close();
	await rm(root, { recursive: true, force: true });
	await rm(workspaceDir(root), { recursive: true, force: true }).catch(() => {});
}

process.stdout.write(failures === 0 ? "\napproval endpoint ok\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
