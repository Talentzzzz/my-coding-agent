// 票 01 的正确性闸门：把一段文本按小片喂给 `renderMarkdown`（增量路径），每一步都和「从零重建
// 一次」的 DOM 结构逐节点比对 —— 增量补写只许更快，不许更不一样。
//
//   node .scratch/branch-line-and-smoothness/research/verify-inline.ts
import { installDom } from "../../../scripts/dom-shim.ts";
import { renderMarkdown } from "../../../packages/web/src/render/markdown.ts";

installDom();

const SAMPLES = [
	"这是一段纯散文，没有任何行内标记，它应当总是走 appendData。",
	"`Workspace.resolve()` 是每一个工具路径都要过的关口，**每一次**都算，见 [架构](docs/architecture.md)。",
	"先说 `a`，再说 `b`，然后 `c` 与 `d` 交替出现；`e` `f` `g`。",
	"开头是 `未闭合的反引号，慢慢写，写很久，然后终于闭合`。",
	"**粗体从很久以前就开始",
	"一段 *斜体* 与 ~~删除~~ 混排，再加 `code` 与 [链接](https://example.com)。",
	"| 列一 | 列二 |\n| --- | --- |\n| a | b |",
	// 列表的增长另有一条**改前就有**的不一致（`ul` 套 `ul`，HEAD 上同样复现，见票据 01），这里不混进来。
	"```ts\nconst a = 1;\nconst b = 2;\n```",
	"> 引用里的 `code` 和 **粗体**。",
	"# 标题 `code`\n正文先是一行 `x`，然后续写。",
];

/** A structural signature: tag, then the children, depth first — what a reader could see. */
function signature(node: Node): string {
	if (node.nodeType === 3) return `#${node.textContent ?? ""}`;
	const element = node as HTMLElement & { children: ArrayLike<Node> };
	return `<${element.tagName.toLowerCase()}>${[...element.children].map(signature).join("|")}`;
}

let failures = 0;
for (const sample of SAMPLES) {
	const incremental = document.createElement("div");
	const fresh = document.createElement("div");
	let state;
	for (let end = 1; end <= sample.length; end += 1) {
		state = renderMarkdown(incremental, sample.slice(0, end), state);
		renderMarkdown(fresh, sample.slice(0, end));
		const got = signature(incremental);
		const want = signature(fresh);
		if (got !== want) {
			failures += 1;
			console.log(`FAIL at ${end}/${sample.length} for ${JSON.stringify(sample.slice(0, 40))}`);
			console.log(`  got  ${got}`);
			console.log(`  want ${want}`);
			break;
		}
	}
}
console.log(failures === 0 ? "ok — 每一次增量补写都与从零重建一致" : `${failures} 个样本不一致`);
process.exitCode = failures === 0 ? 0 : 1;
