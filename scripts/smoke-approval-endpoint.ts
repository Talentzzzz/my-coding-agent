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
import { type ModelConfig, ModelManager, setSessionsDir, createToolManager } from "@my-agent/domain";

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
// 门后。映射与模型行先种到临时 home 文件里（设置归属重构 spec §8：各持有者各持自己的文件），任何
// 东西都不会落到机器自己的设置或模型文件上。
const settingsHome = await mkdtemp(join(tmpdir(), "my-agent-approval-endpoint-home-"));
createToolManager({ home: settingsHome }).applyToolDefaults({ approval: { read: true } });
new ModelManager({ home: settingsHome }).replaceRows(rows);
const sessionHub = new SessionHub({
	workDirAbsPath: root,
	chatTransport: fake.chatTransport,
	settingsHome,
	modelsHome: settingsHome,
});

// 按 `SessionHub.open()` 挂载 session 的方式来挂——停在门口的入口就是下面这些检查要驱动的
// 对象——所以 controller 经由真正的 hub 持有。
const { id: sessionId } = await mountSession(sessionHub, {
	root,
});
const agent = sessionHub.agent;

// 手工组装 controller：这段 smoke 断言的是端点契约本身——冲突、收下、run 继续——
// 经由与本服务器相同的构造路径接线。
const router = new Router(
	createRoutes({
		systemController: new SystemController(sessionHub),
		sessionController: new SessionController(sessionHub, {}),
	}),
);
const httpServerHandle = await createServer({ router, clientDir: "packages/web/dist" });
await new Promise<void>((listen) => httpServerHandle.server.listen(PORT, "127.0.0.1", listen));

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

	const pending = await until(() => agent.snapshot(sessionId).pendingApprovals.length === 1);
	check("the run parked at the approval", pending, JSON.stringify(agent.snapshot(sessionId).pendingApprovals));
	const toolCallId = agent.snapshot(sessionId).pendingApprovals[0]?.toolCallId ?? "";

	// 拒绝那一半：没有任何东西在等的 id 是冲突，session 听不到这次尝试。
	const unknown = await request("POST", `/api/sessions/${sessionId}/approvals/no-such-call`, { approved: true });
	check("an unknown toolCallId is a conflict", unknown.status === 409, `status ${unknown.status} ${JSON.stringify(unknown.payload)}`);
	check("the refusal says what was refused", JSON.stringify(unknown.payload).includes("not a pending approval"), JSON.stringify(unknown.payload));
	check("the run is still parked", agent.snapshot(sessionId).pendingApprovals.length === 1, JSON.stringify(agent.snapshot(sessionId).pendingApprovals));

	const denied = await request("POST", `/api/sessions/${sessionId}/approvals/no-such-call`, { approved: false });
	check("the refusal does not depend on the answer's direction", denied.status === 409, `status ${denied.status}`);

	// 应答那一半：真 id 被收下，run 继续走到它的回答。
	const answered = await request("POST", `/api/sessions/${sessionId}/approvals/${encodeURIComponent(toolCallId)}`, {
		approved: true,
	});
	check("the real answer was accepted", answered.status === 200, `status ${answered.status} ${JSON.stringify(answered.payload)}`);

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
} finally {
	clearTimeout(watchdog);
	await sessionHub.close();
	await httpServerHandle.close();
	await rm(settingsHome, { recursive: true, force: true });
	await rm(root, { recursive: true, force: true });
	await rm(storeRoot, { recursive: true, force: true }).catch(() => {});
}

process.stdout.write(failures === 0 ? "\napproval endpoint ok\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
