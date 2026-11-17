# 02 - core：删除改否决式（中止 → 等收尾 → 闸内 rm → 出表）

Type: task
Status: resolved
Blocked-by: 01

## 背景与指针

- Spec：`Z:/my-coding-agent/.scratch/holds-into-manager/spec.md`（Solution §2、Implementation Decisions 第 3、4 条）。
- 探索笔记：`C:/Users/Administrator/WorkBuddy/spaces/2026_11_17_14-35-39/holds-into-manager-notes/exploration.md` §3.4（remove 现状——**rm 顺序与 spec 相反**）、§4（agent.ts 全貌）、§8.2（abort 的行为面）。

本票只动 core：`packages/core/src/agent.ts` 与 `packages/core/src/session/session-manager.ts`。hub 的三道守卫与 409 仍在（票 03 拆除），所以本票落地后 HTTP 行为暂时不变——这是预期的中间态。

## 改动

### 1. `Agent.deleteSessionBySessionId`（agent.ts L596-620）整个改写

新序：

1. **① 中止 + 等收尾 + 复查到稳定（有界）**：`isRunning(id)` → 复用现成的 abort 机制（agent.ts L1708-1742：`abortController.abort()` → `await activeRun.promise` → 等出槽微任务）。然后**复查循环**：`while (isRunning(id))` → 再次中止并等——覆盖收尾窗口里新启动的恢复运行（`respondApproval` 的 grant 会启动恢复运行，exploration §4.3）。循环**有界**（上限迭代数或时限），到界仍不稳就继续往下走——否决式，删除赢。`settle(id)`（L2048-2075）是仓库现成的「等收尾」助手，注意它注释里「微任务自旋会饿死运行」的教训。
   - 复用 `abort(id)` 时注意它的附带行为：`denyAllApprovals(id, "The run was aborted.")`（合成结果会写入账本——发生在 remove 之前，顺序正确）、停驻（suspended）袋不出表（没关系，第 ③ 步无条件出表）。
2. **② `sessionManager.remove(id)`**：见下。
3. **③ 出表**：`agentStateMap.delete(id)`（与现状一致）。
- 无文件对但有内存态的 id：保持现状语义（只出表）。
- JSDoc 重写：不再有「传输层先把会话安顿好」那句——删除自己安顿一切。

### 2. `SessionManager.remove`（session-manager.ts L1966-1971）rm 顺序反转 + 过闸

- **先删 `.json`（提交标记）后删 `.jsonl`（流）**——现状相反，必须反转。理由：`.json` 先走，两步 rm 之间到达的一切新写入方（prompt 前置校验、grant、冷路径）都查 meta、都读到「不存在」，中间态读作半途夭折的诞生，由既有扫描（`settleSessionFiles` / `fillSession` 的 prune）自愈；实证根据在 `.scratch/fs-race-test/test.mjs`。JSDoc 一并重写。
- 闸罩全程（票 01 已包上）。

### 3. `hasPendingApprovals` 本票**不删**

hub 守卫还在消费它（票 03 拆守卫），smoke 脚本也在用（票 04 清理后由票 04 删方法）。本票只把**删除守卫**里的这层语义拿掉（新序里没有这道检查）。

### 4. 不要做的

- 不动 hub / controller / routes（409 仍在是预期的中间态）；
- 不动 abort 命令本身的对外语义（abort 对未知 id 静默返回的现状归票 03 的实现检查点）；
- 不动队列（steer/followUp）、审批闸门内部、suspended 显示缓存。

## 验收

- `npm run check` 绿；
- `scripts/smoke-sessions.ts` 全绿（票 01 的用例 + 既有编排层表节 L874-896 的删除断言仍成立）；
- 新增一个 core 级否决式用例：用 `gatedApi` transport（仿 `scripts/smoke-approval-queue.ts` L80-147 的可控 gate 模式）把一次运行钉在半空 → 直接调 `agent.deleteSessionBySessionId(id)` → 断言：运行收到中止、流收尾、文件对消失、`findSessionFilePathById` 为 undefined、盘上无残留。
