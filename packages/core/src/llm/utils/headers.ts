// 从 pi-ai（0.99.2）vendor 而来。@ts-nocheck 让仓库根目录更严格的配置放过本文件，而进入
// packages/core 的每次 import 仍然被完整检查。
// @ts-nocheck
import type { ProviderHeaders } from "../types.ts";

export function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

export function providerHeadersToRecord(
	...headerSources: (ProviderHeaders | undefined)[]
): Record<string, string> | undefined {
	const merged = new Map<string, [string, string]>();
	for (const source of headerSources) {
		for (const [name, value] of Object.entries(source ?? {})) {
			const normalizedName = name.toLowerCase();
			merged.delete(normalizedName);
			if (value !== null) merged.set(normalizedName, [name, value]);
		}
	}
	return merged.size > 0 ? Object.fromEntries(merged.values()) : undefined;
}
