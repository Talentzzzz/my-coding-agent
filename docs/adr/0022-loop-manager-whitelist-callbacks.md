# 0022：把一次运行搬回 `LoopManager`——零字段对象、白名单回调、单个 `loopOptions`

日期：2026-11-11 · 状态：已接受（wayfinder 票 003 与用户逐项答辩后拍板；落地归票 004 / 005，见 `.scratch/wayfinder/loop-extraction/`）
取代：[0014](0014-loop-manager-removed.md) 的**全部决定**——作为裁决与理由（决定 1–5 与「后果」一节里零层间接等三条收益的判词）；其中决定 3 / 5 留下的装配形状由本 ADR 在 0017 的理由下**重新确认**，不是 0014 继续有效（逐条见*被取代的是什么*）。亦部分取代 [0008](0008-loop-merged-into-agent.md)——0014 复活的决定 1/2 再次作废；0008 的其余决定与那句「没有信息的对象」判词不动，后者仍是本 ADR 的试金石
复活：[0012](0012-loop-manager-object.md) 的**文件分区**——决定 1（一次运行的全部是 `LoopManager` 的方法、住 `loop-manager.ts`）、决定 2 的判据（值层面不 import `agent.ts`，由票 005 机器化），以及决定 3/5/6/7 里 0014 自己承认「内容仍然有效」的那几件（共享 fanout 住 `session/fanout.ts`、`Agent` 留会话不是运行、`abort` / `settle` / `close` 不搬、事件类型住 `session/events.ts`、恢复机器保持导出）；**不复活**决定 2 的「自带六件依赖」、决定 4 的构造注入与 `LoopManagerConfig`、决定 7 新增的 `index.ts` 两个出口。[0013](0013-loop-services-are-arguments.md) 的**零字段与参数化**结论同样回来（六件服务随调用递进），但形状是单只 `loopOptions`，不复活 `LoopServices` 的名字与十二签名。复活的是结论，**不是 ADR 状态**：0012 / 0013 仍标「已由 0014 取代」，取代者指针不回退（编号规则只增不改）
取代者：无

设计过程见 `.scratch/wayfinder/loop-extraction/`（票 001 盘点、票 002 答辩、票 003 起草与接受）；定下的词见 [CONTEXT.md](../../CONTEXT.md)。

## 背景

同一批代码，这是第四次搬：0008（11-02）删掉 `Loop` 与 `packages/loop`、引擎并进 `agent.ts`；0012（11-04 下午）把一次运行抽成 `LoopManager`、自带六件依赖；0013（当晚）证明这个类没有任何状态，把六件改成每次调用的参数；0014（同日）据此删掉对象，判词是一句「**一个不持有任何东西的对象，唯一的作用是给 1900 行方法提供一个 `this`**」，而 `Agent` 已经是这样一个 `this`——它正好持有那六件。0014 自己写下了代价：`agent.ts` 2658 行，读一段代码要先判断它是运行的还是会话的，分界只是文件里的两个小节标题（`// the engine` 与上面的命令面）。

到本 ADR 之前（票 001 在 c667b9f 上盘点）：`agent.ts` 2947 行，其中 run 一族 ≈1805 行（**61%**）——18 个成员方法（1122–1994）加文件级机件（2016–2947）。编排层语义访问点 7 类 12 处，loop 可自答 6 类 ≈25 处，恰好是 0012 六件依赖的形状。用户这一轮把目标钉成一句话：**结构模块清晰——读 loop 只看一个文件**。这不是 0014 漏掉的事实，是取舍的天平换了：0014 买的是零层间接，这次买的是分区。

### 正面回答 0014 的判据

0014 的推理链是「对象持有六件服务 → 0013 削成零字段 → 那它只剩提供 `this` → `Agent` 已经提供 `this` → 删对象」。这条链把「持有」当成对象唯一可能的价值。本次答辩三层：

1. **对象的价值不是持有，是文件地址。** 它仍然零字段——0013 的结论原样有效（一个 `LoopManager` 实例会被两个会话的 run 同时跑，任何被记住的服务都会被后进的那条换掉，症状是「写进另一个会话的文件」而不是崩溃）。但这次没有谁指望它持有东西；它存在的理由是 1805 行代码有了一个自己的文件。正当性来自用户目标，不来自状态，所以「它持有什么」不再是要害。
2. **跨边界的不再是六个服务字段，而是一条白名单。** 0012 的 `LoopManagerConfig` 六字段构造注入**不复活**；六件服务作为 loop 自己用的依赖进 `loopOptions`（0013 的参数化结论）。`Agent` 与 loop 之间真正绕回去的只有**两条白名单回调**，每条都过了 0008 的试金石「为什么不是把问题原路转回去」（逐项答辩见下节）。对象靠这两条拿到编排层语义，不靠六个字段。
3. **0008 批评的是转发形状，不是分区。** 0008 拆掉的 `Loop` 收下 `streamFn`、runtime 槽位、两个闸门、整条 `prepareRequest`、`subscribe` 和两个队列排水钩子——「引擎的每一个问题都绕回 `Agent` 回答，而这个对象唯一的职责是把问题原路转回去」。白名单把这个形状收窄到 2 条，且每条只关乎编排层语义（会话表的私有性、窗口事件契约）；其余 6 类 ≈25 处由 loop 拿六件依赖自答。0012 决定 2 的判据（值层面不 import `agent.ts`）随之复活，这一次由票 005 的静态守卫机器检查。

一句话：0014 问「这个对象持有什么」，这次答「它把什么挡在外面」；`this` 不是它的作用，文件边界才是。**分区是目的，白名单是它的价格，单个 `loopOptions` 是它的形状。**

## 决定

1. **新建 `packages/core/src/loop-manager.ts`。** 0014 决定 1 的 18 个私有方法（`run`、`runEngine`、`prepareRequest`、`runContext`、`recordSelection`、`pumpAttempts`、`retryCallbacks`、`endRetry`、`compactFor`、`trimRecordedArgs`、`clearStaleToolResults`、`toolCallHooks`、`beforeTool`、`afterTool`、`drainTranscribed`、`dispatchEvent`、`handleRunFailure`、`finishRun`）与决定 2 的文件级机械（`streamAssistantResponse`、`failToolCallsFromTruncatedMessage`、工具批次、恢复机器 `danglingToolCallsOf` / `recoverPendingToolCalls` / `synthesizeToolResult`、`pairLateToolResults`、`messagesOf`、`failureMessage` 等）**整体迁入**。0014 决定 1「唯一的机械改动」的纪律反过来同样成立：方法体的业务逻辑一字不改，只把 `this.xxx` 改写成 `loopOptions.xxx`（或回调名）。0008 决定 3 的分界继续有效：有状态 → 成员（现在挂在 `LoopManager` 上），无状态 → 文件级函数。
2. **`LoopManager` 零字段、零构造参数**（0013 决定 1 复活）。六件服务依赖不构造持有、不注入 `LoopManagerConfig`；`Agent` 内部 `new LoopManager()`，它不进 `AgentConfig`，不复活 0012 决定 4 的构造注入。`Agent` 仍是六件服务的持有者（命令面、fanout、以及组装 `loopOptions` 都要用），装配点仍是 `createSessionAgent()`、全仓库仍只有一处 `new Agent(`（0014 决定 5 的形状、0017 的消费边界）。
3. **三处运行入口各组装一只 `loopOptions` 并调 loop**：`startPromptedRun`、`respondApproval` 的恢复路径、`maybeCompact`。`startPromptedRun` 写消息（落盘 + 发布）仍留在编排层；`respondApproval` 的审批前置账（找悬空调用、grant 记选择、publishState）仍留在编排层，且与 loop 共享**同一只** `bag`（0019「一次运行读一次盘」，不是第二份副本）。loop 暴露压缩入口，`maybeCompact` 的模型计算四行（`modelChoiceOf` + `modelCatalog` + `modelFor`，agent.ts:1091–1095）搬进 loop；`Agent.maybeCompact` 只递 `state / bag / entries / now / signal / transport?`，不再摸 `settingsManager`。
4. **白名单是封闭清单，定稿两条**：`bagOf(id)`、`emit(state, session, event)`。审批闸门确认已是回调形状、零改动。加第三条要重开本 ADR。判据与逐项答辩写进下节，不是口头约定。
5. **依赖方向**：loop 对 `Agent` 的认识只能来自 `loopOptions` 里的回调与数据，**不能 import `agent.ts`**；`agent.ts` 单向 import `loop-manager.ts` 的公开面。票 005 仿 `check-server-facade` 在 `npm run check` 里加一条静态守卫，把这条边界变成可检查的事实（0012 决定 2 的机器化）。
6. **出口决定**：`index.ts` **不恢复** `LoopManager` / `LoopManagerConfig` 导出（0014 撤过；0017 的消费边界说 server 只认编排层公开面，`LoopManager` 是本进程内部装配、唯一消费者是 `Agent`；`LoopManagerConfig` 在零字段形状里根本不存在）。`index.ts` 的 agent 出口**保持**：`Agent` 与事件类型不变，`danglingToolCallsOf` / `recoverPendingToolCalls` 两个函数仍从 `@my-agent/core` 包入口导出（票 001 确认的 `smoke-approval-recovery` 契约，0006 §5）；两条等价做法（`index.ts` 的 re-export 源改指 `./loop-manager.ts`，或 `agent.ts` 原样 re-export 这两个名字）**尚未决定**，由票 004 择一，**包对外的名字一字不变**。`RunStart` / `DanglingToolCall` 等类型随文件搬走、继续从 `loop-manager.ts` 导出。
7. **不随搬迁微调的东西**：`session/fanout.ts` 与 `session/events.ts` 的分工不改——fanout 仍是无状态文件级函数，参数仍是 `(state, session, SessionServices)` 在调用点现建；retry 事件现状就绕过 `dispatchEvent` 直调 `emitEvent` + `publishState`，故 loop 无条件 import fanout，这项裁决只关乎 `dispatchEvent` 组合政策的归属。`abort` / `settle` / `close` 不搬（0012 决定 6，MAP 的 Out of scope）；`hold` / 订阅 / wire 一律不动。

## 判据：白名单逐项答辩与 `loopOptions` 的完整形状

**判据**（0008 的试金石，票 002 定）：每一项都必须答出「为什么这个必须绕回 `Agent`？」——答不上来的改成 loop 自己拿。盘点出 7 类 12 处编排层语义访问点，答辩后只剩两条。

| 项 | 结论 | 答辩 |
|---|---|---|
| `bagOf(id)`（现 `this.bag`，`recordSelection`:1595，全引擎唯一摸会话表处） | **白名单 1** | 会话表编排层私有、不注入（0019「没有被取代的」第一条），`live.unwritten` 只活在表上；「落选择开一只全新的袋」必须走唯一入口，loop 自己开袋就是第二条副本路径。结构上拿不到，只能绕回。 |
| `emit(state, session, event)`（`dispatchEvent` 整体收编） | **白名单 2** | 用户拍板 A 案：落盘（`message_end` 落账本）、清队列（`agent_end` 且非 suspended）、投影（按事件类型 publish）的**组合政策**是编排层与窗口契约的另一半，命令面（`denyAllApprovals` / `abort` / `branchTo` 的发布）是同一契约的另一边；两个实现者分居两文件 = 漂移面。与旧 `subscribe` 的分界：无 listener 表、无跨包函数类型、闭包在运行栈现建（与现状逐字相同），且它是白名单仅有的两条之一，而非七条绕回之一。`runEngine` 内照旧包成 `AgentEventSink` 闭包。 |
| 审批闸门（`before_tool`） | **已是回调形状，零改动** | `beforeTool` 调 `hooks.apply("before_tool", …)`，默认处理器（装配时注册）才调 `Agent.authorize`；`hooks` 是六件依赖之一，这条缝 0012 就批准了。不占白名单名额。 |
| `publishState` × 5（run finally / retryCallbacks × 2 / endRetry / dispatchEvent） | **淘汰，loop 自答** | `publishState(state, session, services)` 三件依赖 loop 全有，现建 `services` 自答。 |
| `approvalsOf`（`prepareRequest`:1513） | **淘汰，loop 自答** | 对快照的纯读，同上自答；审批账本的写侧与命令（`respondApproval` / `authorize` / `danglingApprovals`）留 `Agent` 不动。 |
| `setSuspended`（`run`:1190） | **淘汰，loop 自答** | `sessionManager` 方法，有依赖即自答（0021 的显示标记语义一字不改）。 |
| `live` 半槽位 | **淘汰，不是回调** | 经参数 `state` 写，本来就不是绕回。 |

`loopOptions` 是**一次运行调用的唯一参数袋**（0013 已验证参数化不违反 0007；它是一次调用的参数表，不是被四处传递的聚合袋）。两条回调**平铺**在袋里，不另开 `callbacks` 子袋——单袋是票 002 拍板的形状，平铺让「越过边界的全部」在一个类型上一次性可见，票 005 的守卫也只需检查一只袋与一条 import 边界。完整形状：

```ts
interface LoopOptions {
  // Per-call values
  state: AgentState;
  bag: Session;                    // run bag: one replay at run start (ADR-0019)
  start: RunStart;                 // { prompt } | { answers }
  // Six service dependencies (ADR-0013 shape: in the bag, zero-field LoopManager)
  sessionManager: SessionManager;
  settings: SettingManager;
  tools: ToolManager;
  hooks: Hooks;
  systemPrompt: (
    workDirAbsPath: string,
    agentsMd: readonly AgentsMdFile[],
    toolNames: readonly string[],
    approvals: Record<string, boolean>,
  ) => string;
  api: ChatTransport;
  // Whitelist callbacks (flat)
  bagOf: (id: string) => Session;
  emit: (state: AgentState, session: Session, event: AgentEvent) => Promise<void> | void;
}
```

**不进袋**（票 002 以盘点推翻票面「已知必有」）：模型（`runEngine` 内 `let model`，每请求由填充链重建，0008 决定 8）、abort controller（`runEngine` 内新建、注册 `live.activeRun`）、闸门（`toolCallHooks` 由 `runEngine` 从 `hooks` 依赖现组）、transport（重试泵包装，`run` 内现建）、`thinkingLevel`（骑在 `ModelChoice` 上，每请求 `modelChoiceOf` 派生，从不单独传）——全是运行局部量。压缩入口复用同一只袋的字段（`start` 不适用），另带 `entries / now / signal? / transport?`；`emit` 在 `runEngine` 内包成 `AgentEventSink` 时仍捕获运行栈上的 `state` / `bag`，与现状逐字相同。

## 后果

换来的：

- **读 loop 只看一个文件。** 18 个方法与文件级机械按「一次运行」的顺序排在 `loop-manager.ts`；`agent.ts` 收缩为会话表、读面、命令、审批账本、投影。0014「背上的」那笔账（读一段先判断它是运行的还是会话的）就此清掉。
- **依赖方向再次可检查。** 0012 决定 2 的判据复活，且这次白名单把绕回收窄到两条；票 005 的静态守卫让「loop 不认识 `Agent`」成为 `npm run check` 的一部分，而不是评审时的自觉。
- **零字段的结构性安全原样保留。** 两条并发 run 没有任何可以被互相覆盖的字段（0013）；`Agent` 仍只有一份服务、一只会话表，不存在第二个持有者。
- **白名单是写下来的判据。** 每一条为什么必须绕回都留了答辩，后来的人不必重打 0008 那场仗，也不必猜哪七条曾经是候选。

背上的：

- **一层间接回来。** 三处入口从「直接调自己的方法」变成「组袋 → 调 loop」；读「一次运行怎么开始」要在两个文件之间跳一次。0014 买的那件东西，这次明确退掉。
- **一只 11 字段的参数袋。** `state / bag / start` + 六件依赖 + 两条回调，每个入口都要凑齐；它不是聚合袋（只在调用点现建、用完就丢），但签名确实变宽了。
- **白名单是人工判据。** 守卫只查「不 import `agent.ts`」，不查「这条回调该不该存在」；第三条回调可以在不改守卫的情况下被塞进来。加一条要重开本 ADR，这是自觉，不是类型。
- **`maybeCompact` 退回转发。** 0014 决定 4 省掉的那一层回来了；换来的是 `Agent` 不再摸 `settingsManager`（票 002 的缺口裁决）。
- **`index.ts` 一行改动。** 恢复机器两个函数的 re-export 源改指 `./loop-manager.ts`（或由 `agent.ts` 原样转出）；包对外的名字不变，但漏改就断 `smoke-approval-recovery`。
- **实况文档要等落地才同步。** `AGENTS.md` 的 engine 词条、`docs/architecture.md` 的 `// the engine` 小节、根 `README.md` 里指着 0014 的那一句，今天描述的是代码的实际形状；本票只接受决定、不动这三处实况（票 004 落地时一并改指 0022）。在这段窗口里，ADR 与架构文档对「引擎住哪」的说法不同是**有意的**：一个记决定，一个记实况。
- **行数账已补、守卫待补。** 落地前的基线是 `agent.ts` 2947 行、run 一族 ≈1805 行（61%，票 001 盘点）；落地后（票 004）：`agent.ts` 1172 行，`loop-manager.ts` 1940 行——run 一族 = `loop-manager.ts` 全部 + 编排层留住的 emit 实现（`dispatchEvent`，白名单回调的实现侧）与三处入口的组袋 ≈80 行，合计 ≈2020 行，占两文件合计 3112 行的 ≈65%。一个值得记下的偏差：决定 1 的 18 方法清单里有 `dispatchEvent`，落地时它按决定 4 的白名单答辩留在编排层——「落盘、清队列、投影的组合政策」与命令面的发布是同一契约的两半，分居两文件就是答辩要防的漂移面——所以迁入 `loop-manager.ts` 的是 17 个方法 + 文件级机械，`dispatchEvent` 的**宿主**是编排层、`loopOptions.emit` 是它的出口。`check` 里那条静态守卫由票 005 补进本节（若届时本 ADR 已关，改写票 resolution 与 map 的 Decisions so far）。

## 尚未决定

按 `docs/adr/README.md` 的写法，以下三件在本 ADR 接受时未定 / 未确认，单独列在这里；**上面每一条决定都不依赖它们**：取代关系、白名单判据、`loopOptions` 形状、出口决定、「没有被取代的」清单在这三件未定项的任意取值下逐字相同。*（票 004 落地后，第 1、2 件已定，答案写进了各自条目与「后果」；第 3 件仍归票 005。）*

1. **恢复机器两个函数的 re-export 源路径**：~~`index.ts` 改指 `./loop-manager.ts`，还是 `agent.ts` 原样转出（决定 6）~~——**已定（票 004）**：`index.ts` 的 re-export 源直指 `./loop-manager.ts`，不再经过 `agent.ts` 转手；包对外的名字一字不变，`smoke-approval-recovery` 原样通过。
2. **落地后的前后行数账**：~~由票 004 补进「后果」~~——**已定（票 004）**：见「后果」的行数账 bullet（2947 → `agent.ts` 1172 + `loop-manager.ts` 1940，run 一族 ≈2020 行）。
3. **静态守卫的确切形态**：票 005 仿 `check-server-facade` 加的那条 `npm run check` 检查，扫哪些路径、禁哪些 import，尚未决定；不变式本身（loop 不 import `agent.ts`）已由决定 5 定死。

## 不可逆性与代价

三条门槛逐条成立：

- **难逆转。** 回去要把 18 个方法与 ≈930 行文件级机械（2016–2947，票 001 盘点）再搬回 `agent.ts`、把三处入口改回直接调方法、把两条回调重新摊成 `this.*`、把白名单答辩撤掉、把守卫删掉、把 `index.ts` 的源路径改回去——不止一处，也不止一个文件。九天内第四次搬同一批代码（0014 的「不可逆性」早就拿「一天之内第三次搬」当过门槛的证据），这条链本身就是本 ADR 必须写下「为什么这次不一样」的原因。
- **没有上下文会让人困惑。** 0014 说「那就别要对象」，0022 把对象请回来；四份 ADR 连读，若没有上面那三层答辩，第一反应必然是「不是刚证明过它没用吗」。区别不在持有，在分区与依赖方向：0014 拆的是「被 0013 削空的六字段对象」，0022 立的是「零字段 + 白名单的文件分区」。
- **是真实取舍。** 换来结构模块清晰与可检查的依赖方向，付一层间接、一只宽参数袋、一条人工判据，以及第四次搬迁的历史成本。被放弃的选项各自有代价：维持 0014 就继续付 2947 行的账；复活 0012 的构造注入会把 0013 已经解决的并发踩踏请回来；把 7 类访问点全做成回调就是 0008 拆掉的那个 `Loop`。

## 被取代的是什么

逐条对照 [0014](0014-loop-manager-removed.md)。「全部决定作废」指 **0014 作为裁决与理由不再有效**；其中若干形状（六字段 `AgentConfig`、单一装配点、恢复机器导出）由本 ADR 在 0017 / 0006 §5 的理由下**重新确认**，不是 0014 继续生效：

- **决定 1**（删 `loop-manager.ts`，18 个私有方法成为 `Agent` 方法，机械改动 `services` → `this`）：整体作废。18 个方法搬回 `LoopManager`，纪律反过来用——方法体业务逻辑一字不改，只把 `this.xxx` 换成 `loopOptions.xxx`。
- **决定 2**（文件级机械住 `agent.ts` 末尾）：作废，跟着搬进 `loop-manager.ts` 末尾，仍是文件级函数。它继承的 0008 决定 3 分界与「恢复机器保持导出」不动。
- **决定 3**（`AgentConfig` 回到六必需字段、取值器改回字段、`api` 默认值在 `createSessionAgent` 解析；`loop` / `loopServices` 消失）：作为裁决作废——「引擎从 `this` 就近读这六件」这条理由与「服务就近可读」这条收益一并撤销。`Agent` 仍持有六件服务、`createSessionAgent` 仍是唯一装配点，是**本 ADR 决定 2 在 0017 消费边界下重新确认**的形状。0014 决定 3 里 `loopServices` 消失那一半也不再按原样读：本次 `LoopManager` 零参、`Agent` 内部 new，不进 `AgentConfig`；0012 的六字段 `LoopManagerConfig` 明确不复活。
- **决定 4**（少一层转发，`Agent.maybeCompact` 直接算模型、调 `compactFor`）：作废。模型计算四行搬进 loop，`Agent.maybeCompact` 只组袋转交。
- **决定 5**（装配点仍是 `createSessionAgent`、全仓库只有一处 `new Agent(`）：作为「少一个对象」的论据作废；装配点唯一这个形状由本 ADR 决定 2 重新确认。
- **0014 复活的 0008 决定 1/2**（引擎是 `Agent` 的方法、住 `agent.ts`）**再次作废**。0008 的其余决定（3–9：分界原则、恢复机器导出、类型归位、去 `@ts-nocheck`、运行期瞬态局部化、放弃 vendored 对照）不动；0008 背景里「没有信息的对象」那句判词**继续是本 ADR 的试金石**——被取代的是它的结论，不是它的判据。0008「后果」里 2043 → 2956 行的那笔账，与 0014 后果里 2658 行的那笔账，一并撤销。
- **0014「后果」的三条收益判词**（零层间接、服务就近可读、两个对象不会漂到不同账本上）：零层间接作废（见「后果」）；后两条换成显式签名与 0019 的同一只 run bag + `bagOf` 唯一开袋入口来保证，不再靠「只存在一个持有者」。

## 没有被取代的

0014「没有被取代的」一节**全部继承**，其中按后来 ADR 校正过措辞的地方逐条写明：

- **0006 §5 的结束重启审批**：恢复机器、悬空扫描、答案配对、孤儿收尾一字不改；默认闸门仍经 `Hooks` 的 `before_tool` 回答，处理器仍调 `Agent.authorize`。0021 的 `suspended` 显示标记语义不动（`setSuspended` 只是随 loop 自答）。
- **0007 的无属性服务**：四个服务仍无实例状态、每次现读；fan-out 的参数形状仍在调用点现建。0016 给 `ToolManager` 的常驻实例表是那条 ADR 记在案的**唯一例外**，0017 改的是消费面不是内部形态——两条都不随本次重开。`loopOptions` 是一次调用的参数表，不是聚合袋（0013 已验证）。
- **0011 / 0019 的 `AgentState`**：0014 写的是 0011 的 `state.session` 与 `state.live` 分半，今天由 0019 钉死——**表只装 live 半、`AgentState` 不再有 `session`、transcript 每次操作现读、一次运行读一次盘**。继承的是「表属编排层、私有、不注入、`adopt` / `evict` / `drop` 出入口唯一」这条不变式，形状以 0019 为准，不复活 0011 的四元组。
- **0003 的取走点落盘**、**0009 的两文件格式**：不动。`drainTranscribed` 随 loop 搬，语义不变。
- **`session/fanout.ts` 与 `session/events.ts` 的存在**：不动，分工也不微调（见「决定」7）。模块化本身不是这次要撤的，撤的只是「运行必须是 `Agent` 的方法」。
- **0014 的末条**：模型仍是每次请求按选择从 `models.json` 现查的那一行（`modelChoiceOf` → `modelFor`），不在任何袋上缓存；变的是 `maybeCompact` 那四行的**宿主**随压缩入口搬进 loop，不是这条事实。
- **0017 的消费边界**：三只 Manager 由 `createSessionAgent()` 构造、本进程唯一消费者是编排层，server 只认 `Agent` 公开面，`check-server-facade` 不动；本次不恢复 `index.ts` 的 `LoopManager` 出口正是这条边界的推论。
- **其余**：0015 的传输层折叠、0016 的工具实例表、0018 的 `hold` 语义、0020 的平 store、0021 的显示标记、命令面 REST + 常驻 mux、订阅与 hold 分离、`abort` / `settle` / `close` 的归属——一律不动。
