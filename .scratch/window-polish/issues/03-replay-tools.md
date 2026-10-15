# 03 「重开会话看不到工具结果」的根因

Type: research
Status: resolved

## Question

用户实证：**一个会话关掉再打开，工具调用的结果就不见了**（截图 `../reference/03-tool-and-rounds.png`
右下角的框）。这一票只查根因，不改代码。

要给出带路径行号的结论，回答：

1. 工具调用与结果在**会话文件里**有没有被写下来？查 `packages/core/src/session/` 下 entry 的 kind
   （`message` / `tool_config` / `compaction` / …）——一次工具调用是不是有自己的 entry，
   还是只作为 assistant message 的 `content` 数组里的块存在。
2. 客户端重开时重建记录走的是哪条路：`packages/web/src/state.ts` 的 `itemsFromSnapshot`（以及它上游
   的 baseline 帧）。它有没有把工具块还原成 `{ kind: "tools", cards }` 那样的 item？如果**只**还原
   message，那丢的就不只是"结果"，是整块工具过程——**说清丢在哪一步**。
3. 流式那一遍为什么看得到：`tool_execution_start` / `tool_execution_update` 事件（`packages/web/src/state.ts`
   的 reducer）建的 item，与重放建的 item 是不是**同一个函数**。如果两条路各写各的，本票要指出
   应该收成一条还是补一条。
4. 顺带给一句话的**严重度判断**：这是"只是看不见、数据还在文件里"（前端重放缺一段），还是
   "数据根本没写"（core 侧缺一次落盘）。前者是本轮可以顺手修的，后者要另开一票。

**不要动代码。** 结论写进 `../research/replay-tools.md`，并在本文件的 `## Answer` 里给要点 + 链接。

## Answer

完整调查见 [`../research/replay-tools.md`](../research/replay-tools.md)（含磁盘上真实 session 文件的实证）。

**根因**：工具调用与结果**都在文件里**；重开时丢的是**前端重放这一步**。
`packages/web/src/state.ts` 的 `itemsFromSnapshot`（`state.ts:418-424`）只把 message 还原成
`{ kind: "message" }`，从不构造 `{ kind: "tools", cards }`；且 `upsertMessage` 在
`state.ts:460` 对 `role === "toolResult"` 直接 `return items` 丢弃。丢的**不只是结果，是整块工具过程**
（调用被 `contentToText` 在 `state.ts:662` 降级成一句 `[调用 name]` 文本，结果整条不见）。

**严重度**：**"只是看不见、数据还在文件里"**（前端重放缺一段），**不是** core 漏落盘。
本轮可在 `packages/web` 内修，无需另开 core 票 → 见 ticket `10-reopen-tools.md`。

四问要点：

1. **文件里有**。无工具专属 entry kind（`session-manager.ts:181-189`）。调用 = assistant `message`
   的 `toolCall` block；结果 = 另一条 `role:"toolResult"` 的 `message` entry，靠 `toolCallId` 配对
   （`session-manager.ts:362-367` 保留进 context）。已在真实文件
   `.../my-agent-approval-grace-0xqnqF--/2026-10-14T15-13-35-670Z_...jsonl` 第 4/5 行验证。
2. **丢在** `itemsFromSnapshot`（`state.ts:418-424`）→ `upsertMessage`（`state.ts:460` 丢结果、
   `state.ts:662` 把调用降级为文本）。只还原 message，不还原工具块。
3. **不是同一函数**。流式走 `tool_execution_*`（`state.ts:280-308`）→ `upsertTool`
   （`state.ts:585-616`）造 `{ kind:"tools" }`；重放只调 `upsertMessage`。消息构造共享、工具构造不共享。
   修法：在 `itemsFromSnapshot` **补一条**，让重放也喂给同一个 `upsertTool`，两条路共用卡片构造函数。
4. 见上"严重度"。
