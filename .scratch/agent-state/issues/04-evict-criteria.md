# 04：驱逐判据——「没在跑」到底怎么算

Type: grilling
Status: open
Blocked by: 01

## Question

拍板的条件是「窗口没人看了 + loop 没在跑」。但代码里有三个「没在跑、却清不得」的情况：

1. **suspended**：审批闸门结束的那一轮里 `suspended = true`、`activeRun === undefined`，队列是**故意保留**的
   （`packages/core/src/agent.ts:1462` 的 drop 例外），因为恢复运行要取走它们。按字面条件清掉，等于丢掉用户
   在运行中刚敲的消息——而账本里的悬空 tool call 还在，人回来会看到横幅、却没有那条消息。
2. **claim 在飞**：审批答案、重命名这类请求**不跑 loop**，但正在改这个会话。
3. **审批宽限**：`approvalGraceMs` + `reap` 里的 deny（`hub.ts:747-808`）。会话被清掉后重开，横幅仍从账本派生
   （`hasPendingApprovals` → `danglingApprovals`），所以宽限不是「保住横幅」用的，它是「没人回答就拒」这条语义
   的触发器。这条语义还留吗？

要定：

- 判据的完整形态：`observers 空 && live.activeRun === undefined && live.suspended === false && claims === 0`？
- 宽限期与 reap 的 deny 删还是留；删了之后「无人回答的审批」什么时候收尾（现在的答案：下一次运行的恢复机器把
  孤儿合成错误结果，所以**可以不收尾**）。

➡️ 推荐：判据加上 `suspended === false && claims === 0`；**宽限与 reap 的 deny 一起删**——「没人回答就拒」
退化成「下一次运行自己收尾」，少一条计时器状态机。要说的代价写进 ADR：审批可以悬空到进程重启。
