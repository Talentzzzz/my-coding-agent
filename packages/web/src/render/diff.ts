import type { DiffLine, FileDiff } from "@my-agent/core/protocol";
import { element } from "../dom.ts";

/**
 * A file a tool changed, as the body of its card.
 *
 * The report arrives from the tool that made the change, already reduced to the lines worth showing:
 * which lines were added, which removed, what they were, and where in each file they sit. So nothing
 * here decides *what* changed — that would be a second opinion about a diff the model is also shown
 * — and everything here is about reading it: a number column per file, the one row each line earns,
 * and the mark on the part of a rewritten line that actually differs.
 *
 * The card's summary line is where the file is named, so the body does not name it again.
 */
export function renderFileDiff(diff: FileDiff): HTMLElement {
	const body = element("div", "diff");
	// One width for every number column, measured from the widest number on show: a diff whose gutter
	// grew halfway down would read as two tables rather than as one file.
	body.style.setProperty("--diff-number-width", `${numberWidth(diff)}ch`);

	for (const line of diff.lines) body.append(renderLine(line));
	if (diff.omitted > 0) {
		body.append(element("div", "diff-row omitted", `另有 ${diff.omitted} 行未显示`));
	}
	return body;
}

/** The change in one line: `+12` added, `-3` removed, for the card's summary line. */
export function diffStat(diff: FileDiff): HTMLElement {
	const stat = element("span", "diff-stat");
	if (diff.created) stat.append(element("span", "diff-count created", "新文件"));
	if (diff.added > 0) stat.append(element("span", "diff-count add", `+${diff.added}`));
	if (diff.removed > 0) stat.append(element("span", "diff-count del", `-${diff.removed}`));
	return stat;
}

/** One row: the number the line had, the number it has now, the sign, and the text. */
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
 * A line's text, with the part that actually changed marked.
 *
 * The span comes from the tool, which compared the two lines character by character; a client that
 * guessed at the difference would be showing an opinion rather than the change.
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

/** How many digits the widest line number needs, and never fewer than three. */
function numberWidth(diff: FileDiff): number {
	let widest = 0;
	for (const line of diff.lines) widest = Math.max(widest, line.oldLine ?? 0, line.newLine ?? 0);
	return Math.max(3, String(widest).length);
}
