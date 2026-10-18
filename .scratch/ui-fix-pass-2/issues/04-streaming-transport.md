# 04 · 流式传输瘦身：帧只带 delta

Type: task
Status: resolved
Blocked by: 01

## Question

`message_update` 现在每帧携带整条 partial message，`assistantMessageEvent` 里还另有一份 `partial`；一个
长回答到后半段，每来一个 token 服务端要序列化整条回答两遍，客户端要 `JSON.parse` 两遍、`contentToText`
全量重拼一遍、复制一次 items 数组。这是随答案长度线性增长的固定税，也是「一阵一阵」最可能的来源。

要做的：

- **协议**：`message_update` 帧只带「哪个消息（id/timestamp）+ 哪种 delta（text/thinking/toolcall）+
  contentIndex + 增量文本」；完整消息只在 `message_start` / `message_end` / baseline 出现。D 到
  `ServerMessageItem` / `AgentSessionEvent` 的类型里要能表达这种瘦身，但**不新增顶层帧类型**——
  mux 的上行帧不是端点，下行事件仍走现有 `event` 通道。
- **客户端**：`state.ts` 对 delta 走 append 路径（在最后一条 item 的 text/thinking 上追加），
  不再全量 `contentToText`；`message_end` 仍用完整消息覆盖，保证最终一致。
- **中途接入**：重连或打开一个正在流的会话，baseline 必须带得出现在已经到达的 partial（现在是否带，
  先查 `snapshotNow` / `readSessionSnapshot`）；带不了就在票里写清楚退化行为。
- **量具**：用真 Chromium + CDP `Performance.getMetrics`，同一段 8k 字回答、同样的 delta 节拍，对比
  改动前后每帧 `frame bytes / JSON.parse / reduce` 随字符数的曲线；把脚本放进
  `.scratch/ui-fix-pass-2/research/`，像上一轮的 `verify-03.ts` 那样可重跑。

验收：`npm run check`、`smoke-mux`、`smoke-transcript`、`smoke-api` 通过；量具显示三项成本不再随答案
长度增长（或增长斜率明显下降）；窗口里长回答的到达节奏不再「后半段越来越顿」。

## Answer

### 协议

`AgentSessionEvent` 里 `message_update` 从「照搬循环的成员」改成**替换**：

```ts
type AgentSessionEvent =
  | Exclude<AgentEvent, { type: "message_update" }>
  | { type: "message_update"; delta: { timestamp: number; kind: "text" | "thinking"; contentIndex: number; text: string } }
  | …
```

- `MessageDelta`（`packages/core/src/agent.ts`）用 `timestamp` 指认消息：entry id 要等消息结束才有，而
  transcript 的 item 本来就是按 `assistant:<timestamp>` 键的。`kind` 只有 `text` / `thinking`。
- 循环（`packages/agent`）一个字没改。会话在 `handleEvent` 里把循环的事件投影成 delta：空 delta、
  `*_start` / `*_end`、toolcall 的 delta 都不占帧——块的边界由「第一段 delta」在窗口里自己开，
  工具卡本来就由工具事件建。`error` 那种流内事件也不发了，终态信息在 `message_end` 上（CLI 因此
  改为在 `message_end` 打 `error` / `aborted`，比原来一帧一行更准）。
- **baseline 带 partial**：`SessionSnapshot.partial?: AgentMessage`（只有活着的会话有；冷读没有）。
  会话在 `handleEvent` 里留着循环最后一条 partial，`snapshot` 带上它，`message_end` / `agent_end` 清掉。
  所以中途接入**没有退化**：基线画出已经到达的字符，后面的 delta 接着追加；基线读得晚、消息已经
  落地时，它就在 `messages` 里，同样不缺。
- 没有新增顶层帧类型：仍是 `{ type: "event", event }` 走同一条流。

### 客户端

`packages/web/src/state.ts`：

- `message_update` 走 `appendDelta` / `withDelta`：按 `assistant:<timestamp>` 找 item，**只追加**
  （`text += delta.text`；thinking 同理），不读全文、不重拼。
- item 由**第一段 delta** 创建，而不是 `message_start`：start 的消息是空的，空 item 会先画一个空轮次。
- 追加规则就是整条消息的拼法：同一块内直接追加；**第二段 thinking 块**前面补 `\n\n`（`streamBlock`
  记着上一段落在哪个 contentIndex）；第一段 text delta 把 `thinking.running` 关掉；`错误：` 前缀照旧
  变成 notice。
- `message_start` 现在**先认领身份再判空**：同一毫秒的两条消息（07）里，先到的那条已经结束、后来的
  start 又是空消息——old 代码在判空里提前 return，重命名根本没发生，下一条 delta 会追加到旧回答上。
  重命名因此移到判空之前（顺带修掉「已结束 item 的 entry id 被新 item 继承」这个小尾巴）。
- `message_end` 仍用整条消息覆盖，最终一致；`itemsFromSnapshot` 先重放 `messages`，再画 `partial`
  （`streaming: true`，thinking-only 时 `running: true`）。

### 量具

`.scratch/ui-fix-pass-2/research/measure-streaming.mjs` + `measure/`（Vite 用窗口那份构建，页面 import
生产代码的 `reduce` / `contentToText`；由 `scripts/cdp.ts` 在真 Chromium 158 里驱动，两条路径前后各读
一次 `Performance.getMetrics`）。旧路径是 HEAD 的帧形状：整条 partial 在 JSON 里出现两次，客户端每帧
重算全文；新路径是现在的帧 + 生产 `reduce()`。

```
2000 帧 / 8000 字（每帧 4 字）
                   旧（整条消息 × 2）          新（只有 delta）
  总字节            17150.4 KiB                    316.4 KiB
  最大单帧             16.4 KiB                      0.2 KiB
  JSON.parse 总计       11.1 ms                       1.4 ms
  重算/归并 总计         0.6 ms                       0.6 ms
  任务时长(CDP)         94.7 ms                       3.6 ms
```

按答案进度，旧帧每帧字节 1781 → 15781，新帧 162 恒定；旧 parse 每帧 2.4–7.6 µs 且随长度上扬，
新 parse 0–1.2 µs 平。JSON 结果在 `research/streaming-measure.json`。

一个诚实的发现：**`contentToText` 那一步本身很便宜**——单个 text block 时 `String(text)` 直接返回共享
的字符串，所以「每帧全量重算文本」在 V8 里几乎不花时间（0.6 ms / 2000 帧）。真正的税是**字节**
（服务端 stringify + 网络 + 客户端 parse）与每帧的对象分配；「重算文本会卡」这条假设被量具否掉了，
05 不该拿它当理由。

### 验证

```
npm run check                     # 通过（tokens 137/111）
node scripts/smoke-stream.ts      # 新增第 6 节：帧只带 delta、无第二份 message、最大帧 <300B、
                                  #   2400 字答案的 deltas 拼回原文、答案在 message_end 整条走一次、
                                  #   中途开第二条 lane：baseline.partial 是前缀，partial+deltas = 全文
node scripts/smoke-replay.ts      # 新增：thinking/text delta 追加成一段、第一段 text 停掉思考行、
                                  #   message_end 整条覆盖、baseline.partial 画出前半句并接上下半句
node scripts/smoke-mux.ts / -transcript / -projection / -frame / -session …   # 全绿
```

`smoke-api.ts` 需要供应商密钥，没跑；它读的字段已改成 `event.delta.text`（编译通过）。

窗口里的到达节奏这一步**没有**单独截图验：量具量的是同一段节拍下的字节/解析/任务时长，而渲染侧
（markdown 尾块、贴底）是 05 的范围；05 的量具会接着用这套 Chromium + CDP 装置看长任务与帧间隔。
