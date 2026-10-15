# 03 重开会话看不到工具结果 —— 根因调查

调查范围：只读，未改任何 `packages/` 下代码。证据来自源码 + 磁盘上真实的 session JSONL
（`~/.my-agent/sessions/`）。

## 结论速览

**根因**：工具调用与结果**确实写进了会话文件**，重开时丢的是**前端重放这一步**——
`packages/web/src/state.ts` 的 `itemsFromSnapshot` 只把 message 还原成 `{ kind: "message" }` item，
从不构造 `{ kind: "tools", cards }` item；并且 `upsertMessage` 在遇到 `role === "toolResult"`
的消息时直接丢弃。于是整块工具过程（调用 + 结果）在重开后的 transcript 里消失，而不是只有结果消失。

**严重度判断**：**"只是看不见、数据还在文件里"**——前端重放缺一段，**不是** core 侧漏落盘。
属于本轮可以在 `packages/web` 内顺手修的范围（对应 ticket `10-reopen-tools.md`）。

---

## Q1 工具调用与结果在会话文件里有没有被写下来？

**有。** 而且不是独立 entry kind，而是包在两种 `message` entry 里。

- `SessionEntry` 的 kind 全集见 `packages/core/src/session/session-manager.ts:181-189`：
  `message` / `thinking_level_change` / `model_change` / `compaction` / `prune` / `argtrim`
  / `tool_config` / `leaf`，外加文件头 `session`。**没有**任何 "tool"/"toolCall"/"toolResult" 专属 entry kind。
- `message` entry 定义：`session-manager.ts:69-72`（`{ type: "message", id, parentId, timestamp, message }`）。
- 一次工具调用 = **assistant message 的 `content` 数组里一个 `toolCall` block**；
  结果 = **另一条 `message` entry，`message.role === "toolResult"`**，`toolCallId` 把两者对上。
- `buildSessionContext` 会把 `toolResult` 消息保留进 context：`session-manager.ts:362-367`。

**磁盘验证**（真实文件，非推演）：
`~/.my-agent/sessions/--C--Users-a1368-AppData-Local-Temp-my-agent-approval-grace-0xqnqF--/`
`2026-10-14T15-13-35-670Z_01a13af9-dbb6-7462-b9a8-b921e5260347.jsonl`（7 行）：

| 行 | entry | 内容 |
|----|-------|------|
| 0 | `session` | 文件头 |
| 1 | `message` | user, blocks=[text] |
| 2 | `model_change` | |
| 3 | `thinking_level_change` | |
| 4 | `message` | assistant, blocks=[**toolCall**] |
| 5 | `message` | **role=toolResult**, blocks=[text] |
| 6 | `message` | assistant, blocks=[text] |

第 4 行 toolCall block：
`{ "type":"toolCall", "id":"tool:1791990815669:3wzyt8b10re", "name":"read", "arguments":{"path":"notes.txt"} }`

第 5 行 toolResult（`parentId` 指回第 4 行 entry id）：
```
{ "role":"toolResult", "toolCallId":"tool:1791990815669:3wzyt8b10re", "toolName":"read",
  "content":[{"type":"text","text":"File not found: notes.txt"}], "details":{}, "isError":true, "timestamp":1791990816072 }
```

补充：写/改工具的 diff 也落盘在 `toolResult.details.diff`（`packages/web/src/state.ts:628-639`
`fileDiffOf` 正是从这里读的）；磁盘上确有含 `"diff"` 的 session 文件
（如 `.../my-agent-session-JQ8TGo--/2026-10-13T15-04-39-274Z_...jsonl`）。

**Q1 结论**：数据在文件里，调用（含参数、toolCallId）与结果（含内容、isError、details）都完整。

---

## Q2 重开时重建记录走哪条路？丢在哪一步？

重开（冷读 / 重连）走的是 **baseline 帧**：

1. `reduce` 的 `case "baseline"`：`packages/web/src/state.ts:161-184`；
   `items` 由 `itemsFromSnapshot(message.session)` 重建：`state.ts:165`。
2. `itemsFromSnapshot`：`packages/web/src/state.ts:418-424`——**只对每条 message 调 `upsertMessage`**，
   没有任何构造 `{ kind: "tools" }` 的分支。
3. `upsertMessage`：`packages/web/src/state.ts:445-500`。两个丢弃点：
   - `state.ts:460`：`if (role === "toolResult") return items;` —— **结果 entry 被整条丢掉**。
   - toolCall block 不会变成卡片：`state.ts:468` 走 `contentToText`，而
     `contentToText` 对 `toolCall` 只回占位文本 `[调用 name]`（`state.ts:662`）。

baseline 帧的 `messages` 来源：`packages/core/src/session/snapshot.ts:54,68`
（`input.sessionManager.buildSessionContext().messages`），**这个列表里是包含 `toolResult` 消息的**
（见 Q1 的 `buildContextEntries` → `sessionEntryToContextMessages`），也就是说数据送到了客户端，
是客户端重建时把它扔了。

重开触发点（同一 `{ type:"baseline" }` 处理）：
- 冷读一个会话：`packages/web/src/main.ts:746`（`apply(reduce(state, { type:"baseline", session: snapshot }))`）。
- 切 branch：`packages/web/src/main.ts:873`。

**Q2 结论**：重开这条路**只还原 message，不还原工具块**，所以丢的**不只是结果，是整块工具过程**。
丢的确切位置：`itemsFromSnapshot`（`state.ts:418-424`）→ `upsertMessage`（`state.ts:460` 丢结果、
`state.ts:662` 把调用降级成一句 `[调用 name]` 文本）。渲染侧其实已就绪：
`renderTools` 能画 `{ kind:"tools" }`（`packages/web/src/render/transcript.ts:397-441`），只是这条路永远不给它这种 item。

---

## Q3 流式为什么看得到？两条路是不是同一个函数？

**不是同一个函数。** 流式那条路靠 reducer 里的事件分支现造 item：

- `case "tool_execution_start" / "tool_execution_update" / "tool_execution_end"`：
  `packages/web/src/state.ts:280-308`，三处都调 `upsertTool`。
- `upsertTool`：`packages/web/src/state.ts:585-616`——构造/补丁 `{ kind:"tools", id, cards }`，
  card 形状 `ToolCard` 见 `state.ts:15-31`，diff 由 `fileDiffOf` 抽取（`state.ts:628-639`）。
- 渲染入口：`packages/web/src/render/transcript.ts:106` → `renderTools`（`transcript.ts:397-441`）。

重放那条路（Q2）**只调 `upsertMessage`**，从不调 `upsertTool`。所以：
- **消息**的构造是共享的（流式与重放都用 `upsertMessage`）；
- **工具 item** 的构造只活在 reducer 里，**没有对应的重放实现**。

**Q3 结论**：两条路各写各的（消息共享、工具不共享）。应当在 `itemsFromSnapshot` 里**补一条**：
把持久化的 assistant `toolCall` block 与 `toolResult` 消息，用**和流式同一个** card 构造逻辑
折成 `{ kind:"tools", cards }`——即让重放也喂给 `upsertTool`，两条路共用同一个卡片构造函数，
而不是各维护一份。这样 `toolCallId / toolName / args / output / isError / running=false / diff`
都能从文件重建（文件里字段齐全，见 Q1）。ticket `10-reopen-tools.md` 也明确要求两条路收成同一个函数。

---

## Q4 严重度判断

**"只是看不见、数据还在文件里"——前端重放缺一段。不是 core 侧漏落盘。**

- 文件侧：调用（参数、toolCallId）与结果（文本、isError、details.diff）都完整落盘（Q1 磁盘实证）。
- 客户端侧：`itemsFromSnapshot` 缺一段把工具块还原成 `{ kind:"tools" }` 的逻辑（Q2）。

因此本轮可在 `packages/web` 内改 `state.ts` 修掉，**无需另开 core 侧落盘票**；
按 `10-reopen-tools.md` 走"先红后绿"即可。

---

## 未查证 / 边界

- 未逐条运行 `npm run check` / smoke 脚本（本票只查根因，不动代码）。
- "重开是否一定经 baseline 且不夹杂旧 items"：已由 `reduce` 的 baseline 分支整体替换 `items`
  （`state.ts:162-165`）与 `main.ts:746,873` 佐证；未跑实际 UI 复现验证。
