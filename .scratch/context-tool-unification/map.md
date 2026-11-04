# Map：Context/Tool 统一(llm 折叠进 core)

Label: wayfinder:map

## Destination

全树只剩一个 `Context`、一个 `Tool`:`packages/llm` 目录整体折叠进 `packages/core/src/llm/`,
合并后的类型住 wire 契约文件,core 顶层只转发名字;`AgentContext` / `AgentTool` 等前缀名
全仓清零;`stream(context: Context, ...)` 直接收合并后的 Context。**零行为变化**——wire 协议、
事件流、工具语义一个字不动,check + smoke 全套 + build:web 全绿是每张票的验收线。

## Notes

- 绘图会话已把雾问没(2026-11-05 盘问定案),票是**执行票**(task 型),执行骑在图上走;
  每张票做完跑一遍 check,最后一张票跑 smoke 全套。
- 定案七条(绘图会话 grilling 敲定,票不得推翻,只许执行):
  1. llm 目录原样搬进 `packages/core/src/llm/`(api/、model.ts、types.ts、utils/ 结构不变),
     workspace 成员资格、llm 自己的 package.json/tsconfig、根 tsconfig 的 `@my-agent/llm`
     别名全部撤销;`npm run check` 删掉 llm 那一棒。
  2. 各文件头 `@ts-nocheck` **保留**(机械搬运,零行为);转正另开 effort,本图不碰。
  3. 合并后的 `Tool`(带 execute/label/prepareArguments/outputSchema/replay/executionMode)、
     `Context`(messages + system + **必填** `tools: Tool[]`,允许空数组)、`ToolCall`、
     `ToolResult`、`ToolUpdateCallback`、`ToolCallOutcome` 住在 `core/src/llm/types.ts`;
     core 顶层 `types.ts` 删掉 `AgentContext`/`AgentTool` 定义、re-export 单一名字。
  4. `AgentToolCall` 直接删除——它只是 llm `ToolCall` 的别名,改用 llm 的名字;
     `AgentToolResult`→`ToolResult`、`AgentToolUpdateCallback`→`ToolUpdateCallback`、
     `AgentToolCallOutcome`→`ToolCallOutcome`;llm 的 `LlmContext` 删除,
     `stream(context: Context, ...)` 收合并后的 Context,传输层只读
     name/description/parameters,不调用 execute。
  5. core、server(boot/hub)、web(state.ts)、smoke 脚本的 `@my-agent/llm` 导入全部改指
     core 出口;`@my-agent/llm` 字符串全仓清零(别名改指内部路径是假包名,禁止)。
  6. 验收红线:纯类型层重构,零行为变化;`npm run check`(含 token 审计)+ smoke 全套 +
     `build:web` 全绿。
  7. 文档收账:AGENTS.md(布局节、transport/engine 词条)、architecture.md(请求流程、wire 节)、
     一条新 ADR(llm 折叠 + 单一 Context/Tool;包边界消失,够 ADR 格)、README 布局描述同步。
- 本仓库不用 npm install,依赖解析走 `node scripts/install-deps.ts .`;折叠后重跑一次。
- 改源码只用编辑器工具,绝不走 shell 文本往返(ANSI 代码页会毁 UTF-8)。

## Decisions so far

- [01](issues/01-llm-fold-and-imports.md) resolved(045140a):llm 目录折叠进 `packages/core/src/llm/`,
  全树改线完毕,check+smoke 绿、零行为变化;docs 引用留给 03。前置:工作区在制的
  loop-manager/SettingManager 线先原样入库(511fc09)。

## Not yet specified

- 执行期若 `@ts-nocheck` 文件里浮出隐藏类型错、或 smoke 暴露与行为耦合的接缝:先按零行为红线
  绕行(保留现状语义),若绕不过去,在对应票 Comments 登记并升级成新票,不得顺手改行为。
- `ToolResultMessage` / `estimate.ts` 等 llm 侧泛型与 utils 在合并落点上的最终摆放——机械,
  跟着票 02 走,不单独设票;若发现撞名或语义纠缠再 graduate。

## Out of scope

- `@ts-nocheck` 转正补类型:违反零行为红线,工作量不可预估,另开 effort。
- `AgentEvent`、`AgentState` 等其余 Agent 前缀名:不与 llm 撞名,是会话层自己的词,不属于本次
  「消灭重复」的靶子。
- 任何行为变化(execute 签名调整、ToolResult 字段增删等):另开 effort。
