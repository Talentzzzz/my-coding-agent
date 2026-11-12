---
label: wayfinder:task
title: 按 ADR-0023 落地
status: closed
assignee: WorkBuddy
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

## Resolution（2026-11-12，WorkBuddy）

全项完成。`npm run check` 全绿（tsc × 2 + tokens + server-facade + loop-boundary）；smoke 与基线
同色——`smoke-tools` / `smoke-desktop-observability` / `smoke-api` 红（前两者经 `git stash` 在干净
HEAD 上核实为既有口径，后者同为环境性既有红），其余 26 条全绿；`smoke-approval-recovery` 随新签名
改写后直驱恢复机器，断言语义一字未改。恢复机器保持导出（`index.ts` 名字不变）。

- **`loop-manager.ts`**：`LoopOptions` 改为 25 字段（三值 + 两形 + sink + 19 动词），四件 Manager
  与 `bagOf` 离场；`servicesOf` / `toolCallHooks` / `recordSelection` / `declaredTools` / 两个闸门
  包装方法删除；文件级机件的接缝换成 `ToolChain`（`sessionId` + `declared` + `executeTool` + 两闸门），
  解析改为对声明数组按名查；hooks 三动词事件/答案类型结构定义在本文件；`CompactOptions` 按票 002
  Pick 链改形。
- **`agent.ts`**：回调面实现住在 `loopCallbacks()`（19 动词 + emit），`loopOptions()` 与
  `maybeCompact()` 组袋时摊开；`recordSelection` 随迁（`rowFor` / `normalizeThinkingLevel` /
  `ThinkingLevel` 移址 agent.ts），开袋走私有 `bag()`。
- **`types.ts`**：`ToolCallHooks` / `BeforeToolCallResult` / `AfterToolCallResult` /
  `BeforeToolCallContext` / `AfterToolCallContext` 删除；`AgentRequestUpdate.activeNames` 删除——
  解析改对 `context.tools` 按名查，名单与声明并成同一个对象。
- **行数账**：`agent.ts` 1172 → 1251、`loop-manager.ts` 1940 → 1886、`types.ts` 202 → 99；已补进
  ADR-0023「后果」节。
- **落地偏差三处**（形状级、语义只搬不改，已记进 ADR-0023「后果」末条）：机件的 `currentContext` /
  `assistantMessage` 参数随 hooks context 载荷退场（恢复机器少一个首参）；`activeNames` 从
  `AgentRequestUpdate` 消失（见上）；回调面实现住 `loopCallbacks()` 而非内联进 `loopOptions()` 闭包
  ——两处组袋共享同一组实现，hooks 三动词接线处 `apply` 的 undefined 答案归一成空决定（`?? {}`）。
- **文档**：`AGENTS.md` engine 词条、`docs/architecture.md`（六处）、`README.md` 改指 0023；
  `CONTEXT.md` 三词条票 002 已同步，未动。守卫升级归票 005，本票未动 `check-loop-boundary.ts`。
