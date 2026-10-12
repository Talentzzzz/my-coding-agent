import { readFile, stat } from "node:fs/promises";
import type { AgentTool, AgentToolResult } from "@my-agent/agent";
import { Type, type Static } from "typebox";
import type { Workspace } from "../workspace.ts";
import { textResult, throwIfAborted } from "./types.ts";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LINES = 2_000;

const parameters = Type.Object({
	path: Type.String({ description: "File path, relative to the workspace root or absolute inside it" }),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line to read, 1-based" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: `Maximum lines to read, default ${MAX_LINES}` })),
});

export type ReadParams = Static<typeof parameters>;

interface ReadHooks {
	signal?: AbortSignal;
	onUpdate?: (partial: AgentToolResult<unknown>) => void;
}

/**
 * `read` returns numbered lines so the model can quote exact positions and use them as `edit`
 * anchors. A minified JSON file is pretty-printed first; other minified files are reported as such,
 * because line numbers on a single 500 KB line help nobody. An image file (PNG, JPEG, GIF, WebP,
 * identified by its file signature, not its extension) is answered with the image itself beside a
 * one-line envelope, which is how a vision model sees a picture in the workspace.
 */
export function createReadTool(workspace: Workspace): AgentTool<typeof parameters> {
	return {
		name: "read",
		label: "Read",
		description:
			"Read a file from the workspace and return its contents with line numbers. Use offset and limit for large files. Image files (PNG, JPEG, GIF, WebP) are returned as images.",
		parameters,
		executionMode: "parallel",
		execute(_toolCallId, params, signal, onUpdate) {
			return runRead(workspace, params, { signal, onUpdate });
		},
	};
}

/** Read implementation, exported so tests can call it without an agent. */
export async function runRead(
	workspace: Workspace,
	params: ReadParams,
	hooks: ReadHooks = {},
): Promise<AgentToolResult<unknown>> {
	throwIfAborted(hooks.signal);
	const absolute = workspace.resolve(params.path);
	const info = await stat(absolute).catch(() => undefined);
	if (!info) throw new Error(`File not found: ${params.path}`);
	if (info.isDirectory()) throw new Error(`Not a file (it is a directory): ${params.path}`);
	if (info.size > MAX_FILE_BYTES) {
		throw new Error(`File is ${formatBytes(info.size)}, over the ${formatBytes(MAX_FILE_BYTES)} read limit`);
	}

	const bytes = await readFile(absolute);
	throwIfAborted(hooks.signal);
	const mimeType = sniffImageMimeType(bytes);
	if (mimeType) return imageResult(workspace, params.path, absolute, bytes, mimeType, hooks);
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
	return textResult(`${body}${suffix}`, { path: workspace.display(absolute), lines: lines.length });
}

/**
 * The image result: a one-line text envelope the model reads first, then the image itself. The
 * envelope names the format and size so a non-vision model that receives only the text still learns
 * what the file was.
 */
function imageResult(
	workspace: Workspace,
	requestedPath: string,
	absolute: string,
	bytes: Buffer,
	mimeType: string,
	hooks: ReadHooks,
): AgentToolResult<unknown> {
	hooks.onUpdate?.(textResult(`image ${mimeType}, ${formatBytes(bytes.length)}`));
	return {
		content: [
			{ type: "text", text: `Read image file [${mimeType}], ${formatBytes(bytes.length)}.` },
			{ type: "image", data: bytes.toString("base64"), mimeType },
		],
		details: { path: workspace.display(absolute), mimeType, bytes: bytes.length, requestedPath },
	};
}

/**
 * Identify a supported image format by its file signature. The set is what the providers accept as
 * model input (PNG, JPEG, GIF, WebP); anything else falls through to the text path and, if it is not
 * text either, the usual binary refusal.
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
