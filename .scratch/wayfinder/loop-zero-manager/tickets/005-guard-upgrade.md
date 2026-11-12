---
label: wayfinder:task
title: 守卫升级：check-loop-boundary 机器化「只认函数」
status: open
assignee:
blocked-by: 004-landing
---

## Question

`scripts/check-loop-boundary.ts` 升级，把 ADR-0023 的新规则机器化：

- **负向（新增）**：`loop-manager.ts` 禁止 import 三只 Manager 与 hooks 所在模块
  （`session/session-manager.ts`、`setting-manager.ts`、`tools/`、`hooks.ts`——模块清单按
  ADR-0023 口径定）；静态 / side-effect / `export … from` / 动态 `import()` 同正则命中，
  注释先剥掉；
- **正向（保留）**：`agent.ts` 必须仍 import `loop-manager.ts` 的公开面；
- 接进 `npm run check`（排在 `check-server-facade` 之后），ADR-0023「后果」节补守卫口径；
- 任一文件缺失报错而非空转。
