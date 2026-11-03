import type { DiffLine, FileDiff } from "../protocol.ts";

/**
 * The line diff a file-changing tool reports.
 *
 * Two audiences read one change. The model reads the text form, which has to stay small because it
 * is sent again on every request; the window reads the structured form, which is what a real diff
 * view needs — line numbers in both files, which rows are additions, and where a rewritten line
 * actually differs. Both are projected from one computation, so the text the model verifies itself
 * against and the card the reader looks at can never describe different changes.
 *
 * The algorithm is the ordinary one: peel the common head and tail, then an LCS over what is left.
 * The peel is what keeps the common case cheap — a one-line change in a ten-thousand-line file
 * leaves a middle of one line for the LCS to see — and the budget below bounds the rest.
 */

/** Unchanged lines kept on each side of a change, so a change reads in its context. */
export const DIFF_CONTEXT = 3;

/** Most rows one report may carry. A card is a preview of a change, not a diff viewer. */
export const DIFF_MAX_ROWS = 500;

/** Most rows of that report the model is shown; the file itself has whatever is left. */
export const DIFF_TEXT_MAX_ROWS = 80;

/**
 * Cells the LCS may fill before the middle is reported as one rewrite.
 *
 * The table is quadratic in the changed region, so a large enough middle is a file rewritten rather
 * than edited — and saying that in one removed block and one added block is both cheap and true. The
 * head and tail peel has already taken everything the two sides share, so this is only reached by a
 * middle that really is all change.
 */
const LCS_BUDGET = 200_000;

export interface DiffOptions {
	/** Unchanged lines kept on each side of a change. Defaults to {@link DIFF_CONTEXT}. */
	context?: number;
	/** Most rows `lines` may carry; the rest is counted in `omitted`. Defaults to no bound. */
	maxLines?: number;
	/** Whether the file did not exist before. Defaults to `before` being empty. */
	created?: boolean;
}

/** One line of the edit script, before it is given line numbers and cut into hunks. */
type Op = { kind: "context" | "add" | "remove"; text: string };

/**
 * The change from `before` to `after`, as rows a card can draw.
 *
 * `path` is carried through rather than derived: only the caller knows how the run's working directory displays
 * the file, and the card names the same path the tool's own text does.
 */
export function fileDiff(relPath: string, before: string, after: string, options: DiffOptions = {}): FileDiff {
	const ops = editScript(splitLines(before), splitLines(after));

	let added = 0;
	let removed = 0;
	for (const op of ops) {
		if (op.kind === "add") added += 1;
		else if (op.kind === "remove") removed += 1;
	}

	// Every row is numbered as it is built, before any hunk drops it: a number that shifted because a
	// neighbouring hunk was elided would point at the wrong line of the file.
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
 * The model's half of a report: the familiar `-` / `+` / space prefixes and nothing else.
 *
 * Line numbers are left out on purpose. The card needs them because a reader compares the change
 * against a file; the model is checking what it just did, and every column spent on numbering is a
 * column of context it does not get.
 */
export function diffText(diff: FileDiff, maxLines = DIFF_TEXT_MAX_ROWS): string {
	const rows: string[] = [];
	let omitted = diff.omitted;
	for (const line of diff.lines) {
		// A skip row is a fact about the view, not about the file: the model gets neither the elided
		// lines nor a line saying they are missing.
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
 * Split text into lines, ignoring the trailing newline.
 *
 * The final newline is a terminator, not a line of its own: kept, it would appear in every diff as a
 * trailing empty context row, which reads like a change nobody made.
 */
function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * The shortest edit script between two line lists.
 *
 * The common head and tail are peeled first, because that is where a pure insertion or deletion is
 * decided for free, and because it leaves the LCS the small middle it is good at. A middle past the
 * budget is reported as one rewrite: at that size the one thing that can be said honestly and
 * cheaply is that these lines went and those arrived.
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

/** The edit script of two line lists that share neither a head nor a tail. */
function lcsScript(before: readonly string[], after: readonly string[]): Op[] {
	const width = after.length + 1;
	// `counts[i * width + j]` is the length of the longest common subsequence from `before[i]` on.
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
			// Ties go to the removal, so a rewritten pair reads as the old line and then the new one
			// rather than as an addition somewhere above its own deletion.
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
 * Cut numbered rows into hunks: every change, its surrounding context, and a count of what was left
 * out between them.
 *
 * Unchanged lines beyond the context at either end of the file are dropped without a row — a diff
 * that opened with "1,200 unchanged lines" would bury the change it exists to show — while a gap
 * *between* two changes is reported, because a reader scrolling through a change needs to know that
 * they skipped something rather than that the file jumped.
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
		// A dropped row only counts once something has been kept: the unchanged head and tail of a
		// file are not a gap between two hunks.
		if (lines.length > 0) skipped += 1;
	}
	return lines;
}

/**
 * Mark the part of a rewritten line that actually differs.
 *
 * Only a lone removed line followed by a lone added one is marked. That is the shape a one-line
 * change takes, and it is the case where the difference is worth pointing at; a block of five lines
 * rewritten as six has no pairing to mark, and guessing one would highlight the wrong text.
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

/** The spans of two lines that differ, or undefined when they differ everywhere but the ends. */
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
	// Nothing survived at either end, so the whole line changed and the row's own color already says
	// so; marking all of it would only be a second way of saying the same thing.
	if (prefix === 0 && removed[1] === before.length && added[1] === after.length) return undefined;
	return { removed, added };
}
