# 0010：把 `packages/llm` 折叠进 core——全树只剩一个 `Context` 与一个 `Tool`

日期：2026-11-06 · 状态：已接受，**已落地**（01–04 号票；`check` 与 `build:web` 绿，smoke 逐条与改动前的
树对照零新红——`smoke-api` 要一只在跑的服务器，`smoke-liveness` 的时序断言在本机改动前后同为红，见
[04 号票](../../.scratch/context-tool-unification/issues/04-final-acceptance.md)；零行为变化）
取代：[0007](0007-loop-merged-into-agent.md)（部分——决定 6 里 `LoopContext` → `AgentContext` 的命名，
以及「工具与上下文的形状也住在 `core/src/types.ts`」那一半；还有其*被取代的是什么*一节里
「`packages/llm` 仍原样适用……也**没有**被并入任何人」这句现状陈述）
取代者：[0011](0011-tool-manager-instance-table.md)（部分，2026-11-06——*后果* 里「一次请求只有一个
`Context` 穿过边界」那条中「`prepareRequest` 建它（`tools` 就是活跃的可执行集合）、引擎用它」这句
现状陈述；决定 2/3/7 全部成立）
取代者：分层重构步 4（spec §2.3/§8.6，2026-11-21；ADR-0030 五模块分层随步 5 落笔）——部分：决定 2 的
住址半与决定 4 的出口半（见各条下的注记）。`Context` 留 llm（传输机械）不变；`Tool` 与消息词汇自
`llm/types.ts` 迁 agent 根 `types.ts` 共享内核（`ToolRunContext` 随行），「core 顶层只转发名字」的
出口改由 domain index 承担。决定的实质——一个概念一个类型、传输只读声明——原样成立。

设计过程见 `.scratch/context-tool-unification/`（形状在 2026-11-05 的绘图会话里盘问定案，四张票是执行票，
逐条不得推翻）。

## 背景

`packages/llm` 是 `@earendil-works/pi-ai` 0.99.2 的 vendored 副本：一个独立的 workspace 成员、自己的
package.json 与 tsconfig、根 tsconfig 里两条 `@my-agent/llm` 路径别名、`npm run check` 的一棒、
`install-deps` 里一行硬编码的 workspace 表，以及 27 个源文件里 25 个逐文件 `@ts-nocheck`。

它当初值得一个包，理由和 `packages/loop` 一样（[ADR-0001](0001-transport-websocket-mux.md) 把两者一起
写成「一行都不改」）：**vendored 副本的价值在于能对着上游 diff**。这条理由在
[0007](0007-loop-merged-into-agent.md) 决定 9 那里被放弃了一半（loop 那一半），2026-11-03 用户拍板把
另一半也解除——上游对照放弃之后，这份代码由本仓库自己维护。于是它剩下的身份只是「一份我们维护的
代码」，包边界从此只买到一个**独立的编译设置**，别的什么都不买。而那个设置本身也不是护栏：文件已经被
裁到只剩本项目真正调用的部分，`@ts-nocheck` 又把它们逐条豁免了。

真正的问题不是包，是**同一件事有两个名字，而分界画在了「谁执行」上**：

- **`Tool` 是两层。** llm 的 `Tool` 只有声明（`name` / `description` / `parameters` /
  `constrainedSampling`），core 的 `AgentTool` 是 `extends Tool<TParameters>` 再加执行（`label` /
  `prepareArguments` / `outputSchema` / `execute` / `replay` / `executionMode`）——一个概念、两个类型、
  一条继承边。后果不是「加字段要写两遍」，而是**执行那一族在声明那一侧根本不存在**：`outputSchema`、
  `label`、`execute` 只有引擎看得见，请求那一侧永远读不到；「一个工具是什么」因此被拆成两个视角，
  谁都不能单独回答。
- **一次请求有两个 `Context`，差在一个字段的元素类型上。** llm 的 `LlmContext` 是 `Context` +
  `tools?: Tool[]`，core 的 `AgentContext` 是 `Context` + `tools?: AgentTool[]`。同一个 `tools`，
  两种元素类型，中间靠 `toToolDeclaration` 把可执行的削成声明的——那一步存在的唯一理由，就是这两个
  形状不是同一个形状。
- **名字还撞车。** `AgentToolCall` 把 `Extract<AssistantMessage["content"][number], { type: "toolCall" }>`
  重写了一遍；`AgentToolResult` / `AgentToolUpdateCallback` / `AgentToolCallOutcome` 是 core 给结果那
  一家起的第二套名字（`ToolResult` / `ToolUpdateCallback` / `ToolCallOutcome`）。读代码的人要先学会
  两套词汇，才知道说的是同一件事。

## 决定

1. **目录整体搬进 `packages/core/src/llm/`**，内部结构不动（`api/`、`model.ts`、`models.ts`、
   `types.ts`、`utils/`、`index.ts`）。同时撤销：workspace 成员资格、llm 自己的 package.json 与
   tsconfig、根 tsconfig 的两条别名、`npm run check` 的那一棒、`install-deps` 的 workspace 表。
   llm 的两个第三方依赖（`@anthropic-ai/sdk`、`partial-json`）并入 core 的依赖表。
2. **`Tool` 合一，住在 `llm/types.ts`**：声明字段与可执行字段是同一个类型，双泛型
   `<TParameters, TDetails>` 原样保留。`ToolExecutionMode` 随 `executionMode` 字段一起搬进去。

   **（2026-11-21 Superseded，分层重构步 4，spec §2.3/§8.6：仅住址——`Tool`、`ToolRunContext` 与
   消息词汇（`Message` 一族、`Usage` / `StopReason` / JSON 词汇、模型事实族）被 session / context
   等子包消费，自 `llm/types.ts` 迁 agent 根 `types.ts` 独占（共享内核，守卫 R2：子包只准 import
   根 types.ts）。`Context` 留 `llm/types.ts`——它是传输机械。合一的实质不变：仍是同一个类型，
   传输读声明半、引擎用执行半。）**
3. **`Context` 合一**：`messages` + `system` + **必填**的 `tools: Tool[]`（空数组合法，省掉这个字段
   不合法）。`LlmContext` 删除，`ChatTransport.stream` / `StreamFunction` / `Model.stream` 直接收它。
   必填的直接后果是三处无工具请求补 `tools: []`——压缩摘要那次请求，以及 smoke 的两处 wire 捕获。
4. **`Agent` 前缀从撞名处清零**：core 的 `types.ts` 删掉那些撞名的定义，改为 re-export 单一名字
   （`Context` / `Tool` / `ToolResult` / `ToolUpdateCallback` / `ToolExecutionMode`）；`AgentToolCall`
   删除，调用点改用 `ToolCall`。`AgentEvent`、`AgentState` 等不与 llm 撞名的会话层词留在原处，不动。
   一个例外：`ToolCallOutcome`（`{ toolCall, result, isError }`，钩子跑完之后的定稿）**留在
   `types.ts`**，而绘图会话当时的名单把它列进了 `llm/types.ts`。落地时它只有 `Agent` 一个读者，
   搬进传输契约会与下面那条保留下来的分界（0007 决定 6：引擎契约住 `types.ts`）打架；04 号票复核
   确认这个位置成立，所以记在这里而不是改代码。

   **（2026-11-21 Superseded，分层重构步 4，spec §8.6：仅出口半——「core 顶层只转发名字」的出口改由
   domain 的 `index.ts` 承担；根 `types.ts` 自身成为共享内核的定义处（`Tool` 等在此定义），不再只
   转发。撞名清零的决定原样成立。）**
5. **`@my-agent/llm` 全仓清零**：core 顶层 `index.ts` 补一段传输面出口（`anthropicMessages`、`Model`、
   `createAssistantMessageEventStream`、`ChatTransport` 等），server（`boot.ts` / `hub.ts`）与当时导入
   它的 7 个 script 改从 `@my-agent/core` 取。不设「别名指回内部路径」的假包名。
6. **`@ts-nocheck` 原样保留。** 这是机械搬运，不是转正：零行为的红线要求它留在原处，转正另开 effort。
7. **传输层看得见 `execute`，但不调用它。** 合并之后两者在同一边，接口面上没有任何东西阻止一次请求
   去执行一个工具；「请求只读 `name` / `description` / `parameters` / `constrainedSampling`」写在
   `llm/types.ts` 的注释、`api/anthropic-messages.ts` 的读法与这份 ADR 里。

   **（2026-11-21 修订，分层重构步 4，spec §8.6：注释住址随 `Tool` 搬家——那条「传输只读声明」的
   注释现住在 agent 根 `types.ts` 里 `Tool` 的文档上；`llm/types.ts` 与 `api/anthropic-messages.ts`
   的读法不变。）**

## 后果

换来的：

- **一个概念一个类型。** 工具的声明与执行是同一个 `Tool` 的两组字段，一次请求是同一个 `Context`。
  `toToolDeclaration` 仍然是削薄的那一步，但它现在削的是同一个类型的字段，而不是翻译成另一个类型。
- **一次请求只有一个 `Context` 穿过边界。** `prepareRequest` 建它（`tools` 就是活跃的可执行集合）、
  引擎用它、`streamAssistantResponse` 削薄它的 `tools`、传输层读它——没有第二种形状要在中途换算。

  **（2026-11-06 Superseded，[0011](0011-tool-manager-instance-table.md)：仅「`tools` 就是活跃的可执行
  集合、引擎用它」这句现状陈述——`tools` 今天是声明载体（元素是工具表里的实例、按本轮名单取子集），
  引擎执行经 `ToolManager`。一次请求一个 `Context` 的形状不变。）**
- **依赖图少一层。** core 的依赖表里不再有 workspace 内部包；server 与 script 的 import 回到唯一的
  公开出口 `@my-agent/core`，core 自己的那 16 处改用相对路径，不再有一个只有本仓库认识的包名。
- **三处配置账消失。** workspace 清单、两条 path 别名、`check` 的一棒；`install-deps` 的硬编码表
  同步撤掉一行。

背上的：

- **职责边界只剩约定。** 从前「传输层在另一个包，它看不见 `execute`」是一句类型能保证的话；现在它
  只是一句注释。这是折叠最直接的一项代价，也是它值得被记下来的理由：以后再想「让请求顺手跑一下这个
  工具」，类型系统不会拦。
- **类型检查的屏障换了形状。** 从前 llm 在另一个包的编译设置下，进入 core 的 import 由根 tsconfig
  检查；现在这些文件就在 core 的 `include` 里，逐文件 `@ts-nocheck` 是唯一的屏障。去掉任何一个文件的
  nocheck，它立刻暴露在 `noUncheckedIndexedAccess` 之下——那是另一笔工作，不在本 effort 内。
- **`toToolDeclaration` 的类型不再诚实。** 它返回只有声明字段的对象却标 `→ Tool`；合并前那个对象恰好
  就是 llm 的 `Tool`（本来只有声明字段），所以标注是对的。现在它缺 `label` 与必填的 `execute`，
  靠 `@ts-nocheck` 编译通过。行为正确（传输层确实只读声明字段），但类型在这一处说了谎——修它要么
  补字段、要么给传输层一个自己的窄类型，两者都超出「零行为」。

## 不可逆性与代价

三条门槛逐条成立：

- **难逆转。** 回去要重开一个包、恢复 workspace 成员与两份 tsconfig、找回两条别名与 `check` 的一棒、
  把 27 个文件再搬出去，再把 server 与 script 的 import 改回包名、core 的 16 处相对路径换掉。更麻烦的
  是 `Tool` 与 `Context` 已经合一：拆回去等于把刚删掉的第二个类型重新发明一次，还要重新决定每个字段
  归哪一半——而「哪一半」正是这次被证明没有答案的那个问题。
- **没有上下文会让人困惑。** 后来的人会在 core 的源码树里撞见一份「pi-ai 的裁剪副本」：一个 vendored
  传输层住在我们自己的包里，头顶上还写着「Vendored from」。第一反应必然是「为什么不独立成包」。
  这份 ADR 就是那个「为什么」。
- **是真实取舍。** 放弃的是「同一份代码的两个编译设置」和「一个能与上游对齐的目录」（后者在 0007 就
  已经放弃，这里只是把它的余账结掉）；换来的是「一棵树里一个概念一个类型」。前者本来就在漏——裁过的
  文件加逐文件 nocheck，那个独立设置没拦住过任何东西；后者是每天都在付的账。

## 被取代的是什么

- **0007 决定 6 的两处。** 那一条把 `LoopContext` 改名 `AgentContext`（理由是「与 `AgentEvent` /
  `AgentTool` 同族」），并把类型并进 `core/src/types.ts` 一个模块。现在撞名的类型不存在了，`Context`
  与 `Tool` 住在 `llm/types.ts`，`types.ts` 只转发名字；`AgentEvent` / `AgentState` 留着，但它们属于
  会话层，不再是「一族」里的另一半。**决定 6 的另一半仍然成立**：引擎自己的契约（`AgentEvent`、闸门与
  恢复的答案形状、`QueueMode`）仍住 `types.ts`，wire 类型仍不进那里。
- **0007 *被取代的是什么* 一节里的现状陈述**：「`packages/llm` 仍原样适用……仍在 `packages/llm` 里、
  仍然 vendored、也**没有**被并入任何人」。它的前半段（llm 半条禁令已于 2026-11-03 失效）已经写下，
  这一句现在也不再成立：它被并入了 `core`。**上游对照放弃是因，折叠是果**——只有当这份副本不必再保持
  「与上游逐文件同形」时，它才有资格住进我们的目录、用我们的类型；0007 放弃对照，正是这次折叠的
  许可条件。
- **架构里「运行时依赖是两个包：`@my-agent/llm`、`typebox`」这句话**：core 的依赖表不再有 workspace
  内部包，第三方是 `@anthropic-ai/sdk`、`partial-json`、`typebox`。

## 没有被取代的

明确不动、读者不该跟着本 ADR 一起重开的：

- **零行为。** wire 协议、事件流、工具语义一个字不动；`npm run check`、smoke 全套、`build:web` 是每张票的
  验收线，合并前后**逐条同色**（28 条里 26 条两边同为绿；`smoke-api` 要一只在跑的服务器才绿，
  `smoke-liveness` 的时序断言在本机改动前后同为红——两条都与本 ADR 无关，见 04 号票）。
- **`@ts-nocheck`**：留下。0007 决定 7 是「去掉它」，这一次是「不动它」——搬目录不等于转正，把 27 个
  文件过一遍严格配置是另一笔工作。
- **0007 决定 6 的分界**：类型不进 `protocol.ts`。wire 是客户端看得见的东西，引擎交给工具与 hook 的
  形状不是；合并后的 `Context` / `Tool` 住在传输层自己的 `llm/types.ts`，core 顶层只转发名字。
- **`Tool` 的字段与语义**：`executionMode`、`replay`、`outputSchema`、`prepareArguments`、`details`、
  `structuredContent` 原样，执行模式仍是每个工具上的字段而不是注册表状态。
- **[ADR-0001](0001-transport-websocket-mux.md) 的其余全部**：REST 命令面 + 常驻 WebSocket mux、有界
  写侧、`claim` 与订阅分离，不引入 plugin / MCP。
- **传输层「只说 Anthropic Messages、一行就是一个端点加一个密钥」的形状**，以及六个工具、工具目录、
  写边界归档、审批闸门。
