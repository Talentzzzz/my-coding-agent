# 06 controllers 与 projection 迁移

Type: task
Status: closed
Blocked by: 04

## Question

按 01 的映射迁移 controllers/sessions.ts（约 10 处 `hub.settings.…`）与 projection.ts
（`hub.agent.sessionManager` + `agentState().session`）：全部改走 Agent 公开方法（或 hub 转发），
server 侧不再出现 Manager 类型。

## Answer

机械迁移已随票 04 落地（记录在那边的 Answer 里）：controllers 的 `hub.settings.…` 十处改走
`hub.agent` 门面、`settingsOf` 改吃 `Settings` 纯数据、`listSessions` 自由函数改收 `Agent`；
projection 的 `sessionManager` + `agentState().session` 直读清零，改走 `titleOf` / `timestampOf` /
`messageRoleOf` / `findSessionRowById` / `listDirectories`。本票收尾时按票 03 的禁名单口径全量
核对过：`packages/server/src` 的 import 与成员访问均为零，仅剩方法形态 `.settings(`
（`agent.settings(…)` 与 controller 自己的 `settings()`），属守卫的排除项。本票做的是剩下的
注释改写，零行为变更：

### controllers/sessions.ts

- `SystemController` 类文档「read-only views of something the hub already owns」→ orchestrator
  拥有、hub 只向门面转发而不拥有任何一样（ADR-0017）。
- `SessionController` 类文档「a thin call onto the session the hub holds」→「onto the
  orchestrator, under the claim the hub holds」——hub 持的是 claim/host，会话是编排层的。
- `updateSettings` 行内「The rows are the hub's, read fresh」→ orchestrator 的行、经门面现读。
- `restoreDirectory` 文档「the settings state the hub's visibility rule reads」补上
  「through the facade」，并顺手修复该行丢失缩进的残缺（单空格顶格）。
- `rename` 文档「The store's own shortening rule」→「The shortening rule the derived title
  follows」——规则在 core（`shortenTitle`），与派生标题同一条，不存在一个「store」。
- `branch` 文档「the store is not rewritten, only the leaf moves」→「the log is not rewritten」，
  与压缩那节的口径一致：JSONL 只追加、永不重写。

### projection.ts

- 类文档「sessions are created and appended through the hub」→「by the one orchestrator the hub
  commands (ADR-0017)」——追加发生在 core 的循环里，不经 hub 之手。
- `probe` 文档「dropped into the store by hand … reads every store's headers」→ 盘上口径
  「dropped onto disk by hand … every file's headers」。
- `groups()` 行内「Grouped by the store's own rule」→「the same core rule the facade's scan
  follows」——规则是 core 导出的 `groupSessionsByDirectory`，门面扫描与 projection 共用。
- 票 04 已把 `onEvent` 窄读处的注释写成门面口径（「the orchestrator's facade over the bag …」），
  原样保留。
- 顺手：删去 `LiveFields` 与 `ROW_FIELDS` 之间多出的两个空行，补上文件末尾缺失的换行
  （旧文件 EOF 无 LF）。

### 验证

`npm run check` 绿（tokens ok）；smoke-api / smoke-projection / tools / models / sessions /
settings / boot / session / mux / mux-client / mux-live / liveness / backpressure / modes /
default-model / approval-endpoint / approval-recovery / approval 逐条 PASS
（smoke-approval 的预存在闪失本轮未出现）。
