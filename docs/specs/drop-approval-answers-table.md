# Spec：审批答案表退场——settled 帧去掉 verdict，结果由执行事件自己说

> 状态：已实现并全绿（`npm run check` + 全部 smoke）；本稿为 tracker 规格，待 tracker 配置后发布并打 `ready-for-agent`。
> 关联：ADR-0025（mux 连接 controller）、ADR-0018（grant 的审批增量）、ADR-0005 §5（end-restart）、架构文档 wire 一节。

## Problem Statement

一个审批在屏幕上被作答之后，观看同一会话的其他窗口需要知道两件事：这个审批定案了，以及它定成了什么。此前的实现把第二件事交给一张进程级的「答案表」——REST 处理器把答案暂存进去，mux 在上报定案的差量帧（`approval_settled`）上携带 `approved` 字段，前端用它在"没有任何执行事件跟随的拒绝"（批量拒绝）时把等待卡片就地关掉。

这张表为前端的一个实现选择（卡片只听执行事件）买单：它是一个要接线、要注入、要维护生命周期的常驻服务，`approval_settled` 帧因此背上了一个判别不了什么的字段——`approved` 的 `false` 既可能是"用户点了拒绝"，也可能是"没有任何答案的弃置"，而工具自己的失败在事件上同样是 error。数据里没有一个字段的语义是干净的。

## Solution

**settled 帧只说"定案了"，不说定成了什么；结果由那次关闭自己的执行事件说。**

- `approval_settled` 只携带 `toolCallId`——它的职责是摘掉横幅、让"不再有答案可等"的等待收场。
- 结果的落点是账本里本来就有的东西：grant 是恢复运行重发调用的真实执行，deny 是恢复遍写下的合成结果——两者的 `tool_execution_end` 事件（带结果文本）都会流到每一个订阅者。批量拒绝此前是唯一不发执行事件的关闭路径，现在补齐：它像恢复遍一样，在写下合成结果前后发出开始与结束事件。
- 前端摘掉 `approved` 的分支：卡片的生命周期完全由执行事件驱动——`tool_execution_start` 把等待翻回运行中（grant），`tool_execution_end` 以它的结果文本定论（deny）。**不判别"拒绝 vs 工具失败"**：用户读的就是 result，被拒的调用落下的合成结果写着拒绝的句子，跑挂的命令落下自己的报错——两条都是诚实的记录，不需要一个机器字段去裁决。
- 答案表整个删除：它服务的唯一消费者（帧上的 verdict）不复存在，连同它的注入、它的 `onApproval` 监听器、它的 show/hide 读者计数一起。

## User Stories

1. As a 作答窗口的用户, I want 点下批准后运行立即继续, so that 我不需要等待任何"答案被记录"的中间状态。
2. As a 作答窗口的用户, I want 拒绝后立刻看到调用以它自己的结果文本收场, so that 我确认系统按我的意思做了。
3. As a 旁观窗口的用户, I want 在我正展示的审批被别人作答时看到横幅摘除, so that 我不会对着一个已经没有答案的问题点按钮。
4. As a 旁观窗口的用户, I want 随后看到那次调用的执行事件把卡片收尾, so that 我从结果本身知道它被批准（执行）还是被拒绝（合成结果）。
5. As a 旁观窗口的用户, I want 批量拒绝（会话关闭/中止清扫）也能关掉我手里的等待卡片, so that 没有恢复运行跟随的拒绝不会让我永远等待。
6. As a 同时开多个窗口的用户, I want 每个窗口听到同一次定案, so that 结果不随窗口数量变化。
7. As a 同时看多个会话的用户, I want 一个会话的审批结果永远不出现在另一个会话的流上, so that Anthropic 兼容端点碰巧共用的 `toolCallId` 不会让一个会话的准予出现在另一个会话的窗口。
8. As a 误操作点了未知审批 id 的用户, I want 得到一个明确的 409 且流上不出现任何帧, so that 一次被拒的请求不污染任何差量。
9. As a 中止运行的用户, I want 弃置的调用带上"运行被中止"的结果文本关闭, so that 会话记录说清实际发生了什么，而不是把一次弃置记成一次拒绝的选择。
10. As a agent（模型）, I want 每个悬空的 `tool_use` 都有配对的 `tool_result`, so that 下一次请求对供应商始终合法。
11. As a 维护者, I want 审批的定案只有一个事实来源（那次关闭自己的事件）, so that 没有第二份需要与账本保持同步的进程内状态。
12. As a 维护者, I want mux 的依赖面尽量窄, so that 连接层不背任何业务状态的生命周期。

## Implementation Decisions

- **协议**：`ServerMessage` 的 `approval_settled` 成员去掉 `approved` 字段，只留 `toolCallId`。协议随本次变更同步发布，无兼容层——窗口与服务器同仓库同发布。
- **core（所有关闭路径自报结果）**：批量拒绝（`denyAllApprovals` 走到的悬空调用关闭）在写下合成结果的前后发出 `tool_execution_start` / `tool_execution_end` 事件，与恢复遍的合成结果同形。这条不变量现在成立：**每一个离开 pending 集的审批，随后必有一次属于它的执行结束事件**——grant 是真执行，deny 是合成，批量拒绝也是合成。事件走会话自己的 sink，所有订阅者天然全听到。
- **server**：答案表模块删除；mux 的依赖收窄为 `{ sessionHub }`；`sessionListeners` 去掉 `onApproval`；`approvalSettled` 帧构造去掉参数；`writeBaseline` 的审批表整表换新（差量只服务帧，不再服务读者计数）；观看撤销时不再有 hide 清扫。
- **web**：`approval_settled` 只从横幅列表里摘除该审批，不再触碰卡片；卡片的等待态由恢复运行的 `tool_execution_start` 解除、由 `tool_execution_end` 定论。刻意不判别"拒绝 vs 执行失败"——`isError` 在三种情形（用户拒绝、工具失败、弃置）下都是 true，唯一诚实的表述是结果文本本身。
- **不变量**：答案不落盘、不进快照、不进账本（除了结果文本本来就要落的那条合成结果）；ADR-0025 的分层不变——mux 依赖反而更窄；REST 端点形状不变（仍回 `{ toolCallId, approved }`）；ADR-0018 的 grant「不再问」审批增量不变。
- **跨会话隔离**：不再依赖"表按会话键控"的约定，而是结构性的——帧键控到会话自己的流，结果在会话自己的事件里，一个会话的事实没有第二条路能到达别的会话的窗口。

## Testing Decisions

- **Seam：wire（`ServerMessage` 流）**，沿用既有 seam，不新增。断言只看外部行为：帧与事件到达什么流、什么顺序、带什么内容。
- **判定结果用文本，不用 `isError`**：工具自己的失败（剧本里 read 一个不存在的文件）也是 error result，`isError` 判别不了"拒绝"。grant 的断言是"结束事件的文本不是拒绝的句子"，deny/弃置的断言是"文本就是那句收尾的话"。
- **先例**：`smoke-approval.ts` 的五段结构（round trip / 多窗口 / 跨会话 / 停驻 / 重启）与 `smoke-subscribe.ts` 的审批横幅段是全部断言的既有 prior art；批量拒绝的收尾由 `smoke-approval-queue.ts` 的 sweep 断言覆盖。
- 关键新断言：每条观看流都收到 settled 帧且恰好一次；被拒路径与被弃置路径各以自己的执行结束事件收尾；一个 grant 的执行事件绝不出现在另一个会话的流上。

## Out of Scope

- 给工具结果加结构化 verdict 字段（如 `details.verdict`）——若未来有读者需要机器判别"用户拒绝 vs 工具失败"，再做；那会改账本消息格式。
- REST 审批端点的请求/响应形状。
- 审批增量、模式、工具集等闸门配置（ADR-0018 / ADR-0019 领域）。
- 前端卡片对"拒绝 vs 失败"的任何视觉区分。

## Further Notes

- 讨论中确立的取舍：把答案写进会话状态（永久存，改磁盘格式）vs 进程内暂存（答案表）vs **结果自报（本次选择）**。第三条路最便宜，因为它复用了"每个 tool_use 必须有配对 tool_result"这个本来就无法绕开的账本义务——结果反正要落，让它顺便说话就够了。
- 答案表的两个原始理由——"第二个窗口必须被告知答案"与"答案表按会话键控防 id 碰撞"——分别由"结果在会话自己的事件里、每个订阅者都收到"与"帧/事件键控到会话自己的流"结构性继承。
