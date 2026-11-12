---
label: wayfinder:task
title: 按 ADR-0023 落地
status: open
assignee:
blocked-by: 003-adr-0023
---

## Question

按 ADR-0023 落地：

1. `loop-manager.ts` 全面回调化：方法体机械改动（六件依赖解构 → 回调调用），`servicesOf` 删除，
   `CompactOptions` 按票 002 定稿改；
2. `agent.ts` 提供全部回调实现（内部自己摸 Manager / fanout / toolStateOf），三入口组袋处
   递入回调；
3. 验收：`npm run check` 全绿 + smoke 与基线同色（`smoke-tools` /
   `smoke-desktop-observability` 在干净 HEAD 上同红的既有口径）；恢复机器保持导出；
4. 实况文档同步：`AGENTS.md` / `docs/architecture.md` / `README.md` 改指 0023；
5. 行数账补进 ADR-0023「后果」节；落地偏差如实记进本票与 ADR。
