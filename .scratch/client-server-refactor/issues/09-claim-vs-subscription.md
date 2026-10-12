# `claim` 与订阅计数的关系

Type: grilling
Status: open
Blocked by: 04

## Question

本图引入"按订阅者计数"（票 04），而仓库里已经有一个计数器叫 `claim`。`docs/notes.md:23-25` 明令**不要重命名**它，并把它的含义钉死为"这个请求必须跑在活跃会话上"：

> `claim` 只用于"这个请求必须跑在活跃会话上"。它不再是"记录是否存在"的答案，也不再（第二阶段之后）决定审批能否被回答。

`SessionHub` 今天靠它决定会话何时被回收（`packages/server/src/hub.ts:231-241`），而 `docs/architecture.md:244` 说"`SessionHub.claim()` 是唯一数 claim 的东西——流的 `StreamRegistry.open()`，请求的 `SessionController.claiming()`"。

要钉死的是：

1. **两个计数器还是一个**。订阅计数归零是否等价于"最后一条 claim 释放"？如果不等价，`hub.reap()` 该听谁的？
2. **谁还该拿 claim**。今天"每条事件流一条 claim"这条规则（`packages/server/src/stream-registry.ts:129`）在新模型下变成什么——一条常驻连接拿一条？每个订阅拿一条？还是流完全不拿 claim，只有"会改变会话的请求"拿（`packages/server/src/controllers/sessions.ts:475-484`）？
3. **`claim` 的副作用**。`hub.claim()` 不带 id 时会经 `currentId()` 解析，于是"打开应用会写下一个 JSONL 头文件"（`docs/notes.md:48`）——这是 D1 明知并接受的"读形状的请求带写副作用"。常驻连接若在启动时就拿 claim，这个副作用会不会从"每次打开应用一次"变成别的频率？
4. **重命名禁令的边界**。不重命名 `claim`/`HostedSession`/`SessionHub` 这条禁令，是否允许**新增**一个类型（例如订阅计数）而不动它们？如果允许，新类型的名字与 `HostedSession` 上的落点在哪。

**前置**：票 04 必须先给出订阅计数的形状。本票只解决"两者如何共存"，不重新决定订阅计数。

## Answer

<!-- 解决时在下面追加。 -->
