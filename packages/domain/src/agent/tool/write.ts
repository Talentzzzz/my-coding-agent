import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { Tool } from "../llm/index.ts";
import { dirname } from "node:path";
import { Type, type Static } from "typebox";
import { displayToolPath, resolveToolPath } from "./workdir.ts";
import { DIFF_MAX_ROWS, fileDiff } from "./diff.ts";
import { textResult, throwIfAborted } from "./types.ts";

const parameters = Type.Object({
	path: Type.String({ description: "File path. Relative paths resolve against the working directory; absolute paths are taken as they are." }),
	content: Type.String({ description: "Complete file content. Trailing newline is added when missing." }),
	overwrite: Type.Optional(
		Type.Boolean({ description: "Replace an existing file. Defaults to false; use edit for small changes." }),
	),
});

export type WriteParams = Static<typeof parameters>;

/**
 * `write` 创建文件，设置了 `overwrite` 时替换文件。
 *
 * 默认拒绝覆盖很重要：一个本意是「改一行」却用重建的整个文件调用 `write` 的模型，会无声地毁掉它
 * 没有重现的部分。
 */
export function createWriteTool(): Tool<typeof parameters> {
	return {
		name: "write",
		label: "Write",
		description:
			"Write a complete file. Creates missing directories. Refuses to overwrite an existing file unless overwrite is true; prefer edit for small changes.",
		parameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, run, signal) {
			return runWrite(run.workDirAbsPath, params, signal);
		},
	};
}

export async function runWrite(
	workDirAbsPath: string,
	params: WriteParams,
	signal?: AbortSignal,
): Promise<ReturnType<typeof textResult>> {
	throwIfAborted(signal);
	const absPath = resolveToolPath(workDirAbsPath, params.path);
	const relPath = displayToolPath(workDirAbsPath, absPath);
	const existing = await stat(absPath).catch(() => undefined);
	if (existing?.isDirectory()) throw new Error(`Not a file (it is a directory): ${relPath}`);

	const content = params.content.endsWith("\n") ? params.content : `${params.content}\n`;

	// 文件此前的内容，不存在时为 undefined。只为这里要做的两个决定——这次写入是否改变任何东西、
	// 变更是什么——读一次，所以模型得到的回答和窗口得到的 diff 是同一次比较。
	let before: string | undefined;
	if (existing) {
		if (params.overwrite !== true) {
			throw new Error(
				`${relPath} already exists. Use edit for a targeted change, or pass overwrite: true to replace the whole file.`,
			);
		}
		before = await readFile(absPath, "utf8").catch(() => undefined);
		if (before === content) {
			return textResult(`No change: ${relPath} already has exactly this content.`, { path: relPath, changed: false });
		}
	}

	await mkdir(dirname(absPath), { recursive: true });
	await writeFile(absPath, content, "utf8");
	throwIfAborted(signal);

	const lines = content.split("\n").length - 1;
	const action = existing ? "Replaced" : "Created";
	return textResult(`${action} ${relPath} (${lines} lines, ${content.length} bytes).`, {
		path: relPath,
		changed: true,
		lines,
		// 读不回来的文件没有变更可报：对着没人见过的内容做的 diff 是化装成记录的猜测，所以卡片
		// 回落到工具自己的文字。
		...(existing && before === undefined
			? {}
			: { diff: fileDiff(relPath, before ?? "", content, { maxLines: DIFF_MAX_ROWS, created: existing === undefined }) }),
	});
}
