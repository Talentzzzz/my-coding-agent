# 04 - 活跃集与审批的归属：Map 装全部还是只装活跃

Type: grilling
Status: open

## Question

定案 1 说「虽然不同 session 用不同工具，但都是通过 ToolManager」。今天「这一轮能调哪些、
哪些要问」是从账本派生的纯数据 `ToolState`（`session/tool-config.ts` 的 `toolStateOf` /
`followsGlobalOf` / `globalDefaultToolState` / `defaultToolNames`），目录只答「存在什么」；
`fanout.ts:27` 的 `SessionServices.tools` 也带着同一只目录。AGENTS.md 的 tool set 词条写明
「它是状态，绝不是对话」，写在会话 `.json` 快照的 `activeTools` / `approval` 字段里。

请裁决：

- **(a)** Manager 只管「存在什么 + 按名字取实例」，Map 恒装全部实例；活跃集与审批仍由账本派生、
  Agent 决定本轮名单；`SessionServices.tools` 换成 `ToolManager` 但不给它会话状态。
- **(b)** Manager 接管活跃集：`active(state, run)` 移进 Manager，`toolStateOf` / `followsGlobalOf` /
  `defaultToolNames` 一起收编，Agent 只问 Manager 要本轮声明与执行集。
- **(c)** Map 只装**当前活跃**工具（懒加载按 session 的活跃名单建），「不同 session 用不同工具」
  直接体现在 Map 内容上；需回答多会话并发与会话切换时怎么换出。

并定两处读点改从哪只门读：`agent.ts:528` `setActiveTools` 的未知名校验（`new Set(this.tools.names())`）、
`fanout.ts:85` `snapshotOf` 的 `allTools: services.tools.names()`。

➡️ 推荐 **(a)**。定案 1 的「持有**所有**的 Tool」按字面即全部六个；把选择留在账本派生，
Map 就不会成为活跃集的第二个写者（这条判据不因 ADR-0011 被反转而失效）。
(c) 让一张 Map 承载 per-session 状态，正是 02 号票并发问题的放大器。
