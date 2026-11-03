# 08：Agent 接线——entryOf 换成 agentStateOf，Map 落在 Agent 上

Type: task
Status: open
Blocked by: 07

## Question

把 `packages/core/src/agent.ts` 从「向登记处要条目」改成「自己持表」。

- `private readonly openSessions: OpenSessions` → `private readonly sessions: Map<string, AgentState>`
  （`AgentConfig.openSessions` 换成 `sessions?`，缺省自建；01 号票定的接法）。
- `entryOf(id)` → `agentStateOf(id)`：`this.sessions.get(id)`，缺失即抛（现在抛 `Session is not running: ${id}`，
  语义不变）。
- 构造函数里 `this.openSessions = config.openSessions` 换成表 + `adopt(state): void` 公开方法（工厂装配后交给它；
  测试同一条路）。
- **15 处 `this.sessionManager.stateOf(id)` 全部换成 `agentStateOf(id).session`**：`snapshot`、`getApprovals`、
  `hasPendingApprovals`、`prompt`、`abort`、`moveBranch`、`setActiveTools`、`applyConfig`、`settle`、
  `respondApproval`、`denyAllApprovals`、`compact` 等（`grep -n "stateOf(" agent.ts` 是清单）。
- 字段搬家：`entry.runtime.steeringQueue` → `state.live.steeringQueue`；`entry.runtime.activeRun` →
  `state.live.activeRun`；`entry.run` → `state.live`（本票先把 `entry.run` 读成 `state.live`，`RunScope` 的删除
  留给 09 号票）；`entry.listeners` / `entry.eventListeners` → `state.listeners` / `state.eventListeners`；
  `entry.workDirAbsPath` → `state.session.sessionSetting.workDirAbsPath`；`entry.settings` → `state.setting`；
  `entry.modelSelection` → **`state.session.sessionSetting.model`**（见下）。
- **`modelSelection` 的去向**（拍板的一部分）：`applyModelSelection` 直接改 `sessionSetting.model`
  （`{ name, modelId?, thinkingLevel }` 的合并），`prepareRequest` 的 `recordSelection` 仍只在这里写盘；
  `snapshot` 的 `model` = `live.model ?? modelFor(sessionSetting.model, this.models.list())`——**运行中读 Live，
  空闲读袋**，这就是「输入框之外的都是 Live」。
- `modelFor(entry.modelSelection, …)` 的 4 处调用改成 `modelFor(sessionSetting.model, …)`（`modelFor` 现在的入参
  是 `ModelChoice`，形状够用；若 `modelId` 多余，就在本票顺手把 `ModelChoice` 与之一并）。
- `finalizeToolResult(state, entry, message)` 这类自由函数改收 `AgentState`。
- 收账：`npm run check` 绿；`node scripts/smoke-sessions.ts`、`node scripts/smoke-tools.ts`、
  `node scripts/smoke-models.ts` 绿（smoke 里手建 entry 的两处等 10/12 票）。

## Answer
