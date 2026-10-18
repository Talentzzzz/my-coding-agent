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

/** One member of {@link Block}, named by its kind — what a `switch (block.kind)` case narrows to. */
type BlockOf<Kind extends Block["kind"]> = Extract<Block, { kind: Kind }>;

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
 * everything else is a full parse.
 *
 * The tail is the block still being written, and while it keeps its kind it is patched in place
 * rather than replaced: a long answer is often one paragraph, and replacing it every token makes the
 * browser rebuild the whole subtree, lay the column out again, and drop any selection inside it. See
 * {@link patchBlock} for what "in place" means per kind; a tail that changed kind, or text that was
 * replaced rather than continued, is re-made the old way.
 */
export function renderMarkdown(container: HTMLElement, text: string, state?: MarkdownState): MarkdownState {
	const previous = state?.blocks ?? [];
	// Growth is the one shape a streaming message has; a shorter or rewritten text is a replacement
	// (a `message_end` that disagrees with the deltas, a turn drawn from a new snapshot).
	const continued = state !== undefined && text.length >= state.text.length && text.startsWith(state.text);
	let blocks: Block[];
	let tailOffset: number;

	if (continued) {
		// The text only grew: keep everything before the old tail and re-parse from where it started.
		// The slice shares its first `state.tailOffset` characters with the old text, so the tail's
		// own first line is the block that was still open — and nothing earlier is touched at all.
		const kept = Math.max(0, state.blocks.length - 1);
		const tailLines = text.slice(state.tailOffset).split("\n");
		const tail = parseFrom(tailLines, 0);
		// The tail's blocks may be fewer, equal, or more than the one they replace — a paragraph the
		// new text just split with a blank line becomes two — and the DOM patch below handles all
		// three.
		blocks = [...state.blocks.slice(0, kept), ...tail.blocks];
		tailOffset = state.tailOffset + offsetOfLine(tailLines, tail.lastStart);
	} else {
		const lines = text.split("\n");
		const parsed = parseFrom(lines, 0);
		blocks = parsed.blocks;
		tailOffset = offsetOfLine(lines, parsed.lastStart);
	}

	// The only case worth patching is "same number of blocks, tail kept its kind": every block before
	// the tail is settled, so the screen differs only in its last element, and the element itself can
	// keep its identity. Anything else is a shape change, and the old path re-adds from the cut.
	const kept = previous.length - 1;
	if (continued && blocks.length === previous.length && kept >= 0) {
		const tail = container.lastElementChild as HTMLElement | null;
		if (tail !== null && patchBlock(tail, previous[kept]!, blocks[kept]!)) {
			return { text, blocks, tailOffset };
		}
	}

	if (!continued || blocks.length < previous.length) {
		// A replacement, or a tail that lost blocks: the container is rebuilt rather than patched
		// against blocks that no longer exist.
		container.replaceChildren();
		appendBlocks(container, blocks, 0);
	} else {
		// Drop the tail before re-adding it: it is the block still being written, and the one just
		// parsed is a different kind (or a list that changed type), so it cannot be patched.
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

/**
 * Patch the block still being written, in place, and say whether it worked.
 *
 * The element is the one already on screen, so a successful patch leaves its identity, its place in
 * the column, and everything already laid out around it alone. `false` means the element cannot
 * describe `next` — a kind change, a replacement, or a structure a growth would rewrite — and the
 * caller re-makes it the old way.
 */
function patchBlock(element: HTMLElement, previous: Block, next: Block): boolean {
	if (previous.kind !== next.kind) return false;
	switch (next.kind) {
		case "paragraph": {
			const before = previous as BlockOf<"paragraph">;
			return patchInlineBlock(element, before.lines.join("\n"), next.lines.join("\n"));
		}
		case "heading": {
			const before = previous as BlockOf<"heading">;
			return before.level === next.level && patchInlineBlock(element, before.text, next.text);
		}
		case "code":
			return patchCodeBlock(element, previous as BlockOf<"code">, next);
		case "list":
			return patchListBlock(element, previous as BlockOf<"list">, next);
		case "quote": {
			// A quote is a container of blocks rather than one run of text, so its own children are
			// re-made; the `<blockquote>` itself stays, which is what keeps its margins and place.
			element.replaceChildren();
			for (const child of parseBlocks(next.lines.join("\n"))) element.append(renderBlock(child));
			return true;
		}
		case "table":
			// A table's rows and alignment are a grid, not a run: the element is cheaper to re-make
			// than to patch cell by cell, and a streamed table is rare enough not to earn the code.
			return false;
		case "rule":
			return true;
	}
}

/**
 * Patch a paragraph or heading whose text only grew.
 *
 * Plain prose renders as one text node, and growing it is one `appendData` — no node construction,
 * no re-parse of the inline forms, and the element keeps the box it already laid out. A block with
 * inline formatting is rebuilt child by child instead: a marker that closes (`**bold` becoming
 * `**bold**`) changes how the text splits, so appending to the last node would be wrong.
 */
function patchInlineBlock(element: HTMLElement, previous: string, next: string): boolean {
	if (!next.startsWith(previous)) return false;
	const only = element.firstChild === element.lastChild ? element.firstChild : null;
	// `3` is `Node.TEXT_NODE`; the literal is used because the smoke's DOM shim does not export Node.
	if (only != null && only.nodeType === 3) {
		const suffix = next.slice(previous.length);
		// A form can only open or close with one of the marker characters, so a suffix of ordinary
		// prose is safe to append without reading the paragraph behind it. A suffix that carries a
		// marker is checked against the whole text instead: `**bold` grows to `**bold**` by adding
		// the closing characters, and the paragraph has to be rebuilt as formatted text.
		if (!INLINE_MARKER.test(suffix) || !hasInlineMarkup(next)) {
			(only as Text).appendData(suffix);
			return true;
		}
	}
	element.replaceChildren();
	appendInline(element, next);
	return true;
}

/** Patch a fenced block that grew: the text node, or the diff's spans, extends rather than resets. */
function patchCodeBlock(
	element: HTMLElement,
	previous: Extract<Block, { kind: "code" }>,
	next: Extract<Block, { kind: "code" }>,
): boolean {
	if (!next.code.startsWith(previous.code) || previous.language !== next.language) return false;
	const code = (element.lastElementChild?.firstElementChild as HTMLElement | undefined) ?? null;
	if (code === null) return false;

	const wasDiff = isDiffCode(previous.code);
	const nowDiff = isDiffCode(next.code);
	if (wasDiff !== nowDiff) return false;

	if (!nowDiff) {
		const only = code.firstChild === code.lastChild ? code.firstChild : null;
		if (only != null && only.nodeType === 3) (only as Text).appendData(next.code.slice(previous.code.length));
		else code.textContent = next.code;
		return true;
	}

	// One span per line, so only the last old line and the lines that arrived are touched. The last
	// old line loses its final-line status the moment a new line follows it, hence the newline.
	const spans = [...code.children];
	if (spans.length === 0) return false;
	const oldLines = previous.code.split("\n");
	const newLines = next.code.split("\n");
	const last = spans[spans.length - 1]! as HTMLElement;
	if (newLines.length > oldLines.length) {
		last.textContent = `${newLines[oldLines.length - 1]!}\n`;
		for (let index = oldLines.length; index < newLines.length; index += 1) {
			appendDiffLine(code, newLines[index]!, index === newLines.length - 1);
		}
	} else {
		last.textContent = newLines[newLines.length - 1]!;
	}
	return true;
}

/** Patch a list item by item; items are the only thing a growing list adds or extends. */
function patchListBlock(
	element: HTMLElement,
	previous: Extract<Block, { kind: "list" }>,
	next: Extract<Block, { kind: "list" }>,
): boolean {
	// Ordered-ness and the starting number are fixed by the first item, which growth cannot move.
	if (previous.ordered !== next.ordered || previous.start !== next.start) return false;
	const items = [...element.children] as HTMLElement[];
	const shared = Math.min(previous.items.length, items.length);
	for (let index = 0; index < shared; index += 1) {
		const before = previous.items[index]!;
		const after = next.items[index];
		if (before === after || after === undefined) continue;
		if (!patchInlineBlock(items[index]!, before, after)) return false;
	}
	for (let index = items.length; index < next.items.length; index += 1) {
		const entry = document.createElement("li");
		appendInline(entry, next.items[index]!);
		element.append(entry);
	}
	for (let index = items.length - 1; index >= next.items.length; index -= 1) items[index]!.remove();
	return true;
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

	const pre = document.createElement("pre");
	const element = document.createElement("code");
	if (language.length > 0) element.dataset.language = language;
	appendDiffLines(element, code);

	// Read at click time: the block can still be streaming, and a later tail patch extends the
	// element in place rather than replacing it, so a captured string would go stale.
	copy.addEventListener("click", () => {
		void navigator.clipboard.writeText(element.textContent ?? "").then(
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
	wrapper.append(head, pre);
	pre.append(element);
	return wrapper;
}

/** Whether a code block renders as a patch — the test the line-by-line painter below applies. */
function isDiffCode(code: string): boolean {
	const lines = code.split("\n");
	return lines.some((line) => line.startsWith("@@")) || lines.some((line) => /^\+{3} |^-{3} /.test(line));
}

/** One line of a patch: a span carrying its add/remove fill, and a newline unless it is the last. */
function appendDiffLine(target: HTMLElement, line: string, last: boolean): void {
	const span = document.createElement("span");
	if (line.startsWith("+") && !line.startsWith("+++")) span.className = "diff-add";
	else if (line.startsWith("-") && !line.startsWith("---")) span.className = "diff-del";
	span.textContent = last ? line : `${line}\n`;
	target.append(span);
}

/**
 * Mark unified-diff lines.
 *
 * A tool result pastes a patch verbatim, and the one thing a reader needs from it is which lines were
 * added and which were removed. Syntax highlighting is not attempted: a wrong guess colors correct
 * code misleadingly.
 */
function appendDiffLines(target: HTMLElement, code: string): void {
	if (!isDiffCode(code)) {
		target.textContent = code;
		return;
	}

	const lines = code.split("\n");
	lines.forEach((line, index) => appendDiffLine(target, line, index === lines.length - 1));
}

/**
 * The inline forms this renderer knows: code, strong, emphasis, strikethrough, and links.
 *
 * One pattern with a `g` flag, walked by {@link appendInline} and asked by {@link hasInlineMarkup}.
 * The walk collects its matches before it builds any node, so the recursion into nested emphasis
 * cannot move this pattern's cursor.
 */
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~]+~~)|(\[[^\]\n]*\]\([^)\s]+\))/g;

/** Whether `text` carries a form {@link appendInline} would render as more than one text node. */
function hasInlineMarkup(text: string): boolean {
	INLINE.lastIndex = 0;
	return INLINE.test(text);
}

/**
 * Characters that can open or close an inline form.
 *
 * The tail patch reads this against the suffix that just arrived, not against the paragraph: prose
 * carries none of these, so a growing answer needs no scan of what it already said.
 */
const INLINE_MARKER = /[`*_~[\]]/;

/** Inline spans within a block: code, strong, emphasis, strikethrough, and links. */
function appendInline(parent: HTMLElement, text: string): void {
	const found: { at: number; source: string }[] = [];
	INLINE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = INLINE.exec(text)) !== null) found.push({ at: match.index, source: match[0] });

	let last = 0;
	for (const part of found) {
		if (part.at > last) parent.append(document.createTextNode(text.slice(last, part.at)));
		parent.append(renderInline(part.source));
		last = part.at + part.source.length;
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
