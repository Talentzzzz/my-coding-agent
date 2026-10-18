// 票 01 的量具：同一段文本、同样的 24 字节一帧，量 `renderMarkdown` 的**每帧 DOM 工作量**与脚本时长。
//
// 用 `scripts/dom-shim.ts`：它没有布局，所以绝对毫秒不是浏览器里的帧时间；可靠的信号是
// 「同一把尺子下，短 vs 长」「改前 vs 改后」的比值，以及 `work.nodes`（这一帧造了几个节点）——
// 造节点正是浏览器随后要排版的东西。
//
//   node .scratch/branch-line-and-smoothness/research/measure-inline.ts
//
// 两种文本：
//   prose  —— 纯中文散文（没有行内标记）
//   marked —— 同一段话，但每一句都带 `反引号`、**粗体**、链接：思考块与技术回答的真实密度
import { installDom, resetWork, work } from "../../../scripts/dom-shim.ts";
import { renderMarkdown, type MarkdownState } from "../../../packages/web/src/render/markdown.ts";

installDom();

const TOTAL = 16_000;
const CHUNK = 24;

const PROSE = "这是一段用来测量流式渲染成本的思考，它足够长，长到每一帧重建整段和就地补写之间的差别值得认真量一次。";
const MARKED =
	"先看 `Workspace.resolve()` 这条路，**每一次工具路径**都要经过它，见 [architecture](docs/architecture.md)；" +
	"再看 `SessionManager.getBranch()` 与 `~~旧的~~` `getBranchPoints()` 的差别。";

function makeText(source: string): string {
	let text = "";
	while (text.length < TOTAL) text += source;
	return text.slice(0, TOTAL);
}

interface Result {
	name: string;
	frames: number;
	totalMs: number;
	p50Ms: number;
	p95Ms: number;
	maxMs: number;
	nodes: number;
	appends: number;
}

function run(name: string, text: string): Result {
	// One giant paragraph per shape: the tail block is the whole text, which is the cost being priced.
	const host = document.createElement("div");
	let state: MarkdownState | undefined;
	const frames: number[] = [];
	resetWork();
	for (let end = CHUNK; end <= text.length; end += CHUNK) {
		const frame = text.slice(0, end);
		const started = performance.now();
		state = renderMarkdown(host, frame, state);
		frames.push(performance.now() - started);
	}
	frames.sort((a, b) => a - b);
	const at = (quantile: number) => frames[Math.min(frames.length - 1, Math.floor(frames.length * quantile))]!;
	return {
		name,
		frames: frames.length,
		totalMs: frames.reduce((total, value) => total + value, 0),
		p50Ms: at(0.5),
		p95Ms: at(0.95),
		maxMs: frames[frames.length - 1]!,
		nodes: work.nodes,
		appends: work.appends,
	};
}

const results = [run("prose", makeText(PROSE)), run("marked", makeText(MARKED))];
for (const result of results) {
	console.log(
		`${result.name.padEnd(7)} frames=${result.frames} total=${result.totalMs.toFixed(1)}ms ` +
			`p50=${result.p50Ms.toFixed(3)}ms p95=${result.p95Ms.toFixed(3)}ms max=${result.maxMs.toFixed(3)}ms ` +
			`nodes=${result.nodes} appends=${result.appends}`,
	);
}
