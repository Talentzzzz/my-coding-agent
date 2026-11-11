# 03：smoke——修 §5 rig + 冷启动与生命周期断言

Status: ready-for-agent
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