// @my-agent/infra 的公开面（分层重构 spec §4.4）：存储实现——组合根从这里构造三实现、按端口注入
// domain。按存储域三文件：会话文件对全家（11 方法 + hold 闸 + removeGate 测试缝 + 旧布局迁移 +
// 文件对路径规则）、home JSON 文件族原语、tool-results 归档只写。
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
