# 04 · ADR-0012 与文档

Type: task
Status: resolved
Resolved: 2026-11-04

## Question

ADR-0008 明确写了「引擎是方法而不是对象」的理由，这次反向必须留下为什么。

## Answer

- `docs/adr/0012-loop-manager-object.md` 落库：取代 ADR-0008 决定 1/2 与「后果」里的行数账；
  保留 0008 的决定 3–7、9。核心论证：0008 拆掉的是**没有信息的对象**（每个问题都绕回 `Agent`
  回答），0012 立起来的是**自己回答问题**的对象——判据是依赖方向，不是有没有对象。
- `docs/adr/0008-…md` 头部加「决定 1、2 已由 0012 取代」；`docs/adr/README.md` 清单加 0012 行、
  0008 状态补一句。
- `AGENTS.md`：布局行改写；`engine` 词条改指 `LoopManager.run`；新增 `LoopManager`、`fanout`
  两个词条（`service` 之后、`tool` 之前）。
- `docs/architecture.md`：core 职责段、能力表、依赖段、目录布局、「循环（`LoopManager.run`），
  端到端」、写边界位置、重试段、端到端流程图的 `core/loop-manager.ts` 一行、取舍表。
- `docs/notes.md` 第一节那一行补一句「引擎随后成为 `loop-manager.ts` 的 `LoopManager`」；
  `README.md` 的开场一段同步。
