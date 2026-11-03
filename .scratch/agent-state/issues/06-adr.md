# 06：ADR——Agent 持有会话状态

Type: task
Status: open
Blocked by: 01, 02, 03, 04, 05

## Question

写 `docs/adr/0011-agent-holds-session-state.md`，并把被它推翻的文字改对。

ADR 要记的（按 01–05 的答案落笔）：

- **决定**：会话状态从 hub 的登记处搬进 `Agent` 的一张 `Map<id, AgentState>`；`Agent` 仍是进程唯一单例，
  仍是编排层，只是多一个 Map 属性；`SessionManager` / `SettingsManager` 不再持有任何缓存。
- **代价**：`jsonlEntries` 常驻内存（原本每请求重放）；同目录两个活会话各有一份设置快照；驱逐会丢队列。
- **被放弃的选项**：保持无状态 + 每请求重放（ADR-0006 B 路线）；表留在 hub、Agent 只借读。
- **不做的事**：不是把 `Agent` 变成 per-session 实例（ADR-0006 的 A 路线仍然否掉）。

要改的文字：

- `docs/adr/0007-services-drop-instance-state.md` §4 / §6：「登记处只装磁盘上没有的东西」「Agent 不持有会话
  状态」两句标 Superseded，指到 0011；§3 关于 `SessionManager` state 的表述同时失效。
- `AGENTS.md` `## 术语`：**service**（无属性服务）为 Agent 破例并写清破例范围；**OpenSessions** 整条换成
  **AgentState**；**assembly**（种子→补齐）改写为「打开即建、切走即清」；**claim** 条目补一句驱逐不拿 claim。
- `docs/architecture.md`：:19（core 段）、:21（server 段）、:67（Agent 段）、:259（hub 段）、:266 的图，五处。
- `docs/adr/README.md` 清单行；`README.md` 若提到登记处。
- 0011 自己的状态行：落地前写「尚未落地」，14 号票完成后翻转。

## Answer
