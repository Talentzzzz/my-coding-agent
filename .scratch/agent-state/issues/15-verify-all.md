# 15：全量验证——check、smoke 全套、桌面手测

Type: task
Status: open
Blocked by: 14

## Question

收总账。逐项跑、逐项记结果，失败的回修到绿。

1. `npm run check`（三个包的 tsc + token 审计）。
2. `node scripts/smoke-sessions.ts`（重点：打开→说话→切走→切回，队列与订阅的表现）。
3. 全系 smoke：`smoke-api` / `smoke-mux` / `smoke-mux-client` / `smoke-mux-live` / `smoke-projection` /
   `smoke-approval` / `smoke-approval-endpoint` / `smoke-approval-queue` / `smoke-tools` / `smoke-models` /
   `smoke-settings` / `smoke-modes` / `smoke-branch` / `smoke-replay` / `smoke-transcript` / `smoke-liveness` /
   `smoke-frame` / `smoke-backpressure` / `smoke-boot` / `smoke-default-model` / `smoke-desktop-close` /
   `smoke-desktop-observability`。
4. `npm run build:web`。
5. 桌面手测清单（人工，写进本票 Comments）：开一个会话 → 发消息 → 跑到一半切走 → 切回（Live 还在、流没断）→
   审批挂起时切走再切回（横幅还在）→ 侧边栏改名 → 删除 → 改设置后另一个会话打开是否看到。
6. 回修清单：哪一条 smoke 是**真回归**、哪一条是**按新语义重写**，分别记在本票 Comments 里。

## Answer
