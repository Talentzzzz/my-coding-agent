/**
 * markdown-attribution-probe —— 核对 `jank-harness` 里"其中md"那一列的归因。
 *
 * 量具的两条路：`transcript.render` 走的是 JIT 编译过的快路，而"把同一批文本重画一遍"是另一条路，
 * 同样的 `renderMarkdown` 在两条路上未必同价。这个探针把两者并排：
 *
 * - `transcript.render`：一次真实的整棵绘制（包含建 turn 骨架、建 Markdown DOM、挂进容器）；
 * - 单量 md：对同一批文本逐条 `renderMarkdown`，与量具的"其中md"同法；
 * - "x" 正文对照：正文全是单字时 `transcript.render` 的残值，也就是"不画 Markdown 还剩多少"。
 *
 * 判据：**单量 md − "x" 残值 ≈ transcript.render − "x" 残值**，两边都指向同一笔 Markdown 账，
 * 那条归因才站得住。跑法：`node .scratch/window-rework/research/markdown-attribution-probe.ts`
 */
import { installDom, asElement, resetWork, work } from "./dom-shim.ts";
import { TranscriptView } from "../../../packages/web/src/render/transcript.ts";
import * as markdown from "../../../packages/web/src/render/markdown.ts";
import { initialState, reduce } from "../../../packages/web/src/state.ts";
import type { ServerMessage, SessionSnapshot } from "../../../packages/core/protocol.ts";

installDom();
const hrtime = (): bigint => process.hrtime.bigint();
const msBetween = (a: bigint, b: bigint): number => Number(b - a) / 1e6;

/** 一段定长的正文，形状与量具造的一致。 */
function body(chars: number): string {
	let text = "";
	let section = 0;
	while (text.length < chars) {
		section += 1;
		text += `第 ${section} 段：段落正文，用来把这条消息撑长并让 renderMarkdown 有活干。\n\n`;
	}
	return text.slice(0, chars);
}

function snapshot(count: number, chars: number): SessionSnapshot {
	const messages = Array.from({ length: count }, (_unused, index) => ({
		role: index % 2 === 0 ? "user" : "assistant",
		content: [{ type: "text", text: body(chars) }],
		timestamp: 1_000 + index,
	}));
	return {
		id: "s",
		cwd: "/w",
		createdAt: 1,
		title: "t",
		model: "m/m",
		thinkingLevel: "off",
		thinkingLevels: ["off"],
		approvals: {},
		allTools: [],
		activeTools: [],
		messages,
		messageEntryIds: messages.map((_message, index) => `e${index}`),
		branchPoints: [],
		leafId: "e0",
		submitting: false,
		queued: 0,
		isRetrying: false,
		retryAttempt: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, contextWindow: 1 },
		pendingApprovals: [],
	} as unknown as SessionSnapshot;
}

function textOf(message: unknown): string {
	const content = (message as { content: { text: string }[] }).content;
	return content[0]!.text;
}

/** 一次真实的整棵绘制，返回毫秒。 */
function paintWhole(snap: SessionSnapshot): number {
	const host = asElement(document.createElement("main"));
	const view = new TranscriptView(host, { onUserContext: () => {} });
	const state = reduce(initialState(), { type: "baseline", session: snap } as unknown as ServerMessage);
	resetWork();
	const a = hrtime();
	view.render(state.items, state.streaming);
	return msBetween(a, hrtime());
}

/** 对同一批文本逐条 renderMarkdown，`repeat` 轮取均值。 */
function paintMarkdownOnly(texts: string[], repeat: number): number {
	const container = asElement(document.createElement("div"));
	let total = 0;
	for (let round = 0; round < repeat; round += 1) {
		for (const text of texts) {
			const a = hrtime();
			markdown.renderMarkdown(container, text);
			total += msBetween(a, hrtime());
		}
	}
	return total / repeat;
}

const triple = (run: () => number): string => [run(), run(), run()].map((value) => value.toFixed(2)).join("/");

for (const [count, chars] of [[50, 400], [500, 400], [500, 4000]] as [number, number][]) {
	const snap = snapshot(count, chars);
	const texts = snap.messages.map(textOf);
	// 热身：把两条路都跑几遍，JIT 编译的价不该算进任何一边。
	for (let round = 0; round < 5; round += 1) {
		paintWhole(snapshot(count, chars));
		paintMarkdownOnly(texts, 1);
	}
	// 对照：正文全是单字时，绘制只剩 turn 骨架与节点搬运，没有 Markdown 可画。
	const plainSnapshot = snapshot(count, 1);
	const plain = [plainSnapshot, plainSnapshot, plainSnapshot].map((snapshot) => paintWhole(snapshot));
	console.log(
		`count=${count} chars=${chars}：`
		+ `transcript.render ${triple(() => paintWhole(snap))}ms  `
		+ `单量 md ${triple(() => paintMarkdownOnly(texts, 1))}ms  `
		+ `"x" 正文 ${plain.map((value) => value.toFixed(2)).join("/")}ms`,
	);
}
void work;
