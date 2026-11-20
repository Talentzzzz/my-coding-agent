// 一次停在门口的结束横跨的队列：run 还在流式输出时用户敲下的一条消息，在这个 run 停到审批上
// 之后会遇到什么。
//
//   1. 被 suspend 的 run 保留自己的队列——消息仍然计数在册，`settle` 照常返回（停在门口的
//      session 是一个问题，不是活儿），grant 启动的恢复 run 会在它的取用点把队列排干，消息
//      因此在工具结果之后而非之前到达会话记录；
//   2. 遗弃清扫把它丢掉——不会有恢复 run，没有任何东西会取用它，一个没人降低的深度会让
//      session 的 `settle` 永远等下去。这正是 hub 的 reap 与 `abort` 走的路径。
//
//   node scripts/smoke-approval-queue.ts
//
// 无需 provider key：剧本化 transport 发出工具调用，持门包装器把"run 还在流式中"变成可观察的
// ——那是消息唯一能入队的窗口。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type ChatTransport, type Message } from "@my-agent/core";
import { createFakeTransport, fakeAssistantMessage, fakeToolCall } from "./fake-transport.ts";
import {
	createSession,
	createToolManager,
	ModelManager,
	openAgent,
	setSessionsDir,
	type Agent,
	type ModelConfig,
	type ModelSelection,
	type Session,
} from "@my-agent/core";

const root = await mkdtemp(join(tmpdir(), "my-agent-approval-queue-"));
const storeRoot = await mkdtemp(join(tmpdir(), "my-agent-approval-queue--store-"));
setSessionsDir(storeRoot);
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

/** 会话记录的平面列表形式，让排序断言可以是一次下标比较。 */
function messagesOf(agent: Agent): Message[] {
	return agent.snapshot(sidOf(agent)).messages;
}

function indexOfText(agent: Agent, role: Message["role"], text: string): number {
	return messagesOf(agent).findIndex((message) => message.role === role && textOf(message).includes(text));
}

/**
 * 一个第 N 次调用会停在请求内部、直到被放行的 transport，每次调用一个 hold。
 *
 * 剧本化 transport 在引擎一问就答，run 不留任何在途窗口——而"run 流式中收下的消息"正是本文件
 * 唯一关心的形状。abort 会结束 hold，如同真正的 transport 尊重自己的 signal。
 */
function gatedApi(holds: number[]): { chatTransport: ChatTransport; release(index: number): void; held(index: number): boolean } {
	const inner = fake.chatTransport.stream.bind(fake.chatTransport);
	let calls = 0;
	const pending = new Map<number, () => void>();
	const released = new Set<number>();
	const chatTransport: ChatTransport = {
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
		chatTransport,
		release: (index) => {
			released.add(index);
			pending.get(index)?.();
			pending.delete(index);
		},
		held: (index) => pending.has(index) && !released.has(index),
	};
}

const opened = new WeakMap<Agent, { id: string; session: Session }>();

function sidOf(agent: Agent): string {
	return opened.get(agent)!.id;
}

/** ADR-0021：出生消息。openSession 先落它，之后的 prompt / snapshot 才有文件可开。 */
const BIRTH_TEXT = "the smoke's birth message";

/** 每个 openSession 递自己的临时 home：各持有者的文件都落在这里，随 root 一起清理。 */
let homeSeq = 0;

async function openSession(overrides: { approval?: Record<string, boolean>; chatTransport?: ChatTransport } = {}): Promise<Agent> {
	const session = createSession(root);
	// 设置归属重构（spec §8）后内存后端退场：审批映射与模型行先种进临时 home 的真实文件
	// （tools.json / models.json），homes 透传给 openAgent——与生产同一条构造路，只是文件指到了
	// 无人问津的目录。
	const home = join(root, `agent-home-${homeSeq++}`);
	const toolManager = createToolManager({ home });
	if (overrides.approval !== undefined) toolManager.applyToolDefaults({ approval: overrides.approval });
	const modelManager = new ModelManager(home);
	modelManager.replaceRows(rows);
	const agent = await openAgent({
		session,
		chatTransport: overrides.chatTransport ?? fake.chatTransport,
		settingsHome: home,
		modelsHome: home,
	});
	// 会话随第一条消息出生（ADR-0021），而编排层按 id 现开文件：这里直接对袋追加一条 user
	// 消息让文件落地——不跑引擎、不耗剧本。模型选择随每条 prompt 的 selection 抵达，与生产一致。
	agent.sessionManager.appendMessage(session, {
		role: "user",
		content: [{ type: "text", text: BIRTH_TEXT }],
		timestamp: 1,
	});
	opened.set(agent, { id: session.sessionId, session });
	return agent;
}

/** 轮询到被持住的调用就是手里那次为止，"run 中"因此是事实而不是猜测。 */
async function untilHeld(gate: { held(index: number): boolean }, index: number, ms = 5_000): Promise<void> {
	const end = Date.now() + ms;
	while (!gate.held(index) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
}

// ---------------------------------------------------------------------------------------------------
// 1. 停住的 run 保留入队的东西，恢复 run 把它排干。
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\na message queued before the gate survives the park and is taken by the recovery run\n");

{
	// 持住第 1 个请求：prompt 自己的那个。下面的一切都发生在该请求在途期间。
	const gate = gatedApi([1]);
	const agent = await openSession({ approval: { read: true }, chatTransport: gate.chatTransport });
	fake.setResponses([
		fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })),
		fakeAssistantMessage("after the grant"),
		fakeAssistantMessage("answered the queued message"),
	]);

	// 不 await：prompt 的 promise 在 run 结束时落定，而 run 必须在途，第二条 prompt 才会入队
	// 而不是自己开一个 run。
	void agent.prompt(sidOf(agent), "read the notes", { selection });
	await untilHeld(gate, 1);

	await agent.prompt(sidOf(agent), "and also this", { selection });
	check("the second message was queued, not turned into a run", agent.snapshot(sidOf(agent)).queued.length === 1, String(agent.snapshot(sidOf(agent)).queued.length));

	// 放行被持住的请求：模型要那个被门住的工具，run 停在那里。
	gate.release(1);
	await agent.settle(sidOf(agent));

	check("the gate ended the run with the call dangling", agent.snapshot(sidOf(agent)).pendingApprovals.length > 0, JSON.stringify(agent.snapshot(sidOf(agent)).pendingApprovals));
	check(
		"the queued message is still counted while the approval waits",
		agent.snapshot(sidOf(agent)).queued.length === 1,
		`queued=${agent.snapshot(sidOf(agent)).queued.length}`,
	);
	check(
		"and it was not written to the session behind the run's back",
		indexOfText(agent, "user", "and also this") === -1,
		JSON.stringify(messagesOf(agent).map((message) => `${message.role}:${textOf(message).slice(0, 20)}`)),
	);

	await agent.respondApproval(sidOf(agent), agent.snapshot(sidOf(agent)).pendingApprovals[0]?.toolCallId ?? "", true);
	await agent.settle(sidOf(agent));

	check(
		"the recovery run drained it and the model answered it",
		indexOfText(agent, "assistant", "answered the queued message") !== -1,
		JSON.stringify(messagesOf(agent).map((message) => `${message.role}:${textOf(message).slice(0, 20)}`)),
	);
	check(
		"it reached the session once",
		messagesOf(agent).filter((message) => message.role === "user" && textOf(message) === "and also this").length === 1,
	);
	check(
		"and it landed after the tool result, which is the only place a provider accepts it",
		indexOfText(agent, "toolResult", "notes.txt") < indexOfText(agent, "user", "and also this"),
		`result=${indexOfText(agent, "toolResult", "notes.txt")} user=${indexOfText(agent, "user", "and also this")}`,
	);
	check("the queue is empty once it was taken", agent.snapshot(sidOf(agent)).queued.length === 0);
	await agent.close(sidOf(agent));
}

// ---------------------------------------------------------------------------------------------------
// 2. 遗弃清扫把它丢掉，且不让 session 看起来还在忙。
//
// `abort` 与 hub 的 reap 走的路径：调用带着"无人应答"的那句话被关掉，其后没有 run——于是没有
// 任何东西会排干队列，一个没人降低的深度正是 `settle` 会永远等下去的东西。
// ---------------------------------------------------------------------------------------------------

process.stdout.write("\nan abandoned approval drops what was queued, and settle still returns\n");

{
	const gate = gatedApi([1]);
	const agent = await openSession({ approval: { read: true }, chatTransport: gate.chatTransport });
	fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })), fakeAssistantMessage("never reached")]);

	void agent.prompt(sidOf(agent), "read the notes", { selection });
	await untilHeld(gate, 1);
	await agent.prompt(sidOf(agent), "and also this", { selection });
	gate.release(1);
	await agent.settle(sidOf(agent));
	check("the run parked with a message queued behind it", agent.snapshot(sidOf(agent)).queued.length === 1, String(agent.snapshot(sidOf(agent)).queued.length));

	// 清扫，按一次退出或 reap 执行它的方式。`abort` 是刻意的停止，它进入同一函数的路径正是
	// 这里钉住的。
	await agent.abort(sidOf(agent));
	await agent.settle(sidOf(agent));

	check("the unanswered call was closed with the sweep's sentence", agent.snapshot(sidOf(agent)).pendingApprovals.length === 0);
	check("the queued message went with the run nobody resumed", agent.snapshot(sidOf(agent)).queued.length === 0, String(agent.snapshot(sidOf(agent)).queued.length));
	check(
		"and nothing was written for it",
		indexOfText(agent, "user", "and also this") === -1,
		JSON.stringify(messagesOf(agent).map((message) => `${message.role}:${textOf(message).slice(0, 20)}`)),
	);
	// session 仍然可用：丢掉队列不得把它楔死。
	fake.setResponses([fakeAssistantMessage("still works")]);
	await agent.prompt(sidOf(agent), "carry on", { selection });
	await agent.settle(sidOf(agent));
	check(
		"the session still runs after the sweep",
		indexOfText(agent, "assistant", "still works") !== -1,
		JSON.stringify(messagesOf(agent).map((message) => `${message.role}:${textOf(message).slice(0, 20)}`)),
	);
	await agent.close(sidOf(agent));
}

process.stdout.write(failures === 0 ? "\napproval queue ok\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;

clearTimeout(watchdog);
await rm(root, { recursive: true, force: true });
await rm(storeRoot, { recursive: true, force: true }).catch(() => {});
