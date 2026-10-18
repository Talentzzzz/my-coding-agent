// 票 05 的量具：同一段长回答、同样的逐帧节拍（真 rAF），量「markdown 尾块」两条 DOM 路径的每帧
// 成本。跑在真 Chromium 里（有布局、有合成，这是 DOM shim 给不了的），由 measure-render.mjs 通过
// CDP 驱动；页面自己记每帧的脚本时长与帧间隔，CDP 那侧读 Performance.getMetrics 的差值。
//
// 两条路径：
//   patch  —— 生产代码：renderMarkdown 带着上一帧的 MarkdownState，尾块就地补（appendData）。
//   legacy —— 上一轮的 DOM 行为：解析仍是增量的，但尾块每帧 remove 再重建。复现办法是每帧把
//             state 尾块的字首篡改掉，让 patchInlineBlock 的 startsWith 判定失败、走 remove+re-add
//             的旧分支——DOM 层面的每帧动作与旧行为一致，末态也一致（见票 05 的 Answer）。
//
// 两种文本形状：
//   solid  —— 一整段长段落：尾块就是全文，旧行为每帧重建整段。
//   spaced —— 每 250 字一个空行：尾块只有最后一小段，旧行为的每帧成本与之成正比。
import { renderMarkdown, type MarkdownState } from "../../../../packages/web/src/render/markdown.ts";

const ANSWER_CHARS = 16_000;
const CHUNK_CHARS = 32;
const SPACED_EVERY = 250;
const WARMUP_FRAMES = 60;

const stream = document.getElementById("stream") as HTMLElement;

type Strategy = "patch" | "legacy";
type Shape = "solid" | "spaced";

interface Stats {
	strategy: Strategy;
	shape: Shape;
	frames: number;
	answerChars: number;
	workTotalMs: number;
	workP95Ms: number;
	intervalP95Ms: number;
	nodes: number;
}

/** 造回答文本：`spacedEvery` 为 0 就是一整段，否则每隔这么多个字落一个空行。 */
function makeAnswer(spacedEvery: number): string {
	const sentence = "这是一段用来测量流式渲染成本的回答，它足够长，长到尾块重建和就地补写之间的差别值得认真量一次。";
	let text = "";
	while (text.length < ANSWER_CHARS) {
		text += sentence;
		if (spacedEvery > 0) {
			const within = text.length % spacedEvery;
			if (within < sentence.length) text += "\n\n";
		}
	}
	return text.slice(0, ANSWER_CHARS);
}

/**
 * 把 state 尾块的字首篡改掉，让生产补写路径的 `startsWith` 判定失败。
 *
 * 只改这一份拷贝，返回值是 renderMarkdown 现算的，所以篡改不会留在下一帧的 state 里；DOM 的末态
 * 因此与 patch 路径一致，差别只在「这一帧的尾块元素是新的还是旧的」。
 */
function falsified(state: MarkdownState): MarkdownState {
	const blocks = state.blocks.slice();
	const tail = blocks[blocks.length - 1];
	if (tail !== undefined && tail.kind === "paragraph") {
		blocks[blocks.length - 1] = {
			kind: "paragraph",
			lines: [`\u200b${tail.lines[0] ?? ""}`, ...tail.lines.slice(1)],
		};
	}
	return { text: state.text, blocks, tailOffset: state.tailOffset };
}

function percentile(values: readonly number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))]!;
}

async function run(strategy: Strategy, shape: Shape, frameCap = Number.POSITIVE_INFINITY): Promise<Stats> {
	const answer = makeAnswer(shape === "solid" ? 0 : SPACED_EVERY);
	const chunks = Math.ceil(answer.length / CHUNK_CHARS);
	const frames = Math.min(chunks, frameCap);

	stream.replaceChildren();
	let state: MarkdownState | undefined;
	const work: number[] = [];
	const intervals: number[] = [];
	let last = performance.now();

	await new Promise<void>((done) => {
		const step = () => {
			const now = performance.now();
			intervals.push(now - last);
			last = now;

			const index = work.length;
			const text = answer.slice(0, Math.min(answer.length, (index + 1) * CHUNK_CHARS));
			const start = performance.now();
			if (strategy === "patch" || state === undefined) state = renderMarkdown(stream, text, state);
			else state = renderMarkdown(stream, text, falsified(state));
			work.push(performance.now() - start);
			// 生产里贴底就是这一笔写：clamp 的 scrollTop，不读布局。
			stream.scrollTop = Number.MAX_SAFE_INTEGER;

			if (work.length >= frames) done();
			else requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	});

	return {
		strategy,
		shape,
		frames: work.length,
		answerChars: Math.min(answer.length, work.length * CHUNK_CHARS),
		workTotalMs: work.reduce((total, value) => total + value, 0),
		workP95Ms: percentile(work, 0.95),
		intervalP95Ms: percentile(intervals, 0.95),
		nodes: stream.querySelectorAll("*").length,
	};
}

window.__run = run;
window.__ready = true;

declare global {
	interface Window {
		__ready?: boolean;
		__run?: (strategy: Strategy, shape: Shape, frameCap?: number) => Promise<Stats>;
	}
}
