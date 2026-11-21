// 从 pi-ai（0.99.2）vendor 而来。@ts-nocheck 让仓库根目录更严格的配置放过本文件，而进入
// packages/domain 的每次 import 仍然被完整检查。
// @ts-nocheck
import type * as NodeOs from "node:os";

type ProcessWithOsBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:os") => typeof NodeOs;
};

function loadNodeOs(): typeof NodeOs | null {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
		return null;
	}
	return (process as ProcessWithOsBuiltinModule).getBuiltinModule?.("node:os") ?? null;
}

// 运行时按需加载 OS 模块以保持浏览器安全：顶层的运行时 import node:os 会破坏 browser/Vite 构建。
const nodeOs = loadNodeOs();

export function getPiUserAgent(): string {
	return nodeOs ? `pi (${nodeOs.platform()} ${nodeOs.release()}; ${nodeOs.arch()})` : "pi (browser)";
}
