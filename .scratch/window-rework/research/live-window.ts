// 真窗口检查（09 第 3 条）：把整台服务器跑起来——静态客户端用 packages/web/dist，供应商换成脚本化
// transport——然后保持存活，让浏览器里打开的真窗口被亲眼看到：思考行流式出现、工具卡在运行中就出现、
// 输出增量刷新、最后正文落定。没有密钥：模型就是脚本。
//
//   node .scratch/window-rework/research/live-window.ts
// 然后浏览器打开它打印的 URL，在输入框发任意一句话触发第一段脚本回答。
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer } from "../../../packages/server/src/boot.ts";
import {
	createFakeTransport,
	fakeAssistantMessage,
	fakeText,
	fakeThinking,
	fakeToolCall,
} from "../../../scripts/fake-transport.ts";
import type { UserModel } from "@my-agent/core";

const root = await mkdtemp(join(tmpdir(), "my-agent-live-"));
await writeFile(join(root, "note.txt"), "第一行：工具读到的内容。\n第二行：确认读取完整。\n");

const transport = createFakeTransport({ tokensPerSecond: 18 });
const modelRows: UserModel[] = [
	{
		name: "scripted",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "unused-by-the-scripted-transport",
		modelId: "claude-sonnet-4-5",
		contextWindow: 200_000,
		maxTokens: 8_192,
		reasoning: false,
	},
];

const server = await bootServer({ cwd: root, port: 0, api: transport.api });
server.hub.setUserModels(modelRows);

// 第一段：先思考（几段，让收起行的摘要随段落推进），再调一次真的 read 工具；第二段：再思考，然后落正文。
transport.setResponses([
	fakeAssistantMessage(
		[
			fakeThinking(
				"先想一下要读哪个文件。用户没有点名，那就要先看看工作区里有什么。\n\n"
					+ "工作区里应该有 note.txt，那是这个检查自己写进去的两行文本。\n\n"
					+ "决定：直接读 note.txt，读的时候注意确认两行都完整，不要只看第一行就下结论。",
			),
			fakeToolCall("read", { path: "note.txt" }),
		],
		{ stopReason: "toolUse" },
	),
	fakeAssistantMessage([
		fakeThinking(
			"工具读完了，两行都在。\n\n"
				+ "第一行是写入时的话，第二行确认读取完整，没有截断，也没有多余的字节。\n\n"
				+ "现在把结果总结给用户：文件按预期存在，内容一致，工具过程在运行中就出现在了记录里。",
		),
		fakeText("note.txt 读到了：一共两行，与写入的内容一致。工具卡片在运行中就出现了，输出是逐步刷新的。"),
	]),
]);

process.stdout.write(`${server.url}\n`);
// 一直活着，直到被外部结束：这个进程的意义就是"被打开的窗口背后那台服务器"。
setInterval(() => {}, 1 << 30);
