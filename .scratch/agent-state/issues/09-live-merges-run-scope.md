# 09：Live 合并 RunScope——删 retryMaxAttempts

Type: task
Status: open
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
