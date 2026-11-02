# 0008：删掉 `Loop` 对象与 `packages/loop`——引擎并入 `agent.ts`，放弃与上游的逐文件对照

日期：2026-11-02 · 状态：已接受（loop-into-agent 01/02 号票拍板，03 号票落地）
取代：[0001](0001-transport-websocket-mux.md)（部分——仅其「`packages/llm` 与 `packages/loop`
一行都不改」中 **loop** 的那一半；`packages/llm` 那一半原样有效）

设计过程见 `.scratch/loop-into-agent/`（形状在 2026-11-02 的设计对话与 01/02 号票敲定，
本 ADR 只记合拢后的决定）。

## 背景

`packages/loop` 是 `@earendil-works/pi-agent-core` 0.99.2 的 vendored 副本：三个源文件
（`loop.ts` 的引擎、`types.ts` 的契约、`index.ts` 的出口）加一份包配置，整体 `@ts-nocheck`，
只在 pi 自己的编译设置下检查，而工作区的根配置仍然检查每一个进入 core 的 import。

当初这么定的理由（ADR-0001 把它连同 `packages/llm` 一起写成「一行都不改」）是：
**vendored 副本的价值在于能对着上游 diff**。上游修一个循环的 bug，我们读 diff、抄过来；
我们不认同的地方，diff 里看得见差在哪里。代价是这份代码永远不是自己的——改它等于制造
第二处偏差。

到合并之前，这条收益已经被消耗掉了大半：

- **副本早就不是原样。** 票 13 把 `SessionRuntime` 落进会话，票 15 把恢复机器（悬空扫描、
  答案配对、孤儿合成）搬进循环；更早的 [ADR-0003](0003-queued-writes-at-drain.md) 修订里
  记过的那次改造之后，`Loop` 已经是无状态运行引擎——不再持有 transcript、工具与模型，一次
  运行按次接收。合并前 `loop.ts` 相对初版 +242/−22 行、共 1173 行。对着上游 diff 得到的是
  「上游改动」与「我们改动」的叠加，读一次要先把两层拆开。
- **`Loop` 是个没有信息的对象。** 它被构造时，`Agent` 把引擎需要的每个答案都递了进去：
  `streamFn`、`runtime` 槽位、`beforeToolCall` / `afterToolCall` 两个闸门、`prepareRequest`
  整条填充链，再加一条 `subscribe` 把每个事件交回 `handleEvent`；`runLoop` 的三个参数里还
  塞着两个队列排水钩子。也就是说：引擎的每一个问题都绕回 `Agent` 回答，而这个对象唯一的
  职责是把问题原路转回去。
- **同一件事写两遍。** 引擎的 `dispatchEvent` 与 `Agent.handleEvent` 是同一条链路的两端，而
  引擎为此还维护一张 `Set` 形状的 listener 表——里面只有 `Agent` 那一个成员。队列排水钩子
  存在的唯一原因是 `Loop` 拿不到会话自己的队列；`prepareRequest` 以 `PrepareRequest` 这一层
  函数类型穿过两个包，只为了在 `Agent` 里被调用。

## 决定

1. **删掉 `packages/loop` 与 `Loop` 对象。** 引擎的函数体成为 `Agent.runEngine`；`startRun`
   只剩三件事：开 scope、包 transport、调 `runEngine`。包的目录、root `workspaces`、core 的
   工作区依赖、根 tsconfig 的 path、`check` 里的那一次 `tsc`、`install-deps` 的清单一起删。
2. **有状态 → `Agent` 的私有成员，无状态 → 文件级函数。** 前者：`runEngine`、`dispatchEvent`
   （引擎的 sink 与订阅者的出口合成一个）、`prepareRequest`（既有的每轮填充链，引擎直接调）、
   `toolCallHooks`、`finishRun`、`handleRunFailure`。后者：工具批次执行（顺序 / 并行）、截断
   消息的失败处理、悬空扫描、`runToolCall`。
3. **恢复机器保持文件级导出。** `danglingToolCallsOf` / `recoverPendingToolCalls` 是纯函数，
   `smoke-approval-recovery` 直接驱动它们——不为了「全部是成员」把这唯一一个测试接缝埋进类里。
4. **`runToolCall` 不导出。** 全仓库没有调用者；真有工具需要嵌套调用别的工具时再导出。
   「子代理是一对工具、不是机制」这条边界不变。
5. **类型并入 core 一个模块** `packages/core/src/types.ts`，`index.ts` 的对外 re-export 原样
   保留。`LoopContext` 改名 `AgentContext`（与 `AgentEvent` / `AgentTool` 同族）；而**没有
   对应物的类型直接删**：`StreamFn`（引擎直接 `model.stream`）、`LoopConfig`、`LoopOptions`、
   `LoopRuntime`（`Agent` 直接操作 `SessionRuntime`）、`LoopQueueHooks`（drain 直读队列）、
   `RunLoopOptions`、`PrepareRequest` / `PrepareRequestContext`。wire 面留在 `protocol.ts`；
   `QueueMode` 只留一份定义，`protocol.ts` 改为 re-export。
6. **去掉 `@ts-nocheck`，整份代码过根 tsconfig**（含 `noUncheckedIndexedAccess`）。
7. **放弃 vendored 对照。** 不再跟踪上游；头注释里那些「与 pi-main 的 diff 说明」随文件一起
   删除。合并即分道。

## 后果

换来的：

- **缝不再是接口。** 队列、事件、每轮填充、模型，都是同一个对象上的方法或同一个文件的局部
  变量。一次运行只经过一条链：`startRun → runEngine → prepareRequest → dispatchEvent`，读代码
  不需要在两层之间来回换算。
- **一个对象回答「谁在跑」。** 原来 `Agent` 编排、`Loop` 执行，而两者的边界只传递了「请再问我
  一次」。`runEngine` 的第一条守卫就是 `entry.runtime.activeRun !== undefined`——它读的是会话
  自己的活半，不需要谁来告诉它。
- **类型检查覆盖到引擎。** `@ts-nocheck` 与 pi 的编译设置一起退场，引擎的每一处字段访问都在
  仓库最严的配置下。为此改的都是真问题：`context.tools` 可选、`answers[id]` 可能缺、`filter`
  需要类型守卫、`ToolResultMessage.details` 与工具 `details` 形状不同（唯一的显式 cast，就地
  注明）——没有一个是拿 `any` 盖过去的。
- **运行时依赖少一个包。** 从三个变两个（`@my-agent/llm`、`typebox`）。

背上的：

- **`agent.ts` 从 2043 行长到 2956 行。** 编排与引擎同处一个文件，这是这次合并最直白的代价。
  缓解只到文件内分区为止：引擎、填充链、账本写入、投影各自成段，注释写清每段的边界——也就
  到此为止，没有第二个文件可以指。
- **与上游分家。** 此后 pi 对循环的改动不会再以 diff 的形式出现在我们眼前；要跟进只能读上游、
  手抄、自己过类型检查。ADR-0001 当初为 `packages/loop` 保留的那条理由，在这一半上作废。
- **两处偏离 01 号票字面、按既有 ADR 裁定的地方**（记在这里，以免后人以为是漏做）：`runModel`
  没有成为成员，而是 `runEngine` 里一个 `let model`——它是 per-run 的量，而 `Agent` 是跨会话
  单例，一个字段会把 A 会话当前请求的模型交给 B 会话并发的 run（ADR-0006 §5「run 的瞬态是
  run 的局部变量」）；`activeRun` 槽位仍住 `SessionRuntime`，`subscribe` / `waitForIdle` 由既有
  的 `onEvent` / `settle(id)` 承担，`abort` 本来就是 `Agent` 的公开方法（比 `Loop.abort` 更
  完整：abort 后还扫悬空审批并 publish）。

## 不可逆性与代价

三条门槛逐条成立：

- **难逆转。** 回去要重新取一份上游 `loop.ts`，然后把它对我们现有的每一处接缝（无状态化、
  恢复机器、`SessionRuntime`、每轮填充链、队列直读）再对齐一遍，同时把 `Agent` 里那批私有
  成员拆回构造参数——不止一处，也不止一个文件。
- **没有上下文会让人困惑。** 后来的人看到 2956 行的 `agent.ts`、找不到 `Loop`、找不到
  `packages/loop`，第一反应必然是「为什么不把它拆出去」。这份 ADR 就是那个「为什么」。
- **是真实取舍。** 被放弃的是 vendored 对照能力——它有真实价值（上游修 bug 时省事、可逐行
  核对），也确实在被我们改得面目全非之后才被放弃。

## 被取代的是什么

- **ADR-0001 的「`packages/llm` 与 `packages/loop` 一行都不改」中 loop 的那一半。**
  `packages/llm` 仍原样适用：它同样被裁过（只剩一个 API 实现与它需要的传输层），但它仍在
  `packages/llm` 里、仍然 vendored、也**没有**被并入任何人。
- **`Loop` 作为委派对象这一层**——以及它为此付出的四处代价：`prepareRequest` 以函数类型
  穿过两个包、`dispatchEvent` 之外的第二张 listener 表、`runtime` 槽位透传、两个队列排水钩子。
- **`@ts-nocheck`**，以及「在 pi 自己的编译设置下检查这份代码」这条安排。

## 没有被取代的

明确不动、读者不该跟着本 ADR 一起重开的：

- **ADR-0001 的其余全部**：REST 命令面 + 常驻 WebSocket mux、有界写侧、`claim` 与订阅分离，
  以及「`packages/llm` 一行都不改」。
- **ADR-0003 的取走点落盘**：排队消息仍在取走点写进账本——搬的只是取走点的位置（从
  `getSteeringMessages` / `getFollowUpMessages` 钩子变成 `drainTranscribed` 直读会话队列），
  语义不变。
- **ADR-0006 §5 的结束重启审批**：恢复机器换了个文件住，行为一字不改——grant 重跑、deny 合成、
  孤儿收尾、无答案的悬空调用按错误收场。
- **ADR-0007 的五单例无属性化**：`runEngine` 从 `entry` 与 `state` 现取，没有往 `Agent` 上新增
  会话级实例字段；它的瞬态仍是 run 的局部变量。
- **retry 装在模型的 transport 上**（不在引擎里）；**compaction 的「文件永远保留全文、每步裁剪
  是一条 entry」**；**subagent 是一对工具、无注册表无嵌套**；**客户端对供应商 SDK 一无所知**。
