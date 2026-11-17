// Boot smoke test：像桌面外壳那样启动服务器——进程内、分配到的端口——并检查外壳依赖的一切：
// 客户端被服务、API 有应答、落地 session 就是服务器说的那个、关闭真的会关。
//
//   node scripts/smoke-boot.ts
//
// 最后两节是常驻 transport 需要的 shutdown 证据（ticket 15，§4）：`close()` 返回是必要而非充分
// 条件，因为一个拒绝新连接的 listener 不等于一个已退出的进程。所以本脚本断言两半——`close()`
// 在最坏情况在场时返回（一个窗口的连接正看着一个停在永远无人应答的审批上的 run），然后脚本
// **自己收尾**：文件里唯一的 `process.exit` 藏在一个 unref 的 watchdog 后面，只有某处泄漏了
// 句柄、把事件循环留在活着的状态时它才触发。显式 exit 恰好会掩盖那种泄漏，所以没有。
//
// 子进程那一半跑真的 `main.ts`，并在一条常驻连接开着的情况下终止它。它的诚实边界写在这里：
// `main.ts` 自己的 shutdown handler 以 `process.exit(0)` 结束，所以这只证明外壳能放下服务器
// ——不证明事件循环会自己排干。只有上面的进程内那一半证明这个。
//
// agent home 是脚本自己的临时目录，在第一个 app 模块被 import 之前创建：`AGENT_HOME` 在 import
// 时从 `MY_AGENT_HOME` 一次性解析，这就是下面每个 app import 都是动态的原因。对着机器真实的
// home 启动曾让这个 smoke 读用户的 `models.json`——那里零行会把落地 session 放到 placeholder
// 模型上，那个模型从不发送任何东西，于是下面的 run 永远到不了它的工具调用、审批永远不出现
// （ticket 10：2026-10-16 红，当天下午绿，期间代码未动）。它还会把每次 run 的 session 文件写进
// 真实 home 的 `sessions/`。两处泄漏都已消除：模型列表是本脚本自己的单行文件，home 在最后与
// 工作目录一起删除。
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import type { ChatTransport } from "@my-agent/core";
import type { BootedServer } from "../packages/server/src/boot.ts";
import type { WireClient } from "./wire/client.ts";

// 先是临时 home，然后是它承载的环境变量，再——且仅在那之后——是 app 模块。这一行不需要 key：
// 下面的 fake transport 从不拨打任何一行指名的端点。
const agentHome = mkdtempSync(join(tmpdir(), "my-agent-boot-home-"));
writeFileSync(
	join(agentHome, "models.json"),
	`${JSON.stringify({ models: [{ name: "boot-fake", baseUrl: "http://127.0.0.1:9", id: "boot-fake" }] }, null, "\t")}\n`,
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

/** 临时目录尽力删除：一个残留的 temp 目录不得让已经通过的 smoke 失败。 */
function removeQuiet(dir: string): Promise<void> {
	return rm(dir, { recursive: true, force: true }).catch(() => {});
}

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

/** 一个空闲端口，取到再放回：`main.ts` 拒绝 `--port 0`，所以子进程需要一个真端口。 */
async function freePort(): Promise<number> {
	const probe = createTcpServer();
	await new Promise<void>((listen) => probe.listen(0, "127.0.0.1", listen));
	const port = (probe.address() as { port: number }).port;
	await new Promise<void>((close) => probe.close(() => close()));
	return port;
}

// 桌面外壳对着机器自己的 home 启动；本脚本对着上面的临时 home 启动，因为外壳对 boot 路径的
// 需求不得依赖机器碰巧有什么。工作目录也是临时目录——这里没有任何东西把 session 写进仓库或
// 两棵临时树之外的任何地方。剧本化 transport 骑在 boot 路径本身上：下面的最坏情况需要一个
// 在场的、无人应答的 run，而 provider key 不该是它的代价。那个最坏情况是一次永不应答的 provider
// 调用——在 end-restart 审批语义下（ADR-0005 §5）审批不再让 run 停住，所以这个挂起才是把 run
// 留在栈上供 `close()` 截断的东西。挂起尊重 abort signal，这正是要点：`close()` 先 abort，
// 被 abort 的调用就是让它得以返回的东西。
const workDir = await mkdtemp(join(tmpdir(), "my-agent-boot-"));
const fake = createFakeTransport();
fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" }))]);
// 最坏情况自己的 prompt，且仅它，会挂起：其他各节的调用都照常通过。
const neverAnswers: ChatTransport = {
	stream: (model, context, options) => {
		if (!JSON.stringify(context.messages).includes("read the notes")) {
			return fake.api.stream(model, context, options);
		}
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(fake.api.stream(model, context, options)), 60_000);
			options?.signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve(fake.api.stream(model, context, options));
				},
				{ once: true },
			);
		});
	},
};
const server: BootedServer = await bootServer({ workDirAbsPath: workDir, port: 0, api: neverAnswers });

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

	// 落地是服务器的决定，不是客户端的：启动时不选任何东西，所以未 pin 的启动答 `null`、窗口
	// 停在欢迎态，而 `--session`（与 MY_AGENT_SESSION）是通向非 null 回答的唯一道路——在下面
	// pin 的那节。本节驱动的 session 是显式创建返回的那个。
	const landing = await fetch(`${server.url}/api/sessions/current`);
	const landingBody = (await landing.json()) as { sessionId: string | null };
	const hubId = await server.hub.currentSessionId();
	console.log(`current ${landing.status} sessionId=${landingBody.sessionId} hub=${hubId}`);
	check("startup selects nothing", landingBody.sessionId === null && hubId === null, `sessionId=${landingBody.sessionId}`);

	const created = await request(server.url, "POST", "/api/sessions", { text: "the boot conversation" });
	check("the creation landed", created.status === 201, String(created.status));
	const sessionId = ((created.payload ?? {}) as { sessionId?: string }).sessionId ?? "";
	// 创建改变不了落点：未指名的连接永远不落在任何会话上，显式创建只把 id 交还给请求者自己。
	check("the landing stays null after an explicit creation", (await server.hub.currentSessionId()) === null);

	// modes 面（ADR-0004）：patch 整表替换列表，snapshot 整份带回，与内置默认名——或与另一行
	// ——撞名的请求被拒绝而不是被改得唯一。这里的一切都骑在临时 home 上，不会泄进机器的设置。
	const saved = await request(server.url, "PATCH", "/api/settings", {
		patch: { modes: [{ name: "smoke-readonly", tools: ["read", "glob", "grep"], approval: { bash: false } }] },
	});
	check("modes saved through the settings patch", saved.status === 200, JSON.stringify(saved.payload));
	const carried = (saved.payload as { settings?: { modes?: { name: string; tools: string[] }[] } }).settings?.modes;
	check(
		"the snapshot carries the saved mode whole",
		carried?.length === 1 && carried[0]!.name === "smoke-readonly" && carried[0]!.tools.join(",") === "read,glob,grep",
		JSON.stringify(carried),
	);
	const reserved = await request(server.url, "PATCH", "/api/settings", {
		patch: { modes: [{ name: "默认", tools: [], approval: {} }] },
	});
	check("the built-in default's name is reserved", reserved.status === 400, String(reserved.status));
	const duplicate = await request(server.url, "PATCH", "/api/settings", {
		patch: { modes: [{ name: "a", tools: [], approval: {} }, { name: "a", tools: [], approval: {} }] },
	});
	check("a duplicate mode name is refused", duplicate.status === 400, String(duplicate.status));
	const cleared = await request(server.url, "PATCH", "/api/settings", { patch: { modes: [] } });
	check("an empty list is a choice the patch accepts", cleared.status === 200, String(cleared.status));

	const wire: WireClient = await connect(`${server.url.replace("http", "ws")}/mux`);
	const baseline = await wire.open(sessionId);
	check("the lane serves the landing session", baseline.id === sessionId, `baseline=${baseline.id} landing=${sessionId}`);
	// birth 即第一条消息（ADR-0021）：快照不再为空，它带着出生那次往返写下的一切——
	// 出生消息、模型的回答、以及这个剧本下工具调用与其结果。
	check("a fresh session opens with its birth exchange", baseline.messages.length > 0, String(baseline.messages.length));

	// ---------------------------------------------------------------------------------------------
	// shutdown 的最坏情况，真实组装：一个窗口的连接正看着一个 provider 调用永远无人应答的 run。
	// 剧本化 transport 对这一条 prompt 挂起；没有任何东西会解决它，只有 shutdown 自己的 abort 能。
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("shutdown with the worst case in residence\n");

	const accepted = await request(server.url, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
		text: "read the notes",
	});
	check("the prompt was accepted", accepted.status === 202, String(accepted.status));
	check(
		"the run is in residence, waiting on a provider that never answers",
		await until(
			() => wire.items(sessionId).some((message) => message.type === "status" && (message as { running?: boolean }).running === true),
			10_000,
		),
		JSON.stringify(wire.items(sessionId).map((message) => message.type)),
	);

	const started = Date.now();
	await server.close();
	check("close() returned with the worst case in residence", Date.now() - started < 5_000, `${Date.now() - started} ms`);
	// 那个无人能应答的 run 在下落途中被 abort：没有东西留在等待里。
	check("nothing is left running", !server.hub.isLive(sessionId), String(server.hub.isLive(sessionId)));

	// 关闭的 listener 必须拒绝连接，否则外壳每次重启都会泄漏一台服务器。
	try {
		await fetch(server.url);
		check("the listener refuses connections after close", false, "still answering");
	} catch {
		check("the listener refuses connections after close", true);
	}
	await wire.close().catch(() => {});

	// ---------------------------------------------------------------------------------------------
	// pin 是通向非 null 落地的唯一道路：带 `--session` 的启动逐字回答那个 id——那里有没有活着的
	// 东西是 open 的问题，不是落地的问题。
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a pinned boot lands on the pinned id\n");
	const pinnedWorkDir = await mkdtemp(join(tmpdir(), "my-agent-boot-pin-"));
	const pinned = await bootServer({ workDirAbsPath: pinnedWorkDir, port: 0, api: fake.api, sessionId: "pinned-session" });
	try {
		const answer = (await (await fetch(`${pinned.url}/api/sessions/current`)).json()) as { sessionId: string | null };
		check("the pin is the landing", answer.sessionId === "pinned-session", String(answer.sessionId));
	} finally {
		await pinned.close();
		await removeQuiet(pinnedWorkDir);
	}

	// ---------------------------------------------------------------------------------------------
	// 子进程那一半：真的 `main.ts`、一条对它开着的常驻连接、一次必须到达的终止。这一半证明什么、
	// 不证明什么，见文件头部。
	// ---------------------------------------------------------------------------------------------
	process.stdout.write("a real server process goes down with a connection attached\n");

	const childWorkDir = await mkdtemp(join(tmpdir(), "my-agent-boot-child-"));
	const port = await freePort();
	const child = spawn(
		process.execPath,
		[join("packages", "server", "src", "main.ts"), "--workDir", childWorkDir, "--port", String(port)],
		{
			stdio: "ignore",
			env: {
				...process.env,
				// 显式指定，从不靠运气继承：子进程必须读到与父进程相同的模型。
				MY_AGENT_HOME: process.env.MY_AGENT_HOME ?? join(homedir(), ".my-agent"),
			},
		},
	);
	const childBase = `http://127.0.0.1:${port}`;
	// 就绪与否从 /api/health 轮询，从不去解析子进程的 stdout（那条流归它的 shutdown handler
	// 所有，而 stdio 解析本身就是一堆麻烦）。
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
			// 在 POSIX 上这进 main.ts 自己的 SIGTERM handler；在 Windows 上这个请求直接终止子进程
			// ——无论哪种，exit 都必须到达，这正是外壳依赖的部分。
		child.kill("SIGTERM");
		check("the child exited with a connection attached", await Promise.race([exited, sleep(5_000).then(() => false)]));
		childSocket.close();
	}
	await removeQuiet(childWorkDir);
} finally {
	await removeQuiet(workDir);
	await removeQuiet(agentHome);
}

// 自然退出 watchdog，文件里最后一件事：上面的一切都已拆除，事件循环应当排空、进程应当自己
// 退出——赶在这个不占用循环的 unref 定时器触发之前。它若触发，说明某处泄漏了句柄：大声说出来
// 并失败，因为一个只因被告知才结束的 smoke 对 shutdown 什么也没证明。
setTimeout(() => {
	process.stdout.write("\nFAIL the process did not exit on its own — a handle leaked somewhere above\n");
	// 说出还占着循环的是什么，让下次出现时能指名它的句柄，而不是只宣布存在一个。只是类型——
	// Node 在这里没有可移植的句柄身份——但一个报 "TCPSocketWrap" 的泄漏是可以追捕的；ticket 10
	// 的后半仍未复现，这是它留下的网。
	const resources = [...new Set(process.getActiveResourcesInfo())].join(", ");
	process.stdout.write(`still-active resources: ${resources}\n`);
	process.exit(1);
}, 5_000).unref();

process.stdout.write(failures === 0 ? "\nboot ok\n" : `\n${failures} failure(s)\n`);
process.exitCode = failures === 0 ? 0 : 1;
