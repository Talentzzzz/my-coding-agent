# 10 修「重开会话看不到工具结果」

Type: task
Status: resolved
Blocked by: 03

## Question

照 03 的根因修掉这个缺陷：**一个会话关掉再打开，工具调用的结果就不见了**。

**03 已经查清（完整细节见 `../research/replay-tools.md`）：数据在文件里，丢的是前端重放这一步，
严重度是"只是看不见"——本票不涉及 core，也不必另开票。** 三层事实：

- 文件里**没有工具专属的 entry kind**：一次调用是 assistant `message` 的 `toolCall` 块，结果是**另一条**
  `role: "toolResult"` 的 message entry，靠 `toolCallId` 配对（已在真实 session JSONL 上逐行实证）。
- 断点在 `itemsFromSnapshot`（`packages/web/src/state.ts:418-424`）：它只还原 `message`，从不构造
  `{ kind: "tools", cards }`；而 `upsertMessage` 对 `toolResult` 直接早退（`state.ts:460`）、
  调用被 `contentToText` 降级成 `[调用 name]` 文本（`state.ts:662`）——**丢的是整块工具过程，不只是结果**。
- **两条路不是同一个函数**：流式走 `upsertTool`（`state.ts:585-616`）造出 tools item，重放只走
  `upsertMessage`。修法是**在重放里也喂同一个 `upsertTool`**，不是把两条路各修一遍。

**先红后绿**：开工第一件事是写一个能复现的断言（关掉再打开，工具结果仍在），看着它红，再修到绿。
`npm run check` + `scripts/smoke-sessions.ts` / `smoke-tools.ts` 要绿。

**与 07 号有交叠，别各修一次**：07 号要拿掉正文里的 `[调用 read]`，而它的来源正是这里那条
`contentToText` 降级；两票改的是同一段代码的两端，先读 03 的答案再动手。

## Answer

照 03 的答案修在 `packages/web/src/state.ts` 的重放这一端，core 未动。

**修法**：`itemsFromSnapshot` 现在把每条消息交给新的 `replayMessage`——消息本体照旧走
`upsertMessage`；assistant 消息 content 里的每个 `toolCall` 块、以及 `role: "toolResult"` 的结果
消息，都喂给**与流式同一个** `upsertTool`（调用按 start 事件的形状建卡，结果按 end 事件的形状
补丁：文本、isError、`details.diff`、running 收掉）。两条路从此共用同一个造卡函数，没有第二套
实现；`toolCallId` 配对、一 turn 多调用并成一组、卡片落在调用消息与回答之间，都与流式一致。

**先红后绿**：新 smoke `scripts/smoke-replay.ts`（已加进 `packages/web/tsconfig.json` 的 include）
在修复前跑出 12 处失败（重开后 0 个 tools item，与 03 的诊断一致），修复后 12 处全绿。它钉住的
形状就是 03 在真实 session JSONL 上实证过的那几条：失败调用的文本与 isError、write 结果里
`details.diff`、并行调用共享一组、以及重放卡片夹在调用消息与回答消息之间。

**一处超票面的决定（评审确认为合理加戏）**：快照 `submitting: false` 时，没有结果的卡由
`settleCards` 收成 `running: false`——一条没在运行的快照不可能有调用还在飞，留下的是被截断的
记录（比如分支切在结果写盘之前），不该让它永远转圈；`submitting: true` 时跳过收尾，在飞那张卡
留给活事件的 `tool_execution_end` 自己来补。

**留给 07 的没动**：`contentToText` 的 `[调用 name]` 降级原样保留，所以 07 落地前重开的
transcript 里降级文本与工具卡片会短暂并存——这正是「别各修一次」的约定，07 改一处两条路同时收。

**验证**：`npm run check` 绿（含 token 审计）；`smoke-replay.ts` / `smoke-sessions.ts` /
`smoke-tools.ts` 全绿。
