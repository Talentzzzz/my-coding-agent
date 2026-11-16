// approvals 端点在 REST 面上的契约：可应答的 id 返回 200 并到达 session 与应答监听器；没有
// 任何东西在等的 id 返回 409——且被拒绝的尝试不记录在任何地方，连 mux 汇报结算用的那个监听器
// 也不记。端点的应答顺序是那种一旦被破坏就会悄悄弄坏 settlement 帧的部分，所以只读检查、监听器
// 与 session 自身的应答各按这个顺序断言。
//
//   node scripts/smoke-approval-endpoint.ts
//
// 无需 provider key：剧本化 transport 让 run 停在门口。审批故事的流层面那一半——谁看到请求、
// 谁听到结算——属于 smoke-approval.ts 的 mux 部分；本脚本只钉住端点自己应答的内容。
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
import { type ModelConfig, setSessionsDir, SettingManager } from "@my-agent/core";

const PORT = 8094;
const root = await mkdtemp(join(tmpdir(), "my-agent-approval-endpoint-"));
const storeRoot = await mkdtemp(join(tmpdir(), "my-agent-approval-endpoint--store-"));
setSessionsDir(storeRoot);
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

// 剧本化 transport 顶替模型：一个停在门口的工具调用，然后是应答到达后结束 run 的文本。
// hub 的唯一 orchestrator 建立在它之上，这台服务器跑的每个 session 都经由它发送。
const fake = createFakeTransport();
fake.setResponses([
	fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" })),
	fakeAssistantMessage("done"),
]);
// 审批门是 orchestrator 每个请求都会读一次的设置：这台 hub 服务的每个 session 里 `read` 都在
// 门后。映射与模型行先种到临时 home 文件里，任何东西都不会落到机器自己的设置或模型文件上。
const settingsHome = await mkdtemp(join(tmpdir(), "my-agent-approval-endpoint-home-"));
const seeder = new SettingManager({ home: settingsHome, modelsHome: settingsHome });
seeder.applySettings({ approval: { read: true } });
seeder.replaceModels(rows);
const hub = new SessionHub({
	workDirAbsPath: root,
	api: fake.api,
	settingsHome,
	modelsHome: settingsHome,
});

// 按 `SessionHub.open()` 挂载 session 的方式来挂——停在门口的入口就是下面这些检查要驱动的
// 对象——所以 controller 经由真正的 hub 持有。
const { id: sessionId } = await mountSession(hub, {
	root,
});
const agent = hub.agent;

// 手工组装 controller 的全部意义就在这个 spy 上：mux 的应答表正是经由这个监听器喂进来的，
// 所以"被拒绝的尝试哪儿也没到"就在这里断言。
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

// 测试台在下面这些检查期间持有一个 hold。快照读取与编排层内部的装配/散袋没有真正的竞态——
// 袋的读取面（`agent.snapshot`）对冷会话同样作答——持有 hold 纯粹是让这些检查的意图（有人
// 在用这个会话）写在测试台上的方式。
await hub.hold(sessionId);

try {
	const accepted = await request("POST", `/api/sessions/${sessionId}/messages`, { text: "read the notes" });
	check("the prompt was accepted", accepted.status === 202, `status ${accepted.status}`);

	const pending = await until(() => agent.snapshot(sessionId).pendingApprovals.length === 1);
	check("the run parked at the approval", pending, JSON.stringify(agent.snapshot(sessionId).pendingApprovals));
	const toolCallId = agent.snapshot(sessionId).pendingApprovals[0]?.toolCallId ?? "";

	// 拒绝那一半：没有任何东西在等的 id 是冲突，无论应答监听器还是 session 都听不到这次尝试。
	const unknown = await request("POST", `/api/sessions/${sessionId}/approvals/no-such-call`, { approved: true });
	check("an unknown toolCallId is a conflict", unknown.status === 409, `status ${unknown.status} ${JSON.stringify(unknown.payload)}`);
	check("the refusal says what was refused", JSON.stringify(unknown.payload).includes("not a pending approval"), JSON.stringify(unknown.payload));
	check("a refused answer was recorded nowhere", remembered.length === 0, JSON.stringify(remembered));
	check("the run is still parked", agent.snapshot(sessionId).pendingApprovals.length === 1, JSON.stringify(agent.snapshot(sessionId).pendingApprovals));

	const denied = await request("POST", `/api/sessions/${sessionId}/approvals/no-such-call`, { approved: false });
	check("the refusal does not depend on the answer's direction", denied.status === 409, `status ${denied.status}`);

	// 应答那一半：真 id 被收下，带着 session 自己的身份到达监听器，也到达 session——run 继续
	// 走到它的回答。
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
		await until(() => !agent.snapshot(sessionId).running, 8_000),
		String(agent.snapshot(sessionId).running),
	);
	check("the tool ran", JSON.stringify(agent.snapshot(sessionId).messages).includes("notes.txt"), "");
	check("and the closing answer is there", agent.snapshot(sessionId).messages.some((message) => JSON.stringify(message).includes("done")), "");

	// 应答过一次之后就不再是可应答的：同样的请求现在也冲突。
	const twice = await request("POST", `/api/sessions/${sessionId}/approvals/${encodeURIComponent(toolCallId)}`, {
		approved: true,
	});
	check("an already-settled id is a conflict too", twice.status === 409, `status ${twice.status} ${JSON.stringify(twice.payload)}`);
	check("and the settled answer was not recorded twice", remembered.length === 1, JSON.stringify(remembered));
} finally {
	clearTimeout(watchdog);
	hub.release(sessionId);
	await hub.close();
	await handle.close();
	await rm(settingsHome, { recursive: true, force: true });
	await rm(root, { recursive: true, force: true });
	await rm(storeRoot, { recursive: true, force: true }).catch(() => {});
}

process.stdout.write(failures === 0 ? "\napproval endpoint ok\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
