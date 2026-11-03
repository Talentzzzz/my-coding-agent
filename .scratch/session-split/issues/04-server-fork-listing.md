# 04 - server 连带：listing、fork、删除与 protocol

Type: task
Status: open
Blocked by: [02 - SessionManager 两文件重写](02-session-manager.md)

## Question

`packages/server` 与 `packages/core/src/protocol.ts` 的连带改造：

- SessionInfo / listing：元数据（title、workDir、时间戳、parentSession）从 JSON 读，消息统计才开 JSONL；目录扫描按两文件配对。
- fork：复制两个文件，`parentSession` 指源文件路径。
- 删除会话：两个文件一起删。
- tool_config / approvals 路由落 JSON 快照；`config_changed` 等事件的连带。
