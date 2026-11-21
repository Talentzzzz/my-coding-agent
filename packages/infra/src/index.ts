// @my-agent/infra 的公开面（分层重构 spec §4.4）：存储实现——组合根从这里构造各实现、按端口注入。
// 按存储域分文件：会话文件对全家（11 方法 + hold 闸 + removeGate 测试缝 + 旧布局迁移 + 文件对路径
// 规则）、home JSON 文件族原语、tool-results 归档只写、项目指示收集（@my-agent/prompt 的端口，
// ADR-0031）。
export {
	SessionFileStore,
	setRemoveGate,
	sessionJsonlPath,
	sessionMetaPath,
	sessionPath,
	type SessionFileStoreOptions,
} from "./session-store.ts";
export { HomeJsonStore, type HomeJsonStoreOptions } from "./home-json.ts";
export { ToolResultsArchive } from "./tool-results.ts";
export { AgentsMdStore } from "./agents-md.ts";
