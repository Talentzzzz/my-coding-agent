# 实施步 1：骨架（五包 stub）

Type: task
Status: resolved
Blocked by: 10

## Question

按 [spec.md](../spec.md) §7 步 1 落地五包骨架：全部 stub、不改任何既有文件的行为。
验收 = `npm run check` + 基础门。

## Answer

`lm/step1-skeleton`（88a8fd7），已并入 `layered-modules`。五包 stub（package.json 依赖与
exports 按终态一次写全）+ 根 workspaces / install-deps 表 / tsconfig paths 七条与 include
glob。check 与基础门四条 smoke 全绿，改动前后各验一遍。零偏离。
