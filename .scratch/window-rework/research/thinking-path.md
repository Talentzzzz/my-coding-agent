# 思考（thinking）内容的数据通路：从供应商流到窗口

研究票：`.scratch/window-rework/issues/02-thinking-path.md`
状态：已解决（结论见票的 `## Answer`）

## 这份文档怎么读

**范围**：只回答一件事 —— 供应商返回的 thinking / extended thinking **内容**，在这条通路上走到哪一步、哪一层被怎样处理。请求侧的 `thinkingLevel`（`off`..`max`）不是本题对象，只在文末单独澄清它与"思考内容"是两回事。

**两条证据等级**，每条结论都挂其一：

| 标记 | 含义 |
|---|---|
| **已读代码确认** | 我在本仓库源码里读到该行，并在此引用原文（含 `文件:行号`）。 |
| **推断** | 代码里没有直接依据，由已确认事实推出的结论。文末单列一节，不混进正文判据。 |

**取证方式**：直接读 `packages/` 下五个包的源码，逐段追一条通路。未运行任何程序、未改任何文件。

---

## 一句话结论

**思考内容从供应商流一路带到了浏览器，没有被任何一层丢弃；是 web 客户端在 `state.ts` 里把它**压平成正文文本**（加 `[思考] ` 前缀拼进消息的单一 `text` 字段），既没有独立字段、也不可折叠。**

三种候选里，既不是「压根没发」，也不是「存了没画」——而是**第 2 种的变体：发了、也存了、客户端 reducer 也接了，但它把思考折进了正文字符串、没有留下结构**。缺口在客户端 (`packages/web/src/state.ts` + `render/transcript.ts`)，不在供应商、不在 agent、不在 server。

### 全链路对照（思考内容的每一步归宿）

| 层 | 文件:行 | 思考内容在那里是…… |
|---|---|---|
| 供应商解析 | `packages/ai/src/api/anthropic-messages.ts:527-545` | `content_block_start(thinking/redacted_thinking)` → 建 `ThinkingContent` 块、yield `thinking_start` |
| 供应商增量 | `anthropic-messages.ts:571-582` | `thinking_delta` → 累加 `block.thinking`、yield `thinking_delta` |
| 供应商收尾 | `anthropic-messages.ts:616-622` | `content_block_stop` → yield `thinking_end`（带全文 `content`） |
| 事件类型 | `packages/ai/src/types.ts:559-561` | `thinking_start \| thinking_delta \| thinking_end` 是一等事件成员 |
| agent 循环 | `packages/agent/src/agent-loop.ts:361-379` | 四类 `*_start/delta/end`（含 thinking）原样转成 `message_update` 事件 |
| agent 终局 | `agent-loop.ts:381-393` | `message_end` 携带最终 AssistantMessage，`content` 里有 `ThinkingContent` 块 |
| core → 会话事件 | `packages/core/src/agent.ts:1391-1411` | `handleEvent` 把每个 AgentEvent 原样 `emit` 出去 |
| core 持久化 | `packages/core/src/session/session-manager.ts:1097-1107` | `appendMessage` 把 message **原样**写入 JSONL（含 thinking 块） |
| server → wire | `packages/server/src/mux.ts:411-417` | `{ type: "event", event }` 整包推给客户端，**无过滤** |
| server → baseline | `packages/core/src/session/snapshot.ts:51,63` | snapshot 的 `messages` 就是原样 message 数组 |
| **客户端 reducer** | `packages/web/src/state.ts:243` → `:557-577`（尤其 `:571`） | **思考块被 `contentToText` 折成 `[思考] …` 拼进单一 `text`** |
| 客户端渲染 | `packages/web/src/render/transcript.ts:104-127` | 只把 `item.text` 当一段 markdown 画出来 |

---

## Q1. 供应商侧：`anthropic-messages.ts` 解析到思考了吗？

**是的，解析了，且以独立事件形状 yield 出来。已读代码确认。**

1. **块开始**。响应流里 `content_block_start` 的块类型若为 `thinking`，建一个 `thinking` 块并把事件推成 `thinking_start`：

   `packages/ai/src/api/anthropic-messages.ts:527-535`
   ```ts
   } else if (event.content_block.type === "thinking") {
       const block: Block = {
           type: "thinking",
           thinking: event.content_block.thinking ?? "",
           thinkingSignature: event.content_block.signature ?? "",
           index: event.index,
       };
       output.content.push(block);
       stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
   }
   ```
   `redacted_thinking`（安全过滤后返回的加密块）也被当成 thinking 处理，文本固定为 `[Reasoning redacted]`，见 `anthropic-messages.ts:536-545`。

2. **增量**。`content_block_delta` 里的 `thinking_delta` 累加进块并推 `thinking_delta`：

   `anthropic-messages.ts:571-582`
   ```ts
   } else if (event.delta.type === "thinking_delta") {
       const index = blocks.findIndex((b) => b.index === event.index);
       const block = blocks[index];
       if (block && block.type === "thinking") {
           block.thinking += event.delta.thinking;
           stream.push({
               type: "thinking_delta",
               contentIndex: index,
               delta: event.delta.thinking,
               partial: output,
           });
       }
   }
   ```

3. **签名增量**。`signature_delta` 只累积到 `thinkingSignature`，**不**单独发事件（`anthropic-messages.ts:596-602`）——这符合类型定义里签名是"回放用的不透明数据"。

4. **块收尾**。`content_block_stop` 推 `thinking_end`，带全文：

   `anthropic-messages.ts:616-622`
   ```ts
   } else if (block.type === "thinking") {
       stream.push({
           type: "thinking_end",
           contentIndex: index,
           content: block.thinking,
           partial: output,
       });
   }
   ```

5. **终局消息**。整轮结束时 `done` 事件携带的 `output`（`AssistantMessage`）里，`content` 数组就含这些 thinking 块：

   `anthropic-messages.ts:690`
   ```ts
   stream.push({ type: "done", reason: output.stopReason, message: output });
   ```

**类型层面**也把思考当作一等成员，不是临时字段：

`packages/ai/src/types.ts:268-276`
```ts
export interface ThinkingContent {
    type: "thinking";
    thinking: string;
    thinkingSignature?: string;
    redacted?: boolean;
}
```
`packages/ai/src/types.ts:416-418` 里 `AssistantMessage.content` 的联合类型是 `(TextContent | ThinkingContent | ToolCall)[]`；事件联合类型见 `types.ts:554-570`，其中 `thinking_start/delta/end` 与 `text_*`、`toolcall_*` 并列。

**小结**：供应商侧没有任何"没解析"或"解析后丢掉"的问题。它甚至发得比正文还早（思考块在内容数组里先于文本块）。

---

## Q2. 供应商 → agent：循环把增量变成了什么？

**变成了 `AgentEvent` 的 `message_update` 成员，思考增量原样携带。已读代码确认。**

`packages/agent/src/agent-loop.ts:361-379` —— 注意 `case` 里**明确列了** `thinking_start`/`thinking_delta`/`thinking_end`，与 text/toolcall 同类处理：
```ts
case "text_start":
case "text_delta":
case "text_end":
case "thinking_start":
case "thinking_delta":
case "thinking_end":
case "toolcall_start":
case "toolcall_delta":
case "toolcall_end":
    if (partialMessage) {
        partialMessage = event.partial;
        context.messages[context.messages.length - 1] = partialMessage;
        await emit({
            type: "message_update",
            assistantMessageEvent: event,
            message: { ...partialMessage },
        });
    }
    break;
```

终局时（`agent-loop.ts:381-393`）`done`/`error` 分支把最终 message 通过 `message_end` 发出，其 `content` 保留 thinking 块（来自 `event.partial`，即供应商的 `output`）。

`AgentEvent` 的成员定义在 `packages/agent/src/types.ts:499-514`：`message_update` 携带 `assistantMessageEvent: AssistantMessageEvent`（`:509`），也就是 Q1 里那套含 thinking 的事件联合；`message_start`/`message_end` 携带 `message: AgentMessage`（`:507`、`:510`）。

**小结**：agent 层对思考是透明的，既没有重命名、也没有过滤。

---

## Q3. agent → wire：core 与 server 把它们投影成了什么？

**投影成会话事件（含 `message_update`）和 baseline 快照，二者都带完整思考内容。已读代码确认。**

**core**：`AgentSessionEvent`（`packages/core/src/agent.ts:161-244`）的第一支就是 `AgentEvent` 的整包并集——它把 loop 的事件**原样**并入自己的事件名空间，只加了会话自己的成员（`queue_update`、`compaction` 等）。

`packages/core/src/agent.ts:1391-1411` 的 `handleEvent`：持久化之后，把每个 AgentEvent 原封不动 `emit`：
```ts
private async handleEvent(event: AgentEvent): Promise<void> {
    if (event.type === "message_end") {
        const duplicate = this.isOptimisticEcho(event.message);
        if (!duplicate) this.appendMessage(this.transcriptMessage(event.message));
    }
    ...
    this.emit(event);
    ...
}
```
`transcriptMessage`（`agent.ts:1355-1359`）只对 `toolResult` 角色做替换，assistant 消息**原样**返回。

**持久化**：`appendMessage` 把整个 message 对象写进 entry，不做字段裁剪：

`packages/core/src/session/session-manager.ts:1097-1107`
```ts
appendMessage(message: AgentMessage): string {
    const entry: SessionMessageEntry = {
        type: "message",
        id: generateId(this.byId),
        parentId: this.leafId,
        timestamp: new Date().toISOString(),
        message,
    };
    this.appendEntry(entry);
    return entry.id;
}
```
读回时 `sessionEntryToContextMessages`（`session-manager.ts:354-374`）对 `message` 类型的 entry 直接 `return [message]`（`:367`），也不剥 thinking。

**server**：`packages/server/src/mux.ts:411-417` 把事件整包推给订阅者，没有任何字段过滤：
```ts
const onEvent = feeds.onEvent((event) => {
    this.push(sessionId, subscription, { type: "event", event });
    if (event.type === "branch_changed") this.pushBaseline(sessionId, subscription);
    if (event.type === "entry_appended") this.pushEntry(sessionId, subscription, event.entryId);
});
```
wire 类型 `ServerMessage` 的 `event` 支见 `packages/server/src/protocol.ts:276`：`{ type: "event"; event: AgentSessionEvent }` —— 就是 core 那个并集，未收窄。

baseline 快照里，`SessionSnapshot.messages` 类型为 `AgentMessage[]`（`protocol.ts:204`），由 `sessionSnapshot` 从 `buildSessionContext().messages` 直接填（`packages/core/src/session/snapshot.ts:51,63`），同样不剥 thinking。

**旁证**：服务端自带 CLI (`packages/server/src/cli.ts:72-75`) 直接读 `message_update` 的 `assistantMessageEvent` 并渲染思考增量（`inner.type === "thinking_delta"` 时打印），说明 server 侧代码**预期**这条事件里就有思考。

**小结**：wire 上思考内容完好。客户端既能在流式 `message_update` 里收到思考增量，也能在 baseline 的 `messages` 里收到完整思考块。

---

## Q4. 客户端：思考被丢了、被拼进正文，还是根本没有字段？

**结论：被拼进正文（`[思考] ` 前缀），且 Item 没有独立字段。已读代码确认。**

1. **reducer 确实接了**。`packages/web/src/state.ts:240-247`，`message_start`/`message_update`/`message_end` 三种都走 `upsertMessage`：
   ```ts
   case "message_start":
   case "message_update":
   case "message_end": {
       const items = upsertMessage(state.items, event.message, event.type === "message_end");
       ...
   }
   ```
   注意：它取的是 `event.message`（部分消息），**从不读 `event.assistantMessageEvent`** —— 流式增量的类型信息（是不是 thinking_delta）在这里就被丢了，只当作"消息又变了"来重算整条消息。

2. **Item 里没有 thinking 字段**。`packages/web/src/state.ts:33-51` 定义了 `Item` 的 `message` 支：字段只有 `kind`、`id`、`role`、`text`、`notice`、`streaming`、`forkEntryId?`、`branch?`。**没有** `thinking`、没有 `blocks`、没有分区结构。

3. **思考被折进 `text`**。`upsertMessage` 用一个 `contentToText(record.content)` 得到整条消息的文本（`state.ts:431`），而 `contentToText` 对 thinking 块的处理就是加前缀拼进去：

   `packages/web/src/state.ts:557-577`（关键在 `:571`）
   ```ts
   const blocks: unknown[] = content;
   return blocks
       .map((block) => {
           if (typeof block !== "object" || block === null) return "";
           const typed = block as { type?: unknown; text?: unknown; thinking?: unknown; content?: unknown; name?: unknown };
           if (typed.type === "text") return String(typed.text ?? "");
           if (typed.type === "thinking") return `[思考] ${String(typed.thinking ?? "")}`;
           if (typed.type === "toolCall") return `[调用 ${String(typed.name ?? "tool")}]`;
           if (typed.type === "image") return "[图片]";
           return typed.content === undefined ? "" : contentToText(typed.content);
       })
       .join("");
   ```
   多个块之间用 `""` 相连（`:576`）。思考块在内容数组里先于文本块，所以拼出来大致是 `[思考] <思考全文><正文>` —— **思考与正文粘成一个字符串，中间没有分隔**。

4. **渲染只画这一坨文本**。`packages/web/src/render/transcript.ts:124-125`：
   ```ts
   if (item.text === turn.text) return;
   turn.blocks = renderMarkdown(turn.body, item.text, turn.blocks);
   ```
   `renderMarkdown` 把整个 `item.text` 当一段 markdown 画进 `turn-body`。没有任何 collapsible/`<details>` 结构（对照：工具卡片 `renderTool` 用了 `<details>`，见 `transcript.ts:352-370`，但那是给工具结果的，不是给思考的）。

**小结**：思考没有丢——它以 `[思考] …` 的形式**确实显示出来了**——但它**混在助手正文里**，和正文同属一个 markdown 块，没有独立字段也没有折叠控件。全局搜 `thinking|思考` 在 `packages/web/src` 里，与"思考内容"相关的实现只有 `state.ts:571` 这一处（其余命中都是 `thinkingLevel` 档位选择器、设置面板文案、CSS 注释）。

---

## Q5. 结论：缺口在哪一层？

**三种可能里选第 2 种（客户端没给它留位置），并加一句限定它是"压平"而非"丢弃"。**

- **不是「压根没发」**：Q1–Q3 逐段证明，供应商 yield 了 `thinking_start/delta/end`，agent 转成 `message_update`，core 原样 emit 并持久化，server 整包推给客户端。四层里没有一处过滤。
- **不是「存了没画」**：客户端**画了**——`[思考] …` 就在助手消息里可见。所以"整条通路里 thinking 从没出现过"这个假设不成立。
- **是「发了、客户端把它压平了」**：客户端 reducer 收下了思考增量与思考块，却在 `contentToText` 里把它转成一个带前缀的字符串，塞进 `Item.text` 这一个字段；渲染层再把 `item.text` 当一整段 markdown 画。**结构在客户端第一跳（`upsertMessage`/`contentToText`）就被抹掉了**，此后没有任何折叠/合并的可能，因为下游拿到的只是纯文本。

**缺口定位**：`packages/web`，具体两处 + 一处样式：
1. `state.ts:33-51`（`Item` 的 message 支需增字段，例如 `thinking?: string` 或分块结构）；
2. `state.ts:413-456` 的 `upsertMessage` 与 `state.ts:557-577` 的 `contentToText`（需从 `record.content` 里把 thinking 块分流出来，而不是折进 `text`）；
3. `render/transcript.ts:104-127` 的 `renderMessage`（需为思考单独建可折叠节点并渲染）；
4. 配套 `style.css`/`tokens.css`（折叠样式；注意 `AGENTS.md` 规定窗口只读设计 token）。

**这决定了 09 的改动量**：**不需要跨供应商/agent/server 三层**。整条上游通路已经是正确的，改动全部落在 `packages/web` 内部（reducer + 渲染 + 样式）。这与"改一个前端文件"很接近，但严格说是一个包内的两三处协同改动（state 的字段与分流逻辑、transcript 的渲染结构），因为要在 reducer 里新增字段、在渲染层新增 DOM。

> 一个必须点破的现状细节（**推断**）：由于 `contentToText` 用 `join("")` 拼接、且思考块先于文本块，当前窗口里的助手消息实际显示为 **`[思考] 〈思考全文〉〈正文〉`** 首尾相接的一整段，靠 markdown 渲染恰好分段。这不是"折叠了一小行"，而是思考全文直接铺在正文前面。若只是为了"能读"，现状已勉强可读；"可合并、可折叠切换"正是要把这段从正文里拆出来。

---

## Q6. 别把 `thinkingLevel` 和"思考内容"混为一谈

这两件事在本仓库里走的是两条不同的通路，`thinkingLevel` 的存在**不能**推出思考内容必然有、也不能推出它必然没有：

- **`thinkingLevel` 是请求侧**：它骑在 `Model.thinkingLevel` 上，决定这次请求要求多强的思考。供应商侧在 `buildParams` 里把它变成 `output_config.effort`（`anthropic-messages.ts:864-874`），并在 `thinking: { type: "adaptive", display }` 里带上 `display: "summarized"`（默认，见 `anthropic-messages.ts:868-872`），意思是"请把思考以摘要形式回给我"。选它是 UI（composer 的档位下拉，`packages/web/src/composer.ts:68`），随消息以 `ModelSelection` 送出（`packages/server/src/protocol.ts:110-114`），落成一条 `thinking_level_change` entry（`packages/core/src/agent.ts:542-547`）。
- **思考内容是响应侧**：它是模型按 `display` 返回的块，落点就是本文追的 Q1–Q4。

**关键点一**：`display: "summarized"` 是**我们主动要**思考文本的开关（`anthropic-messages.ts:868-872` 注释原话："Default to 'summarized' so a model whose own default is 'omitted' comes back as thinking the transcript can show."）。也就是说，**只要 level 非 `off`，供应商侧就已经在往回流思考内容了**——这解释了为什么 Q1 一定有东西可解析，但它**不等于**客户端就会保留结构。请求侧要了、响应侧收到了、客户端又压平了，三件事各是各的。

**关键点二**：`level === "off"` 时供应商发 `thinking: { type: "disabled" }`（`anthropic-messages.ts:865-866`），此时**没有**思考内容可回——所以窗口里"有时看不到思考"里有一部分是请求侧的正常结果，与"客户端把思考压平"是两回事。本票的对象是后者（非 off 时应能折叠显示），不要拿前者去解释 `outline` 缺陷。

---

## 推断（不在正文判据内）

以下几项是推理，不是源码直读，只作为后续实现的提示：

1. **思考与正文之间无空行**：正文 Q4.3 说 `contentToText` 以 `""` 拼接、思考块在前，故当前实际显示为 `[思考] …<正文>` 直接相接。视觉上是否难看，取决于 markdown 渲染对无分隔文本的处理——我没有渲染验证。
2. **流式期间思考已经逐字出现**：`message_update` 每条都触发 `upsertMessage` → `contentToText` 重算整条 `item.text`，所以思考增量在流式时就被拼进去了。这意味着"折叠"实现若想保留流式体验，需要在扩展字段时仍把 delta 累加进去，而不能只在 `message_end` 补。
3. **09 的最省改法**：在 `contentToText` 旁加一个"分块提取"函数，`Item.message` 增一个可选 `thinking` 字段，`renderMessage` 先渲染思考 `<details>` 再渲染正文。由于 `contentToText` 还被别处复用（例如工具输出），改动时不要动它的既有行为，只在其调用点分流。
4. **持久化与重载一致**：思考块写进了 JSONL（Q3），所以重开窗口时 baseline 的快照里也有思考，折叠控件对"历史消息"和"流式中消息"应表现一致——这一点我**没有**实测，仅由 Q3 的持久化路径推出。

---

## 附录：字段形状建议（硬绑定现状数据形状）

给 01（`.scratch/window-rework/research/ui-spec.md` §6 的 `ReasoningRow`）与 09 用。逐条绑定到源码里**实际**的块结构与客户端现状，不另造形状。

### 数据侧的本相（先钉死可取到什么）

wire / baseline 上，一条助手消息的 `content` 数组里，思考块的真实形状就是 `ThinkingContent`（`packages/ai/src/types.ts:268-276`）：

```ts
{ type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean }
```

- **`thinking` 是 Markdown 原文，保换行**。它由供应商侧逐段 `block.thinking += event.delta.thinking` 直接拼接（`anthropic-messages.ts:575`），**没有任何单行化/转义**，写 JSONL（`session-manager.ts:1097-1107`）与过 wire（`mux.ts:411-417`）都原样。
- **`redacted` 就在同一字段形状上**：`redacted_thinking` 被归一成 `type: "thinking"` + `thinking: "[Reasoning redacted]"` + `redacted: true`（`anthropic-messages.ts:536-543`）。所以它**与普通思考同型**，不是另一种块，可以落在同一个字段、旁挂一个布尔标志即可。
- **流式每次带的是"已累计的全量"**：`message_update` 的 `event.message` 是 `{...partialMessage}`，其思考块里已经是**到此刻为止累加完**的字符串（`agent-loop.ts:370-377`，`partial` 就是供应商 `output`）。所以客户端**不需要自己累加 delta** —— 每次 update 取当前 `block.thinking` 即是"增量来源"。

### 建议形状

`Item` 的 message 支（`packages/web/src/state.ts:33-51`）**新增一个可选字段**：

```ts
// 只列新增部分；其余照现状
thinking?: {
    /** Markdown 原文，保换行；一条消息有多个 thinking 块时用 "\n\n" 合并。 */
    text: string;
    /** 该消息的思考里出现过 redacted_thinking（文本为 "[Reasoning redacted]"）。 */
    redacted?: boolean;
    /** 思考仍在流式：收到 thinking_start/delta 置 true，thinking_end 置 false。 */
    running: boolean;
};
```

**不拆 `summary` + `full`**：摘要（`firstLine` / `latestCompletedParagraphFirstLine`）是**渲染时从原文算**的（ui-spec §6 引 `ReasoningRow.tsx:19,56`），不是存出来的。字段只需给"保换行的原文"，段落切分（`/\r?\n(?:[\t ]*\r?\n)+/`）在组件里做。

### 抽取算法（在 `upsertMessage` 里，不动 `contentToText`）

`contentToText`（`state.ts:557-577`）被工具输出等复用（`state.ts:262,272`），**不要改它的 thinking 分支**；在调用点分流：

1. 若 `record.content` 是数组：把 `type === "thinking"` 的块分出去，其余**过滤后**再交给 `contentToText` 得到 `text`（这样正文不再含 `[思考] …`）；
2. 思考块按出现顺序取 `block.thinking`，用 `"\n\n"` 连接成 `thinking.text`（保留原来 `\n\n` 作为消息内块边界——与段落切分兼容）；任一块 `redacted === true` 则 `thinking.redacted = true`；
3. `record.content` 是字符串或嵌套 `{content}` 形状时（`contentToText` 的兜底分支），按现状走文本路径，不产出 `thinking`。

### 两个必须处理的坑（否则规格落不了地）

1. **`state.ts:435` 的早退会丢掉"只有思考、还没正文"的消息**：现状 `if (text.length === 0) return items;`。分流后，一条消息在"思考已开始、正文未开始"的流式瞬间，`text` 会是空串 → 整条 item 被丢弃 → 收起态那一行**永远不会在正文前出现**，直接违反 ui-spec §6 的"流式中摘要随 delta 前进"。**改法**：该早退要放行 `thinking?.text` 非空的 item。
2. **`running` 需要客户端别再丢 `event.assistantMessageEvent`**：现状 reducer 只取 `event.message`，把增量类型扔了（`state.ts:240-247`）。`text` 的推进不依赖它（全量已在 message 里），但"思考是否已结束"必须从事件判定 —— 否则只能退而用消息级的 `item.streaming`（`state.ts:443`），那会让"思考已结束、正文仍在流"期间收起态仍显示右侧渐隐遮罩，与 §6 不符。最小改动：把 `event.assistantMessageEvent` 透传给 `upsertMessage`，在其中按 `thinking_start/delta/end` 维护 `running`。

> 结论一句话（认同 ui-spec-scout 的方向）：**一个 `thinking` 字段存 Markdown 原文（保换行）+ 一个 `running` 标志**即可支撑 §6 的收起/展开/流式三态；`redacted_thinking` 用 `redacted` 布尔位落在同一字段上，不新开块类型。前提是先解掉上面两个坑。

---

## 附：与票面三选项的对照（结论表）

| 票面候选 | 判定 | 依据 |
|---|---|---|
| 压根**没发**（供应商或 agent 侧就断了） | **否** | `anthropic-messages.ts:527-545,571-582,616-622`；`agent-loop.ts:361-379`；`mux.ts:411-417` |
| **发了，客户端丢了**（state 里没字段或 reducer 没接） | **部分成立** | reducer 接了（`state.ts:240-247`），但 `Item` 无字段（`state.ts:33-51`）、`contentToText` 把思考折进文本（`state.ts:571`）。准确说法是「客户端把它压平进正文」而非「丢了」 |
| **发了、也存了，只是没画** | **否** | 已画：`render.ts` 把 `item.text`（含 `[思考] …`）渲染为 markdown（`transcript.ts:124-125`） |

**最终定位**：缺口在 `packages/web`（客户端 reducer + 渲染 + 样式），**不在**供应商 / agent / server。09 是**包内前端改动**，不是跨三层改动。
