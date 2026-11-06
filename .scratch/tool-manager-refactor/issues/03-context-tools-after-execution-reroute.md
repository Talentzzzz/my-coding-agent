# 03 - 执行改道后 Context.tools 的命运

Type: grilling
Status: open
Blocked by: 02

## Question

定案 2 要求「执行也改道 Manager」。今天引擎的工具全部读 `Context.tools`
（ADR-0015 定为**必填 wire 字段**）：`agent.ts:1288` 每请求 `active()` 现建、
`:1849` `toToolDeclaration` 削薄声明、`:2091` `executionMode`、`:2272` `find`、
`:2402` `execute`、`:1534` 压缩摘要 `tools: []`、`:2020` 恢复机器 `recoverPendingToolCalls`、
`:2376` `runToolCall`。ADR-0015 决定 7 还写明「传输层看得见 `execute`，但不调用它」。

请裁决：

- **(a)** `Context.tools` 保留为**声明载体**——放 Map 里实例的引用（或声明视图）给传输层，
  所有查找与执行改走 `manager.get(name)` / Manager 的执行入口；字段仍必填，线协议零改动。
- **(b)** 从 `Context` 删掉 `tools`，传输层的声明改从 Manager 现取；要改 `llm/types.ts` 的
  `Context`、`streamAssistantResponse` 的 `stream` 调用形状与 ADR-0015。
- **(c)** `Context.tools` 仍旧每请求现建，只有执行查找走 Manager；Map 只服务执行、声明仍走工厂，
  等于两套工具来源。

并逐条点名改道覆盖的调用点（`executeToolCalls` / `prepareToolCall` /
`prepareToolCallArguments` / `executePreparedToolCall` / `recoverPendingToolCalls` /
`runToolCall` / 压缩摘要 / `streamAssistantResponse`），以及「Manager 是否也 owns `execute` 本身」
（即 `Tool.execute` 还在 Tool 上，还是搬到 Manager 的方法里）。

➡️ 推荐 **(a)**：改道覆盖全部执行调用点，但 `toToolDeclaration` 仍从 `Context.tools` 读声明，
传输层零改动。(c) 会留下两份工具来源，(b) 把一次 core 重构升级成 wire 重构、面铺得太大。
