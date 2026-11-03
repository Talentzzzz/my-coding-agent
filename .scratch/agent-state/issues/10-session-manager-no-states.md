# 10：SessionManager 去 states——34 个调用点迁移

Type: task
Status: open
Blocked by: 02, 08

## Question

删掉 `private readonly states = new Map<string, Session>()`（`session-manager.ts:1377`）与 `adopt`（若 03 号票
判删），`SessionManager` 退成「收 `Session` 的纯函数 + 文件 I/O」的薄壳。

- 新增 `open(id): Session`（02 号票的答案）：`fillSession(filePath)` 一份、**不缓存**，并在文档里写明
  「冷路径的一次性袋：fill → 改 → persist，并发靠 claim」。
- `stateOf` 删除或降为 `open` 的别名——**不留两个名字**。调用点迁移：
  - `agent.ts`：已由 08 号票吃掉；
  - `hub.ts` 5 处（:402 / :558 / :563 / :587 / :692）：读的改 `open(id)`，写的保持「fill → 改 → persist」；
  - `projection.ts:180`：活会话，改 `hub.agent.agentState(id).session`（需要一个公开读法，别把 Map 露出去）；
  - `session-factory.ts:148`：`assemble` 里的 `getRecordedSettings(options.session)` 保留（它本来就收袋）；
  - smoke 5 处（`smoke-sessions.ts`、`smoke-settings.ts`、`smoke-projection.ts`、`smoke-tools.ts`、
    `smoke-session.ts`）：按各自语义改。
- **smoke-sessions.ts:884 的手建 entry**（`new OpenSessions()` + `createOpenSession`）改成走新公开入口
  （`agent.adopt(createAgentState(…))` 或 `openAgent` 的等价路径）。
- 收账：`npm run check` 绿；`smoke-sessions` / `smoke-session` / `smoke-projection` / `smoke-settings` 绿。

## Answer
