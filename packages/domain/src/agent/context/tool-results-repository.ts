// tool-results 归档的端口声明（分层重构 spec §4.3）：过大的 tool result 整体离开 context、落到
// 工作目录之下的 `.my-agent/tool-results/`，写的就是这个端口。**只写**——今天没有任何代码读归档
// （模型用 read 工具），读不进端口；**清理不发明**（今天不存在这套逻辑，零行为变化约束下不做）。
//
// 实现收绝对路径、无 home 概念（spec §4.2 的翻译表）；实例由编排层持有（构造注入），经参数表递给
// `spillOversizedToolResult` 与 `archiveToolResult`——ContextManager 保持构造零依赖（ADR-0006
// 修订）。
export interface ToolResultsRepository {
	/**
	 * 整体写一个归档文件：不存在才写 + mkdir；写入失败（含目录建不出）返回 false，调用方回落到
	 * 硬截断，而不是展示一条指名了不存在文件的通知。
	 */
	writeIfAbsent(absPath: string, text: string): boolean;
}
