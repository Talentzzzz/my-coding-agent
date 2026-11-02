# Loop 并入 Agent —— wayfinder 地图

## Destination

`packages/loop` 从仓库里消失：`Loop` 类与全部引擎代码并入 `packages/core/src/agent.ts`，
引擎相关类型并入 core，`Loop` 不再是委派对象而是 Agent 自身的能力——引擎里原来靠构造
函数传递的东西（prepareRequest、dispatchEvent、runtime 槽位、队列排水钩子）变成直接调
Agent 的成员。`npm run check` 与全部 smoke 绿，ADR-0008 与文档同步落地。

## Notes

- 领域：本仓库自有代码（`packages/core`、`packages/loop`、`scripts/`）。术语与约定的家是
  `AGENTS.md`（本仓库无 CONTEXT.md，术语更新随执行走 AGENTS.md）。
- 决策已全部在 2026-11-02 的 grilling 会话与用户逐题敲定（见 Decisions so far）；本 effort
  携带执行（用户选 Q5b），执行类 ticket 是 task 型。
- 决策速记：收编 vendored 代码（Q1）；全部代码住 agent.ts——有状态 → Agent 私有成员、
  无状态 → 文件级函数（Q2a）；去掉 `@ts-nocheck`、过根 tsconfig 严格检查（Q3）；类型集中
  并入 core 一个模块、`index.ts` 对外 re-export 原样保留（Q4）；恢复机器纯函数保持导出供
  smoke 直接驱动（Q6ii）；写 ADR-0008（Q7）；`runToolCall` 降为内部函数（Q8）。
- 验证：`npm run check` + core 相关 smoke（`node scripts/smoke-*.ts`），均不需要供应商密钥。
- 编辑源码必须用编辑器工具（Edit/Write），绝不走 shell 文本往返（AGENTS.md 既有规则）。

## Decisions so far

- [Loop 并入 Agent 的形态](issues/01-merge-shape.md)：全并 agent.ts；有状态（dispatchEvent、
  prepareRequest、activeRun 槽位、subscribe/abort/waitForIdle、runModel）→ Agent 私有成员，
  无状态助手 → 文件级函数；恢复机器纯函数保持导出；`runToolCall` 降为内部。
- [类型的新家与严格检查](issues/02-types-home.md)：类型集中并入 core 一个模块，`index.ts`
  对外 re-export 原样保留；去掉 `@ts-nocheck`、过根 tsconfig 严格检查。
- [ADR-0008](issues/04-adr-0008.md)：`docs/adr/0008-loop-merged-into-agent.md` 落库，部分取代
  0001「`packages/loop` 一行都不改」那一半；`docs/adr/README.md`、`0001` 的 `取代者` 行、
  `docs/notes.md` 第一节同步标注。
- [合并落地](issues/03-merge-engine.md)：引擎进 `agent.ts`（`runEngine`）、`packages/loop` 删除、
  类型进 `types.ts`、smoke 迁到恢复函数；[文档同步](issues/05-docs.md) 把 `AGENTS.md` /
  `docs/architecture.md` / `README.md` 按合并后的现实校正，术语新增 **engine**。

## Not yet specified

（无——决策已全部落定，剩余工作均在 ticket 里。）

## Out of scope

- 上游 pi-main 的任何同步与对照：合并即分道，不再跟踪上游（vendored 头注释随之删除）。
- 子代理机制、插件、MCP：AGENTS.md 既有边界，本次不碰。
- `LoopConfig`/`LoopOptions` 等 vendored API 的向上兼容 shim：本仓库无外部消费者。
