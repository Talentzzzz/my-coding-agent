// 学习 session-manager.ts 的演示脚本：写入线、读取线、compaction、branch。
// 只在系统临时目录里落盘，不碰真实的 agent home。跑法：node .tour/demo.ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@my-agent/core";

function say(tag: string, text: string): void {
	process.stdout.write(`\n=== ${tag} ${text} ===\n`);
}

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const assistant = (text: string): AgentMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "test",
	provider: "test",
	model: "test/model",
	usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	timestamp: Date.now(),
});

/** 给 JSONL 文件编号打印，对照 SessionManager 的行号直觉。 */
async function showFile(path: string): Promise<void> {
	const text = await readFile(path, "utf8");
	const lines = text.split("\n").filter((line) => line.length > 0);
	for (const [index, line] of lines.entries()) {
		process.stdout.write(`  第${index + 1}行  ${line}\n`);
	}
}

// A. 写入线：create() 与 appendMessage()
const dir = await mkdtemp(join(tmpdir(), "tour-"));
const writer = SessionManager.create(dir, dir); // cwd=dir, sessionDir=dir，文件落在临时目录里

say("A1", `create() 刚返回，文件已存在：${writer.getSessionFile()}`);
await showFile(writer.getSessionFile()!);

const q1 = writer.appendMessage(user("这个项目的结构是什么？"));
writer.appendMessage(assistant("packages/core 是无传输的 headless agent，packages/server 是 HTTP API……"));
const q2 = writer.appendMessage(user("session 文件放在哪？"));
writer.appendMessage(assistant("放在 agent home 的 sessions 目录下，每个 workspace 一个子目录。"));

say("A2", `四条消息 append 之后，q1=${q1} q2=${q2}，leaf=${writer.getLeafId()}`);
await showFile(writer.getSessionFile()!);

// B. 读取线：模拟另一个进程重新打开同一个文件
say("B", "SessionManager.open() 同一个文件（模拟进程重启）");
const reader = SessionManager.open(writer.getSessionFile()!);
const context = reader.buildSessionContext();
process.stdout.write(`  leaf=${reader.getLeafId()}（和 writer 的一致）\n`);
process.stdout.write(`  视图消息: ${context.messages.map((message) => message.role).join(" -> ")}\n`);
process.stdout.write(`  记录的 model: ${JSON.stringify(context.model)}，thinkingLevel: ${context.thinkingLevel}\n`);

// C. compaction：文件加一行，视图变短
say("C1", "appendCompaction()：把 q2 之前的内容折叠成摘要（firstKeptEntryId = q2）");
writer.appendCompaction("用户询问本项目结构，得知 core/server/web/desktop 四个包的分工。", q2, 5000);
await showFile(writer.getSessionFile()!);

const afterCompaction = writer.buildSessionContext();
say("C2", "compaction 之后的视图");
process.stdout.write(`  视图消息: ${afterCompaction.messages.map((message) => message.role).join(" -> ")}\n`);
const firstText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return String((content[0] as { text?: string } | undefined)?.text ?? "");
};
process.stdout.write(`  第一条消息的文本开头: ${JSON.stringify(firstText(afterCompaction.messages[0]?.content).slice(0, 40))}...\n`);

// D. branch：inMemory 里玩树
say("D", "inMemory() + branch()：同一个文件里的另一条路");
const tree = SessionManager.inMemory(dir);
const u1 = tree.appendMessage(user("问题A"));
tree.appendMessage(assistant("答案A"));
tree.branch(u1); // leaf 移回问题A
tree.appendMessage(assistant("答案A'（另一条分支）"));
process.stdout.write(`  当前分支: ${tree.buildSessionContext().messages.map((message) => `${message.role}:${String((message.content as { type: string; text?: string }[])[0]?.text ?? "").slice(0, 6)}`).join(" -> ")}\n`);
process.stdout.write(`  分支点: ${JSON.stringify(tree.getBranchPoints())}\n`);

process.stdout.write("\n（演示文件都在系统临时目录，随系统清理；本脚本可随意改再跑。）\n");
