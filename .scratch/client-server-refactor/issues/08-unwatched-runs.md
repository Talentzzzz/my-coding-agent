# 无人观看时的失败与弃置

Type: grilling
Status: open
Blocked by: 04

## Question

三个"没有人在看"的场景，今天都有明确的坏行为。它们共用一个根：**运行可以在没有任何订阅者的情况下发生，而运行产生的、只属于"当下"的东西无处投递。**

1. **失败不留痕**。`StreamRegistry.announce()` 遍历 `watchers.get(sessionId) ?? []`（`packages/server/src/stream-registry.ts:263-265`）。唯一调用者是 `onRunFailure`（`packages/server/src/boot.ts:90`），来源是 `session.prompt()` 的 rejection，而那个请求早已回答 `{accepted:true}`。**一条流都没有时它遍历空集合**；服务端 `packages/server/src` 里 `console.*` **零匹配**。用户看到：自己的提问下面既没有回答也没有报错，刷新后还是这样。
   注意 D3（`docs/notes.md:46`）已经**被本图重开**：它规定"发送路径无法挂上流时报告失败且不发送"，理由只有"`announce` 不缓冲"。本票要给出替代方案。
2. **无人回答的审批**。`hub.reap()` 等 `approvalGraceMs`（十分钟）后 `denyAllApprovals("No window answered this approval.")`，而 **reason 被丢弃**（`packages/core/src/agent.ts` 里明确 `void reason`），transcript 里只留下一次被拒绝的工具调用。用户看到：一个自己从未被问过的工具，十分钟后"被判拒绝"。
3. **弃置的边界**。`docs/notes.md:111` 记录了这次取舍："本仓库保留定时器，因为它的传输是每个查看者一条 HTTP 响应……第二阶段改变了这个定时器的**含义**（是'被遗弃'，不是'没人在看'）。"常驻订阅之后，"被遗弃"该怎么判定——订阅计数归零？还是仍然需要时间宽限？

要钉死的是：**(a)** 一条只属于"当下"的失败，要不要有落点（落盘？保留在内存直到有人订阅？）；**(b)** `denyAllApprovals` 的 reason 为什么不进 transcript，这是不是一处该修的丢弃；**(c)** 票 04 定了订阅计数之后，`approvalGraceMs` 与它是什么关系——两个计时器还是一个。

## Answer

<!-- 解决时在下面追加。 -->
