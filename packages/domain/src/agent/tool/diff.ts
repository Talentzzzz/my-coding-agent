/**
 * 文件修改工具报告的行级 diff。
 *
 * 两个读者读同一处变更。模型读文字形式，它必须保持小，因为它在每次请求里都要重发；窗口读结构
 * 形式，那是真正的 diff 视图需要的——两个文件各自的行号、哪些行是新增、重写的一行究竟哪里不同。
 * 两者从同一次计算投影而来，所以模型拿来核对自己的文字和读者看到的卡片不可能描述不同的变更。
 *
 * 算法是常规做法：剥掉公共的头尾，然后对剩下的做 LCS。剥头尾是让常见情形保持便宜的原因——
 * 一万行文件里的一行改动给 LCS 只留下一行的中间段——下面的预算则约束其余情况。
 */

/**
 * 工具改动的文件中的一行。
 *
 * 行号是文件自己的：1 起算，旧文件与新文件各有一套，所以窗口不用回读任何东西就能显示改动落在哪里。
 * 只有旧文件有的行不带新行号，反之亦然；`skip` 行代表报告省略的未改动行。
 */
export interface DiffLine {
	kind: "add" | "remove" | "context" | "skip";
	oldLine: number | null;
	newLine: number | null;
	text: string;
	/**
	 * `text` 中发生变化的那段半开区间，用于「一行删除加紧随其后的新增」其实是同一行被重写的情形。
	 * 整行变更时缺失，那种情况下行本身的颜色已把标记想说的话说完了。
	 */
	changed?: [number, number];
	/** 这条 `skip` 行所代表的未改动行数。 */
	skipped?: number;
}

/**
 * 一次工具调用对一个文件做了什么。
 *
 * 改动文件的工具在 `ToolResult.details` 里以此作答，与模型读的文本并列：文本写给模型，这份写给
 * 窗口。两者是同一处改动，所以视图永远不必解析文本——工具的文本也得以保持简短，对整个文件的
 * `write` 而言，这就是「点一下文件名」与「把内容再付一遍钱」的差别。
 *
 * 它搭引擎自己的 `tool_execution_end` 事件走，wire 无需为它加成员，而引擎记录的是整个结果
 * ——会话记录便把这份报告存在工具文本旁边。任何供应商都看不到它：请求携带工具结果时只携带
 * content。
 */
export interface FileDiff {
	/** 文件按工作目录的显示方式——目录内相对，之外绝对。 */
	relPath: string;
	lines: DiffLine[];
	added: number;
	removed: number;
	/** 文件此前不存在时为 true，每一行都是新增。 */
	created: boolean;
	/** 因改动超出报告上限而未进 `lines` 的行数。 */
	omitted: number;
}

/** 变更两侧各保留多少未变行，让变更在其上下文中可读。 */
export const DIFF_CONTEXT = 3;

/** 一份报告最多携带的行数。卡片是变更的预览，不是 diff 查看器。 */
export const DIFF_MAX_ROWS = 500;

/** 该报告中最多给模型看多少行；文件本身拥有其余的。 */
export const DIFF_TEXT_MAX_ROWS = 80;

/**
 * LCS 允许填充的格子数，超过即把中段整体报告为一次重写。
 *
 * 表格对变更区域是二次方的，所以足够大的中段是一次重写文件而不是一次编辑——用一块删除加一块
 * 新增来说明它既便宜又真实。头尾的剥离已经拿走了两侧共享的一切，所以只有真正全是变更的中段
 * 才会到这里。
 */
const LCS_BUDGET = 200_000;

export interface DiffOptions {
	/** 变更两侧各保留多少未变行。默认 {@link DIFF_CONTEXT}。 */
	context?: number;
	/** `lines` 最多携带的行数；其余计入 `omitted`。默认无限制。 */
	maxLines?: number;
	/** 文件此前是否不存在。默认把 `before` 当作空的。 */
	created?: boolean;
}

/** 编辑脚本的一行，在被标上行号、切成 hunk 之前。 */
type Op = { kind: "context" | "add" | "remove"; text: string };

/**
 * 从 `before` 到 `after` 的变更，按卡片能绘制的行。
 *
 * `path` 原样携带而不是推导：只有调用方知道 run 的工作目录如何展示该文件，卡片指名的路径与工具
 * 自己的文字相同。
 */
export function fileDiff(relPath: string, before: string, after: string, options: DiffOptions = {}): FileDiff {
	const ops = editScript(splitLines(before), splitLines(after));

	let added = 0;
	let removed = 0;
	for (const op of ops) {
		if (op.kind === "add") added += 1;
		else if (op.kind === "remove") removed += 1;
	}

	// 每一行在构建时就编号，在任何 hunk 丢掉它之前：一个因为相邻 hunk 被省略而移位的编号会指向
	// 文件的错误一行。
	const numbered: DiffLine[] = [];
	let oldLine = 1;
	let newLine = 1;
	for (const op of ops) {
		if (op.kind === "context") numbered.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: op.text });
		else if (op.kind === "remove") numbered.push({ kind: "remove", oldLine: oldLine++, newLine: null, text: op.text });
		else numbered.push({ kind: "add", oldLine: null, newLine: newLine++, text: op.text });
	}

	const lines = changedLines(numbered, options.context ?? DIFF_CONTEXT);
	markRewrites(lines);

	const limit = options.maxLines ?? lines.length;
	return {
		relPath,
		lines: lines.slice(0, limit),
		added,
		removed,
		created: options.created ?? (before.length === 0 && after.length > 0),
		omitted: Math.max(0, lines.length - limit),
	};
}

/**
 * 报告中模型的那一半：熟悉的 `-` / `+` / 空格前缀，仅此而已。
 *
 * 行号刻意不给。卡片需要它们，因为读者要拿变更对照文件；模型检查的是自己刚做的事，花在编号上的
 * 每一列都是它得不到的一列上下文。
 */
export function diffText(diff: FileDiff, maxLines = DIFF_TEXT_MAX_ROWS): string {
	const rows: string[] = [];
	let omitted = diff.omitted;
	for (const line of diff.lines) {
		// skip 行是关于视图的事实，不是关于文件的事实：模型既拿不到被省略的行，也拿不到一行说明
		// 它们缺失的话。
		if (line.kind === "skip") continue;
		if (rows.length >= maxLines) {
			omitted += 1;
			continue;
		}
		rows.push(`${line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}${line.text}`);
	}
	if (omitted > 0) rows.push(`[... ${omitted} diff lines omitted ...]`);
	return rows.join("\n");
}

/**
 * 把文本切成行，忽略结尾换行。
 *
 * 最后的换行是终止符，不是独立的一行：保留它，它会以一行尾部空 context 行出现在每个 diff 里，
 * 读起来像一次没人做过的变更。
 */
function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * 两个行列表之间的最短编辑脚本。
 *
 * 公共的头尾先剥掉，因为纯插入或纯删除在这里可以免费判定，也因为这让 LCS 得到它擅长的小中段。
 * 超出预算的中段报告为一次重写：在那个规模上，唯一既诚实又便宜的说法就是这些行没了、那些行来了。
 */
function editScript(before: readonly string[], after: readonly string[]): Op[] {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;

	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) {
		suffix += 1;
	}

	const head: Op[] = before.slice(0, prefix).map((text) => ({ kind: "context", text }));
	const tail: Op[] = before.slice(before.length - suffix).map((text) => ({ kind: "context", text }));
	const oldMiddle = before.slice(prefix, before.length - suffix);
	const newMiddle = after.slice(prefix, after.length - suffix);

	let middle: Op[];
	if (oldMiddle.length === 0 || newMiddle.length === 0 || oldMiddle.length * newMiddle.length > LCS_BUDGET) {
		middle = [
			...oldMiddle.map((text): Op => ({ kind: "remove", text })),
			...newMiddle.map((text): Op => ({ kind: "add", text })),
		];
	} else {
		middle = lcsScript(oldMiddle, newMiddle);
	}

	return [...head, ...middle, ...tail];
}

/** 既不共享头也不共享尾的两个行列表的编辑脚本。 */
function lcsScript(before: readonly string[], after: readonly string[]): Op[] {
	const width = after.length + 1;
	// `counts[i * width + j]` 是从 `before[i]` 起的最长公共子序列长度。
	const counts = new Uint32Array((before.length + 1) * width);
	for (let i = before.length - 1; i >= 0; i -= 1) {
		for (let j = after.length - 1; j >= 0; j -= 1) {
			counts[i * width + j] =
				before[i] === after[j]
					? counts[(i + 1) * width + j + 1]! + 1
					: Math.max(counts[(i + 1) * width + j]!, counts[i * width + j + 1]!);
		}
	}

	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < before.length && j < after.length) {
		if (before[i] === after[j]) {
			ops.push({ kind: "context", text: before[i]! });
			i += 1;
			j += 1;
		} else if (counts[(i + 1) * width + j]! >= counts[i * width + j + 1]!) {
			// 平局归给删除，于是重写的一对读作旧行在前、新行在后，而不是一次出现在自己删除上方
			// 某处的插入。
			ops.push({ kind: "remove", text: before[i]! });
			i += 1;
		} else {
			ops.push({ kind: "add", text: after[j]! });
			j += 1;
		}
	}
	while (i < before.length) ops.push({ kind: "remove", text: before[i++]! });
	while (j < after.length) ops.push({ kind: "add", text: after[j++]! });
	return ops;
}

/**
 * 把带编号的行切成 hunk：每个变更、它的周围上下文，以及它们之间被略去内容的计数。
 *
 * 文件两端超出 context 的未变行不带行直接丢弃——以「1,200 行未变」开头的 diff 会把它要展示的变更
 * 埋掉——而两个变更*之间*的间隙要报告，因为滚动查看一段变更的读者需要知道自己跳过了内容，而不
 * 是文件突然跳了一下。
 */
function changedLines(rows: readonly DiffLine[], context: number): DiffLine[] {
	const keep = new Array<boolean>(rows.length).fill(false);
	for (let index = 0; index < rows.length; index += 1) {
		if (rows[index]!.kind === "context") continue;
		const from = Math.max(0, index - context);
		const to = Math.min(rows.length - 1, index + context);
		for (let mark = from; mark <= to; mark += 1) keep[mark] = true;
	}

	const lines: DiffLine[] = [];
	let skipped = 0;
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index]!;
		if (keep[index]) {
			if (skipped > 0) {
				lines.push({ kind: "skip", oldLine: null, newLine: null, text: "", skipped });
				skipped = 0;
			}
			lines.push(row);
			continue;
		}
		// 一行被丢的行只有在已经保留过东西之后才计数：文件的未变头尾不是两个 hunk 之间的间隙。
		if (lines.length > 0) skipped += 1;
	}
	return lines;
}

/**
 * 标出重写的一行里真正不同的部分。
 *
 * 只标记单独一行删除后跟单独一行新增的情况。这是一行变更呈现的形状，也是差异值得指出的情形；
 * 五行重写成六行没有可标记的配对，硬猜一个会高亮错误的文字。
 */
function markRewrites(lines: DiffLine[]): void {
	let index = 0;
	while (index < lines.length) {
		if (lines[index]!.kind !== "remove") {
			index += 1;
			continue;
		}

		let removed = 0;
		while (index + removed < lines.length && lines[index + removed]!.kind === "remove") removed += 1;
		let added = 0;
		while (index + removed + added < lines.length && lines[index + removed + added]!.kind === "add") added += 1;

		if (removed === 1 && added === 1) {
			const removedLine = lines[index]!;
			const addedLine = lines[index + 1]!;
			const marks = rewriteMarks(removedLine.text, addedLine.text);
			if (marks) {
				removedLine.changed = marks.removed;
				addedLine.changed = marks.added;
			}
		}
		index += removed + added;
	}
}

/** 两行中不同的区段，除两端外全不同时为 undefined。 */
function rewriteMarks(
	before: string,
	after: string,
): { removed: [number, number]; added: [number, number] } | undefined {
	const max = Math.min(before.length, after.length);
	let prefix = 0;
	while (prefix < max && before[prefix] === after[prefix]) prefix += 1;

	let suffix = 0;
	while (suffix < max - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
		suffix += 1;
	}

	const removed: [number, number] = [prefix, before.length - suffix];
	const added: [number, number] = [prefix, after.length - suffix];
	// 两端什么都没剩下，说明整行都变了，行自己的颜色已经说明了这一点；全部标出来只是换一种方式
	// 说同一件事。
	if (prefix === 0 && removed[1] === before.length && added[1] === after.length) return undefined;
	return { removed, added };
}
