# 12：hub 适配——pending / reap / evict 与新生命周期

Type: task
Status: open
Blocked by: 03, 04, 08

## Question

把 `SessionHub` 的三张表与两段计时器对齐到「打开即建、切走即清」。

- **`pending` 删除**（03 号票）：`has()` / `snapshotOf()` / `open()` 判据改为「Agent 的表里有，或磁盘上有」；
  `sessionOptions` 不再传 `openSessions`，改为在 `open()` 里 `agent.adopt(createAgentState(...))`。
- **`hosts`**：现在 `HostedSession` 就是「这个进程跑着它 + 有几个 claim + 正在 reap」。表本身可以留（它是
  claim 的计数器），但要定它和 `AgentState` 谁是「会话在跑」的判据——推荐 `hosts` 留、`AgentState` 的存亡
  跟随 `hosts` 的增删，两者同生同灭。
- **`evict`**：`Agent` 新增公开 `evict(id): boolean`，内部判 `live.activeRun === undefined && live.suspended === false`
  （04 号票），不满足返回 false；`hub` 在**最后一个 observer 离开**时调它（`observers` 的 `delete` 点）。
  `reap` 里现有的「settle → 有审批就等宽限 → 再 settle → 删 host → close」按 04 号票的答案删减。
- **`remove` / `close`** 两条路径同步改：`openSessions.delete` → `agent.evict`（或直接 `sessions.delete`，
  这两处是宿主收摊，不需要判据）。
- **`agentState(id)` 公开读法**：`projection.ts` 与 `feedsOf` 要读活会话的袋，别把 Map 露出去。
- 收账：`npm run check` 绿；`smoke-api` / `smoke-mux` / `smoke-sessions` / `smoke-liveness` /
  `smoke-desktop-close` / `smoke-desktop-observability` 绿。

## Answer
