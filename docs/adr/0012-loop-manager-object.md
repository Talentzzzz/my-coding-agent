# 0012：一次运行成为一个对象——`LoopManager` 由 `Agent` 构造注入

日期：2026-11-04 · 状态：已接受（同日的设计对话三题拍板，03 号票落地）；**已整体被 [0014](0014-loop-manager-removed.md) 取代**
（对象已删；决定 2 的后半句曾先由 [0013](0013-loop-services-are-arguments.md) 削去）
取代：[0008](0008-loop-merged-into-agent.md) 的决定 1、决定 2，以及它「后果」一节里
「`agent.ts` 从 2043 行长到 2956 行……没有第二个文件可以指」那一条

设计过程见 `.scratch/loop-manager/`。

## 背景

[ADR-0008](0008-loop-merged-into-agent.md) 删掉了 `packages/loop` 与它的 `Loop` 对象，理由是三条，
其中两条是这次要推翻的：

- **`Loop` 是个没有信息的对象。** 它被构造时，`Agent` 把引擎需要的每个答案都递了进去：
  `streamFn`、`runtime` 槽位、`beforeToolCall` / `afterToolCall` 两个闸门、`prepareRequest` 整条
  填充链，再加一条 `subscribe` 把每个事件交回 `handleEvent`。引擎的每一个问题都绕回 `Agent` 回答，
  而这个对象唯一的职责是把问题原路转回去。
- **并文件。** 删掉委派对象之后文件边界也一起删：引擎住进 `agent.ts`，理由是「它要的东西没有一件
  是引擎自己的」。

第二条的代价当时就写清了，只是被当成可接受的：`agent.ts` 从 2043 行长到 2956 行，缓解「只到文件内
分区为止」。到这次动手之前它是 2916 行、`Agent` 类本身约 1600 行，其中约 1150 行是**一次运行**的
代码——引擎、每轮填充链、压缩阶梯、重试泵、两个工具闸门、事件 sink——与会话自己的东西（一张会话表、
命令面、审批账本、投影）平铺在同一个类里。读一段代码要先判断「这是运行的还是会话的」，而这两件事的
生命周期本来就不同：前者随一次运行生灭，后者随会话生灭。

用户在同一次对话里把方向定死：**循环不是散落在 `Agent` 里的方法，而是一个对象**；`Agent` 多一个
属性 `LoopManager`，通过构造注入；`base: ChatTransport` 一起搬进去。

## 决定

1. **`LoopManager`（`packages/core/src/loop-manager.ts`）持有一次运行的全部。** 引擎（`run` →
   `runEngine`）、每轮填充链（`prepareRequest`、`runContext`、`recordSelection`）、压缩阶梯
   （`maybeCompact` / `compactFor` / `trimRecordedArgs` / `clearStaleToolResults`）、引擎之下的重试泵
   （`pumpAttempts`、`retryCallbacks`、`endRetry`）、两个工具闸门（`toolCallHooks`、`beforeTool`、
   `afterTool`）、事件 sink（`dispatchEvent`、`drainTranscribed`）、收尾（`handleRunFailure`、
   `finishRun`），以及引擎的整套文件级机械（流、工具批次、恢复机器、`pairLateToolResults`、
   `messagesOf`）。
2. **它不回头问 `Agent`。** 这是这次与 ADR-0008 那次 `Loop` 的分界线，也是本 ADR 唯一值得记住的
   判据：`LoopManager` 自带六件依赖——账本、`SettingManager`、`ToolRegistry`、`Hooks`、prompt
   builder、`base: ChatTransport`——会话以 `AgentState` 作**参数**递进来（队列、订阅者、live 半都
   在那上面），事件与投影走 `session/fanout.ts` 的文件级函数。因此「有没有绕回编排层」不是靠自觉，
   而是编译期可验证的：`loop-manager.ts` 在**值**的层面不 import `agent.ts`。
3. **共享的扇出抽成 `session/fanout.ts`。** `emitEvent`、`publishState`、`appendMessageEntry`、
   `dropQueued`、`emitQueueUpdate`、`nextStamp`、`snapshotOf`、`approvalsOf`，参数是
   `(state, SessionServices)`；写入口 `finalizeToolResult` 也住这里。它们既不是运行的私有物
   （`branchTo`、`applyConfig` 也要发事件），也不是会话表的私有物，做成任何一方的成员，另一方就得
   伸手进去——那正是 ADR-0008 批评的形状。ADR-0008 决定 3 的原则（有状态 → 成员，无状态 →
   文件级函数）继续成立，只是"成员"多了一个宿主。
4. **构造注入。** `AgentConfig` 变成 `{ sessionManager, settings, tools, loop }`：`api` 与
   `systemPrompt` 从它移出，成为 `LoopManagerConfig` 的字段。装配点是 `createSessionAgent()`——
   它解析工具目录、建 hooks、建 prompt builder、建 `LoopManager`，把同一个 `tools` / `hooks` 实例
   同时交给两边。`Agent` 的构造参数里没有一条是 `LoopManager` 的内部依赖，`private readonly base`
   从此不是它的字段。`Agent.hooks` 仍是公开的，它就是 `loop.hooks`——只有一份，宿主在其后追加
   处理器（`smoke-session` 就这么用）。
5. **留在 `Agent` 里的是会话，不是运行。** 会话表（`adopt`/`evict`/`drop`/`agentState`）、读面
   （`snapshot`/`getApprovals`/`hasPendingApprovals`/`onChange`/`onEvent`）、命令
   （`prompt`/`steer`/`followUp`/`branchTo`/`setActiveTools`/`applyModelSelection`/`applyConfig`）、
   审批账本（`respondApproval`/`denyAllApprovals`/`authorize`/`danglingApprovals`）、
   `emitConfigChanged`，以及一行转发的 `maybeCompact`。
6. **`abort` / `settle` / `close` 不搬。** 它们读 `state.live.activeRun`（状态自带），abort 之后要
   扫悬空审批、把中止落成结果——那是审批账本与端到端等待的事，不是运行的事。搬进去反而要让
   `LoopManager` 认识审批语义。
7. **事件的类型搬到 `session/events.ts`**（`SessionListener`、`MessageDelta`、`AgentSessionEvent`、
   `SessionEventListener`、`messageDeltaOf`）。两边都发事件，谁都不该独占那个联合类型；`agent.ts`
   原样 re-export，`index.ts` 的出口不变，另外新增 `LoopManager` / `LoopManagerConfig`。
   `danglingToolCallsOf` / `recoverPendingToolCalls` 随引擎搬到 `loop-manager.ts` 并继续导出——
   `smoke-approval-recovery` 直接驱动它们。

## 后果

换来的：

- **`agent.ts` 2916 → 809 行，`loop-manager.ts` 1942 行。** 编排层回到它该有的体量：表、命令、
  审批、投影；运行的全部在另一个文件里、按"一次运行"的顺序排。
- **依赖方向成了可检查的事实。** ADR-0008 的判断理由是"这个对象有没有信息"，那要看调用链；这次
  换成了"它 import 谁"，一眼可查。`LoopManager` 不知道 `Agent` 存在。
- **`base: ChatTransport` 到了它唯一被使用的地方。** 它原来骑在编排层上，只为了在 `run` 里被闭包
  一次；现在它是运行对象自己的字段，重试泵直接读它。
- **`snapshot` 与 `publish` 合成一条路。** 两者原先各写一份 `sessionSnapshot` 的输入，现在都走
  `fanout.ts` 的 `snapshotOf`，窗口帧和 REST 读不可能再对不上。

背上的：

- **一层间接。** `Agent` 的三处入口（`startPromptedRun`、`respondApproval`、`maybeCompact`）现在
  只是转发；读"一次运行怎么开始"要在两个文件之间跳一次。
- **一个共享参数形状。** 两个对象都要把 `{ sessionManager, settings, tools }` 攒成 `SessionServices`
  递给 fan-out。按 ADR-0007 的说法它不能是字段（那是聚合袋），所以两边各有一个 `private get
  services()`，在调用点现建。
- **装配点变长。** `createSessionAgent` 多了三行：解析工具、建 loop、把同一批服务交给两个对象。这是
  "构造注入"的账单，也只能记在这里。

## 不可逆性与代价

三条门槛逐条成立：

- **难逆转。** 回去要把 1150 行再拆回 `Agent` 的方法、把 `api` / `systemPrompt` 塞回 `AgentConfig`、
  把事件类型搬回 `agent.ts`，还要把 `fanout.ts` 的八个函数按调用方拆两半——不止一处，也不止一个
  文件。
- **没有上下文会让人困惑。** 两份 ADR 摆在一起看，0008 说「引擎是方法、不是对象」，0012 说「引擎
  是对象」，而两边都写着理由。这份 ADR 就是那个"为什么这次不一样"：0008 拆掉的是一个**只转发
  问题**的对象，0012 立起来的是一个**自己回答问题**的对象。判据不是有没有对象，是依赖方向。
- **是真实取舍。** 换来分区与可检查的依赖，付出一次跳转与一个共享参数形状。

## 被取代的是什么

- **ADR-0008 决定 1**（删 `Loop` 对象、引擎函数体成为 `Agent.runEngine`）与**决定 2**（引擎住
  `agent.ts`、不另开 core 内的文件）。`packages/loop` 仍然不存在，也仍然不跟踪上游——被取代的只是
  "引擎必须是 `Agent` 的方法"这一半。
- **ADR-0008「后果」里的行数账**：`agent.ts` 不再承载引擎，那个"最直白的代价"随之撤销。

## 没有被取代的

明确不动、读者不该跟着本 ADR 一起重开的：

- **ADR-0008 决定 3 的原则**：有状态 → 成员，无状态 → 文件级函数。搬的是成员住在哪个对象，不是这
  条分界。
- **ADR-0008 决定 4–7、9**：恢复机器保持文件级导出（smoke 直接驱动）、`runToolCall` 不导出、类型并
  入 `core/types.ts`、去掉 `@ts-nocheck`、放弃 vendored 对照。四件事全部有效，只是文件从
  `agent.ts` 换成 `loop-manager.ts`。
- **[ADR-0006](0006-stateless-session-architecture.md) §5 的结束重启审批**：恢复机器、悬空扫描、答案
  配对、孤儿收尾一字不改。默认闸门仍经 `Hooks` 的 `before_tool` 回答，那个处理器调
  `Agent.authorize`——这是**注册在 hook 上的处理器**在问编排层，不是运行对象在问它。
- **[ADR-0003](0003-queued-writes-at-drain.md) 的取走点落盘**、**ADR-0007 的无属性服务**、
  **[ADR-0011](0011-agent-holds-session-state.md) 的 `AgentState`**：一律不动。运行期瞬态仍是本次运行
  的局部变量（模型、abort controller、事件 sink、闸门），`state.live` 上只留快照要读的那几个槽位。
