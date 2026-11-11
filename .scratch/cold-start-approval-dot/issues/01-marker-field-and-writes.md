# 01：标记字段与写入点

Status: ready-for-agent
Blocked by: （无）

设计见 `../spec.md`（形状、写入点、不变式）。本票只做 core 的字段与写侧。

## 做什么

1. `SessionMeta`（`packages/core/src/session/session-manager.ts:72`）加 `suspended?: true`，
   仅 true 落盘；`SessionSetting`（:1043）加 `suspended`，注释写明它是可重建的显示缓存、
   不是用户选择。版本不动。
2. 两个翻译点：`fillSession`（:1248）合并 `meta.suspended === true`；
   `metaOf`（:1169）仅 true 时落字段。不开第三个翻译点。
3. `SessionManager.setSuspended(bag, suspended)`，走 `recordMeta`（:1417），
   形态照 `setToolConfig`；no-op 时不重写。
4. 三个写入点：
   - `Agent` 运行收尾清扫（`packages/core/src/agent.ts` ~1259–1301）：
     `setSuspended(bag, live.suspended)`。
   - `denyAllApprovals`（`agent.ts:1067`）：清 `live.suspended` 处同步 `setSuspended(bag, false)`。
   - `forkFrom`：当前值复制处（title/model/level/工具/审批五值随拷）加第六值。
5. **不动** `respondApproval`：回答到达不清标记，恢复运行收尾才清。

## 验收

- park 一个会话后直读其 `.json`：有 `suspended: true`；回答+恢复完成后：无该字段；
  abort 收尾后：无；fork 一个 parked 会话：fork 的 `.json` 有标记。
- 无字段旧快照 `fillSession` 读出 `suspended === false`，不报错、不迁移。
- 重复同值写入不产生快照重写（recordMeta no-op）。
- `npm run check` 绿；smoke-approval 第 1–4 节、smoke-sessions 绿。
- 控制流（hasPendingApproval / respondApproval / recoverPendingToolCalls）不读新字段。