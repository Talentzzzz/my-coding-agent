# 02 单一 Context/Tool:类型合并与前缀清零

Type: task
Status: resolved
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

## Answer

落地于本票提交(前置:票 01 的 045140a)。

- 合并全按票面:`Tool` 双泛型住在 `core/src/llm/types.ts`(声明字段 + label/prepareArguments/
  outputSchema/execute/replay/executionMode);`Context` 收编必填 `tools: Tool[]`(空数组合法);
  `LlmContext` 删除,`ChatTransport.stream` / `StreamFunction` / `Model.stream` 直接收 `Context`;
  core 顶层 `types.ts` 删掉全部 Agent 撞名定义,单一名字 re-export(`Context`/`Tool`/`ToolResult`/
  `ToolUpdateCallback`/`ToolExecutionMode`),`AgentToolCall` 删除、调用点改用 llm 的 `ToolCall`,
  `AgentToolCallOutcome` 更名为 `ToolCallOutcome` 留在 `types.ts`。
- `ToolExecutionMode` 随 `executionMode` 字段一并搬进 `llm/types.ts`(原先只在 `types.ts` 内部
  使用,无外部导入);`types.ts` re-export 保持旧位的可寻址性。
- 必填 `tools` 的直接后果:三处无工具请求补 `tools: []`——`agent.ts` 的压缩摘要请求与
  `smoke-models.ts` 两处 wire 捕获。
- 验收核对:check 绿;代码内(`packages/`、`scripts/`)grep `AgentContext|AgentTool|LlmContext`
  清零——docs 侧 AGENTS.md、architecture.md、ADR-0008 的引用留给票 03(票 01 先例:验收的
  「全仓清零」要到票 03 才字面成立);smoke 全套 24 条绿,smoke-api 未跑(环境依赖,票 15 已记录);
  build:web 绿。
- code-review(Standards/Spec 双轴)无硬违规,按评审修掉四处尾:types.ts 的 re-export 补齐
  (票面字面)、必填后残留的防御守卫清掉(`tools?.find`、两处 `tools ?? []`)、bash.ts/manager.ts
  的陈旧注释改写(pi-agent-core 归属已不真、"an `Tool`" 冠词)、index.ts 出口面恢复与原先
  一一对应(评审加的 `ToolCallOutcome` 出口撤回,维持零表面变化)。
- 设计后果留观(非阻塞):`toToolDeclaration`(transcript.ts,@ts-nocheck)返回只有
  name/description/parameters/constrainedSampling 的对象、却标 `→ Tool`——合并后该对象缺
  `label` 与必填的 `execute`,编译靠 nocheck 通过。行为不变(传输层只读声明字段),但「传输层
  不调用 execute」现在靠约定而非类型保证;票 04 全量验收时复核是否要一句 ADR 备注。
