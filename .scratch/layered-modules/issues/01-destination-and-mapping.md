# 目的地与总体映射

Type: grilling
Status: resolved

## Question

这次 wayfinder 的目的地是什么形状？五个新模块与今天代码的映射是什么？重构的性质约束是什么？

## Answer

- **目的地** = 一份 spec（`.scratch/layered-modules/spec.md`）：完整决策记录 + 分步迁移方案。
  图只产 spec、不搬代码；执行是 spec 走完后的下一个 effort。
- **映射**：
  - **domain** = `packages/core` 全部：编排层 `agent.ts`（引擎、会话表、fanout、装配）整体在内，
    拆成 `agent` 包下的 `context/` `llm/` `session/` `tool/` 子包 + `agent.ts` + `types.ts`，
    managers 构造注入。
  - **case** = `packages/server/src/hub.ts`（SessionHub）。
  - **trigger** = server 其余：`controllers/`、`http/`、`frames.ts`、`mux.ts`、`wire.ts`、`http.ts`。
  - **infra** = 从 manager 里抽出的文件操作（账本/快照读写、models.json、tools.json、tool-results
    归档），实现 domain 声明的接口。
  - **app** = `boot.ts` + `main.ts` 改组合根。
- **性质**：纯结构搬迁、零行为变化——REST 面、mux 帧、会话文件格式、smoke 输出全部不变；
  验收 = `npm run check` + 五个 smoke 全绿；文档与 ADR 同步更新纳入目的地（不欠账）。
