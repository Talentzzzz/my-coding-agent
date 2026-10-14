/**
 * A Markdown subset renderer, built as DOM nodes.
 *
 * It renders from a block list rather than an HTML string, so model output can never inject markup.
 * The block list is also what makes streaming cheap: a growing message is re-parsed as text arrives,
 * but only the blocks that changed are touched — complete blocks are appended once and never
 * revisited, and the one block still being written is the only one replaced. Without that split, a
 * long answer would rebuild its whole subtree on every token.
 *
 * The subset is deliberately small: headings, paragraphs, fenced code, blockquotes, ordered,
 * unordered and task lists, tables, horizontal rules, and inline code, emphasis, strikethrough and
 * links. Anything outside it stays literal text rather than being guessed at.
 */

export type Block =
	| { kind: "heading"; level: number; text: string }
	| { kind: "paragraph"; lines: string[] }
	| { kind: "code"; language: string; code: string }
	| { kind: "quote"; lines: string[] }
	| { kind: "list"; ordered: boolean; start: number; items: string[] }
	| { kind: "table"; header: string[]; rows: string[][]; align: Align[] }
	| { kind: "rule" };

type Align = "left" | "center" | "right" | undefined;

function isBlank(line: string): boolean {
	return line.trim().length === 0;
}

function isRule(line: string): boolean {
	return /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line);
}

function headingLevel(line: string): number | undefined {
	const match = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
	return match ? match[1]!.length : undefined;
}

function fenceInfo(line: string): { marker: string; language: string } | undefined {
	const match = /^\s{0,3}(`{3,}|~{3,})\s*([^`]*)$/.exec(line);
	if (!match) return undefined;
	return { marker: match[1]!, language: match[2]!.trim() };
}

function isQuote(line: string): boolean {
	return /^\s{0,3}>/.test(line);
}

function listItem(line: string): { ordered: boolean; start: number; text: string } | undefined {
	const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line);
	if (bullet) return { ordered: false, start: 1, text: bullet[3]! };
	const numbered = /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line);
	if (numbered) return { ordered: true, start: Number(numbered[2]), text: numbered[3]! };
	return undefined;
}

function splitRow(line: string): string[] {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	const cells: string[] = [];
	let current = "";
	let escaped = false;
	for (const character of trimmed) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "|") {
			cells.push(current);
			current = "";
			continue;
		}
		current += character;
	}
	cells.push(current);
	return cells;
}

/** A table's delimiter row: `| --- | :-: |`, which is what tells a table from a paragraph. */
function tableAlign(line: string): Align[] | undefined {
	const cells = splitRow(line);
	if (cells.length === 0) return undefined;
	const align: Align[] = [];
	for (const cell of cells) {
		const trimmed = cell.trim();
		if (!/^:?-{1,}:?$/.test(trimmed)) return undefined;
		const left = trimmed.startsWith(":");
		const right = trimmed.endsWith(":");
		align.push(left && right ? "center" : right ? "right" : left ? "left" : undefined);
	}
	return align;
}

/**
 * Split Markdown into blocks, from `start` onward, and say where the last block began.
 *
 * An unterminated block — a fence with no closing marker, a table with no delimiter row, a list still
 * being written — becomes the block it looks like so far. A streaming message needs that: the tail
 * is rendered as it stands, then replaced when the next chunk decides what it really is.
 *
 * Every iteration pushes exactly one block, and lines are consumed in order, so the line index of the
 * final block is also the point past which nothing earlier can change. `lastStart` reports it: the
 * incremental caller keeps everything before it and re-parses only from there.
 */
function parseFrom(lines: string[], start: number): { blocks: Block[]; lastStart: number } {
	const blocks: Block[] = [];
	let index = start;
	let lastStart = start;

	while (index < lines.length) {
		const line = lines[index]!;

		if (isBlank(line)) {
			index += 1;
			continue;
		}

		// This line begins the block the iteration will push, so it is the newest safe cut.
		lastStart = index;

		const fence = fenceInfo(line);
		if (fence) {
			const char = fence.marker[0] === "`" ? "`" : "~";
			const closer = new RegExp(`^\\s{0,3}${char}{${fence.marker.length},}\\s*$`);
			const body: string[] = [];
			index += 1;
			let closed = false;
			while (index < lines.length) {
				const candidate = lines[index]!;
				if (closer.test(candidate)) {
					closed = true;
					index += 1;
					break;
				}
				body.push(candidate);
				index += 1;
			}
			blocks.push({ kind: "code", language: fence.language, code: body.join("\n") });
			continue;
		}

		const heading = headingLevel(line);
		if (heading !== undefined) {
			blocks.push({ kind: "heading", level: heading, text: line.replace(/^\s{0,3}#{1,6}\s+/, "").trim() });
			index += 1;
			continue;
		}

		if (isRule(line)) {
			blocks.push({ kind: "rule" });
			index += 1;
			continue;
		}

		if (isQuote(line)) {
			const quoted: string[] = [];
			while (index < lines.length && !isBlank(lines[index]!)) {
				quoted.push(lines[index]!.replace(/^\s{0,3}>\s?/, ""));
				index += 1;
			}
			blocks.push({ kind: "quote", lines: quoted });
			continue;
		}

		const item = listItem(line);
		if (item !== undefined) {
			const { ordered, start: first } = item;
			const items: string[] = [];
			while (index < lines.length) {
				const current = lines[index]!;
				const next = listItem(current);
				if (next !== undefined && next.ordered === ordered) {
					items.push(next.text);
					index += 1;
					continue;
				}
				// An indented line continues the item above it.
				if (!isBlank(current) && /^\s{2,}/.test(current) && items.length > 0) {
					items[items.length - 1] += `\n${current.trim()}`;
					index += 1;
					continue;
				}
				break;
			}
			blocks.push({ kind: "list", ordered, start: first, items });
			continue;
		}

		// A table is a row followed by a delimiter row; anything else here is a paragraph.
		if (line.includes("|") && index + 1 < lines.length) {
			const align = tableAlign(lines[index + 1]!);
			if (align) {
				const header = splitRow(line).map((cell) => cell.trim());
				const rows: string[][] = [];
				index += 2;
				while (index < lines.length && lines[index]!.includes("|") && !isBlank(lines[index]!)) {
					rows.push(splitRow(lines[index]!).map((cell) => cell.trim()));
					index += 1;
				}
				blocks.push({ kind: "table", header, rows, align });
				continue;
			}
		}

		const paragraph: string[] = [];
		while (index < lines.length) {
			const current = lines[index]!;
			if (isBlank(current) || headingLevel(current) !== undefined || isRule(current)) break;
			if (fenceInfo(current) || isQuote(current) || listItem(current) !== undefined) break;
			paragraph.push(current);
			index += 1;
		}
		if (paragraph.length === 0) {
			// Unreachable in practice, but a parser that cannot advance would hang the renderer.
			paragraph.push(line);
			index += 1;
		}
		blocks.push({ kind: "paragraph", lines: paragraph });
	}

	return { blocks, lastStart };
}

/** Split Markdown into blocks. */
export function parseBlocks(text: string): Block[] {
	return parseFrom(text.split("\n"), 0).blocks;
}

/**
 * What {@link renderMarkdown} carries between calls.
 *
 * A streaming message is re-rendered many times a second, and re-parsing the whole answer each time
 * costs O(answer²) over the answer. This keeps the parse: every block before the last one is settled
 * — appending text cannot change it — so the next call keeps those and re-parses only the tail. The
 * tail is cut by character offset rather than by re-splitting the whole text, so a frame's cost is
 * proportional to the block still being written and not to the answer so far. The caller holds one
 * of these per message and threads it back in; it means nothing on its own.
 */
export interface MarkdownState {
	/** The text this state was parsed from. */
	text: string;
	/** Every block parsed from that text, in order. */
	blocks: Block[];
	/**
	 * The character offset at which the last block began — the only block that can still change.
	 *
	 * An offset rather than a line index, because the next call must not touch the whole text to
	 * find the tail: slicing here and splitting the slice costs O(tail), where a line index would
	 * force a full `split` just to be usable.
	 */
	tailOffset: number;
}

/**
 * Render `text` into `container`, touching only what changed.
 *
 * `state` is the previous call's {@link MarkdownState}, and the returned value is the one to pass
 * back next time. When the text only grew, the settled blocks are kept and just the tail is parsed;
 * everything else is a full parse. Either way the tail block is re-rendered every call, because it is
 * the block still being written.
 */
export function renderMarkdown(container: HTMLElement, text: string, state?: MarkdownState): MarkdownState {
	const previous = state?.blocks ?? [];
	let blocks: Block[];
	let tailOffset: number;

	if (state !== undefined && text.length >= state.text.length && text.startsWith(state.text)) {
		// The text only grew: keep everything before the old tail and re-parse from where it started.
		// The slice shares its first `state.tailOffset` characters with the old text, so the tail's
		// own first line is the block that was still open — and nothing earlier is touched at all.
		const kept = Math.max(0, state.blocks.length - 1);
		const tailLines = text.slice(state.tailOffset).split("\n");
		const tail = parseFrom(tailLines, 0);
		// The tail's blocks may be fewer, equal, or more than the one they replace — a paragraph the
		// new text just split with a blank line becomes two — and the DOM patch below handles all
		// three by re-adding from `kept`.
		blocks = [...state.blocks.slice(0, kept), ...tail.blocks];
		tailOffset = state.tailOffset + offsetOfLine(tailLines, tail.lastStart);
	} else {
		const lines = text.split("\n");
		const parsed = parseFrom(lines, 0);
		blocks = parsed.blocks;
		tailOffset = offsetOfLine(lines, parsed.lastStart);
	}

	if (blocks.length < previous.length) {
		// Fewer blocks than are on screen means this is a replacement, not a continuation, so the
		// container is rebuilt rather than patched against blocks that no longer exist.
		container.replaceChildren();
		appendBlocks(container, blocks, 0);
	} else {
		// Drop the tail before re-adding it: it is the block still being written, and the one just
		// parsed may differ from what is on screen.
		if (previous.length > 0) container.lastElementChild?.remove();
		appendBlocks(container, blocks, Math.max(0, previous.length - 1));
	}

	return { text, blocks, tailOffset };
}

/** The character offset at which line `index` begins, within the text `lines` was split from. */
function offsetOfLine(lines: readonly string[], index: number): number {
	if (index <= 0) return 0;
	let offset = 0;
	for (let at = 0; at < index; at += 1) offset += lines[at]!.length + 1;
	return offset;
}

function appendBlocks(container: HTMLElement, blocks: readonly Block[], from: number): void {
	for (let index = from; index < blocks.length; index += 1) container.append(renderBlock(blocks[index]!));
}

function renderBlock(block: Block): HTMLElement {
	switch (block.kind) {
		case "heading": {
			const element = document.createElement(`h${Math.min(6, Math.max(1, block.level))}`);
			appendInline(element, block.text);
			return element;
		}
		case "paragraph": {
			const paragraph = document.createElement("p");
			appendInline(paragraph, block.lines.join("\n"));
			return paragraph;
		}
		case "rule":
			return document.createElement("hr");
		case "code":
			return renderCode(block.language, block.code);
		case "quote": {
			const quote = document.createElement("blockquote");
			for (const child of parseBlocks(block.lines.join("\n"))) quote.append(renderBlock(child));
			return quote;
		}
		case "list": {
			const list = block.ordered ? document.createElement("ol") : document.createElement("ul");
			if (block.ordered && block.start !== 1) (list as HTMLOListElement).start = block.start;
			for (const item of block.items) {
				const entry = document.createElement("li");
				// A task item keeps its box as text: turning `[ ]` into a control would invite a click
				// that changes nothing about the run.
				appendInline(entry, item);
				list.append(entry);
			}
			return list;
		}
		case "table": {
			const table = document.createElement("table");
			const head = document.createElement("thead");
			const headRow = document.createElement("tr");
			block.header.forEach((cell, cellIndex) => {
				const th = document.createElement("th");
				const align = block.align[cellIndex];
				if (align) th.style.textAlign = align;
				appendInline(th, cell);
				headRow.append(th);
			});
			head.append(headRow);
			table.append(head);

			const body = document.createElement("tbody");
			for (const row of block.rows) {
				const tr = document.createElement("tr");
				block.header.forEach((_, cellIndex) => {
					const td = document.createElement("td");
					const align = block.align[cellIndex];
					if (align) td.style.textAlign = align;
					appendInline(td, row[cellIndex] ?? "");
					tr.append(td);
				});
				body.append(tr);
			}
			table.append(body);
			return table;
		}
	}
}

/** A fenced block: a head row naming the language with a copy button, then the code itself. */
function renderCode(language: string, code: string): HTMLElement {
	const wrapper = document.createElement("div");
	wrapper.className = "code-block";

	const head = document.createElement("div");
	head.className = "code-head";
	const label = document.createElement("span");
	label.textContent = language.length > 0 ? language : "文本";

	const copy = document.createElement("button");
	copy.type = "button";
	copy.className = "code-copy";
	copy.textContent = "复制";
	copy.addEventListener("click", () => {
		void navigator.clipboard.writeText(code).then(
			() => {
				copy.textContent = "已复制";
				window.setTimeout(() => {
					copy.textContent = "复制";
				}, 1200);
			},
			() => {
				copy.textContent = "复制失败";
			},
		);
	});

	head.append(label, copy);

	const pre = document.createElement("pre");
	const element = document.createElement("code");
	if (language.length > 0) element.dataset.language = language;
	appendDiffLines(element, code);

	wrapper.append(head, pre);
	pre.append(element);
	return wrapper;
}

/**
 * Mark unified-diff lines.
 *
 * A tool result pastes a patch verbatim, and the one thing a reader needs from it is which lines were
 * added and which were removed. Syntax highlighting is not attempted: a wrong guess colors correct
 * code misleadingly.
 */
function appendDiffLines(target: HTMLElement, code: string): void {
	const lines = code.split("\n");
	const isDiff = lines.some((line) => line.startsWith("@@")) || lines.some((line) => /^\+{3} |^-{3} /.test(line));
	if (!isDiff) {
		target.textContent = code;
		return;
	}

	lines.forEach((line, index) => {
		const span = document.createElement("span");
		if (line.startsWith("+") && !line.startsWith("+++")) span.className = "diff-add";
		else if (line.startsWith("-") && !line.startsWith("---")) span.className = "diff-del";
		span.textContent = index === lines.length - 1 ? line : `${line}\n`;
		target.append(span);
	});
}

/** Inline spans within a block: code, strong, emphasis, strikethrough, and links. */
function appendInline(parent: HTMLElement, text: string): void {
	const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~]+~~)|(\[[^\]\n]*\]\([^)\s]+\))/g;
	let last = 0;
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(text)) !== null) {
		if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)));
		parent.append(renderInline(match[0]));
		last = match.index + match[0].length;
	}
	if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

function renderInline(source: string): Node {
	if (source.startsWith("`")) {
		const code = document.createElement("code");
		code.textContent = source.slice(1, -1);
		return code;
	}
	if (source.startsWith("**") || source.startsWith("__")) {
		const strong = document.createElement("strong");
		appendInline(strong, source.slice(2, -2));
		return strong;
	}
	if (source.startsWith("~~")) {
		const strike = document.createElement("del");
		strike.textContent = source.slice(2, -2);
		return strike;
	}
	if (source.startsWith("[")) {
		const split = source.indexOf("](");
		const link = document.createElement("a");
		link.textContent = source.slice(1, split);
		link.href = source.slice(split + 2, -1);
		link.target = "_blank";
		link.rel = "noreferrer noopener";
		return link;
	}
	const emphasis = document.createElement("em");
	appendInline(emphasis, source.slice(1, -1));
	return emphasis;
}
