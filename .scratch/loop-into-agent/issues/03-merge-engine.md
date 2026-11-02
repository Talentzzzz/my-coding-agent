# 03 · 实施合并：引擎进 agent.ts，删 loop 包，smoke 迁移

Type: task（AFK）
Status: resolved
Blocked by: 01, 02

## Question

（不是决策，是执行）把 `packages/loop` 的引擎与类型并入 `packages/core/src/agent.ts`，删除
`packages/loop`，core 内全部 import 改指新家，`smoke-approval-recovery` 改为驱动 agent.ts
导出的恢复函数，`npm run check` 与全部 core smoke 绿。

## 工作清单

- [ ] 类型搬家（按 02 的答案落位）
- [ ] 引擎并入 agent.ts：有状态 → 私有成员（`dispatchEvent`、`prepareRequest`、activeRun
      槽位、`subscribe`/`abort`/`waitForIdle`、`runModel`）；无状态 → 文件级函数；恢复机器
      纯函数保持导出；`runToolCall` 内部化
- [ ] `startRun` 不再 `new Loop`；队列排水钩子（`LoopQueueHooks`）消失，drain 直读 Agent
      自己的队列；vendored 头注释删除
- [ ] core 内 19 个文件的 import 改指新家；`index.ts` 对外 re-export 保持
- [ ] 删除 `packages/loop`（目录 + `packages/core/package.json` 的 workspace 引用）
- [ ] `scripts/smoke-approval-recovery.ts` 改为驱动 agent.ts 导出的恢复函数
- [ ] `npm run check` 绿；core 相关 smoke 全绿

## Answer

**类型的新家：`packages/core/src/types.ts`（新文件，非 `protocol.ts`）。** 理由是分工：`protocol.ts` 是
wire 面（客户端看得见的东西），而工具/事件的契约不是 wire——它是引擎交给工具与 hook 的形状，两者
不该共用一个模块。`QueueMode` 只剩一份定义（在 types.ts），`protocol.ts` 改为 re-export，`index.ts`
的 `QueueMode` 仍从 protocol 出。

- 改名：`LoopContext` → `AgentContext`（与 `AgentEvent`/`AgentTool` 同族）。
- 删除（合并后无对应物）：`StreamFn`（引擎直接 `model.stream`）、`LoopConfig`、`LoopOptions`、
  `LoopRuntime`（02 已裁：Agent 直操作 `SessionRuntime`）、`LoopQueueHooks`（drain 直读队列）、
  `RunLoopOptions`、`PrepareRequest` / `PrepareRequestContext`（`prepareRequest` 现在是 Agent 的方法）。
- `ToolCallHooks` 从 `Pick<LoopConfig, …>` 变成独立接口：批次助手是文件级函数，这对 gate 是它们唯一
  还接收的参数，值得有自己的名字。
- `@ts-nocheck` 消失，整份代码过根 tsconfig（含 `noUncheckedIndexedAccess`）。为此改的都是真问题：
  `context.tools` 可选、`answers[id]` 可能缺、`filter` 需要类型守卫、`ToolResultMessage.details` 是
  `JsonValue | undefined` 而工具 `details` 无类型（唯一的显式 cast，就地注明）。

**引擎落位。** `Loop.runLoop` 的函数体成为 `Agent.runEngine`：activeRun 槽位仍在 `entry.runtime` 上
（abort 从任何层落下来的那一个控制器），事件经 `Agent.dispatchEvent`——它就是原来的 `handleEvent`，
现在同时是引擎的 sink，所以引擎不再需要一张自己的 listener 表；每轮的填充链是既有的
`Agent.prepareRequest`，被引擎直接调用；两个取走点直接 `drainTranscribed(entry.runtime.…)`，队列排水
钩子消失；`finishRun` 收摊 activeRun，`handleRunFailure` 写失败消息（模型作为参数传入，见下）。
`startRun` 只剩三件事：开 scope、包 transport、调 runEngine。

**偏离 01 字面、已按 ADR 裁定（记在这里以免后人以为是漏做）：**

1. `runModel` **没有**成为私有成员。它是 per-run 的量，而 Agent 是跨会话单例——一个字段会把 A 会话
   当前请求的模型交给 B 会话并发的 run。改成 `runEngine` 里的 `let model`，失败路径显式传参，语义
   （失败消息报的是最后一次请求用的模型）不变。这正是 ADR-0006 §5「run 的瞬态是 run 的局部变量」。
2. `activeRun` 槽位没有搬到 Agent：它住 `SessionRuntime`，02 已明确 `LoopRuntime` 结构视图消失、Agent
   直接操作 `SessionRuntime`。同理 `subscribe`/`waitForIdle` 由既有的 `onEvent`/`settle(id)` 承担，
   `abort` 本来就是 Agent 的公开方法（比 `Loop.abort` 更完整：abort 后还扫悬空审批并 publish）。

**文件级函数与导出。** 批次执行、截断失败、dangling 扫描、恢复机器都是无状态助手，留在文件级。
`danglingToolCallsOf` 与 `recoverPendingToolCalls` 导出（`index.ts` 一并导出，供 smoke 直接驱动）；
`runToolCall` 降为内部函数且按 Q8 不导出——目前全仓无调用者，注释就地写明这一点。

**删包。** 目录、root `workspaces`、`packages/core/package.json` 依赖、root tsconfig 的 path、
`check` 里的 loop tsc、`install-deps.ts` 的 workspace 清单、`node_modules/@my-agent/loop` 链接，全删。

**smoke 迁移。** `smoke-approval-recovery` 的「开关」小节不再 `new Loop`，改为直接驱动
`recoverPendingToolCalls(context, danglingToolCallsOf(...), …)`：toggle 关掉 = 不合成、不发声；默认 =
孤儿收尾；重复 suspend = 停在原处、什么都不写。语义不变，断言改为看返回的 batch 与 emit 到的帧
（原来那句「没有请求发出去」在机器这一层是结构性的：什么都不返回就没有东西可发）。

**验证。** `npm run check` 绿。smoke 全绿：`smoke-tools` / `smoke-models` / `smoke-sessions` /
`smoke-mux` / `smoke-session` / `smoke-approval` / `smoke-approval-endpoint` / `smoke-approval-recovery` /
`smoke-branch` / `smoke-replay` / `smoke-settings` / `smoke-modes` / `smoke-default-model` /
`smoke-stream` / `smoke-transcript` / `smoke-projection` / `smoke-sidebar` / `smoke-frame` /
`smoke-model-form` / `smoke-boot` / `smoke-liveness` / `smoke-backpressure` / `smoke-mux-client`。
两处非本票的问题，已核对：`smoke-api` 需要先起服务器；`smoke-mux-live` 的 5 项失败在 HEAD 的
worktree 上同样失败（同一批断言），是既有问题，不是合并引入的。

**本票不做：** ADR-0008（04 票）、`AGENTS.md`/`architecture.md`/`README.md` 同步（05 票）。
