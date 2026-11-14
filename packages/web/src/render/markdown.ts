/**
 * Markdown 子集渲染器，直接构建 DOM 节点。
 *
 * 它从块列表渲染而不是 HTML 字符串，所以模型输出永远无法注入标记。块列表也是让流式便宜的东西：
 * 生长中的消息随文本到达重新解析，但只有变化的块被触碰 —— 完成的块追加一次之后永不再访，仍在
 * 写入的块是唯一被替换的。没有这个拆分，长回答会在每个 token 上重建整棵子树。
 *
 * 子集刻意很小：标题、段落、围栏代码、引用、有序/无序/任务列表、表格、水平线，以及行内代码、
 * 强调、删除线和链接。子集之外的保持字面文本，而不是去猜。
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

/** {@link Block} 的某个成员，按 kind 指名 —— `switch (block.kind)` 分支收窄到的类型。 */
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

/** 表格的分隔行：`| --- | :-: |`，正是它把表格从段落里认出来。 */
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
 * 从 `start` 起把 Markdown 拆成块，并说出最后一个块从哪里开始。
 *
 * 未终结的块 —— 没有闭合标记的围栏、没有分隔行的表格、还在写的列表 —— 按目前为止的样子成为
 * 那个块。流式消息需要这个：尾部按现状渲染，下一个 chunk 决定它真正是什么之后再替换。
 *
 * 每次迭代恰好压入一个块，行按顺序消费，所以最后一个块的行下标也就是更早内容不可能再变化的
 * 分界点。`lastStart` 报告它：增量调用者保留它之前的一切，只从那里重新解析。
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

		// 这一行开启了本次迭代将压入的块，所以它是最新的安全切点。
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
				// 缩进行延续它上面的条目。
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

		// 表格是一行加上一个分隔行；其余都是段落。
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
			// 实践中不可达，但一个无法前进的解析器会挂死渲染器。
			paragraph.push(line);
			index += 1;
		}
		blocks.push({ kind: "paragraph", lines: paragraph });
	}

	return { blocks, lastStart };
}

/** 把 Markdown 拆成块。 */
export function parseBlocks(text: string): Block[] {
	return parseFrom(text.split("\n"), 0).blocks;
}

/**
 * {@link renderMarkdown} 在两次调用之间携带的东西。
 *
 * 流式消息每秒重渲染多次，每次重新解析整个答案的成本是 O(答案²)。这里保存解析结果：最后一个块
 * 之前的每个块都已落定 —— 追加文本不可能改变它 —— 所以下次调用保留它们、只重新解析尾部。尾部
 * 按字符偏移切，而不是重新切分整个文本，所以一帧的成本正比于仍在写的块，而不是到目前为止的
 * 答案。调用者为每条消息持有一个并传回来；它单独存在毫无意义。
 */
export interface MarkdownState {
	/** 这份状态解析自的文本。 */
	text: string;
	/** 从那份文本解析出的所有块，按序。 */
	blocks: Block[];
	/**
	 * 最后一个块开始的字符偏移 —— 唯一仍可能变化的块。
	 *
	 * 是偏移而不是行下标，因为下次调用绝不能为了找尾部而触碰整个文本：在这里切再切分切片的
	 * 成本是 O(尾部)，而行下标光是为了可用就得强制一次完整的 `split`。
	 */
	tailOffset: number;
}

/**
 * 把 `text` 渲染进 `container`，只触碰变化的部分。
 *
 * `markdownState` 是上一次调用的 {@link MarkdownState}，返回值是下次要传回去的那个。文本只是增长时，
 * 落定的块被保留、只解析尾部；其他一切都是完整解析。
 *
 * 尾部是仍在写的块，只要类型不变就原地修补而不是替换：长回答常常就是一个段落，逐 token 替换
 * 会让浏览器重建整棵子树、重新排版列、丢掉其中的选中。每种"原地"的含义见 {@link patchBlock}；
 * 类型变了或文本是被替换而非续写的尾部，按老办法重做。
 */
export function renderMarkdown(container: HTMLElement, text: string, markdownState?: MarkdownState): MarkdownState {
	const previous = markdownState?.blocks ?? [];
	// 增长是流式消息唯一的形态；更短或被改写的文本是替换（与 delta 不一致的 `message_end`、
	// 从新快照画出的回合）。
	const continued = markdownState !== undefined && text.length >= markdownState.text.length && text.startsWith(markdownState.text);
	let blocks: Block[];
	let tailOffset: number;

	if (continued) {
		// 文本只是增长：保留旧尾部之前的全部，从它开始的地方重新解析。切片的前
		// `state.tailOffset` 个字符与旧文本共享，所以尾部的第一行就是还开着的那个块 —— 更早的
		// 什么都没被触碰。
		const kept = Math.max(0, markdownState.blocks.length - 1);
		const tailLines = text.slice(markdownState.tailOffset).split("\n");
		const tail = parseFrom(tailLines, 0);
		// 尾部的块可能比被替换的那个更少、相等或更多 —— 新文本用空行拆开的段落变成两个 —— 下面的
		// DOM 补丁处理这三种。
		blocks = [...markdownState.blocks.slice(0, kept), ...tail.blocks];
		tailOffset = markdownState.tailOffset + offsetOfLine(tailLines, tail.lastStart);
	} else {
		const lines = text.split("\n");
		const parsed = parseFrom(lines, 0);
		blocks = parsed.blocks;
		tailOffset = offsetOfLine(lines, parsed.lastStart);
	}

	// 值得补丁的唯一情形是"块数相同、尾部类型未变"：尾部之前的每个块都已落定，所以屏幕只差最后
	// 一个元素，元素自己还能保住身份。其余都是形状变化，老路径从切点重加。
	const kept = previous.length - 1;
	if (continued && blocks.length === previous.length && kept >= 0) {
		const tail = container.lastElementChild as HTMLElement | null;
		if (tail !== null && patchBlock(tail, previous[kept]!, blocks[kept]!)) {
			return { text, blocks, tailOffset };
		}
	}

	if (!continued || blocks.length < previous.length) {
		// 一次替换，或丢失了块的尾部：容器重建，而不是对着已不存在的块打补丁。
		container.replaceChildren();
		appendBlocks(container, blocks, 0);
	} else {
		// 重加之前先丢掉尾部：它是仍在写的块，刚解析出的那个类型不同（或列表改了类型），无法
		// 补丁。
		if (previous.length > 0) container.lastElementChild?.remove();
		appendBlocks(container, blocks, Math.max(0, previous.length - 1));
	}

	return { text, blocks, tailOffset };
}

/** 行 `index` 在 `lines` 所拆出的文本中的字符偏移。 */
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
 * 原地修补仍在写的块，并回答是否成功。
 *
 * 元素是屏幕上已有的那个，所以成功的补丁保住它的身份、它在列中的位置、以及周围已经排好的
 * 一切。`false` 表示元素无法描述 `next` —— 类型变了、是替换、或一次增长会重写的结构 ——
 * 调用者按老办法重做。
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
			// 引用是块的容器而不是一段文本，所以它自己的子节点重做；`<blockquote>` 本身保留，这正是
			// 保住它的边距和位置的东西。
			element.replaceChildren();
			for (const child of parseBlocks(next.lines.join("\n"))) element.append(renderBlock(child));
			return true;
		}
		case "table":
			// 表格的行和对齐是一张网格，不是一段流：重做元素比逐格补丁便宜，且流式表格罕见得配不上
			// 这段代码。
			return false;
		case "rule":
			return true;
	}
}

/**
 * 修补文本只是增长的段落或标题。
 *
 * 元素的**最后一个子节点**决定了哪种写入是廉价且正确的，整段从不重读：
 *
 * - 文本节点是上一个行内形态之后的字面文本流，所以后缀可能新形成的任何东西都必须从这段流内部
 *   开始 —— 它之前的内容不会留下未回应的部分。普通文字的后缀因此只是延长节点（`appendData`）；
 *   带标记的后缀重读的只是那段流加上后缀，并原地换掉节点。
 * - 末尾是行内形态时，它关闭了之前的文本，后缀之前的东西不可能开启或关闭任何东西：后缀单独
 *   渲染后追加。
 *
 * 更早的版本问的是"整段是否含有行内形态"（`hasInlineMarkup(next)`），是就重建元素，这对 `思考`
 * 和任何技术回答 —— 每几个词一个反引号 —— 意味着**每一帧**逐节点重建整个段落：一段 16k 字符的
 * 回答在 666 帧里造了 456,053 个节点，而纯文本只要 2 个
 * （`.scratch/branch-line-and-smoothness/research/measure-inline.ts`）。只重新解析未回应的那段流，
 * 成本与纯文本一样。
 */
function patchInlineBlock(element: HTMLElement, previous: string, next: string): boolean {
	if (!next.startsWith(previous)) return false;
	const suffix = next.slice(previous.length);
	if (suffix.length === 0) return true;

	const literal = !INLINE_MARKER.test(suffix);
	const last = element.lastChild;
	// `3` 是 `Node.TEXT_NODE`；用字面量是因为冒烟测试的 DOM shim 不导出 Node。
	if (last != null && last.nodeType === 3) {
		const tail = last.textContent ?? "";
		// 这个节点必须是已渲染内容的尾部，否则它里面的偏移毫无意义。
		if (!previous.endsWith(tail)) return false;
		// 两侧都是普通文字时跨连接处形成不了任何东西，节点直接生长。任一侧有标记就可能在这里
		// 开启或关闭形态，那时只重读未回应的那段流 —— 就是这个节点，绝不是它后面的段落。
		if (literal && !INLINE_MARKER.test(tail)) {
			(last as Text).appendData(suffix);
			return true;
		}
		const nodes = hasInlineMarkup(tail + suffix) ? inlineNodes(tail + suffix) : [];
		// 仍不含形态的一段流解析出的就是它已经是的文本，节点直接生长：标记悬而未决时
		// （`**粗` 变成 `**粗体`）这是普通情形，什么都不构建。
		if (nodes.length === 0) {
			(last as Text).appendData(suffix);
			return true;
		}
		for (const node of nodes) element.insertBefore(node, last);
		last.remove();
		return true;
	}

	// 文本以一个形态结尾。那个形态左侧仍未回应的标记可能跨它绑定（`**每一次*` 渲染成一个孤立的
	// `*` 加一个 `em`，下一个 `*` 把这一对变成 `strong`），除了整段没有任何东西能定论它。
	if (pendingMarker(element)) {
		element.replaceChildren();
		appendInline(element, next);
		return true;
	}
	if (literal) {
		element.append(document.createTextNode(suffix));
		return true;
	}
	appendInline(element, suffix);
	return true;
}

/**
 * 关闭 `element` 的那段字面文本是否仍带着未回应的标记。
 *
 * 从结尾的形态元素往回走到最近的文本：以 {@link INLINE_MARKER} 字符结尾的文本节点是一个没人闭合
 * 的标记，接下来的字符决定它保持字面还是成为形态。遍历的是几个兄弟节点，绝不是整段。
 */
function pendingMarker(element: HTMLElement): boolean {
	const nodes = element.childNodes;
	for (let index = nodes.length - 1; index >= 0; index -= 1) {
		const node = nodes[index]!;
		if (node.nodeType !== 3) continue;
		const text = node.textContent ?? "";
		return text.length > 0 && INLINE_MARKER.test(text.slice(-1));
	}
	return false;
}

/** 修补一个变长的围栏块：文本节点或 diff 的 span 延长而不是重置。 */
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

	// 每行一个 span，所以只有最后的旧行和到达的新行被触碰。新的行跟上来的一刻，最后的旧行就失去
	// 了"最后一行"身份，所以有换行。
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

/** 逐条目修补列表；条目是增长中的列表唯一会新增或延长的东西。 */
function patchListBlock(
	element: HTMLElement,
	previous: Extract<Block, { kind: "list" }>,
	next: Extract<Block, { kind: "list" }>,
): boolean {
	// 有序性和起始编号由第一个条目固定，增长动不了它。
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
				// 任务条目的方框保持为文本：把 `[ ]` 变成控件会招致一次对运行毫无影响的点击。
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

/** 一个围栏块：一行标着语言并带复制按钮的头，然后是代码本身。 */
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

	// 点击时读取：块可能仍在流式输出，后续的尾部补丁会原地延长元素而不是替换它，所以捕获的字符串
	// 会过期。
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

/** 代码块是否渲染为补丁 —— 下面逐行绘制器应用的判据。 */
function isDiffCode(code: string): boolean {
	const lines = code.split("\n");
	return lines.some((line) => line.startsWith("@@")) || lines.some((line) => /^\+{3} |^-{3} /.test(line));
}

/** 补丁的一行：携带增删底色的 span，非最后一行带换行。 */
function appendDiffLine(target: HTMLElement, line: string, last: boolean): void {
	const span = document.createElement("span");
	if (line.startsWith("+") && !line.startsWith("+++")) span.className = "diff-add";
	else if (line.startsWith("-") && !line.startsWith("---")) span.className = "diff-del";
	span.textContent = last ? line : `${line}\n`;
	target.append(span);
}

/**
 * 标记 unified diff 的行。
 *
 * 工具结果会原样粘贴补丁，读者唯一需要的是哪些行被加、哪些被删。语法高亮不做尝试：一次错误的
 * 猜测会把正确的代码染成误导性的颜色。
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
 * 本渲染器认识的行内形态：代码、加粗、强调、删除线和链接。
 *
 * 一个带 `g` 标志的模式，由 {@link appendInline} 遍历、被 {@link hasInlineMarkup} 询问。遍历在
 * 构建任何节点之前先收集所有匹配，递归进嵌套强调时就不会移动这个模式的游标。
 */
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~]+~~)|(\[[^\]\n]*\]\([^)\s]+\))/g;

/**
 * 可能开启或关闭行内形态的字符。
 *
 * 尾部补丁对刚到达的后缀应用它，而不是对整段：普通文字不含这些字符，所以生长中的回答不需要
 * 扫描已经说过的话。
 */
const INLINE_MARKER = /[`*_~[\]]/;

/** `text` 是否含有 {@link appendInline} 会渲染成多个文本节点的形态。 */
function hasInlineMarkup(text: string): boolean {
	INLINE.lastIndex = 0;
	return INLINE.test(text);
}

/** 一次行内流渲染出的节点，按序 —— 尾部补丁为它的字面段换入的东西。 */
function inlineNodes(text: string): Node[] {
	const nodes: Node[] = [];
	const found: { at: number; source: string }[] = [];
	INLINE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = INLINE.exec(text)) !== null) found.push({ at: match.index, source: match[0] });

	let last = 0;
	for (const part of found) {
		if (part.at > last) nodes.push(document.createTextNode(text.slice(last, part.at)));
		nodes.push(renderInline(part.source));
		last = part.at + part.source.length;
	}
	if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
	return nodes;
}

/** 块内的行内 span：代码、加粗、强调、删除线和链接。 */
function appendInline(parent: { append(...nodes: Node[]): void }, text: string): void {
	parent.append(...inlineNodes(text));
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
