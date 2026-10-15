# 16 用户消息发送后的渲染异常

Type: task
Status: resolved
Blocked by:

## Question

用户报告：每次输入并发送后，这条用户消息在会话里渲染不对（截图
`.scratch/window-polish/research/shot-user-bubble-bug.png` 存 Clipboard_Screenshot 的复制件）：
气泡悬在上一轮回答的下方、明显小于正文字号，气泡下面还跟着一个孤立的光标块。

先在真窗口复现（bootServer + 本机 Chromium，`.scratch/window-rework/research/shots.ts` 那套），
再定位修复。已核实的线索，按嫌疑排序：

1. **流式中途插入**：用户消息的 echo（`user:<timestamp>`）由循环异步回放，`upsertMessage`
   （`state.ts:656`）对陌生 id 直接 append 到数组尾。若发送时上一轮还在流式（steer/排队就是这个
   形状），用户 item 会落在**流式中 assistant item 之后**；assistant 后续 update 靠
   `indexOfMessage`（`state.ts:674`）找回去——它的尾优化假设"流式消息是最后一项"，此时失效，
   兜底的 `findIndex` 能找回去但**新到的工具组仍 append 在用户气泡之后**，正文被用户气泡拦腰截断。
2. **`role:timestamp` 同毫秒碰撞**（07 号出图时撞到过、登记未修）：两个 item 同 id 时
   `upsertMessage` 会互相覆盖，位置与内容都可能错乱。
3. **气泡下的光标块来源不明**：候选是 IME 组合串、streaming caret 样式、composer textarea 溢出
   ——复现时用 DevTools 指认，别猜。

修完跑 `npm run check` + `smoke-replay.ts`；若修的是 1，给 `smoke-replay` 补一个"流式中途用户
echo 落地"的用例钉住顺序。

## Answer

复现走的是真窗口：`../research/repro-16.ts`（bootServer + 脚本化 transport + 本机 Chromium，
走窗口自己的「新建会话 → 输入 → Enter」路径，含页内 WebSocket 探头与 Node 侧 wire 对照
`repro-16b.ts`）。三条线索逐一核实的结论：

**③ 气泡下的光标块——实锤，已修。** 来源是 `style.css` 的流式光标选择器
`.streaming .turn:last-of-type .turn-body::after`：它画在**最后一条 turn** 上，不问角色。发送后
echo 已落地、下一条回答的第一个 delta 还没到的间隙里（截图正是这个时刻——状态行还亮着停止
按钮），最后一条 turn 是用户自己的气泡；`::after` 挂在 `.turn-body` 上、排在块级 `<p>` 之后，
于是光标在气泡内**另起一行**，读作孤立的光标块。原图放大可证：光标块（约 7×15px 的实心亮块）
在气泡背景矩形内部、文本行之下。修法：光标改由**消息 item 自己的 `streaming` 标记**驱动——
`transcript.ts` 给 turn 挂 `streaming` 类，选择器收成
`.streaming .turn.assistant.streaming .turn-body::after`（容器在流式 + 该 turn 是 assistant 且
仍在写）。间隙里没有正在写的消息，光标消失，下一条回答开始时再出现。

**② `role:timestamp` 同毫秒碰撞——实锤，已修。** 复现 harness 里两条脚本化回答在同一毫秒创建，
wire 上两条 assistant 消息同 id；`upsertMessage` 对 `message_start`（循环对一条消息只 announce
一次，start 撞上已 finished 的 item 即异名消息）走了「原地替换」，把新回答的正文画到了旧回答的
位置上——用户气泡被顶到正文之后，正文看似被拦腰截断。修法：`message_start` 撞上非 streaming
item 时**给旧 item 改名让路**（`assistant:T#1`），新消息拿走裸 id，它后续的 update/end 仍按
裸 id 命中；顺序保持 [旧回答, 气泡, 新回答]。根子上给 `fake-transport.ts` 换了单调盖章
（`nextStamp`，与会话自己的 `nextStamp` 同一不变式），脚本化场景撞不出同毫秒；真实供应商
两条 assistant 消息间隔一次往返，实际撞不到。

**① 流式中途插入——线索的机制不成立，顺序本身是对的。** wire 帧日志证明：循环只在取走点
回放排队消息，echo 永远落在上一条 assistant 的 `message_end` **之后**（`agent-loop.ts` 的两个
drain 点都在 turn 结束处），`indexOfMessage` 的尾优化失效场景（update 落在非尾 item 上）由
兜底的 `findIndex` 正确接管，新到的工具组 append 在尾部也就是 append 在它的 assistant 消息
之后——顺序从不乱。`smoke-replay.ts` 已补「流式中途用户 echo 落地」用例（含同毫秒碰撞变体）
把这套顺序钉住。**但**复现同时暴露了一个真问题：重连/复活带来的运行中基线读的是 store 顺序，
而排队消息乐观落盘在被打断的回答**之前**，气泡会在重连后跳到问题和回答中间——传输层的事，
登记到 [20 号](20-midrun-baseline-reorder.md)，本票不动。

**「明显小于正文字号」——不成立。** 两处量化：真窗口计算样式，气泡与正文同为
`--dsw-fs-body`（复现里同为 20px 设置值）；原始截图逐像素量行高，气泡文本行 ≈18px、正文行
≈20px（DPR≈1.25 下都是 15px 档，2px 是两种底色上的抗锯齿阈值差）。观感差来自孤立的短气泡
贴在大段正文旁、再加上气泡里那个光标块，不是字号。

改动清单：`packages/web/src/state.ts`（碰撞改名让路 + `freeMessageId`/`renameMessage`）、
`packages/web/src/render/transcript.ts`（turn 的 `streaming` 类）、`packages/web/src/style.css`
（光标选择器）、`scripts/fake-transport.ts`（单调盖章）、`scripts/smoke-replay.ts`（两个新用例）。
`npm run check` 绿；`smoke-replay`/`smoke-session`/`smoke-stream`/`smoke-tools`/`smoke-mux` 绿
（`smoke-api` 需要外部起在 8080 的服务器，本机前后同样失败，与本次无关）；修复后真窗口复跑，
间隙 DOM 顺序 [问, 答(流式), 气泡]、光标计算值 `content: none`，落定后 [问, 答, 气泡, 答]。
