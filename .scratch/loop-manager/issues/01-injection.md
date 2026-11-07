# 01 · LoopManager 怎么进 Agent

Type: grilling
Status: resolved，**整份作废**——对象已删，见 [ADR-0014](../../../docs/adr/0014-loop-manager-removed.md)
Resolved: 2026-11-04，经与用户逐题敲定（三问选 A）

> 2026-11-04 补两次：先由 [ADR-0013](../../../docs/adr/0013-loop-services-are-arguments.md) 作废
> 「`api` 与 `systemPrompt` 归 `LoopManagerConfig`」的归属（对象改成零字段，六件随调用传）；
> 当晚 [ADR-0014](../../../docs/adr/0014-loop-manager-removed.md) 把对象整个删掉，方法回到 `Agent`。
> **仍然有效的是最后半句**：装配点只有 `createSessionAgent`，全仓库只有一处 `new Agent(`——只是被注入的
> 不再是 `loop`，而是六个服务字段本身。

## Question

`LoopManager` 用哪种方式进 `Agent`：`AgentConfig` 里必填一个已构造的实例，还是 `Agent` 在构造
函数里自己 `new` 一个？`base: ChatTransport` 与 `systemPrompt` 跟谁走？

## Answer

**必填注入。** `AgentConfig` 收 `{ sessionManager, settings, tools, loop }`；`api` 与
`systemPrompt` 从 `AgentConfig` 移出，成为 `LoopManagerConfig` 的字段（`api` 默认
`anthropicMessages`，与移动前一致）。

装配点是 `createSessionAgent()`：它解析工具目录、建 hooks、建 prompt builder、建 `LoopManager`，
然后把同一个 `tools` / `hooks` 实例同时交给两边。`openAgent()` 仍走 `createSessionAgent()`，所以
全仓库只有一处装配（`new Agent(` 只有这一处）。

`hooks` 也不再是 `AgentConfig` 的字段：`Agent.hooks` 就是 `loop.hooks`，一份实例，没有第二个可以
分叉。`Agent.hooks` 仍然公开——宿主要在默认处理器之后追加（`smoke-session` 就这么用）。

理由：这样才真的叫构造注入——`Agent` 不知道 `api` 存在，`private readonly base` 不再是它的字段。
代价是 `createSessionAgent` 多三行，换来「`Agent` 的构造参数里没有一条是 `LoopManager` 的内部依赖」。
