# 04 订阅在 run 结束后不再复活

Type: task
Status: resolved
Blocked by: （无）

## Question

已实证的**最严重**缺陷，也是用户那句"输入消息后收不到流式，要再重新打开这个窗口才行"的直接根因。

**现象。** 一次 run 结束后，服务器回收宿主并给这条流发 `end`；而客户端收到 `end` 时既不重新订阅、也不
释放引用。于是**发第二条消息起，请求照样被 202 接受、侧边栏那一行照样亮"运行中"，但转录里一个帧都收不
到**——不出现回复、不出现工具卡片、停止按钮也不出现（它由 `streaming` 驱动）。切走再切回、或者重开窗口
才恢复。

**已确认的三个环节**（读代码 + 端到端复现，复现输出里有"第二条 prompt 之后到达的帧数 = 0"）：

- `packages/web/src/client.ts:282-295`：`retain` 遇到已存在的条目只加引用，不重开。
- `packages/web/src/client.ts:484-488`（`endStream` 把条目打成 `ended`）与 `client.ts:597-603`
  （`replaySubscriptions` 显式跳过 `ended`）→ `ended` 之后唯一的复活路径是"引用降到 0 再 retain"。
- `packages/web/src/main.ts:211-214`：`onStreamEnd` 只 `apply(reduceEnd(state))`；对比
  `main.ts:215-228` 的 `onStreamError`，它会 `mux.release(sessionId, "send")`。

**要做的。**

1. **先补一条能提交的 smoke**，在真服务器 + 真 WebSocket + 生产 `MuxClient` 上断言"第二个 prompt 必须
   再次收到帧"。把排查时的内联复现整理成脚本，`scripts/smoke-mux-live.ts` 是最接近的落点。**这条 smoke
   在修好之前应当是红的**——先让它红，再让它绿。
2. **修**：倾向两条一起做——
   (a) `onStreamEnd` 像 `onStreamError` 一样释放 send 引用；
   (b) `retain` 对 `ended` 条目重新 `open`，同时**把"新的一次想要"与"重连后的按引用重放"分开**（后者仍
   走 `replaySubscriptions`）。写成哪一条要说明为什么。
3. **别顺手改坏** `main.ts:203-208` 那段次序：`settled → release` 必须在 `if (followed !== sessionId) return`
   **之前**。那个次序是对的，注释里写了为什么（读的时候先读那段注释）。
4. 跑 `npm run check` + `smoke-mux-client.ts` / `smoke-mux-live.ts` / `smoke-mux.ts` / `smoke-liveness.ts`。

**答案里写清**：改了什么、新 smoke 叫什么、以及"必须重开窗口才恢复"这个症状是否消失。

## Answer

修好了，用户那句"输入消息后收不到流式，要再重新打开这个窗口才行"消失。

**两条都做了，各自负责一半：**

**(b) 复活机制 —— `packages/web/src/client.ts` 的 `retain`。** 这是真正的根因。`retain` 遇到已存在的条目
过去只 `sources.add(source)` 后就 `return`，而 run 结束时条目已被 `endStream` 打成 `ended`，于是新一次
`retain(sessionId, "send")` 只是往一个死条目里加引用，既不重开也不发 `open`——服务器侧那条订阅在 `end`
时就已被 `forget` 掉，所以第二个 prompt 的帧在服务端生成后没有订阅可投递，一个都到不了客户端。

现在 `retain` 在条目 `status === "ended"` 时把它复位为 `subscribed` 并在通道 live 时补发 `open`。
**关键区分就在这里**："新的一次想要"走的是 `retain`（会复活）；"重连后的按引用重放"走的是
`replaySubscriptions`，它依旧 `continue` 跳过 `ended`（不会被一条陈旧的重连重新订阅一个服务端已判终的会话）。
`SubscriptionStatus.ended` 的文档也随之更新，说明它现在有两条清除路径：引用归零、以及一次新的 `retain`。

**(a) 引用出口 —— `packages/web/src/main.ts` 的 `onStreamEnd`。** 与 `onStreamError` 对齐，在
`if (followed !== sessionId) return` **之前** `mux.release(sessionId, "send")`。
`send` 引用的本意是"活到它发起的那次 run 结束为止"，而 run 的结束并不总有 `submitting: false` 那一帧：
`end` 是它第三条出口。少了它，一个没有 `settle` 帧的 run 会把 `send` 引用漏在表里，条目再也不会归零。
注意它放在 pane 判定之前——引用属于 run 不属于 pane，这和 `onStreamMessage` 里 `settled → release` 必须
先于 `if (followed !== sessionId) return` 是同一个道理，那段次序没动。

**只做这一件事**：没碰 `render/`，没动样式，没 commit。工作区改动：
`packages/web/src/client.ts`（+12/-1）、`packages/web/src/main.ts`（+6）、`scripts/smoke-mux-live.ts`（+92/-7）。

**新 smoke**：`scripts/smoke-mux-live.ts` 新增一节 **"run 结束后，同一会话的下一次 prompt 必须重新收到帧"**。
它在真服务器 + 真 WebSocket + 生产 `MuxClient` 上跑两轮真 prompt（模型是脚本化 transport，无需 key）：
第一轮 `retain(send)` → 收到帧 → 服务端回收宿主并发 `end`；第二轮在 pane 仍持有该会话的情况下
`retain(send)`，断言帧必须再次到达。修复前该断言 FAIL（detail 为 `[]`），修复后全绿。

**症状是否消失**：是。这一节正是"必须重开窗口才恢复"的机器化复现——修复前第二个 prompt 一个帧都收不到，
修复后正常收到。`npm run check` 与 `smoke-mux-client / smoke-mux-live / smoke-mux / smoke-liveness` 全绿。
未验证的部分：没有在真桌面窗口里手动点验（无 GUI 运行环境），但该 smoke 刻意复刻了 `main.ts` 的
`settled → release` 与 `onStreamEnd` 接线，端到端覆盖到了这条通路。
