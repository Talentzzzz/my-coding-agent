/**
 * markdown-attribution-probe —— 核对 `jank-harness` 里"其中md"那一列的归因。
 *
 * 量具的两条路：`transcript.render` 走的是 JIT 编译过的快路，而"把同一批文本重画一遍"是另一条路，
 * 同样的 `renderMarkdown` 在两条路上未必同价。这个探针把三者并排：
 *
 * - `transcript.render`：一次真实的整棵绘制（建 turn 骨架、建 Markdown DOM、挂进容器）；
 * - 单量 md：对同一批文本逐条 `renderMarkdown`，与量具的"其中md"同法；
 * - "x" 正文对照：正文全是单字时 `transcript.render` 的残值，也就是"不画 Markdown 还剩多少"。
 *
 * 判据：**单量 md − "x" 残值 ≈ transcript.render − "x" 残值**，两边都指向同一笔 Markdown 账，那条归因
 * 才站得住。跑法：`node .scratch/window-rework/research/markdown-attribution-probe.ts`
 *
 * 它 import 量具本身：造数据的助手（`snapshotWith` / `textOfMessage` / `messageBody`）在那里，**不在
 * 这里再抄一份**——这一票的病根就是"同一件事被抄了两遍然后漂移"。import 的副作用是量具会先跑一遍并
 * 打印它自己的表，探针的结果跟在后面，正好当上下文读。
 */
import { installDom, asElement, resetWork } from "../../../scripts/dom-shim.ts";
import { TranscriptView } from "../../../packages/web/src/render/transcript.ts";
import * as markdown from "../../../packages/web/src/render/markdown.ts";
import { initialState, reduce } from "../../../packages/web/src/state.ts";
import { messageBody, snapshotWith, textOfMessage } from "./jank-harness.ts";
import type { ServerMessage, SessionSnapshot } from "../../../packages/core/protocol.ts";

// 量具在 import 时就装好了 DOM；这一行是为了"单独 import 这个文件"时也成立。
installDom();

const hrtime = (): bigint => process.hrtime.bigint();
const msBetween = (a: bigint, b: bigint): number => Number(b - a) / 1e6;

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

/** 对同一批文本逐条 renderMarkdown，量具的"其中md"用的就是这个法子。 */
function paintMarkdownOnly(texts: string[]): number {
	const container = asElement(document.createElement("div"));
	let total = 0;
	for (const text of texts) {
		const a = hrtime();
		markdown.renderMarkdown(container, text);
		total += msBetween(a, hrtime());
	}
	return total;
}

const triple = (run: () => number): string => [run(), run(), run()].map((value) => value.toFixed(2)).join("/");

const cases: [number, number][] = [
	[50, 400],
	[500, 400],
	[500, 4000],
];

process.stdout.write("\n=== markdown-attribution-probe：把\"其中md\"那一列单独量一遍 ===\n");
for (const [count, chars] of cases) {
	const snap = snapshotWith(count, chars, { id: "probe", stamp: 5_000_000, cwd: "/probe" });
	const texts = snap.messages.map(textOfMessage);
	// 热身：两条路都跑几遍，JIT 编译的价不该算进任何一边。
	const plainSnapshot = snapshotWith(count, 1, { id: "probe-plain", stamp: 7_000_000, cwd: "/probe" });
	for (let round = 0; round < 5; round += 1) {
		paintWhole(snap);
		paintMarkdownOnly(texts);
		paintWhole(plainSnapshot);
	}
	process.stdout.write(
		`count=${count} chars=${chars}（${texts.length} 条，共 ${texts.reduce((total, text) => total + text.length, 0)} 字，正文样例「${messageBody(0, Math.min(chars, 24))}」）\n`
		+ `  transcript.render  ${triple(() => paintWhole(snap))}ms   ← 整棵绘制\n`
		+ `  单量 renderMarkdown ${triple(() => paintMarkdownOnly(texts))}ms   ← 与量具的"其中md"同法\n`
		+ `  "x" 正文对照        ${triple(() => paintWhole(plainSnapshot))}ms   ← 不画 Markdown 的残值\n`,
	);
}
