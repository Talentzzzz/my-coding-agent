import { readFile, stat } from "node:fs/promises";
import type { Tool, ToolResult } from "../llm/index.ts";
import { Type, type Static } from "typebox";
import { displayToolPath, resolveToolPath } from "./workdir.ts";
import { textResult, throwIfAborted } from "./types.ts";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LINES = 2_000;

const parameters = Type.Object({
	path: Type.String({ description: "File path. Relative paths resolve against the working directory; absolute paths are taken as they are." }),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line to read, 1-based" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: `Maximum lines to read, default ${MAX_LINES}` })),
});

export type ReadParams = Static<typeof parameters>;

interface ReadHooks {
	signal?: AbortSignal;
	onUpdate?: (partial: ToolResult<unknown>) => void;
}

/**
 * `read` 返回带编号的行，让模型能引用精确位置并把它们用作 `edit` 的锚点。压缩过的 JSON 文件先
 * 美化；其他压缩文件如实报告，因为一行 500 KB 上的行号帮不了任何人。图片文件（PNG、JPEG、GIF、
 * WebP，按文件签名识别，不按扩展名）以图片本身加一行信封回答，这就是视觉模型看图的方式。
 */
export function createReadTool(): Tool<typeof parameters> {
	return {
		name: "read",
		label: "Read",
		description:
			"Read a file and return its contents with line numbers. Use offset and limit for large files. Image files (PNG, JPEG, GIF, WebP) are returned as images.",
		parameters,
		executionMode: "parallel",
		execute(_toolCallId, params, run, signal, onUpdate) {
			return runRead(run.workDirAbsPath, params, { signal, onUpdate });
		},
	};
}

/** 读取实现，导出以便测试不需要 agent 就能调用。 */
export async function runRead(
	workDirAbsPath: string,
	params: ReadParams,
	hooks: ReadHooks = {},
): Promise<ToolResult<unknown>> {
	throwIfAborted(hooks.signal);
	const absPath = resolveToolPath(workDirAbsPath, params.path);
	const info = await stat(absPath).catch(() => undefined);
	if (!info) throw new Error(`File not found: ${params.path}`);
	if (info.isDirectory()) throw new Error(`Not a file (it is a directory): ${params.path}`);
	if (info.size > MAX_FILE_BYTES) {
		throw new Error(`File is ${formatBytes(info.size)}, over the ${formatBytes(MAX_FILE_BYTES)} read limit`);
	}

	const bytes = await readFile(absPath);
	throwIfAborted(hooks.signal);
	const mimeType = sniffImageMimeType(bytes);
	if (mimeType) return imageResult(workDirAbsPath, params.path, absPath, bytes, mimeType, hooks);
	const raw = bytes.toString("utf8");
	if (looksBinary(raw)) throw new Error(`Binary file, not shown: ${params.path}`);

	let content = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
	if (isJson(params.path)) content = prettyJson(content);

	const lines = content.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	const offset = params.offset ?? 1;
	if (offset > lines.length) {
		throw new Error(`offset ${offset} is past the end of the file (${lines.length} lines)`);
	}

	const limit = params.limit ?? MAX_LINES;
	const slice = lines.slice(offset - 1, offset - 1 + limit);
	const width = String(offset + slice.length - 1).length;
	hooks.onUpdate?.(textResult(`${slice.length} of ${lines.length} lines`));

	const body = slice.map((line, index) => `${String(offset + index).padStart(width, " ")}\u2192${line}`).join("\n");
	const shown = offset - 1 + slice.length;
	const suffix =
		shown < lines.length ? `\n\n[${lines.length - shown} more lines; continue with offset=${shown + 1}]` : "";
	return textResult(`${body}${suffix}`, { path: displayToolPath(workDirAbsPath, absPath), lines: lines.length });
}

/**
 * 图片 result：一行模型先读的文字信封，然后是图片本身。信封说明格式和大小，这样只收到文本的
 * 非视觉模型仍然知道文件是什么。
 */
function imageResult(
	workDirAbsPath: string,
	requestedPath: string,
	absPath: string,
	bytes: Buffer,
	mimeType: string,
	hooks: ReadHooks,
): ToolResult<unknown> {
	hooks.onUpdate?.(textResult(`image ${mimeType}, ${formatBytes(bytes.length)}`));
	return {
		content: [
			{ type: "text", text: `Read image file [${mimeType}], ${formatBytes(bytes.length)}.` },
			{ type: "image", data: bytes.toString("base64"), mimeType },
		],
		details: { path: displayToolPath(workDirAbsPath, absPath), mimeType, bytes: bytes.length, requestedPath },
	};
}

/**
 * 按文件签名识别受支持的图片格式。这个集合是 provider 接受为模型输入的（PNG、JPEG、GIF、WebP）；
 * 其他的落到文本路径，如果也不是文本，就走常规的二进制拒绝。
 */
function sniffImageMimeType(bytes: Buffer): string | undefined {
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWithAscii(bytes, 0, "GIF87a") || startsWithAscii(bytes, 0, "GIF89a")) return "image/gif";
	if (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WEBP")) return "image/webp";
	return undefined;
}

function startsWith(bytes: Buffer, signature: number[]): boolean {
	if (bytes.length < signature.length) return false;
	return signature.every((byte, index) => bytes[index] === byte);
}

function startsWithAscii(bytes: Buffer, offset: number, text: string): boolean {
	if (bytes.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index += 1) {
		if (bytes[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}

function looksBinary(text: string): boolean {
	const sample = text.slice(0, 8_000);
	if (sample.includes("\u0000")) return true;
	let control = 0;
	for (const char of sample) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 9 || (code > 13 && code < 32)) control += 1;
	}
	return sample.length > 0 && control / sample.length > 0.1;
}

function isJson(path: string): boolean {
	return /\.jsonc?$/i.test(path);
}

function prettyJson(text: string): string {
	const firstLine = text.split("\n", 1)[0] ?? "";
	if (firstLine.length < 400) return text;
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
