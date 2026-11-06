# 09 - 本轮名单进执行链：先判活再取实例（04 §2.4）

Type: task
Status: open
Blocked by: 08

## Question

08 之后 Map 装全部六个，`manager.get(name)` 找得到**禁用**的工具——「未激活工具的调用回
`Tool <name> not found`」这条既有行为（`docs/architecture.md:125`）于是缺一半。按 04 §2.4 把本轮
`activeNames` 作为栈上局部显式穿过执行链，让 `prepareToolCall` 与 `executionMode` 判定**先判活再取实例**。

### 依据（都已 resolved）

- **04 §2.2**：`toolStateOf(...)` 仍返回 `{ activeToolNames, approvalOverride }` 纯数据、仍每次现算；
  `prepareRequest:1252` 与 `Agent.run:999` 各把 `activeToolNames` 收成这一请求的局部；
  `:1063-1070` 每次 `prepareRequest` 返回后随 `currentContext` 换成这一轮那份（`requestUpdate` 缺省时沿用上一轮）。
- **04 §2.4**：`activeNames`（数组或 `Set` 由本票选）与 Manager、`run` 一样显式传过
  `:1011` 恢复机器 → `:1101` → `:2082` / `:2099` / `:2161` → `:2264` → `:2393`；
  `prepareToolCall` 在闸门前 `activeNames.has(name)` 判活，落空仍回今天那句 `Tool <name> not found`
  （`:2273-2279`）；命中才 `manager.get(name)`；`executeToolCalls:2091` 的 `executionMode` 判定同样先判活，
  否则一个已被禁用的 `bash` 会把整批翻成 sequential。
- **04 §2.4 的衔接**：03 §5 #6 的「未知名」在 Map 装全部六个之后只能读作「**不在本轮名单**」；
  本票补的正是这一半，**不改 03 / 04 的任何决定**。
- **04 §5 #5**：判活归引擎，不归 Manager——Manager 只答「这个名字存在吗、给我实例」，
  答不了「这个会话这一轮准不准」；执行入口不重复判活（03 §2.4）。
- **05 §3.5 的后半**：`recoverPendingToolCalls` 还要拿本轮 `activeNames`；分传还是合对象、放第几位归本票。

### 改动面

| 落点 | 动作 |
|---|---|
| `agent.ts:1252` / `:999` | 派生本轮 `activeNames`（07 已在 `:999` 用过它的局部值装数组，本票把它收成一份可传的值） |
| `agent.ts:1063-1070` | `prepareRequest` 返回后换掉本轮那份；`requestUpdate` 缺省时沿用上一轮 |
| `agent.ts:1011` / `:1101` | 入口把 `activeNames` 一并传下去（`recoverPendingToolCalls` 签名在 08 已加 Manager + `run`，本票补第三个值） |
| `agent.ts:2082` / `:2091` / `:2099` / `:2161` | 两条批次路径链上带 `activeNames`；`:2091` 先判活再读 `executionMode` |
| `agent.ts:2264-2339` | 闸门前 `activeNames.has(name)`，落空回 `Tool <name> not found`（用的是今天那段代码，不新增来源） |
| `scripts/smoke-approval-recovery.ts:268-311` | 三个调用点补本轮名单（`["read"]` 量级），断言不动 |

### 边界（不做）

- 不改 `Context.tools` 的元素（03 决定 1 不变）、不回退 08 的改道。
- 不把 `activeNames` 塞进 `Context` / `AgentState.live` / Manager / 模块级全局；不给 Manager 加判活方法。
- 不动 `setToolConfig` / 审批 / 账本格式（04 §5 #2 #3 的零改动面）。
- 不改文档与 ADR（归 10）。

### 验收

- `npm run check` 绿。
- 28 条 smoke 对跑 **26 绿 / 2 既有红、零新红**；`smoke-session.ts:1342-1343`「禁用工具仍回 not found」
  仍绿，并且**路径经判活**（不是靠 `get` 找不到）。
- 新增一条可测断言（本票定形）：一个会话禁用 `bash` 后，`executionMode` 判定不因 `get("bash")` 命中
  而把批次翻成 sequential——具体断言形式按 04 §2.4 写的两处行为定。
- `smoke-approval-recovery` 绿：grant 重跑仍经 Manager，且名单外的工具不被执行。

### 交接（给 10）

`## Answer` 记：`activeNames` 的最终形态（数组 / `Set`、传参位置、`recoverPendingToolCalls` 的完整签名）、
两处判活落点、新断言、check / smoke 数字（`../smoke-runs/after-09/`）、以及「代码面到此收口，
只剩文档收账与全量验收」。
