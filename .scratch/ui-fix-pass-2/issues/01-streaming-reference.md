# 01 · 流式平滑度对照：dsh / pi 怎么做

Type: research
Status: resolved
Blocked by:

## Question

`优化` 这一轮的核心抱怨之一：流式刷新「还是卡，一抽一抽的，一点也不丝滑」，并指定「看一下工作区里其他项目
是如何丝滑刷新的，如 dsh 和 pi」。上一轮 `.scratch/ui-fix-pass/issues/03-streaming-jank.md` 已经做过帧合并、
只画尾部、去掉强制布局，用户仍觉得卡。要回答的是：dsh 和 pi 的机制里，哪些是我们缺的；我们的链路上还有
哪些每次 delta 都随答案长度增长的固定税。

## Answer

详见 [research/streaming-reference.md](../research/streaming-reference.md)。一句话总结：

- **dsh**：host 只发瞬态 delta，客户端 accumulator 累加，完整消息只在 settlement 出现；markdown 把尾部
  两块以外的块全部冻结（块 key 用源码 offset）；跟尾时 `overflow-anchor:none`，读滚动位置与写滚动分帧；
  行容器 `contain:strict` + `will-change`。
- **pi**：TUI 的 `requestRender()` 有 16ms 最小间隔，键盘输入可以抢帧。
- **我们**：每个 delta 发一条**含整条消息**的帧，而且 `assistantMessageEvent` 里还有一份 `partial`；客户端
  每个 delta `contentToText` 全量重拼、每个流式帧把 markdown 尾块删了重建、`pin()` 写 `scrollTop` 之后
  scroll 监听立刻读 `scrollHeight`；光标/思考 marquee/spinner 在软件合成下是周期性 CPU 重绘。

结论：卡顿不是单点，是「传输 × 全量重算 × 尾块重建 × 贴底强制布局 × 合成动画」叠加。票 04 处理传输与
状态增量，票 05 处理渲染、贴底与合成，两张都要先用真 Chromium 的 CDP main-thread task 时长量一遍。
