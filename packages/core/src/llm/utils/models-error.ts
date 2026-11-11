// 从 pi-ai（0.99.2）vendor 而来。@ts-nocheck 让仓库根目录更严格的配置放过本文件，而进入
// packages/core 的每次 import 仍然被完整检查。
// @ts-nocheck
import { formatThrownValue } from "./diagnostics.ts";

export type ModelsErrorCode = "model_source" | "model_validation" | "provider" | "stream" | "auth" | "oauth";

export class ModelsError extends Error {
	readonly code: ModelsErrorCode;

	constructor(code: ModelsErrorCode, message: string, options?: { cause?: unknown }) {
		super(withCauseDetail(message, options?.cause), options);
		this.name = "ModelsError";
		this.code = code;
	}
}

/** 调用方只展示 `error.message`，所以把底层原因并进它。 */
function withCauseDetail(message: string, cause: unknown): string {
	if (cause === undefined || cause === null) return message;
	const detail = formatThrownValue(cause).trim();
	if (!detail || message.includes(detail)) return message;
	return `${message}: ${detail}`;
}
