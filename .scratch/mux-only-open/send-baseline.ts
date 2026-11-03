// `retain(send)` 带来的那份基线，是「run 还没开始」还是「run 已经落定」？
// 这一问决定 03 的 send 引用要不要多一个「见过它开跑」的标记。
// node .scratch/mux-only-open/send-baseline.ts（需要 MY_AGENT_HOME=<临时目录>）
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "../../packages/server/src/boot.ts";
import { createFakeTransport, fakeAssistantMessage } from "../../scripts/fake-transport.ts";
import { MuxClient, browserSocket } from "../../packages/web/src/client.ts";
import type { ModelConfig } from "@my-agent/core";

const root = await mkdtemp(join(tmpdir(), "my-agent-send-"));
const home = process.env.MY_AGENT_HOME ?? root;
const transport = createFakeTransport({ tokensPerSecond: 20 });
const server = await bootServer({ workDirAbsPath: root, port: 0, api: transport.api, settingsHome: home });
const model: ModelConfig = { name: "scripted", baseUrl: "http://127.0.0.1:1/v1", apiKey: "x", id: "claude-sonnet-4-5", contextWindow: 200_000, maxTokens: 8_192 };
server.hub.setModelConfigs([model]);

const { sessionId } = (await (await fetch(`${server.url}/api/sessions`, { method: "POST" })).json()) as { sessionId: string };
transport.setResponses([fakeAssistantMessage("在跑" + "着".repeat(40))]);

const log: string[] = [];
const t0 = Date.now();
const client = new MuxClient(
	{
		onChannel: () => {},
		onConnectionItem: () => {},
		onStreamMessage: (id, message) => {
			const submitting =
				message.type === "status" ? message.submitting : message.type === "baseline" ? message.session.submitting : undefined;
			if (id === sessionId && submitting !== undefined) log.push(`${Date.now() - t0}ms ${message.type} submitting=${submitting}`);
		},
		onStreamEnd: () => {},
		onStreamError: () => {},
	},
	{
		url: server.url.replace("http", "ws") + "/mux",
		socket: browserSocket(server.url.replace("http", "ws") + "/mux"),
		log: () => {},
	},
);
client.start();
while (client.channel !== "live") await new Promise((r) => setTimeout(r, 20));

client.retain(sessionId, "pane");
await new Promise((r) => setTimeout(r, 120));
log.push(`${Date.now() - t0}ms —— 关掉 pane 引用，改由 send 引用看着（窗口就是这样发消息的）`);
// 窗口的 prompt()：先 retain(send)（会真的发 open），再 POST。
client.retain(sessionId, "send");
const posted = Date.now();
await fetch(`${server.url}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ text: "发一条" }),
});
log.push(`${Date.now() - t0}ms POST 返回 ${Date.now() - posted}ms`);
await new Promise((r) => setTimeout(r, 4000));
for (const line of log) process.stdout.write(`  ${line}\n`);
client.close();
await server.close();
process.exit(0);
