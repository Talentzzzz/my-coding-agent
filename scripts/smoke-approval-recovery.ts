// The loop's recovery machine at the session's face (ADR-0006 §5, ticket 15): the approval gate ends
// the run with the call dangling in the ledger, and what happens to that call afterwards is the
// contract this file pins —
//
//   1. a grant resumes: the answer starts a run whose recovery pass re-runs the call through the
//      gate and the tool itself, and the loop carries on in the same run;
//   2. a denial closes: the dangling call gets the result the answer's reason names, and the model
//      answers it;
//   3. orphans close: dangling calls no answer names — the shape a crash leaves — are closed with
//      synthesized error results at the next run's entry, prompt or resume, so the first request is
//      provider-legal; and the toggle that turns that sweep off leaves them to the host;
//   4. abort during recovery: the run stops like any run, the recovered call keeps its own result,
//      and no denial rides the abort — abort's rejections do not go through the approval chain;
//   5. the mailbox is the recovery run's too: a message steered into a recovery run is drained and
//      answered at the take points, exactly as in a run that started from a prompt.
//
//   node scripts/smoke-approval-recovery.ts
//
// No provider key is needed: the scripted transport makes the tool calls, and a held-gate wrapper
// makes "while the recovery run is streaming" observable.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Loop, type AgentTool, type LoopRuntime } from "@my-agent/loop";
import { createAssistantMessageEventStream, type ChatTransport, type Message, type Model } from "@my-agent/llm";
import { createFakeTransport, fakeAssistantMessage, fakeToolCall } from "./fake-transport.ts";
import {
	openAgent,
	createSessionState,
	SettingsManager,
	type Agent,
	type ModelConfig,
	type ModelSource,
	type ModelSelection,
	workspaceDir,
} from "@my-agent/core";

const root = await mkdtemp(join(tmpdir(), "my-agent-approval-recovery-"));
let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
	process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : ` ${detail}`}\n`);
	if (!ok) failures += 1;
}

const watchdog = setTimeout(() => {
	process.stdout.write("\nFAIL the recovery checks did not settle within 60 s\n");
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
const models: ModelSource = { list: () => rows };
const modelName = "anthropic";
const selection: ModelSelection = { model: modelName };

const fake = createFakeTransport();

function textOf(message: Message): string {
	if (!Array.isArray(message.content)) return "";
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** Every tool result in the session's transcript, oldest first. */
function toolResultTexts(session: Agent): string[] {
	return session.snapshot.messages.filter((message) => message.role === "toolResult").map((message) => textOf(message));
}

/** The prompt-side view of one request: the roles the provider was sent, in order. */
function requestRoles(context: { messages: readonly Message[] }): string[] {
	return context.messages.map((message) => message.role);
}

/**
 * A transport whose calls stop inside the request until released, one hold per call.
 *
 * The scripted transport answers as soon as the loop asks, which leaves no window in which a run can
 * be steered or aborted. Holding the Nth call is what makes mid-run observable; `holds` says which
 * call numbers (1-based, across the transport's lifetime) stop. An abort ends the hold: the signal is
 * what a real transport honors, and letting the scripted answer through on it is what makes the run
 * settle on the aborted message the same way it would over a network.
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

async function openSession(overrides: { approval?: Record<string, boolean>; api?: ChatTransport } = {}): Promise<Agent> {
	return openAgent({
		absWorkspaceRoot: root,
		sessionState: createSessionState(root),
		models,
		api: overrides.api ?? fake.api,
		model: modelName,
		settingsManager: SettingsManager.inMemory({ approval: overrides.approval ?? {} }),
	});
}

// ---------------------------------------------------------------------------------------------------
// 1 + 2. The two answers, each starting the run that closes the call it names.
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\na grant resumes the run and re-runs the call; a denial closes it with its reason\n");

{
	const session = await openSession({ approval: { read: true } });
	fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })), fakeAssistantMessage("after the grant")]);
	await session.prompt("read the notes", { selection });
	await session.settle();
	check("the gate ended the run with the call dangling", session.hasPendingApprovals, JSON.stringify(session.snapshot.pendingApprovals));
	const callId = session.snapshot.pendingApprovals[0]?.toolCallId ?? "";
	check("the dangling call has no result yet", toolResultTexts(session).length === 0, JSON.stringify(toolResultTexts(session)));

	await session.respondApproval(callId, true);
	await session.settle();
	const grantResults = toolResultTexts(session);
	check("the recovery pass re-ran the call through the tool", grantResults.some((text) => text.includes("notes.txt")), JSON.stringify(grantResults));
	check("the granted call is no longer waiting", !session.hasPendingApproval(callId));
	check("a grant records the session's own approval choice", session.getApprovals().read === false);
	check(
		"and the model carried on in the same run",
		session.snapshot.messages.some((message) => message.role === "assistant" && textOf(message) === "after the grant"),
	);
	await session.close();
}

{
	const session = await openSession({ approval: { read: true } });
	fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })), fakeAssistantMessage("after the denial")]);
	await session.prompt("read the notes", { selection });
	await session.settle();
	const callId = session.snapshot.pendingApprovals[0]?.toolCallId ?? "";

	await session.respondApproval(callId, false);
	await session.settle();
	const denialResults = toolResultTexts(session);
	check("the recovery pass closed the call with the deny's sentence", denialResults.some((text) => text.includes("The user denied permission to run read.")), JSON.stringify(denialResults));
	check("the denied call is no longer waiting", !session.hasPendingApproval(callId));
	check(
		"and the model answered the denial",
		session.snapshot.messages.some((message) => message.role === "assistant" && textOf(message) === "after the denial"),
	);
	await session.close();
}

// ---------------------------------------------------------------------------------------------------
// 3. Orphans: what a crash leaves is closed at the next run's entry, prompt or resume.
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\ndangling calls no answer names are closed before the first request\n");

{
	const session = await openSession();
	// The crash shape: two calls in the transcript, no results behind either — appended the way a
	// process that died mid-batch leaves them.
	session.sessionManager.appendMessage(session.sessionState, fakeAssistantMessage(fakeToolCall("read", { path: "a.txt" }, { id: "call_a" })));
	session.sessionManager.appendMessage(session.sessionState, fakeAssistantMessage(fakeToolCall("read", { path: "b.txt" }, { id: "call_b" })));
	check("both dangling calls are derived from the ledger", session.snapshot.pendingApprovals.length === 2, JSON.stringify(session.snapshot.pendingApprovals));

	const prompts: { roles: string[] }[] = [];
	fake.setResponses([
		(context) => {
			prompts.push({ roles: requestRoles(context) });
			return fakeAssistantMessage("carried on");
		},
	]);
	await session.prompt("continue", { selection });
	await session.settle();

	const orphanResults = toolResultTexts(session);
	check(
		"both orphans were closed with the sentence that says what happened",
		orphanResults.filter((text) => text.includes("was left unanswered")).length === 2,
		JSON.stringify(orphanResults),
	);
	check("the sweep cleared the waiting", !session.hasPendingApprovals);
	check(
		"and the first request was provider-legal: each result beside its own call, the prompt after them",
		JSON.stringify(prompts[0]?.roles) === JSON.stringify(["system", "assistant", "toolResult", "assistant", "toolResult", "user"]),
		JSON.stringify(prompts[0]?.roles),
	);
	await session.close();
}

// The toggle: a host that turns the sweep off owns the unanswered calls itself. Driven at the loop's
// own face, because this host never turns it off — the option is the loop's contract, not a setting.
process.stdout.write("\nthe recovery toggle leaves the orphans to the host\n");

{
	const bare = createFakeTransport();
	const model = {
		id: "bare",
		name: "bare",
		api: "anthropic-messages",
		baseUrl: "",
		apiKey: "unused",
		input: [],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 0,
		maxTokens: 0,
		thinkingLevel: "off",
	} as unknown as Model;
	const requests: { roles: string[] }[] = [];
	bare.setResponses([
		(context) => {
			requests.push({ roles: requestRoles(context) });
			return fakeAssistantMessage("answered anyway");
		},
	]);
	const runtime: LoopRuntime = {};
	const loop = new Loop({
		streamFn: (m, context, options) => bare.api.stream(m, context, options),
		runtime,
	});
	const dangling: Message = fakeAssistantMessage(fakeToolCall("read", { path: "a.txt" }, { id: "call_x" }));
	// A tool the recovery pass can resolve, so a re-suspending gate is what stops it — not a missing
	// tool, which the loop answers before any hook runs.
	const readTool: AgentTool = {
		name: "read",
		label: "read",
		description: "reads a file",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as never,
		execute: async () => ({ content: [{ type: "text", text: "ran" }], details: {} }),
	};

	const off = await loop.runLoop({ messages: [dangling], tools: [] }, undefined, {
		model,
		recovery: { enablePendingToolRecovery: false },
	});
	check(
		"toggle off: nothing was synthesized for the call",
		off.every((message) => message.role !== "toolResult"),
		JSON.stringify(off.map((message) => message.role)),
	);
	check(
		"toggle off: the call went to the provider unanswered, as the host asked",
		JSON.stringify(requests[0]?.roles) === JSON.stringify(["assistant"]),
		JSON.stringify(requests[0]?.roles),
	);

	const on = await loop.runLoop({ messages: [dangling], tools: [] }, undefined, { model });
	check(
		"default: the orphan was closed with the sweep's sentence",
		on.some((message) => message.role === "toolResult" && textOf(message).includes("was left unanswered")),
		JSON.stringify(on.map((message) => `${message.role}:${textOf(message)}`)),
	);

	// A grant the gate does not actually clear: the recovery pass re-runs the call through the gate,
	// and a gate that suspends again stops the recovery where it stands — no result is written, and
	// the run ends before its request, exactly as a live batch's suspend does. The tool must exist
	// for the gate to be reached at all, so the context carries a real one.
	const gated = createFakeTransport();
	let asked = 0;
	gated.setResponses([fakeAssistantMessage("should never be asked")]);
	const resuming = new Loop({
		streamFn: (m, context, options) => {
			asked += 1;
			return gated.api.stream(m, context, options);
		},
		runtime: {},
		beforeToolCall: async () => ({ suspend: true }),
	});
	const resuspended = await resuming.runLoop(
		{ messages: [dangling], tools: [readTool] },
		undefined,
		{ model, recovery: { answers: { call_x: { approved: true } } } },
	);
	check(
		"re-suspended: the granted call stayed a question and no request went out",
		resuspended.every((message) => message.role !== "toolResult") && asked === 0,
		`asked=${asked} ${JSON.stringify(resuspended.map((message) => message.role))}`,
	);
}

// ---------------------------------------------------------------------------------------------------
// 4. Abort during recovery: the run stops like any run, and no denial rides the abort.
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\naborting a recovery run leaves the recovered call with its own result\n");

{
	// Hold the recovery run's request — the second call, after the prompted run's own.
	const gate = gatedApi([2]);
	const session = await openSession({ approval: { read: true }, api: gate.api });
	fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })), fakeAssistantMessage("after the grant")]);
	await session.prompt("read the notes", { selection });
	await session.settle();
	const callId = session.snapshot.pendingApprovals[0]?.toolCallId ?? "";
	check("the run parked at the gate", callId.length > 0);

	// The grant starts the recovery run; the held provider call is where the abort lands.
	void session.respondApproval(callId, true);
	const started = Date.now();
	while (!gate.held(2) && Date.now() - started < 5_000) await new Promise((resolve) => setTimeout(resolve, 10));
	check("the recovery run reached its request", gate.held(2));

	await session.abort();
	await session.settle();
	check("the abort settled the recovery run", !session.snapshot.submitting);
	const results = toolResultTexts(session);
	check("the recovered call kept its own result", results.some((text) => text.includes("notes.txt")), JSON.stringify(results));
	check(
		"and no denial rode the abort: the gate's sentences are nowhere",
		results.every((text) => !text.includes("denied permission") && !text.includes("The run was aborted")),
		JSON.stringify(results),
	);
	check("the aborted session has nothing waiting", !session.hasPendingApprovals);
	await session.close();
}

// ---------------------------------------------------------------------------------------------------
// 5. The mailbox is the recovery run's too: a steered message is drained and answered at the take
// points, exactly as in a run that started from a prompt (0003 unchanged).
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\na message steered into a recovery run is taken at the take point\n");

{
	// Hold the recovery run's request — the second call, after the prompted run's own.
	const gate = gatedApi([2]);
	const session = await openSession({ approval: { read: true }, api: gate.api });
	fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })), fakeAssistantMessage("answered both")]);
	await session.prompt("read the notes", { selection });
	await session.settle();
	const callId = session.snapshot.pendingApprovals[0]?.toolCallId ?? "";

	void session.respondApproval(callId, true);
	const started = Date.now();
	while (!gate.held(2) && Date.now() - started < 5_000) await new Promise((resolve) => setTimeout(resolve, 10));
	// The steer is accepted mid-recovery — the run is streaming, so it queues rather than prompts.
	await session.steer("and also this", { selection });

	gate.release(2);
	await session.settle();
	check(
		"the recovery run drained the mailbox and answered it",
		session.snapshot.messages.some((message) => message.role === "assistant" && textOf(message) === "answered both"),
	);
	check("and the steered message is in the transcript once", session.snapshot.messages.filter((message) => message.role === "user" && textOf(message) === "and also this").length === 1);
	await session.close();
}

process.stdout.write(failures === 0 ? "\napproval recovery ok\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;

clearTimeout(watchdog);
await rm(root, { recursive: true, force: true });
await rm(workspaceDir(root), { recursive: true, force: true }).catch(() => {});
