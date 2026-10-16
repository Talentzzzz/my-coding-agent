/**
 * fixtures —— 量具与几个探针共用的造数据助手。
 *
 * 为什么单独一份：量具在 **import 时就把整张表跑一遍**（它是个脚本，不是一个模块），而 05 号的
 * `switch-paint-probe.ts` 要造同一批快照却不想顺带跑完量具。同类助手在 `.scratch/` 下已经抄过一份
 * 并漂移过一次（见票 04），所以这里只留一份，量具与探针都从这里 import。
 *
 * 内容只有三样：一条既有消息的正文、一条由历史撑起来的会话、以及把一条持久消息读成正文的那个读法
 * （`state.ts` 的读法：text 块拼起来）。**没有任何产品代码**。
 */
import type { ModelOption, SessionSnapshot } from "../../../packages/core/protocol.ts";

export const MODEL: ModelOption = {
	name: "faux",
	modelId: "faux-1",
	baseUrl: "http://127.0.0.1:1/v1",
	contextWindow: 200_000,
	maxTokens: 8_192,
	reasoning: false,
	thinkingLevels: ["off", "low", "medium", "high"],
	defaultThinkingLevel: "off",
	hasApiKey: true,
};

export const USAGE = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 150, contextWindow: 200_000 };

/** 一条既有消息的正文：`chars` 字的 markdown 段落。 */
export function messageBody(index: number, chars: number): string {
	if (chars <= 0) return `第 ${index} 条既有消息`;
	let text = "";
	let section = 0;
	while (text.length < chars) {
		section += 1;
		text += `第 ${index} 条 · 第 ${section} 段：段落正文，用来把这条消息撑长并让 renderMarkdown 有活干。\n\n`;
	}
	return text.slice(0, chars);
}

/**
 * 一段被历史撑起来的会话：`count` 条 user/assistant 交替的既有消息。
 *
 * `stamp` 是时间戳的起点，也是 item id 的来源（`state.ts` 用 `role:timestamp` 认一条消息）。切换
 * 会话的场景必须给每条会话**各自**的 `stamp`：所有会话共用一批时间戳的话，`transcript.render` 会
 * 把新会话的 item 认成上一个会话那几个 turn（id 相同 → 复用），量出来的就成了"什么都没重画"。
 */
export function snapshotWith(count: number, chars = 20, options: { id?: string; stamp?: number; cwd?: string } = {}): SessionSnapshot {
	const stamp = options.stamp ?? 1_000;
	const messages = Array.from({ length: count }, (_unused, index) => ({
		role: index % 2 === 0 ? "user" : "assistant",
		content: [{ type: "text", text: messageBody(index, chars) }],
		timestamp: stamp + index,
	}));
	return {
		id: options.id ?? "s1",
		cwd: options.cwd ?? "/workspace",
		createdAt: 1,
		title: "卡顿测量",
		model: `${MODEL.name}/${MODEL.modelId}`,
		thinkingLevel: "off",
		thinkingLevels: ["off", "low"],
		approvals: {},
		allTools: ["read", "write", "edit", "bash"],
		activeTools: ["read", "write"],
		messages,
		messageEntryIds: messages.map((_message, index) => `entry-${index}`),
		branchPoints: [],
		leafId: `entry-${count - 1}`,
		submitting: true,
		queued: 0,
		isRetrying: false,
		retryAttempt: 0,
		usage: USAGE,
		pendingApprovals: [],
	} as unknown as SessionSnapshot;
}

/** 一条持久消息的正文，按 `state.ts` 的读法（text 块拼起来）。 */
export function textOfMessage(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (typeof block === "object" && block !== null && (block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
		.join("");
}

/** 一条会被逐帧"流式"吐出的长 markdown 回答。 */
export function longAnswer(targetLength: number): string {
	let text = "# 测量回答\n\n";
	let section = 0;
	while (text.length < targetLength) {
		section += 1;
		text += `## 第 ${section} 节\n\n`;
		text += "这是正文段落，用来把这条消息撑长。每一帧 renderMarkdown 都会把整条消息重新 parseBlocks 一次，"
			+ "因此单帧成本与消息当前长度成正比。\n\n";
		text += "- 列表项一\n- 列表项二\n- 列表项三\n\n";
		text += "```ts\nconst value = 1;\nconsole.log(value);\n```\n\n";
	}
	return text.slice(0, targetLength);
}
