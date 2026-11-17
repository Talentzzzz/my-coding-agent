# 04 - 测试：spec Testing Decisions 全量落地 + hasPendingApprovals 退场

Type: task
Status: resolved
Blocked-by: 03

## 背景与指针

- Spec：`Z:/my-coding-agent/.scratch/holds-into-manager/spec.md`（Testing Decisions 整节 + User Story 13）。
- 探索笔记：`C:/Users/Administrator/WorkBuddy/spaces/2026_11_17_14-35-39/holds-into-manager-notes/exploration.md` §6（smoke 现状与确定性 gate 模式）。

票 01-03 已落地：Manager 级闸用例（01）、core 级否决式用例（02）、既有 409 用例的机械改写（03）。本票补齐 spec Testing Decisions 的**其余**用例，并做最后的清理。

## 改动

### 1. smoke-api.ts（HTTP 表面，主接缝）新增用例

时序敏感的用例用确定性手段构造（`createSessionAgent` 的 test-only 接缝 / `gatedApi` 可控 gate），不靠 sleep 赌调度。smoke-api 连外部 HTTP——需要可控 gate 时，仿 smoke-sessions 的 bootServer 模式把用例放对文件，或给 smoke-api 起进程内服务器（它现在的 MY_AGENT_URL 模式保留给既有用例）：

- **运行中删除 → 202 应答先到**：gatedApi 钉住运行 → DELETE → 断言 202 先于运行结束到达（gate 未放行时应答已回来）→ 放行/中止生效 → `until` 轮询到运行收尾、删除完成 → 列表无该行、读 → 404、盘上无残留、无僵尸行。
- **停在审批闸门（suspended）的会话删除 → 成功**：造一个停在审批闸门的会话（gatedApi + grant 前挂起，或直接驱动机器的既有模式）→ DELETE → 202 → 最终 404、文件消失。
- **删除后对同一 id 的读 → 404**；删除完成后到达的 mutating 命令 → 404（闸内拒绝的端到端表现）。
- **health → 应答不再含 `held` 字段**（exploration §8.11：现状无任何断言，补上）。
- 第二次删除 → 404（保留 03 改写过的断言）。

### 2. smoke-sessions.ts 补充否决式用例

- rm 两步之间的中间态（用票 01 的 test-only gate）：中间态下 `findSessionFilePathById` 回答 `undefined`，新写入方被存在性检查挡住；扫描（`settleSessionFiles`）清掉半途夭折的中间态——参照既有不可打开配对被删的用例风格（L898-947）。
- 删除与在途 mutating 撞车：删除后（文件消失）到达的 meta setter / append → `UnknownSessionError`，无孤儿文件、无诈尸（User Story 4）。

### 3. `hasPendingApprovals` 退场

hub 守卫已拆（票 03）、smoke 消费者已在本票改写完毕后：删除 `Agent.hasPendingApprovals`（agent.ts L762-771）。exploration §4.5 的 smoke 消费者清单（smoke-approval-recovery / smoke-approval-queue / smoke-approval / smoke-projection / smoke-session）逐个改写为不依赖它的等价断言（悬空审批的可观察面在投影与审批端点的 409 上）。单数版 `hasPendingApproval`（approve 端点的 409 预检查）**保留**。

### 4. 既有回归

- `npm run check` 全绿；
- 逐条核对 spec Testing Decisions 清单，每条都有对应用例或在票 01-03 已覆盖（在票注里记录核对结果）。

## 验收

全部 smoke 脚本通过；`npm run check` 绿；spec Testing Decisions 清单逐条有主。
