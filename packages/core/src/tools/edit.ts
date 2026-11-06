import { readFile, stat, writeFile } from "node:fs/promises";
import type { Tool } from "../llm/index.ts";
import { Type, type Static } from "typebox";
import { displayToolPath, resolveToolPath } from "../workdir.ts";
import { DIFF_MAX_ROWS, diffText, fileDiff } from "./diff.ts";
import { textResult, throwIfAborted } from "./types.ts";

const parameters = Type.Object({
	path: Type.String({ description: "File path. Relative paths resolve against the working directory; absolute paths are taken as they are." }),
	old_string: Type.String({ description: "Exact text to replace, including indentation, as it appears in read" }),
	new_string: Type.String({ description: "Replacement text. Use an empty string to delete the matched text." }),
	replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence. Defaults to false." })),
});

export type EditParams = Static<typeof parameters>;

/**
 * `edit` replaces exact text. Line endings are normalized before matching, so a file with CRLF
 * endings still matches the LF text the model saw in `read`; the file keeps its original endings.
 */
export function createEditTool(): Tool<typeof parameters> {
	return {
		name: "edit",
		label: "Edit",
		description:
			"Replace an exact string in a file. Fails when the string is missing or ambiguous, so include enough surrounding context to match once.",
		parameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, run, signal) {
			return runEdit(run.workDirAbsPath, { ...params, replace_all: params.replace_all ?? false }, signal);
		},
	};
}

export async function runEdit(
	workDirAbsPath: string,
	params: EditParams,
	signal?: AbortSignal,
): Promise<ReturnType<typeof textResult>> {
	throwIfAborted(signal);
	if (params.old_string === params.new_string) {
		throw new Error("old_string and new_string are identical; there is nothing to change.");
	}
	if (params.old_string.length === 0) {
		throw new Error("old_string must not be empty.");
	}

	const absPath = resolveToolPath(workDirAbsPath, params.path);
	const relPath = displayToolPath(workDirAbsPath, absPath);
	const info = await stat(absPath).catch(() => undefined);
	if (!info) throw new Error(`File not found: ${relPath}`);
	if (info.isDirectory()) throw new Error(`Not a file (it is a directory): ${relPath}`);

	const raw = await readFile(absPath, "utf8");
	const usesCrlf = raw.includes("\r\n");
	const original = normalize(raw);
	const needle = normalize(params.old_string);
	const replacement = normalize(params.new_string);

	const occurrences = countOccurrences(original, needle);
	if (occurrences === 0) {
		throw new Error(`old_string not found in ${relPath}.${hintFor(original, needle)}`);
	}
	if (occurrences > 1 && params.replace_all !== true) {
		throw new Error(
			`old_string appears ${occurrences} times in ${relPath}. Add surrounding context to make it unique, or pass replace_all: true.`,
		);
	}

	const updated = params.replace_all === true ? original.split(needle).join(replacement) : original.replace(needle, replacement);
	await writeFile(absPath, usesCrlf ? updated.replace(/\n/g, "\r\n") : updated, "utf8");
	throwIfAborted(signal);

	const replaced = params.replace_all === true ? occurrences : 1;
	// The change is read off the whole file rather than off the needle: a real diff has to know where
	// in the file it landed, which is what gives the card its line numbers.
	const diff = fileDiff(relPath, original, updated, { maxLines: DIFF_MAX_ROWS });
	const text = diffText(diff);
	const header = `Edited ${relPath}: ${replaced} replacement${replaced === 1 ? "" : "s"}.`;
	return textResult(text.length > 0 ? `${header}\n${text}` : header, {
		path: relPath,
		replacements: replaced,
		diff,
	});
}

function normalize(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/** Explain the most likely near miss instead of just saying "not found". */
function hintFor(original: string, needle: string): string {
	const originalLines = original.split("\n");
	const needleFirst = needle.split("\n")[0] ?? "";
	const trimmed = needleFirst.trim();
	if (trimmed.length > 0) {
		const loose = originalLines.findIndex((line) => line.trim() === trimmed);
		if (loose !== -1) {
			return ` A line with the same text exists at line ${loose + 1}, but the indentation or trailing whitespace differs; copy the exact line from read.`;
		}
	}
	const first = originalLines.findIndex((line) => needle.trim().length > 0 && line.includes(needle.trim().slice(0, 24)));
	if (first !== -1) {
		return ` The closest match starts at line ${first + 1}; read that region and copy the exact text.`;
	}
	return " Read the file first and copy the exact text, including indentation.";
}