# 03 · 正文流式渲染卡顿

Type: task
Status: resolved

## Question

`优化/6.png` 是长会话里的流式帧：内容“一卡一卡”，有时干脆不出来。要的是定点修复，不是重写。

当前每来一个 `message_update` 都会走一遍 `apply()` → `transcript.render(items, streaming)`，而这条路径上每一步都和会话长度成正比：

1. **`visit()` 每帧从头部重算轮次**：`roundLastFlags(items)` 逆扫全部 items；`lastUserOf(items)` 再扫一遍；`placeAll(items, items.length)` 又从头把每个 item 的节点摆一遍（`insertBefore` 比较）。几百条消息时，每 token 都是几千次 DOM 比较。
2. **强制同步布局**：`draw()` 末尾 `this.sticky` 为真就 `follow()`，`follow()` 读 `this.container.scrollHeight` 再写 `scrollTop`——在同一个帧里先写 DOM 再读布局，每 token 一次 reflow。
3. **`setRuntime()` 每帧 `container.append(this.runtime)`**：正在计时的行每帧被移动到末尾，触发又一次布局；`tickRuntime` 的 interval 每秒一次，但 append 是每帧。
4. **思考 marquee**：`patchMarquee` 有 2s 节流，但节流命中时仍读 `track.scrollWidth`；`patchReasoning` 在展开时每帧重解析整段思考。

要做成：

- **delta 合并**：多个 `message_update` 在一帧内只落一次（`requestAnimationFrame` 合并，替代逐条 `apply`），真正的最后状态进 `transcript.render`。
- **每帧只碰尾部**：轮末标记与末条 user 只在 items 的尾部变化时重算，或按下标缓存；完整摆放只在 items 结构变化（新增/删除/换会话）时做，纯文本增长不摆放。
- **不再每帧挂 runtime**：runtime 节点只创建一次、只在其应处位置变化时移动；`follow()` 已经贴底时用不读 `scrollHeight` 的写法（如 `scrollTop = container.scrollHeight` 仅在内容增长事件后执行，或用 `scrollTo({ top: Number.MAX_SAFE_INTEGER })` 的等价物），并且把“是否贴底”的判断与滚动写入分开到帧的末尾一次。
- **思考正文**：展开状态下也按增量重解析（`renderMarkdown` 已支持 `MarkdownState`），只在文本真正变化时调用。

验收：在 200+ 条消息的会话里发一条长回答，用 DevTools Performance 录 5 秒，主线程无 >50ms 的长任务、帧间隔稳定；同一段流式内容不再出现“停住再一口气吐出来”。改动不改变 wire、不新增事件。`npm run check` 通过。

## Answer

四条全部落地，另外补掉了一个 delta 化必然踩到的回归。**没有动 wire、没有加事件**：改的只有
`packages/web`（新增 `frame.ts`，`main.ts` 的 apply/draw，`render/transcript.ts`），外加两个 smoke 与
一个浏览器量具。会话文件、服务器、协议都没碰。

### 改动

1. **delta 合并到帧**：新增 `packages/web/src/frame.ts` 的 `OncePerFrame`——`requestAnimationFrame`
   合并，`cancel()` 让立即绘制顶掉排队帧。`main.ts` 把 `apply()` 拆成
   `apply(next, { deferred?, coalesce? })` + `drawState(next, previous, options)`，并新增 `drawnState`
   （上一次**画到屏幕上**的 state；门控对它比，不对上一次折叠比——一帧里可能折了好几次）。
   `onStreamMessage` 走 `apply(reduce(state, message), { coalesce: true })`：折叠仍逐事件（廉价的不可变
   更新），绘制每帧最多一次、画这一帧最后到达的状态；`onStreamEnd`、报错、会话切换这些立即绘制先
   `cancel()` 排队帧，所以“运行结束”仍然当帧落屏，不会晚一帧。
2. **每帧只碰尾部**：`transcript.ts` 删掉 `visit()` / `roundLastFlags()` / `lastUserOf()` 的逐帧全量走查。
   改为：`drawnItems`（按下标存上次画过的 item 引用——reducer 只重建变化项，所以一次 `===` 就是
   delta）、`roundIndex()` / `RoundIndex`（本轮末答案、开轮 user、最后 user，一次前向走查算好，只在形状
   变化时重算）、`sameShape()` / `shapeKey()`（长度 + 末项身份 = 形状）、`idsOf()` + `reconcile(wanted)`
   （按整份 items 剪枝，不再按“已画集合”累积）。`placeAll()` 只在形状变化时跑；纯文本增长只画一条消息。
   `renderDeferred()` 分批画完时屏幕已满、形状看起来没变，所以它在**开头**就把 `roundIndex` 发布出去，
   否则收尾那次 pass 不会重算，后续 delta 帧会按空索引画。
3. **不再每帧挂 runtime、不再强制布局**：`setRuntime()` 只在 `container.lastChild !== runtime` 时 append；
   `tickRuntime()` 用 `runtimeShown` 去重，秒数没变不写。`follow()` 改成 `pin()`：
   `scrollTop = Number.MAX_SAFE_INTEGER`（写入由浏览器钳到最大滚动位），**不读 `scrollHeight`**，只在
   `sticky && touched` 的帧末调一次；`scrollToBottom()` 复用 `pin()`。
4. **思考正文/头部**：`paintReasoning` 本就按 `MarkdownState` 增量、文本没变即返回；补了
   `ReasoningView.previewText`，折叠头（`firstLineOf()`）只在思考文本真正变化时切。票面第 4 条说的
   marquee 节流在写票前就已经存在（现状无需再改，`patchMarquee` 只在运行时跑）。

**顺带修掉的回归**：脚注可见性/用时原先靠“每帧补所有 turn”，delta 化之后必须显式重读。新增
`patchFeet()`，只在**形状变化或 streaming 翻转**的帧跑（同轮更晚答案接管脚注、运行结束落定用时）；
`setRuntime()` 在 delta 渲染**之前**执行，好让同一帧把观察值交给脚注；`FootView.shown` /
`MetaView.shown` / `applyEntry` 加重复写保护。

### 数字

**(1) jank-harness**——同一把尺子，`FRAMES=2000`，短历史 50 / 长历史 500，看比值（绝对值跨 node 版本
不可比：旧记录 22.22.2，本机 24.15.0）：

| 阶段 | 改前（仓库记录 `jank-harness-output-after.txt`） | 改后 |
|---|---|---|
| `transcript` mean 50→500 | 0.0229 → 0.1071ms（**4.67x**） | 0.0152 → 0.0141（**0.92x**） |
| `full` mean 50→500 | 0.0261 → 0.1102（4.22x） | 0.0178 → 0.0177（**1.00x**） |

`FRAMES=600` 的两次跑法给出 1.00x 与 1.11x（`transcript`）——同一量具的跑间抖动，量级一致：不再随历史
增长。

**(2) `scripts/smoke-transcript.ts` 的计数**——200 条会话、100 个纯增长帧，量的是 DOM 写入次数（与机器
无关）：属性写入 **20000 → 1**；同一份 items 再画一次 **200 次属性写入 + 1 次 append → 0/0/0**；增长帧
不重建任何 turn 节点；计时行自始至终是同一个节点。旧路径这两个数是把 `render/transcript.ts` 退回
`e439710` 那一版实测的。

**(3) 真 Chromium**（`.scratch/ui-fix-pass/research/verify-03.ts`，脚本化传输、8851 字回答；新增 CDP
`Performance.getMetrics`，取发出请求与运行结束两次读数的差）：

| | 210 条 · 旧 | 210 条 · 新 | 800 条 · 旧 | 800 条 · 新 |
|---|---|---|---|---|
| 运行期脚本时间 | 175ms | 93–119ms（4 次） | 284–299ms（3 次） | **108–122ms（4 次）** |
| 长任务 >50ms | 0 | 0 | 0 | 0 |
| 帧间隔 p95 / 最大 | 4.3 / 20.9ms | 4.4 / 16.6ms | 8.4–12.4 / 20.9–37.4ms | 8.2–12.5 / 20.9–21.6ms |
| `LayoutCount` | 337 | 365–379 | 343–384 | 341–370 |

要点：**同一段 8851 字内容，新路径的脚本时间不随会话长度走（210→800 条：93–119 → 108–122ms），旧路径
走（175 → 284–299ms）**。验收线（0 个 >50ms 长任务、帧距 p95 <40ms、无 >200ms 空档、正文持续变长、
整段回答到达）在 210 与 800 条下都过。

### 诚实边界

- **浏览器量具的长任务/帧距区分不了两个版本**：210 条时旧路径一帧约 0.1ms，离 50ms 很远；改前改后
  都过。改善的证据是“脚本时间是否随规模增长”（上面 1、2、3），不是长任务对比。
- **`LayoutCount` 不区分两者**（210 条 337 / 365–379，800 条 343–384 / 341–370）。这里的 delta 约每
  10ms 一个，headless 的帧又是每 ~4ms 一个，于是两个版本都差不多“每画一帧布局一次”（~350 次）；旧路径
  每 token 强制的那次 reflow 省掉的是 CPU，不是布局次数——那正是 `ScriptDuration` 显示的东西。所以这个
  计数器只作参考、不当证据；`verify-03.ts` 的注释里写明了这条。
- headless 的 rAF 不受 vsync 限制（~240Hz），两次运行的墙钟时长因此不同（800 条：旧 2.9–3.0s、新
  3.9–4.4s），所以比的是**同一段内容的累计**脚本时间，不是每秒。
- `verify-03.ts` 的 `--messages` 是新加的参数（默认 210 = 票面规模）；800 条是放大历史，让“是否随规模
  增长”看得出来。原来的“最长静止”检查会把答案写完之后到运行结束之间的平台期算成卡顿，已改成只统计
  最后一个增长样本之前的部分，并补了“整段回答都到了屏幕上”。
- “每帧只碰尾部”是指**DOM 工作**只在尾部：`draw()` 仍对 items 逐项做一次 `===`（500 条时整个 transcript
  阶段约 0.014ms），没有按下标跳到第一个变化项的办法；轮事实、剪枝、摆放才是按下标/形状缓存的。
- 中途接上一条**正在流式**的会话（重连、或打开一个已经在跑的会话）走的是 `renderDeferred`。它必须当场
  发布轮索引：收尾那次 `draw()` 时屏幕已经满了、形状没变，不会重算——不发布的话后续 delta 帧按空索引用，
  答案会丢掉“轮末”身份（脚注不出现、计时行没有起点）。这是 code-review 抓出来的，`smoke-transcript`
  第 5 节最后一组用例先红后绿地钉住了它。

### 验证

```
npm run check                                                        # tsc（ai/agent/core/server/web）+ token 审计
node scripts/smoke-transcript.ts                                     # 第 4 节只碰尾部、第 5 节脚注跟着轮与运行走
node scripts/smoke-frame.ts                                          # 一帧一次、跑最新、cancel、回调里再排是下一帧
npm run build:web && node .scratch/ui-fix-pass/research/verify-03.ts              # 210 条
node .scratch/ui-fix-pass/research/verify-03.ts --messages 800                   # 800 条
```
