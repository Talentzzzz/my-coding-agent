# 004：按 ADR-0022 落地——loop 抽出、check 与 smoke 全绿

- label: wayfinder:task
- status: closed
- assignee: WorkBuddy（2026-11-12 实现会话）
- closed: 2026-11-12
- blocked-by: 003-adr-0022（已解除）

## Resolution

四条全部落地；一处按 ADR 内部裁决记了偏差，两处 pre-existing 红与基线同色。

1. **`packages/core/src/loop-manager.ts`（1940 行）**：决定 1 清单里的 17 个方法（除
   `dispatchEvent`，见下）+ 文件级机械（`streamAssistantResponse`、工具批一族、恢复机器、
   `pairLateToolResults`、`messagesOf`、`failureMessage` 等）整体迁入；`LoopManager` 零字段、
   零构造参数；方法体业务逻辑一字不改，机械改动只有三类——`this.六件` → `loopOptions` 解构
   （`settingsManager` 经解构重命名保住原变量名）、`this.bag` → `loopOptions.bagOf`、
   `this.services` → 文件级 `servicesOf(loopOptions)` 现凑。压缩入口 `compact(loopOptions)`
   把 `maybeCompact` 的模型计算四行搬进 loop，参数是 `CompactOptions = Pick<LoopOptions,
   "state" | "bag" | "sessionManager" | "settings"> + entries/now/signal/transport`——
   正是「复用同一只袋的字段、start 不适用」的形状。
2. **`agent.ts` 收缩（2947 → 1172 行）**：会话表、读面、命令、审批账本、投影 + 事件契约。
   新增 `private readonly loop = new LoopManager()` 与 `private loopOptions(state, bag, start)`
   组袋助手（六件服务 + `bagOf: (id) => this.bag(id)` + `emit` 转发 `dispatchEvent`）；
   `startPromptedRun` / `respondApproval` 恢复路径 / `maybeCompact` 三处入口改为组袋调 loop，
   审批前置账与写消息留编排层、与 loop 共享同一只袋（0019）。**偏差（记入 ADR 后果节）**：
   决定 1 的 18 方法清单里有 `dispatchEvent`，落地时它按决定 4 的白名单答辩留在编排层——
   组合政策与命令面发布是同一窗口契约的两半，分居两文件即答辩要防的漂移面；迁入 loop 的是
   17 个方法，`dispatchEvent` 宿主是编排层、`loopOptions.emit` 是它的出口。
3. **恢复机器保持导出**：`RunStart` / `DanglingToolCall` 随文件迁走、继续从
   `loop-manager.ts` 导出。「尚未决定」第 1 件择定：`index.ts` 的 re-export 源**直指
   `./loop-manager.ts`**（不经过 agent.ts 转手；agent.ts 落地后不再 import 这两个名字，
   转手层没有存在的理由），包对外名字一字不变。
4. **验证**：`npm run check` 全绿（core/server tsc + token 审计 + server 门面守卫）。
   smoke 全套与改动前同色——`smoke-sessions` / `smoke-approval-recovery`（经包入口驱动
   恢复机器，契约未断）/ `smoke-approval` / `smoke-approval-endpoint` / `smoke-approval-queue` /
   `smoke-models` / `smoke-default-model` / `smoke-projection` / `smoke-mux` / `smoke-mux-client` /
   `smoke-mux-live` / `smoke-liveness` / `smoke-backpressure` / `smoke-session` / `smoke-stream` /
   `smoke-replay` / `smoke-boot` / `smoke-api`（带临时 home 的活服务器）/ `smoke-settings` /
   `smoke-modes` / `smoke-branch` / `smoke-transcript` / `smoke-frame` / `smoke-sidebar` /
   `smoke-model-form` / `smoke-desktop-close` 全绿；`smoke-tools` 与
   `smoke-desktop-observability` 红，但**均在干净 HEAD（c9524be）上以相同错误红**
   （stash 验证：前者 `UnknownSessionError: idle-session` @ smoke-tools.ts:1007，后者
   `bootWithinBudget is not defined` @ desktop/observability.cjs）——pre-existing，非本次引入。
   行数账补进 ADR-0022「后果」（agent.ts 1172 + loop-manager.ts 1940，run 一族 ≈2020 行）；
   `AGENTS.md`（布局 + engine 词条）、`docs/architecture.md`（core 职责、归属表、目录布局、
   「循环」一节、retry 接缝、请求链图、压缩对照表）、根 `README.md`（开头与「状态」）一并改指 0022。

静态守卫归票 005，本票不动 `npm run check`。

## Question

按已接受的 ADR-0022 搬代码：

1. 新建 `packages/core/src/loop-manager.ts`：0014 决定 1 的 18 个私有方法 + 文件级机械
   （流、工具批次、恢复机器、`pairLateToolResults`、`messagesOf`、`failureMessage`）整体
   迁入；`this` 上的访问按白名单改写成回调或 loopOptions 字段，**方法体的业务逻辑一字
   不改**（0014 决定 1 的「唯一的机械改动」纪律反过来用同样成立）。
2. `Agent` 收缩为编排层：会话表、读面、命令、审批账本、投影；运行入口改为构造
   `loopOptions` 并调 loop；`abort` / `settle` / `close` 不动（见 map 的 Out of scope）。
3. 恢复机器保持导出——精确契约（001 票确认）：smoke-approval-recovery 经 `@my-agent/core`
   包入口（index.ts）import `danglingToolCallsOf` + `recoverPendingToolCalls`，不直接 import
   agent.ts 路径；index.ts 的 agent 出口必须保住。
4. `npm run check` 全绿、smoke 全套与改动前同色；记录前后行数账进 ADR 的「后果」节。

这是本 map 把执行纳入范围的 override 票（见 map Notes）。
