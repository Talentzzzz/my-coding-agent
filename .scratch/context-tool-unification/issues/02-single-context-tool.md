# 02 单一 Context/Tool:类型合并与前缀清零

Type: task
Status: open
Blocked by: 01

## Question

在折叠后的 `core/src/llm/types.ts` 里完成类型合并,把 `Agent*` 前缀从全仓清零——本票做完,
全树只剩一个 `Context`、一个 `Tool`,`LlmContext` 不存在,行为零变化。

范围(定案 3、4、6):

- `Tool` 合并:llm 的声明(name/description/parameters/constrainedSampling)与 core
  `AgentTool` 的扩展(label/prepareArguments/outputSchema/execute/replay/executionMode,
  含 `<TParameters, TDetails>` 双泛型)合成一个 `Tool`,住在 `core/src/llm/types.ts`;
- `Context` 合并:messages + system + **必填** `tools: Tool[]`(允许空数组);`LlmContext`
  删除,`stream(context: Context, ...)` 直接收它;传输层(api/anthropic-messages.ts、model.ts)
  只读 name/description/parameters,不调用 execute;
- core 顶层 `types.ts` 删掉 `AgentContext`/`AgentTool`/`AgentToolCall`/`AgentToolResult`/
  `AgentToolUpdateCallback`/`AgentToolCallOutcome` 的定义,改为 re-export 单一名字;
- `AgentToolCall` 直接删除——它只是 llm `ToolCall` 的别名,调用点改用 llm 的 `ToolCall`;
  `AgentToolResult`→`ToolResult`、`AgentToolUpdateCallback`→`ToolUpdateCallback`、
  `AgentToolCallOutcome`→`ToolCallOutcome`;
- 全仓调用点跟改(agent.ts、hooks.ts、tools/、protocol.ts、smoke 脚本);
- 验收:`npm run check` 绿;`grep -rn "AgentContext\|AgentTool\|LlmContext"` 全仓清零;
  smoke 全套绿。

边界:`AgentEvent`、`AgentState` 等非撞名前缀**不动**(范围外);`@ts-nocheck` 不去。
