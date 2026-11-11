# 02：扫描读侧——行从标记派生 pending

Status: resolved
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

## Comments

- 2026-11-11：实现完成。`SessionInfo.suspended` 由 `buildSessionInfo` 一处填充
  （扫描与 probe 共用这一个建 info 处），`toSessionRow` 派生 `pending: info.suspended ? 1 : 0`；
  两处注释（`toSessionRow`、`protocol.ts` 的 `SessionRow`）同步收账。projection 与 web 零改动。
- 验收证据：`verify-02.ts`（本目录，19 项断言全绿）——冷 seed（无 host）parked 行
  pending 1 / running false、无字段旧快照 pending 0、host 在世与 reap 后 live overlay 均账本派生、
  陈旧标记不上 live 行、rename 后 parked 无 host 行仍 pending 1（附带闭合，未改 refresh 代码）。
  `npm run check` 绿；smoke-projection、smoke-sessions、smoke-approval-endpoint 绿；
  smoke-mux 首跑一次 Ping 超时假失败、复跑两次全绿（与票 03 记的负载假超时同族）；
  smoke-approval §1–4 绿，§5 仍是票 03 要修的既有 rig 红（子进程「未知的会话」）。
- grep 证实快照标记的读取仍只在翻译两点、setter、fork 拷贝，加本票的 display 一路
  （`buildSessionInfo` → `toSessionRow`）；控制流不读。
- code-review 双轴：Standards 无硬违规（三条判断项已修：注释 snapshot 歧义、
  verify 脚本命名与重复扫描）；Spec 全符合、无越界。