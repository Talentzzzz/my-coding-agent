# 02：扫描读侧——行从标记派生 pending

Status: ready-for-agent
Blocked by: 01

设计见 `../spec.md`（读取点、附带闭合）。

## 做什么

1. `SessionInfo`（`packages/core/src/session/session-manager.ts:223`）加 `suspended: boolean`，
   扫描与 probe 建 info 处从 meta 取（缺省 false）。
2. `toSessionRow`（`session-manager.ts:2291`）：`pending: info.suspended ? 1 : 0`，
   替换硬编码 0。注释同步改写——「没有 host 的会话没有在等的审批」这句旧语义假设
   （内存挂起时代的遗留）不再成立，`running` 仍是进程事实，`pending` 现在是账本事实的缓存。
   `protocol.ts` 的 `SessionRow` 注释（~:42「running 和 pending 没有存储形式」）同步收账。
3. **projection 与 web 零改动**：seed/probe 共用 toSessionRow，一条路改完两处生效；
   `busyOf`（`packages/web/src/render/sidebar.ts:101`）已认 pending ≥ 1。
4. 确认附带闭合：`projection.refresh`（重命名路径）对无 host 会话发布 probe 行，
   现在自动带 pending 1——不改 refresh 代码，靠 03 号票的断言钉住。

## 验收

- 含 parked 会话的存储，全新 projection 冷 seed（无 host）：行 `pending === 1`、`running === false`。
- 无字段旧快照：行 pending 0。
- host 在世时 live overlay 仍以账本派生为准（进程内修复不回退）。
- `npm run check` 绿；smoke-projection、smoke-sessions 绿。