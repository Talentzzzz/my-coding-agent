# 09：Live 合并 RunScope——删 retryMaxAttempts

Type: task
Status: resolved
Blocked by: 08

## Question

`RunScope`（`agent.ts:317`）现在是每次 `startRun` 现造、`finally` 里丢掉的运行瞬态：`partial` / `model` /
`suspended` / `retrying` / `retryAttempt` / `retryMaxAttempts`。字段搬进常驻 `live` 之后：

- 删 `RunScope` 接口；`runEngine(scope, …)` / `pumpAttempts(scope, …)` / `retryCallbacks(scope, …)` /
  `endRetry(scope, …)` / `dispatchEvent(scope, …)` 一律改收 `state: AgentState`（它们本来就同时收 `state`）。
- **重置点**：`startRun` 开头把 `live.partial = undefined`、`live.model = undefined`、`live.suspended = false`、
  `live.retrying = false`、`live.retryAttempt = 0` 一次写完（这是现在 `const scope = {…}` 的位置）；
  `finally` 里除了 `activeRun` 与队列，其余字段**不清**——它们是「上一次运行结束时留下的读数」，清了下一次
  快照就读不到。要确认这一点：空闲会话的快照读 `live.model` 会是上一次运行的模型（现在是 `run?.model ??
  modelFor(...)`，退到目录）。**推荐**：`finally` 里把 `live.model` 也清掉，保持现在的读法。
- `retryMaxAttempts` 删除。`retry_scheduled` / `retry_start` 事件里的 `maxAttempts` 现取
  `getRetrySettings(state.setting).maxAttempts`（`pumpAttempts` 已经读过一次，把它提到调用点即可）。
  代价：重试等待中改设置会让下一次事件的 `maxAttempts` 跳变——接受。
- `snapshot()` 里 `run?.partial` / `run?.retrying` / `run?.retryAttempt` / `run !== undefined` 的判断改成读
  `live`：`submitting` 仍是 `live.activeRun !== undefined`（不能只看 `retrying`，见下一行），
  `isRetrying: live.retrying`，`retryAttempt: live.retryAttempt`，`partial` 仍是 `live.partial`。
- 收账：`npm run check` 绿；`node scripts/smoke-sessions.ts`（含 retry 一节）、`node scripts/smoke-approval.ts` 绿。

## Answer

### 结论（一句话）

`RunScope` 整个删掉（接口、`open-session.ts` 的 `run` 槽、`index.ts` 导出、`dropQueued` 文档里的引用），
五个运行瞬态的重置点从 `finally` 搬到 `startRun` 开头一次写完，`finally` 只清 `live.model`（照票面推荐），
`retryMaxAttempts` 连同闭包变量一起删——`retry_start` 的 `maxAttempts` 在 `pumpAttempts` 调用点由设置现算；
`check` 与 smoke 全绿。另补了一处票面没写的必然推论：`denyAllApprovals` 里显式清 `live.suspended`。

### 落地形状

- **agent.ts**
  - `RunScope` 接口连同 doc 块删除。08 号票已把五个字段全部搬到 `Live`、五个函数
    （`runEngine` / `pumpAttempts` / `retryCallbacks` / `endRetry` / `dispatchEvent`）全部改收
    `state: AgentState`、`snapshot` 全部改读 `live`——本票只剩壳。
  - **重置点搬家**：`startRun` 顶部（原 `const scope = {…}` 的位置）一次写完
    `partial` / `model` / `suspended` / `retrying` / `retryAttempt` 的清零；`finally` 里照票面
    **推荐**只清 `live.model`，空闲快照退回目录的读法不变。其余四个留着——它们是「上一次运行结束时
    留下的读数」：`partial` 本就在 `message_end` / `agent_end` 清，`retrying` / `retryAttempt` 本就在
    `endRetry`（含 `pumpAttempts` 尾部的兜底收口）归零，真正带语义过场的是 `suspended`——挂起运行结束
    后、恢复运行开始前，`live.suspended === true` 就是「停在审批闸门」的读法。
  - **`retryMaxAttempts` 删除**：`retryCallbacks` 的闭包变量没了；`pumpAttempts` 把
    `getRetrySettings(state.setting)` 提到调用点一次读出，`retryAssistantCall` 与 `retryCallbacks` 收
    同一份——`retry_scheduled` 沿用策略回调带来的 `maxAttempts`（同一份设置的同一换算），
    `retry_start` 用提上来的那个数。换算式与 `retry.ts` 逐字对齐：`enabled ? maxRetries : 0`
    （`RetrySettings` 上没有 `maxAttempts` 字段，`maxRetries` 计的是重试次数）。票面接受的代价照旧：
    重试等待中改设置，下一次请求的事件 `maxAttempts` 才跟着变。
  - **补遗（票面没写，但不做就是泄漏）**：`finally` 不再清 `suspended` 之后，`denyAllApprovals`
    （放弃清扫——宽限到期、无人回来）成了唯一一条「运行结束了、恢复运行永远不会来」的路径，挂着
    `suspended === true` 会把 `evict` 判据（`activeRun === undefined && !suspended`）永久堵死，
    被 reap 的会话状态清不掉。清扫点显式 `live.suspended = false` 并注了理由。`respondApproval` 的
    恢复运行由 `startRun` 顶部清零覆盖，不受影响。
  - `dropQueued` doc 里的 `RunScope.suspended` 引用改成 `live.suspended`。
- **open-session.ts**：`run` 槽与 `RunScope` import 删除（08 之后已无任何读者），工厂里
  `run: undefined` 随之；接口 doc 里「cross-stack run slot」两句一并摘掉。本体文件的删除仍是 14 号票。
- **index.ts**：`type RunScope` 导出移除。
- **agent-state.ts**：`Live` 无需改——07 号票建它时就没收 `retryMaxAttempts`。

### 验证

- `npm run check` 绿（core / server / web tsc + token 审计）。
- `smoke-sessions`（含 retry 一节）/ `smoke-approval` / `smoke-approval-recovery` /
  `smoke-approval-queue` / `smoke-approval-endpoint` / `smoke-session` / `smoke-tools` /
  `smoke-models` / `smoke-settings` / `smoke-projection` / `smoke-branch` / `smoke-replay` /
  `smoke-mux` / `smoke-transcript` / `smoke-stream` / `smoke-liveness` / `smoke-modes` /
  `smoke-backpressure` / `smoke-boot` / `smoke-sidebar` / `smoke-default-model` / `smoke-frame` 全绿。
- `smoke-approval` 首跑出现过一次 `1 FAILED`，复跑 4 次（含 stash 后干净 master）全绿——grace 计时段
  的既有偶发，与本票无关。`smoke-api` 维持 07 号票登记的本机 mux 环境问题，未重跑。

### code-review 记录

两轴跑完，处置如下：

1. **Spec 轴（已修）**：`denyAllApprovals` 清 `suspended` 的注释原写「blocking both a new prompt's
   acceptance and the state's own eviction」——`prompt` 只查 `activeRun`，不查 `suspended`，前半句
   言过其实；改 为只说 evict 判据。
2. **Standards 轴（登记归属 14 号票）**：AGENTS.md 的「OpenSessions（活登记处）」条目仍写「跨栈
   run 槽」，`docs/architecture.md` 与 `smoke-sessions.ts` 的注释同样还描述 run 槽——`OpenSession`
   本体的删除与全仓 grep 清零本就是 14 号票的范围（`OpenSessions` / `RunScope` / `run 槽`一并列），本票
   不动文档避免二改。
3. **Standards 轴 smell（judgement call，保留）**：读数归零的知识现在散在三处（`startRun` 开头五连
   赋值、`finally` 只清 `model`、`denyAllApprovals` 清 `suspended`）。三处清的**子集各不相同**且各有
   独立理由（恢复运行前的过场读数 / 空闲退目录 / 放弃清扫的终点），抽一个 `resetLiveReadings` 助手反而
   要靠布尔参数挑字段，把差别藏进调用点——保留分散，注释里已把清单位置写明。
4. `maxAttempts` 与 `retrySettings` 结伴传参（Data Clumps，轻微）——派生式就一行且注释已写明与
   `retry.ts` 对齐，收窄成类型过重，保留。
