# 02 思考（thinking）的数据通路

Type: research
Status: resolved
Blocked by: （无）

## Question

用户要求"思考能合并、能展开/折叠切换"。要在窗口里显示可折叠的思考，先得知道思考内容现在**走到哪一步就
没了**。请沿着一条通路逐段查，每段给出 `文件:行号` 加结论：

1. **供应商侧**：`packages/ai/src/api/anthropic-messages.ts` 解析响应流时，thinking / extended thinking
   的增量有没有被 yield 出来？以什么事件形状？如果没有，说明它压根没被解析。
2. **供应商 → agent**：`packages/agent` 的循环把这些增量变成什么？`AgentEvent` 的成员里有没有它？
3. **agent → wire**：`packages/server/src/projection.ts` 与 `mux.ts` 把它们投影成什么帧？客户端能看见吗？
4. **客户端**：`packages/web/src/state.ts` 的 reducer 里，思考是被丢了、被拼进正文了、还是根本没有字段？
   `packages/web/src/render/transcript.ts` 又画了什么？
5. **结论**：要做出"思考可以合并、可以展开/折叠切换"，缺口在哪一层？三种可能，请明确选一个并给证据：
   - 压根**没发**（供应商或 agent 侧就断了）；
   - **发了，客户端丢了**（state 里没字段或 reducer 没接）；
   - **发了、也存了，只是没画**。
   **这一条决定 09 是小改还是跨三层的改动**，所以结论必须硬。
6. 顺带说清一件事：`thinkingLevel`（`off`..`max`）与"思考内容"是两件事，别混为一谈——前者已经在输入框上
   选了，后者才是这一票的对象。

产出 `.scratch/window-rework/research/thinking-path.md`。同样：区分"我读了代码确认"与"我猜"。

## Answer

**结论：思考内容一路带到了浏览器，没有任何一层丢弃；是 web 客户端在 `state.ts` 里把它压平成正文文本（加 `[思考] ` 前缀拼进单一 `text` 字段），既没有独立字段、也不可折叠。** 三选项里是**第 2 种的变体**——"发了、客户端也接了，但没留结构"，既不是"压根没发"，也不是"存了没画"。缺口在 `packages/web`，**不在供应商/agent/server**，因此 09 是**包内前端改动**，不是跨三层改动。

逐段证据（完整版见 `research/thinking-path.md`）：

1. **供应商侧**：解析了，且以独立事件形状 yield。`packages/ai/src/api/anthropic-messages.ts:527-545`（`thinking`/`redacted_thinking` → `thinking_start`）、`:571-582`（`thinking_delta`）、`:616-622`（`thinking_end`）。事件类型 `thinking_start/delta/end` 是一等成员（`packages/ai/src/types.ts:559-561`），块类型 `ThinkingContent`（`:268-276`）。
2. **供应商 → agent**：转成 `message_update`，思考增量原样携带。`packages/agent/src/agent-loop.ts:361-379` 的 `case` 明确列了 `thinking_start/delta/end`；`AgentEvent.message_update` 携带 `assistantMessageEvent`（`packages/agent/src/types.ts:509`）。
3. **agent → wire**：core 原样 emit 并持久化（`packages/core/src/agent.ts:1391-1411`；`session-manager.ts:1097-1107` 原样写 JSONL），server 整包推给客户端、无过滤（`packages/server/src/mux.ts:411-417`；`protocol.ts:276`）；baseline 快照 `messages` 也是原样（`packages/core/src/session/snapshot.ts:51,63`）。
4. **客户端**：**这里断的结构**。reducer 接了 `message_start/update/end`（`packages/web/src/state.ts:240-247`），但 `Item` 没有 thinking 字段（`state.ts:33-51`），`contentToText` 把思考折成 `[思考] …` 拼进单一 `text`（`state.ts:571`，并以 `""` 拼接 `:576`）；渲染层把整段 `item.text` 当一个 markdown 块画（`packages/web/src/render/transcript.ts:124-125`），没有可折叠节点。
5. **缺口定位**：`packages/web` 的 `state.ts`（新增字段 + 从 `record.content` 分流 thinking）与 `render/transcript.ts`（为思考建可折叠 DOM），加配套样式。上游四层已经正确，无需改动。
6. **别混两件事**：`thinkingLevel`（`off`..`max`）是**请求侧**强度，供应商侧把它变成 `output_config.effort` 并请求 `display: "summarized"`（`anthropic-messages.ts:864-874`），随消息以 `ModelSelection` 送出并落成 `thinking_level_change` entry。它是响应侧思考内容存在的前提，但**不等于**客户端会保留结构；`level === "off"` 时供应商发 `thinking: { type: "disabled" }`（`:865-866`），本来就没有思考内容可显示——这属于请求侧的正常结果，与本票"客户端把思考压平"是两回事。

标为**推断**的部分：当前窗口实际显示为 `[思考] 〈思考全文〉〈正文〉` 首尾相接的一整段（由 `""` 拼接 + 思考块在前推出，未渲染验证）；以及 09 的最省改法建议（在 `contentToText` 调用点分流、不动其既有行为）。
