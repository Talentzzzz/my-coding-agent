// tool-results 归档的只写实现（分层重构 spec §4.4）：ToolResultsRepository 端口的唯一方法。
// 收绝对路径、无 home 概念——归档挨着 result 所谈论的文件（工作目录之下的
// `.my-agent/tool-results/<session id>/`），路径推导（spillPathFor）留在 context 包，这里只管
// 「不存在才写 + mkdir，失败 false 回落硬截断」的机械。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolResultsRepository } from "@my-agent/domain";

/** 归档只写实现：无状态，一个实例服务所有会话。 */
export class ToolResultsArchive implements ToolResultsRepository {
	writeIfAbsent(absPath: string, text: string): boolean {
		try {
			if (!existsSync(absPath)) {
				mkdirSync(dirname(absPath), { recursive: true });
				writeFileSync(absPath, text, "utf8");
			}
		} catch {
			return false;
		}
		return true;
	}
}
