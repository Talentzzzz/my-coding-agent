# 16 用户消息发送后的渲染异常

Type: task
Status: open
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
