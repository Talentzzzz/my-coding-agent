# 001：盘点 run 一族代码的现状

- label: wayfinder:research
- status: closed
- assignee: research 子代理（2026-11-11 图表会话放出）
- closed: 2026-11-11

## Resolution

发现全文在 [research/run-inventory.md](../research/run-inventory.md)（1–6 分节，行号经 Read/Grep 逐一确认）。要点：

- run 一族 ≈1805 行，占 agent.ts 的 61%（成员引擎段 1122–1994 + 文件级机件 2016–2947）。
- **编排层语义访问点：7 类 12 处**——dispatchEvent 整体（emit sink 是现成回调样本）、
  publishState×5、approvalsOf×1（prepareRequest:1513）、this.bag×1（recordSelection:1595，
  全引擎唯一摸会话表处）、setSuspended（run:1190）、this.hooks×3、live 半槽位（经参数写）。
- **loop 可自答访问点：6 类 ≈25 处**（settingsManager、tools、sessionManager 账本、api、
  systemPrompt、fanout）——恰好是 0012 六件依赖的形状，白名单候选面比预想窄。
- 三处入口改 loopOptions 的缺口：maybeCompact 绕过 run 直达 compactFor；respondApproval
  的审批前置账必须与 loop 共享同一只袋（0019）；袋需补 emit 回调（`(state, session, event)`
  签名现成）。
- **偏差**：old-loop-manager.ts 无法取回——该文件从未进入任何提交（511fc09 把 0012 立→
  0013 改→0014 删一次性入库）；替代证据在 §6：`.scratch/loop-manager/` 设计文档 +
  ADR-0012 文字 + `git show 511fc09^:packages/core/src/agent.ts`。
- **smoke 契约修正**：smoke 不直接 import agent.ts 路径，而是经 `@my-agent/core` 包入口
  （index.ts）import `danglingToolCallsOf` + `recoverPendingToolCalls`——抽取必须保住这条出口。
- blocked-by: （无）

## Question

`agent.ts`（2947 行）里一次运行的机械到底摸了 `this` 上的哪些东西？要产出一张清单底稿，
供白名单答辩（票 002）使用：

1. **成员方法清单**：ADR-0014 决定 1 的 18 个私有方法（`run`、`runEngine`、`prepareRequest`、
   `runContext`、`recordSelection`、`pumpAttempts`、`retryCallbacks`、`endRetry`、`compactFor`、
   `trimRecordedArgs`、`clearStaleToolResults`、`toolCallHooks`、`beforeTool`、`afterTool`、
   `drainTranscribed`、`dispatchEvent`、`handleRunFailure`、`finishRun`）各自的行号范围、
   一句话职责，以及**它读了/写了 `this` 的哪些成员**（`sessionManager`、`settings`、`tools`、
   `hooks`、`systemPrompt`、`api`、会话表、hold、订阅集合等）。
2. **文件级机械清单**：`streamAssistantResponse`、工具批次（`executeToolCalls` 及兄弟）、
   恢复机器（`danglingToolCallsOf`、`recoverPendingToolCalls`、`synthesizeToolResult`）、
   `pairLateToolResults`、`messagesOf`、`failureMessage` 等的行号与职责；确认哪些被 smoke
   直接导入（导出不能断）。
3. **分类**：每个 `this.*` 访问点标注是「编排层语义」（订阅者表、审批账本、hold、投影——
   这些是白名单回调的候选）还是「loop 可自答」（读设置、建模型、执行工具、fanout 文件级
   函数——这些跟着 loop 走）。
4. **运行入口**：`startPromptedRun`、`respondApproval` 的恢复路径、`maybeCompact` 三处入口
   现在给 `run` 什么、若改成 `loopOptions` 需要补什么。
5. **事件 sink 现状**：`agent.ts:1250` 附近的 `emit` 闭包怎么构造、`dispatchEvent` 里用了
   什么；这正是白名单回调的第一个现成样本。
6. **0012 时代的参照**：从 git 历史把被 0014 删除的 `packages/core/src/loop-manager.ts`
   捞出来（`git log --oneline -- packages/core/src/loop-manager.ts` 找删除前的提交，
   `git show <rev>:packages/core/src/loop-manager.ts`），存到本票同级
   `research/old-loop-manager.ts` 供对照——它当时怎么拿六件依赖、怎么拿 state 参数。

发现写入本票同级 `research/run-inventory.md`（按上面 1–6 分节），ticket 的 resolution
指向该文件。这是纯读 + git 取史的活，不改任何源码。
