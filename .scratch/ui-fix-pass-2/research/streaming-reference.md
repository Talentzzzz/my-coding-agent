# 流式平滑度：dsh / pi / 我的机制对照

只读调研（2026-10-18），来源是本仓库工作区里的两棵参考树：`deepseek-harness-master/`（dsh）与
`pi-main/`（pi）。结论用于票 04（传输）与 05（渲染/贴底）。

## 一、维度对照

| 维度 | dsh | pi | 我们 |
|---|---|---|---|
| 传输批处理 | **只发增量**：host 把每个 chunk 发成瞬态 `assistant/live-chunk`，客户端 `AssistantStreamAccumulator` 累加；完整消息只在 durable settlement 时替换。服务端没有时间窗合并，合并在客户端 | 进程内，无传输 | 每个 delta 一条 WS 帧，**载荷是整条 partial message**（`agent-loop.ts:370-378`）；`assistantMessageEvent` 自己还带一份 `partial`，`mux.ts:411-417` 原样 `push`。客户端逐帧 `JSON.parse`（`client.ts:431`） |
| 渲染调度 | `Notifier`：结构变更 microtask 批（`notifier.ts:31-36`），可见流式走 `markFrameDirty`（`:39-44`）；Conversation 侧对 `assistant/live-chunk` 声明 `publication:'animation-frame'`，实际是三层嵌套 rAF（`assembly.ts:140-157`）。每个 node 一个 store key，`ChatView` 每行只订阅自己的 node + 大量 `memo` | `requestRender()` nextTick 合并 + **最小间隔 16ms**（`tui.ts:990-1042`，`MIN_RENDER_INTERVAL_MS=16` 在 `:507`）；键盘输入走 immediate 抢帧（`:1116-1118`） | `OncePerFrame`（`frame.ts:13-33`）：每 delta 一次 `reduce`，每 rAF 一次 `draw`；**没有最小间隔、没有多帧闸门**；其余帧（status/entry）走立即 `apply` 并 `cancel()` 掉待画帧（`main.ts:916-928`） |
| markdown | 增量块解析，冻结"除尾部 2 块"以外全部，key = 源码 offset 以便 reconcile（`incremental.ts:1-38`；`MarkdownText.tsx:86-146`）；代码围栏流式增量高亮 | `Markdown` 按 `(text,width)` 缓存整段渲染行 + token 缓存（`components/markdown.ts:246-307`） | 增量**解析**只重解析尾块（`markdown.ts:271-282`），但尾块**整块删了重建**（`:296-300`）；不做语法高亮，高亮不是我们的成本 |
| 滚动 | 跟尾时 `overflow-anchor:none`（`ChatView.module.css:36-39`）；跟尾只在 commit 时写（`use-chat-scroll.ts:52-85`），读数按 500ms/rAF 采样（`use-chat-reading.ts:126-156`） | 主屏 append-only 写入 | `pin()` 每变动帧写 `scrollTop=MAX`（`transcript.ts:423-425`）不读；但 `trackScroll` 的 scroll 监听每事件读 `scrollHeight/scrollTop/clientHeight`（`:211-217`）= 每次 pin 后一次强制布局；`overflow-anchor` 用默认 `auto` |
| 差分/键 | React keyed node、memo、块 key 用源码 offset（跨冻结边界不重挂） | 行级缓存，无 DOM 差分（终端重画） | item 引用 `===` + `drawnItems`、shape 键、工具卡 shape 键都成立；**唯一每帧整节点重建**是 markdown 尾块 |
| 昂贵效果 | 行容器 `contain:strict`、`will-change:transform`（`ChatView.module.css:164,186`）、`ReasoningRow` `contain:size layout` | 无（终端） | 光标 `blink 1s steps(2)`（`style.css:1432-1447`）、思考行 marquee 无限 `translateX` 且无 `will-change`/`contain`（`:1495-1513`）、spinner `spin .9s`；本机 Chromium 只有 WARP（ADR-0004）→ 这些动画每次重绘都是 CPU 价 |

## 二、值得照搬

1. **增量帧只带 delta**（dsh `assistant-stream.ts` + `packages/llm` 的 accumulator）：协议加一条瞬态
   `message_delta`（文本/思考增量 + contentIndex），完整 message 只在 `message_start` / `message_end` /
   baseline 出现；客户端在最后一条 item 上 append。O(delta) 取代 O(answer)。**不要照搬的**：dsh 的
   durable/transient 双轨在我们这里没有对应物，直接瘦身现有 `message_update` 即可。
2. **尾部文本节点 append-only**：流式中把正在写的块渲染成**持久 text 节点**，每帧 `appendData(delta)`；
   该块闭合（空行/块边界/类型变化）时才 `renderMarkdown` 落成正式块。`markdown.ts` 加 openBlock 状态、
   `transcript.ts:508` 换调用点。
3. **尾块只补不删**：至少"块类型未变则只改其文本节点"，块型变了才重建；现在 `container.lastElementChild?.remove()`
   让整段 `<p>` 每帧重建，长段落 = 每帧全段断行、选区被清。
4. **跟尾时关掉滚动锚定**：加 `.transcript.pinned { overflow-anchor: none }`，由 `sticky` 切类；把
   `trackScroll` 的读数与 pin 分帧，不在同一帧里读 `scrollHeight`。
5. **最小绘制间隔/预算**（pi 16ms）：`OncePerFrame` 加"距上次绘制 <16ms 则顺延"，避免多帧连发时每帧
   都做一次尾块重建。
6. **单节点订阅**：我们的 `drawState` 已是"只碰变化项"，等价，不必照搬；但别再新增每帧全量 walk 的门控。

## 三、最可能的成因（按优先级）

1. **每个 delta 一条"整条消息"帧**（含两份 partial）：长回答时服务端序列化、客户端 parse + `contentToText`
   全量重拼（`state.ts:652`）+ `[...items]` 复制（`:693`）都随答案长度线性增长。
   量法：每个 delta 记 `frame bytes / JSON.parse ms / reduce ms`，画随字符数的曲线。
2. **markdown 尾块每帧整块重建**：一整段长段落时尾块就是全文 → 每帧 O(n) 解析 + 建 DOM + 重排 + 光标/选区被毁。
   量法：`renderMarkdown` 前后打点 + 尾块字符数；同一文本"有空行 vs 无空行"对比帧时间。
3. **pin 之后立刻被 scroll 监听强制布局**，且 `overflow-anchor:auto` 与 pin 抢位置。
   量法：`overflow-anchor:none` 开关 A/B，看 layout 时长与 scrollTop 抖动。
4. **软件合成下的周期性重绘**：光标 blink + marquee（无限 translateX 超长文本、无 contain）+ spinner。
   量法：只加 `animation:none`，同一段流式跑两遍比长任务 / paint 次数。
5. **立即绘制抢掉 coalesced 帧**：`status`/`entry` 等非 delta 帧立即画并 `cancel()` 待画帧，节律不稳。
   量法：记录每帧是 immediate 还是 coalesced 及距上一帧的间隔。

## 四、可复用的量具

- dsh：真 Chromium + 真实 composer/agent loop/transport 的合成流，120 个 delta、16ms 节拍
  （`benchmarks/long-session-browser/README.md:15`）；端点 = first visible reply / trusted typing /
  complete wall / **Chromium main-thread task duration**；"两个 animation frame"当渲染机会；另有
  `vitest.web.perf.config.ts` 与 `benchmarks/active-stream-reconnect`（10 万 delta 的 `replace()` 13.83ms）。
- 我们：`.scratch/window-repair/issues/04-jank-harness.md` + `research/switch-paint-probe.ts` 是 FakeNode
  shim，**没有布局/绘制**，不能回答"一帧多久"。票 04/05 应借 dsh 那条：真 Chromium + CDP
  main-thread task 时长 + 16ms 合成流。

## 五、诚实边界

- 参考树是只读快照，行号以 2026-10-18 为准；dsh 的 `assembly.ts` 注释与 `docs/subsystems/conversation.md`
  对"每帧最多一次"的说法不一致，这里按**代码**记（三层嵌套 rAF）。
- 上述成因是按代码路径排的，尚未在本机 Windows/Chromium 上量过；票 04/05 的第一件事是把量具搭起来，
  而不是直接改。
