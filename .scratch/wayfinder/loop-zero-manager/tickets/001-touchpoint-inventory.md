---
label: wayfinder:research
title: 盘点 loop 对 Manager/hooks 的全部触点
status: closed
assignee: WorkBuddy（research 子代理）
blocked-by:
---

## Question

`packages/core/src/loop-manager.ts` 对六件依赖（`sessionManager` / `settings` / `tools` /
`hooks`，以及经 `servicesOf` 现凑喂给 fanout 的间接触点）的**全量触点盘点**：逐处给出行号、
所在方法、直调还是现凑传递，并按回调草案 16 动词（见 MAP Notes 与票 002 的草案表）归类，
**标出草案归不进去的触点**——它们是票 002 答辩的新输入。

特别要查清的形状：

- `servicesOf` 的全部消费点（`publishState` ×?、`approvalsOf` ×?）；
- `toolStateOf` 这类**文件级纯函数**——它自己收三件 Manager 作参数，loop 是它的调用方，
  收编形状（连参数整体变回调？）要单独记；
- `hooks` 的两种用法：`hooks.apply(...)` 与 `hooks.beforeToolCall` / `afterToolCall` 成员直读；
- `CompactOptions` 的 `Pick` 链上有哪些 Manager 字段；
- 工具执行的入口（`ToolManager.execute` 经哪条路径被 loop 触达）。

产出写 `research/001-touchpoint-inventory.md`，作为票 002 答辩的事实底座。

## Resolution（2026-11-12，research 子代理）

报告全文：[research/001-touchpoint-inventory.md](../research/001-touchpoint-inventory.md)。

- 六件依赖共 **87 个触点实例 / 67 物理行**：sessionManager 27（追加/读改族 19 处为主）、
  tools 27（执行链 15 处为主）、settings 19（`modelCatalog` ×5 最多）、hooks 12
  （`apply` ×3 + 成员直读 ×2 + 接线）、api 1、systemPrompt 1。
- `servicesOf` 消费点 5 处：`publishState` ×4、`approvalsOf` ×1。
- 16 动词草案归入 56 实例，覆盖率约 **82%**。
- **草案外 12 行、6 类形状**：`modelChoiceOf` ×3、`declaredTools` ×3、`api.stream` ×1、
  `systemPrompt` 调用 ×1、`drainTranscribed`→`appendMessageEntry` 追加链 ×3、
  `servicesOf` 组装机制行 ×1。前两类与追加链建议分别并入动词 4（activeTools）、8（账本追加）；
  `api` / `systemPrompt` 已是回调化样板，建议在票 002 里确认为保留项而非新动词。
- `Tool.execute` 的生产唯一入口在 L1693 `manager.execute`——票 002 的 `executeTool`
  回调要把整条执行链（15 处）收进一个动词。
