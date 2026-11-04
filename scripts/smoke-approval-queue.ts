// The queue across a gate'd end: what happens to a message a person typed while the run was still
// streaming, when that run then parks at an approval.
//
//   1. a suspended run keeps its queue — the message stays counted, `settle` still returns (a parked
//      session is a question, not work), and the recovery run the grant starts drains it at its take
//      points, so the message reaches the transcript after the tool result rather than before it;
//   2. the abandonment sweep drops it — no recovery run is coming, so nothing would ever take it, and
//      a depth nobody lowers is a session `settle` waits on forever. That is the path the hub's reap
//      and `abort` take.
//
//   node scripts/smoke-approval-queue.ts
//
// No provider key is needed: the scripted transport makes the tool call, and the held-gate wrapper
// makes "while the run is streaming" observable — the only window in which a message can be queued.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type ChatTransport, type Message } from "@my-agent/core";
import { createFakeTransport, fakeAssistantMessage, fakeToolCall } from "./fake-transport.ts";
import {
	createSession,
	inMemorySettingManager,
	openAgent,
	sessionDir,
	type Agent,
	type ModelConfig,
	type ModelSelection,
	type Session,
} from "@my-agent/core";

const root = await mkdtemp(join(tmpdir(), "my-agent-approval-queue-"));
let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
	process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : ` ${detail}`}\n`);
	if (!ok) failures += 1;
}

const watchdog = setTimeout(() => {
	process.stdout.write("\nFAIL the queue checks did not settle within 60 s\n");
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
const selection: ModelSelection = { model: modelName };

const fake = createFakeTransport();

function textOf(message: Message): string {
	if (!Array.isArray(message.content)) return "";
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** The transcript as a flat list, so an ordering claim can be an index comparison. */
function messagesOf(session: Agent): Message[] {
	return session.snapshot(sidOf(session)).messages;
}

function indexOfText(session: Agent, role: Message["role"], text: string): number {
	return messagesOf(session).findIndex((message) => message.role === role && textOf(message).includes(text));
}

/**
 * A transport whose Nth call stops inside the request until released, one hold per call.
 *
 * The scripted transport answers as soon as the engine asks, which leaves no window in which a run
 * can be mid-flight — and a message accepted while the run is streaming is the only shape this file
 * is about. An abort ends the hold, as a real transport honors its signal.
 */
function gatedApi(holds: number[]): { api: ChatTransport; release(index: number): void; held(index: number): boolean } {
	const inner = fake.api.stream.bind(fake.api);
	let calls = 0;
	const pending = new Map<number, () => void>();
	const released = new Set<number>();
	const api: ChatTransport = {
		stream: (model, context, options) => {
			calls += 1;
			const nth = calls;
			if (holds.includes(nth) && !released.has(nth)) {
				const outer = createAssistantMessageEventStream();
				void (async () => {
					await new Promise<void>((resolve) => {
						pending.set(nth, resolve);
						options?.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					pending.delete(nth);
					const answer = inner(model, context, options);
					for await (const event of answer) outer.push(event);
					outer.end(await answer.result());
				})();
				return outer;
			}
			return inner(model, context, options);
		},
	};
	return {
		api,
		release: (index) => {
			released.add(index);
			pending.get(index)?.();
			pending.delete(index);
		},
		held: (index) => pending.has(index) && !released.has(index),
	};
}

const opened = new WeakMap<Agent, { id: string; state: Session }>();

function sidOf(session: Agent): string {
	return opened.get(session)!.id;
}

async function openSession(overrides: { approval?: Record<string, boolean>; api?: ChatTransport } = {}): Promise<Agent> {
	const state = createSession(root);
	const session = await openAgent({
		workDirAbsPath: root,
		session: state,
		api: overrides.api ?? fake.api,
		model: modelName,
		settings: inMemorySettingManager({ approval: overrides.approval ?? {} }, rows),
	});
	opened.set(session, { id: state.sessionId, state });
	return session;
}

/** Poll until the held call is the one in hand, so "mid-run" is a fact rather than a guess. */
async function untilHeld(gate: { held(index: number): boolean }, index: number, ms = 5_000): Promise<void> {
	const end = Date.now() + ms;
	while (!gate.held(index) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
}

// ---------------------------------------------------------------------------------------------------
// 1. A parked run keeps what was queued, and the recovery run drains it.
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\na message queued before the gate survives the park and is taken by the recovery run\n");

{
	// Hold request 1: the prompt's own. Everything below happens while that request is in flight.
	const gate = gatedApi([1]);
	const session = await openSession({ approval: { read: true }, api: gate.api });
	fake.setResponses([
		fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })),
		fakeAssistantMessage("after the grant"),
		fakeAssistantMessage("answered the queued message"),
	]);

	// Not awaited: the prompt's promise resolves when the run ends, and the run has to be in flight
	// for the second prompt to queue rather than open a run of its own.
	void session.prompt(sidOf(session), "read the notes", { selection });
	await untilHeld(gate, 1);

	await session.prompt(sidOf(session), "and also this", { selection });
	check("the second message was queued, not turned into a run", session.snapshot(sidOf(session)).queued.length === 1, String(session.snapshot(sidOf(session)).queued.length));

	// Let the held request answer: the model asks for the gated tool, and the run parks there.
	gate.release(1);
	await session.settle(sidOf(session));

	check("the gate ended the run with the call dangling", session.hasPendingApprovals(sidOf(session)), JSON.stringify(session.snapshot(sidOf(session)).pendingApprovals));
	check(
		"the queued message is still counted while the approval waits",
		session.snapshot(sidOf(session)).queued.length === 1,
		`queued=${session.snapshot(sidOf(session)).queued.length}`,
	);
	check(
		"and it was not written to the transcript behind the run's back",
		indexOfText(session, "user", "and also this") === -1,
		JSON.stringify(messagesOf(session).map((message) => `${message.role}:${textOf(message).slice(0, 20)}`)),
	);

	await session.respondApproval(sidOf(session), session.snapshot(sidOf(session)).pendingApprovals[0]?.toolCallId ?? "", true);
	await session.settle(sidOf(session));

	check(
		"the recovery run drained it and the model answered it",
		indexOfText(session, "assistant", "answered the queued message") !== -1,
		JSON.stringify(messagesOf(session).map((message) => `${message.role}:${textOf(message).slice(0, 20)}`)),
	);
	check(
		"it reached the transcript once",
		messagesOf(session).filter((message) => message.role === "user" && textOf(message) === "and also this").length === 1,
	);
	check(
		"and it landed after the tool result, which is the only place a provider accepts it",
		indexOfText(session, "toolResult", "notes.txt") < indexOfText(session, "user", "and also this"),
		`result=${indexOfText(session, "toolResult", "notes.txt")} user=${indexOfText(session, "user", "and also this")}`,
	);
	check("the queue is empty once it was taken", session.snapshot(sidOf(session)).queued.length === 0);
	await session.close(sidOf(session));
}

// ---------------------------------------------------------------------------------------------------
// 2. The abandonment sweep drops it, and does not leave the session looking busy.
//
// The path `abort` and the hub's reap take: the call is closed with the sentence that says nothing
// answered, and no run follows — so nothing would ever drain the queue, and a depth nobody lowers is
// what `settle` would wait on forever.
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\nan abandoned approval drops what was queued, and settle still returns\n");

{
	const gate = gatedApi([1]);
	const session = await openSession({ approval: { read: true }, api: gate.api });
	fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })), fakeAssistantMessage("never reached")]);

	void session.prompt(sidOf(session), "read the notes", { selection });
	await untilHeld(gate, 1);
	await session.prompt(sidOf(session), "and also this", { selection });
	gate.release(1);
	await session.settle(sidOf(session));
	check("the run parked with a message queued behind it", session.snapshot(sidOf(session)).queued.length === 1, String(session.snapshot(sidOf(session)).queued.length));

	// The sweep, as an exit or a reap performs it. `abort` is the deliberate stop, and its own route
	// into the same function is what this pins.
	await session.abort(sidOf(session));
	await session.settle(sidOf(session));

	check("the unanswered call was closed with the sweep's sentence", !session.hasPendingApprovals(sidOf(session)));
	check("the queued message went with the run nobody resumed", session.snapshot(sidOf(session)).queued.length === 0, String(session.snapshot(sidOf(session)).queued.length));
	check(
		"and nothing was written for it",
		indexOfText(session, "user", "and also this") === -1,
		JSON.stringify(messagesOf(session).map((message) => `${message.role}:${textOf(message).slice(0, 20)}`)),
	);
	// The session is still usable: dropping the queue must not wedge it.
	fake.setResponses([fakeAssistantMessage("still works")]);
	await session.prompt(sidOf(session), "carry on", { selection });
	await session.settle(sidOf(session));
	check(
		"the session still runs after the sweep",
		indexOfText(session, "assistant", "still works") !== -1,
		JSON.stringify(messagesOf(session).map((message) => `${message.role}:${textOf(message).slice(0, 20)}`)),
	);
	await session.close(sidOf(session));
}

process.stdout.write(failures === 0 ? "\napproval queue ok\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;

clearTimeout(watchdog);
await rm(root, { recursive: true, force: true });
await rm(sessionDir(root), { recursive: true, force: true }).catch(() => {});
