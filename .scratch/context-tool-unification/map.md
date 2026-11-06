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
- [02](issues/02-single-context-tool.md) resolved(本笔):`Tool`/`Context` 合一落进
  `core/src/llm/types.ts`,`LlmContext` 与全部 Agent 撞名前缀清零,`Context.tools` 必填;
  check+smoke 全套绿、零行为变化;docs 引用同 01 留给 03;`toToolDeclaration` 的类型诚实性
  后果留观(票 Answer 有记)。
- [03](issues/03-docs-and-adr.md) resolved(本笔):文档收账——新 ADR 0015(llm 折叠进 core + 全树
  单一 `Context`/`Tool`:三层重复声明是痛因、传输层「看见 execute 但不调用」是取舍、与 0008 的
  因果是折叠的许可条件),`docs/adr/README` 补清单行、0008 头部加「取代者」前向指针;
  architecture.md 逐句核到新形状(职责段、依赖段、目录布局、package 表、请求流程、工具契约、重试、
  外壳、偏离表),AGENTS.md 布局与术语表(tool/model/transport/engine),README 导语,notes.md 加
  2026-11-06 补。验收 grep 在 architecture/AGENTS/README 清零,剩余 37 处全在 ADR 历史叙述、
  0015 引用旧决策与 notes 第一节「结论清单」(按票 14 同类扩免);check 绿,smoke 全套留给 04。
  留观:折叠文件的头注释「every import into packages/core stays fully checked」已不成立(04 号票数过,
  实为 **23** 个,票 03 记的 25 是估的),加上两处仍把 `core/src/llm/` 叫作「this package」的句子
  (`llm/index.ts` 开头的注释、`llm/model.ts` 的 `transport` 字段注释),一并等微票。
- [04](issues/04-final-acceptance.md) resolved(本笔):终验过关,图收口。`npm run check` 绿
  (137/111 token);`build:web` 绿;清零断言成立——`packages/`、`scripts/`、配置 0 处,`packages/llm`
  目录不存在,全仓剩余 37 处全在 ADR 历史叙述与 notes(与票 03 的账逐条一致)。smoke 28 条改成
  **与改动前那棵树(511fc09)同机同环境对跑**:两边同为 26 绿 + 2 红(`smoke-api` 无服务器、
  `smoke-liveness` 时序断言),起服务器后 `smoke-api` 两边都 ok,故零新红;`smoke-tools` 223 行输出
  逐字节相同,25/28 份日志完全相同、3 份差异逐份归因(随机端口/id、基线树缺 `dist`、宿主 fs 垫片偶发崩)。
  「目的地达成」的判据全部落在实测上,不再引用文字记录。ADR-0015 状态行与验收句按实测收紧。
  code-review 双轴:Standards 零硬违规(6 条判断项,均已判为风格或本就有意,见票 Answer);
  Spec 轴抓到一处**定案偏离**——`ToolCallOutcome` 住在 `types.ts` 而不是定案 3 点名的 `llm/types.ts`。
  复核后判定「不动代码、记进 ADR」:它只有 `Agent` 一个读者,是引擎的定稿形状,搬进传输契约会与
  0008 决定 6 保留下来的分界打架;ADR-0015 决定 4 已补这一笔。另:前三条票记的「smoke 全套绿」是
  当时的实测,今天 `smoke-liveness` 在本机复现为红(改动前后同红),口径以本条的对照为准。

## Not yet specified

- 执行期若 `@ts-nocheck` 文件里浮出隐藏类型错、或 smoke 暴露与行为耦合的接缝:先按零行为红线
  绕行(保留现状语义),若绕不过去,在对应票 Comments 登记并升级成新票,不得顺手改行为。
- `ToolResultMessage` / `estimate.ts` 等 llm 侧泛型与 utils 在合并落点上的最终摆放——机械,
  跟着票 02 走,不单独设票;若发现撞名或语义纠缠再 graduate。
- **登记(04 号票升级,本图不做)**:`smoke-liveness` 的
  `within three of the heartbeats it was promised…` 这条断言在本机改动前后同为红(实测 ~2.0 s
  对 1.65 s 预算,去掉宿主垫片也红)。修它要么动客户端判活、要么动断言预算,两边都越过零行为红线,
  留待下一次专门处理。同理 `smoke-api` 要一只在跑的服务器才算绿,属 rig 的环境依赖,不在本图。

## Out of scope

- `@ts-nocheck` 转正补类型:违反零行为红线,工作量不可预估,另开 effort。
- `AgentEvent`、`AgentState` 等其余 Agent 前缀名:不与 llm 撞名,是会话层自己的词,不属于本次
  「消灭重复」的靶子。
- 任何行为变化(execute 签名调整、ToolResult 字段增删等):另开 effort。
