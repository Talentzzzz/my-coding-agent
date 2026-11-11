# 03：smoke——修 §5 rig + 冷启动与生命周期断言

Status: resolved
Blocked by: 01, 02

设计见 `../spec.md`（测试计划）。

## 做什么

1. **先修 smoke-approval §5 的 rig**（`scripts/smoke-approval.ts` ~588–686，当前本就是红的）：
   父进程 `setSessionsDir(storeRoot)` 是进程内覆盖，spawn 的子进程只认
   `MY_AGENT_HOME/sessions`，报「未知的会话」。修法：§5 用独立 scratch home（mkdtemp），
   父进程 `setSessionsDir(join(restartHome, "sessions"))`，子进程 env
   `MY_AGENT_HOME=restartHome`；finally 清理 restartHome。注意 setSessionsDir 是进程全局，
   §5 在第 1–4 节之后跑，切换安全。
2. §5 加冷启动断言：子进程 healthy 后、`wire.open` 前，`connect` 一条新连接，
   `waitForConnection` 拿 overview `sessions` 帧，该会话行 `pending ≥ 1`、`running === false`。
   既有基线断言（`baseline.pendingApprovals.length === 1`）保留。
3. 标记生命周期断言（§4 或新小节）：
   - park 后直读 `.json`：`suspended: true`；
   - 回答+恢复完成后：字段消失；
   - abort 收尾（denyAllApprovals 路）后：字段消失；
   - fork parked 会话：fork 的 `.json` 有标记，fork 行 pending 1。
4. smoke-projection：对含 parked 会话的存储建全新 projection（纯冷 seed、无 host），
   行 pending 1；无字段旧快照行 pending 0。
5. 重命名闭合断言：parked、无 host 的会话，rename（`projection.refresh`）后行仍 pending 1。

## 验收

- `node scripts/smoke-approval.ts` 全绿（含 §5）。
- `node scripts/smoke-projection.ts`、`smoke-sessions.ts`、`smoke-mux.ts`、
  `smoke-approval-endpoint.ts` 绿。
- 单独跑各 smoke（并行负载曾造成 mux 握手假超时）。

## Comments

- 2026-11-11：实现完成，生产代码零改动。
  - §5 rig：独立 scratch home（`restartHome`），父进程 `setSessionsDir(join(restartHome, "sessions"))`
    且 `bootServer` 传 `settingsHome: restartHome`（`modelsHome` 缺省即同一 home，父子真正共享一份
    模型行），子进程 env `MY_AGENT_HOME=restartHome`；finally 清理 restartHome，不再触碰 storeRoot。
  - §5 冷启动断言：子进程 healthy 后先连一条**不开任何会话**的连接，overview `sessions` 帧断言
    `pending ≥ 1` / `running === false`，之后才 `wire.open`；既有 baseline 断言保留。
  - §4 生命周期：patient rig 加 park 后（`suspended: true`）与回答+恢复完成后（字段消失）两处直读
    `.json`；新增两个 rig——abort（放弃清扫后字段消失）与 fork（fork 的 `.json` 有标记、fork 行
    `pending 1` / `running false`；sidebar 先连、等 overview 确认注册再 fork，听 `session_row` 帧）。
  - smoke-projection：park 两个会话后释放，剥掉其中一个快照的字段；全新 projection 纯冷 seed
    （无 host）断言 pending 1 / pending 0；rename + `refresh` 闭合断言点仍亮。
- 验收证据：`npm run check` 绿；smoke-approval（含 §5 全部断言）、smoke-projection、smoke-sessions、
  smoke-mux、smoke-approval-endpoint **单独**跑全绿。smoke-mux 在评审子代理的并行负载下出现过一次
  握手假超时、复跑绿——票面已记的同族 flake，与本改动无关。
- code-review 双轴：Standards 无硬违规（判断项已修两处：park 助手改用 `hasPendingApprovals` 门面
  动词、`label` 参数改名 `promptText`；meta 读取助手保留 per-script——verify-01/02 同形，smoke
  自包含惯例）；Spec 全符合（修一处理论 race：fork 的 sidebar 等 overview 注册证明后再 fork；
  「父子共享模型行」注释经核实准确——`modelsHome` 缺省即 `settingsHome`，setting-manager.ts:44）。