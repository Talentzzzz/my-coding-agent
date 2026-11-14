# 0017：fanout 并入编排——删掉 `session/fanout.ts` 与 `SessionServices` 参数袋

日期：2026-11-14 · 状态：已接受
取代：[0012](0012-agent-facade.md)「没有被取代的」中「fanout 的 `SessionServices` 参数袋」一条；
[0016](0016-loop-is-orchestration.md)「没有被取代的」中「fanout 文件与参数形状」一条
取代者：无

## 背景

fanout（`emitEvent`、`publishState`、`snapshotOf`、`approvalsOf`、`appendMessageEntry`、
`dropQueued`、`emitQueueUpdate`、`nextStamp`、私有的写边界 `finalizeToolResult`）自会话架构
重写起就是 `session/fanout.ts` 的文件级函数：每个函数收 `(state, session, services)`，`services`
是调用点现凑的 `SessionServices` 三件套袋。这个形状的理由写在 fanout.ts 自己的注释里——「orchestrator
的命令面和它的 run 都通过它们」，两个实现者共享，所以谁都不是任何东西的成员。

[0016](0016-loop-is-orchestration.md) 把 loop 并回 `Agent` 之后，这个理由已经过期：引擎不再是
第二个实现者，fanout 的读者只剩编排层一个（全仓唯一 import 它的是 `agent.ts`；`assembly.ts`
只 import `SessionServices` 类型本身）。留下的形状是：

- 一个只为跨对象共享而存在的参数袋，每个调用点现凑或经 `Agent` 的 `services` getter 转手——
  adapter 为它曾经的第二个消费者空转；
- 一份独立文件，存在的理由（「谁都不是任何东西的成员」）失去了对象。

## 判据

**共享消失时，为共享付的成本该跟着退。** [0016](0016-loop-is-orchestration.md) 的判据换了层级
（「这条边界该不该存在」而非「哪种边界划得更好」），同一条判据问到这里：文件级 + 参数袋是
「两个实现者共用无状态件」的代价，现在只剩一个实现者，代价买不到东西了。

## 决定

1. **删 `session/fanout.ts`。** 八个函数原样成为 `Agent` 的私有方法，签名去掉 `services`
   首参——服务从 `this` 上直取（`sessionManager` / `settingsManager` / `tools` 本就是编排层
   自己的字段）。原注释逐字随迁。
2. **投影函数改名 `projectionOf`。** 原 `snapshotOf` 与公开面 `Agent.snapshotOf(id)` 重名；
   AGENTS.md 对 agent.ts 的职责描述本就用「投影」一词，故以此为准。`snapshotOf` / `snapshot`
   两个公开方法与 mux 基线的语义一字不变。
3. **`SessionServices` 删除，`Agent` 的 `services` getter 随行。** 袋的类型与现凑它的 adapter
   是同一件事的两半。
4. **`assembly.ts` 改收三只 manager 的显式实参。** `assemble` / `assembleSession` 的签名从
   `(services, options)` 改为 `(sessionManager, settings, tools, options)`；`readSessionSnapshot`
   的回落三只原地构造。类型随函数签名走，不再需要一份接口文件；「本文件不从 `agent.ts` 导入」
   的硬规则不受影响——实参在调用点现递，没有反向依赖。
5. **写边界 `finalizeToolResult` 一并搬入**，仍是私有方法、仍只被 `appendMessageEntry` 调用；
   语义与归档行为一字不改。

## 后果

换来的：

- **约 24 个调用点少一个实参**：`publishState(agentState, session, this.services)` →
  `this.publishState(agentState, session)`，adapter getter 与它的答辩注释消失。
- **`agent.ts` 增约 190 行**（约 2928 → 3120）：[0016](0016-loop-is-orchestration.md) 决定 6
  的口径不变——规模问题不再用搬文件治，拆类需独立论证。
- **「无状态件是文件级函数」的规则收窄一条**：[0007](0007-loop-merged-into-agent.md) 决定 3
  仍管着引擎机件（工具批执行、恢复遍等仍在本文件的机件段），fanout 不再是它的实例。

背上的：

- **fanout 不可再被 `Agent` 之外的代码直调。** 之前 smoke 可以 import 文件级函数单测投影；
  现在只能经 `Agent.snapshotOf` / `Agent.snapshot` 走公开面。smoke 无一使用这条旧缝
  （grep 零命中），故无既有消费者受损——但这条缝从此不存在。

## 不可逆性与代价

- **可逆但多文件。** 回去要重开文件、恢复袋类型、改 `assembly.ts` 签名、给每个调用点补回实参
  ——机械但不止一处，故按编号规则立此存照。
- **没有上下文会困惑。** 读到 `Agent` 的私有发布方法族而不读本文，会问「为什么违反 0007 的
  『无状态 → 文件级函数』」——答案是那条规则的理由（两个实现者共享）已经不在。
- **是真实取舍。** 放弃的选项是「保留文件、只删袋」（`assemble` 式签名搬进 fanout.ts 的函数上）：
  那会留下一份只有一个消费者的文件，文件的分区理由（共享）已死而文件还活着，比并掉更糟。

## 没有被取代的

- **[0013](0013-table-holds-live-half-only.md) 的袋语义**：投影与发布仍是「调用方带着自己这次
  打开的那只袋来」——方法收 `agentState` / `session` 实参，不从表里自取，ADR-0013 的「一次操作一次
  重放」原样。
- **[0016](0016-loop-is-orchestration.md) 的其余全部决定**：引擎归编排、`RunInput` 三件值、
  不用搬文件治规模，一律不动。
- **[0006](0006-services-drop-instance-state.md) 的无属性服务**：三只 Manager 仍不持有实例
  状态；变的只是「递给无状态函数」这条路没了——现在读它们的方法本来就是编排层的成员。
