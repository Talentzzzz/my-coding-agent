import type { DiffLine, FileDiff } from "@my-agent/case/protocol";
import { element } from "../dom.ts";

/**
 * 工具改过的文件，作为其卡片的正文。
 *
 * 报告来自做出变更的工具，已经精简到值得显示的行：哪些行新增、哪些删除、内容是什么、在各文件
 * 中的位置。所以这里没有任何东西决定*什么*变了 —— 那会是对模型同样看到的这份 diff 的第二种
 * 意见 —— 这里的一切都是关于如何阅读它：每个文件一列行号、每行独占的行、以及重写行中实际不同
 * 部分的标记。
 *
 * 卡片的摘要行是指名文件的地方，所以正文不再重复它。
 */
export function renderFileDiff(diff: FileDiff): HTMLElement {
	const body = element("div", "diff");
	// 每列行号同宽，从显示的最宽行号量出：行号沟槽中途变宽的 diff，读起来像两张表而不是一个
	// 文件。
	body.style.setProperty("--diff-number-width", `${numberWidth(diff)}ch`);

	for (const line of diff.lines) body.append(renderLine(line));
	if (diff.omitted > 0) {
		body.append(element("div", "diff-row omitted", `另有 ${diff.omitted} 行未显示`));
	}
	return body;
}

/** 一行的变化量：`+12` 新增、`-3` 删除，供卡片的摘要行。 */
export function diffStat(diff: FileDiff): HTMLElement {
	const stat = element("span", "diff-stat");
	if (diff.created) stat.append(element("span", "diff-count created", "新文件"));
	if (diff.added > 0) stat.append(element("span", "diff-count add", `+${diff.added}`));
	if (diff.removed > 0) stat.append(element("span", "diff-count del", `-${diff.removed}`));
	return stat;
}

/** 一行：它曾有的行号、它现在的行号、符号和文本。 */
function renderLine(line: DiffLine): HTMLElement {
	if (line.kind === "skip") {
		const count = line.skipped ?? 0;
		return element("div", "diff-row skip", `⋯ ${count} 行未改动`);
	}

	const row = element("div", `diff-row ${line.kind}`);
	row.append(
		element("span", "diff-num", line.oldLine === null ? "" : String(line.oldLine)),
		element("span", "diff-num", line.newLine === null ? "" : String(line.newLine)),
		element("span", "diff-sign", line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "),
		text(line),
	);
	return row;
}

/**
 * 一行的文本，标记出实际变化的部分。
 *
 * 标记范围来自工具，它逐字符比较了两行；由客户端去猜差异，展示的就是意见而不是变更。
 */
function text(line: DiffLine): HTMLElement {
	const cell = element("span", "diff-text");
	const range = line.changed;
	if (!range || range[0] >= range[1] || range[1] > line.text.length) {
		cell.textContent = line.text;
		return cell;
	}
	cell.append(
		document.createTextNode(line.text.slice(0, range[0])),
		element("mark", "diff-mark", line.text.slice(range[0], range[1])),
		document.createTextNode(line.text.slice(range[1])),
	);
	return cell;
}

/** 最宽行号需要的位数，且绝不少于三位。 */
function numberWidth(diff: FileDiff): number {
	let widest = 0;
	for (const line of diff.lines) widest = Math.max(widest, line.oldLine ?? 0, line.newLine ?? 0);
	return Math.max(3, String(widest).length);
}
