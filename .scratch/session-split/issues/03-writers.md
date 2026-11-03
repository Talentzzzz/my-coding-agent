# 03 - 写侧改造：agent 与 JSON 快照写点

Type: task
Status: open
Blocked by: [02 - SessionManager 两文件重写](02-session-manager.md)

## Question

所有「写 entry」的调用点改造：`recordSelection`（model / thinking level）、rename 写点、tool_config 写点，全部改写 JSON 快照（原子重写）；`message` / `usage` / `compaction` / `clear_tool_result` / `trim_tool_call_arg` / `leaf` 的 append 路径原样保留。

- JSON 重写的时机：每个变更点即时写，还是标脏合并写。
- 重写失败的语义：写 JSON 失败算什么（会话还能不能用、报给谁）。
- 「没说过话的会话不落盘」的纪律在两文件下怎么维持（JSON 何时才第一次出现）。
