---
label: wayfinder:grilling
title: 回调白名单答辩：动词清单与 LoopOptions 接口定稿
status: closed
assignee: WorkBuddy
blocked-by: 001-touchpoint-inventory
---

## Question

回调面定稿。草案 16 动词（票 001 盘点后逐项答辩）：

| # | 回调 | 吸收的触点 |
|---|------|-----------|
| 1 | `contextMessages(session)` | buildSessionContext |
| 2 | `contextEntries(session)` | buildContextEntries ×4 |
| 3 | `modelCatalog()` | modelCatalog ×5 |
| 4 | `activeTools(session)` | toolStateOf（纯函数连三件参数整体收编）×2 |
| 5 | `recordSelection(...)` | setModel / setThinkingLevel / flushMeta |
| 6 | `recordedOnDisk(session)` | recordedOnDisk |
| 7 | `setSuspended(session, flag)` | setSuspended |
| 8 | `appendCompaction` / `appendTrimToolCallArgs` / `appendClearToolResults` | 三个账本追加 |
| 9 | `bashSettings(workDir)` | getBashSettings |
| 10 | `retrySettings(workDir)` | getRetrySettings |
| 11 | `executeTool(...)` | ToolManager.execute（0016 实例表不动，只挡可见性） |
| 12 | `rewriteContext(entries)` | hooks.apply("context") |
| 13 | `decideBeforeTool` / `decideAfterTool` | hooks.apply + hooks.beforeToolCall / afterToolCall |
| 14 | `publish(state, session)` | publishState ×4（组装点挪进 Agent） |
| 15 | `approvals(session)` | approvalsOf |

要答辩的子问题：

1. 逐项合/拆/改名/定签名——哪些动词该并（如 14+15 合成 `publishView`？8 的三个账本追加要不要
   一个族回调？），哪些盘点出来的新形状要加动词或改签名；
2. `CompactOptions` 的连带形状（`Pick` 链上不再有 Manager 字段后 pick 什么）；
3. hooks 在 Agent 侧的实现形状：保留 `apply` 门面 vs 拆成显式回调成员；
4. 保留项确认：`state` / `bag` / `start` / `api` / `bagOf` / `emit` / `systemPrompt` 原样不动。

产出 = 定稿的 `LoopOptions` 接口草案（TS 接口逐字段）+ `CONTEXT.md` 术语同步
（「回调面」「白名单回调」等词条随定稿更新）。

## Resolution（2026-11-12，WorkBuddy）

答辩全文与定稿接口：[research/002-callback-whitelist.md](../research/002-callback-whitelist.md)；
`CONTEXT.md` 的 loopOptions / 回调白名单 / run bag 三词条已随定稿更新。

- 草案 15 行逐项判决：12 行按草案定名定签名；**5+6 合并**为 `recordSelection`（对比盘上基线、开袋、
  三写是一个语义操作），并连带 **`bagOf` 退出白名单**——它唯一的运行触点就是 recordSelection 内的
  开袋（L629），loop 从此没有任何自开袋路径；**4 扩签名**为 `activeTools` 返回 `{ names, declared }`
  （吸收草案外 b 的 declaredTools ×3；`approvalOverride` 不进 loop）；**8 不设族回调**（族回调把
  账本格式知识推进 loop 且丢参数类型），定稿 3 个具名追加动词；**14+15 不合并**（`publishView` 案
  被否：publish 是窗口发布、approvals 是 prompt/闸门读取，消费者与时机都不同）。
- 新增两动词：`modelChoice`（草案外 a，×3，选择派生族）、`appendMessage`（草案外 e，×3，签名带
  `state`——fanout 组装点要清 `live.unwritten` 并发 `entry_appended`）。
- 定稿 **19 动词 + emit**：读 8、写 6、执行 1、接缝 3、窗口 1。001 的 68 归档实例 + 12 草案外行
  100% 着落，无剩余触点。
- **CompactOptions** = `Pick<LoopOptions, "state" | "bag" | "modelCatalog" | "modelChoice" |
  "contextEntries" | "appendCompaction" | "appendTrimToolCallArgs" | "appendClearToolResults">` +
  entries/now/signal?/transport?——链上不再有 Manager 字段，Pick 链本身就是压缩阶梯的依赖清单；
  不取整袋（压缩不需要执行链与 hooks）。
- **hooks 形状**：LoopOptions 上拆成三个显式回调（`rewriteContext` / `decideBeforeTool` /
  `decideAfterTool`）；`Hooks` 服务与 `apply` 门面留在 Agent 侧原样；事件/答案类型在 loop-manager.ts
  结构定义（守卫将禁 import hooks 模块），同步点在 agent.ts 接线处（形状不合编译即失败）；
  `toolCallHooks` 包装方法消失，两闸门的裁决归一化留在 loop（suspend 结束运行是引擎机械）。
- **保留项确认**：`state` / `bag` / `start` / `api` / `emit` / `systemPrompt` 原样不动；
  `bagOf` 为唯一修正（消失）。`executeTool` 镜像 `ToolManager.execute`，ADR-0016 不动；
  `activeTool` 的表解析改为对 `declared` 按名查（同一派生、同为表实例），解析与调度留在 loop。
- 移交票 004：Agent 侧实现对照表（答辩文 §4，全部住在 `Agent.loopOptions()` 闭包；`servicesOf` 与
  `toolCallHooks` 随之消失）。移交票 005：类型驻地口径（`Session`/`SessionEntry` 与 `ToolRunContext`/
  `ToolUpdateCallback` 的 import 面如何过「禁 Manager 模块」守卫）。
