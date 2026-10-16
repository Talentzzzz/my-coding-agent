# 03 分支图进入时居中

Type: task
Status: resolved
Label: feature
Resolution: 2026-10-16

## Question

分支页进入时图贴在左上角（`scrollHome()` 滚到 0,0）。改成进入时整图在视口中**居中**显示，之后用户可以像拖地图一样自由拖动（按住左键拖动已存在，确认顺滑即可）。

实现提示：`homeZoom()` 之后把滚动位置设为 `(sizer 尺寸 − viewport 尺寸) / 2`，图小于视口时用 `place-items: center` 一类的方式让它居中而不是贴角。缩小到「适应」档时同样居中。

## Answer

- **居中就是「滚动位置取中点」，而票面提示的 CSS 那一半是空转的**。`scrollHome()` 不再滚到 `0,0`，改成
  `max(0, (sizer − viewport) / 2)`，两个轴各算一次；`enter()` 与「适应」都落在这里，所以进页和按「适应」
  是同一条路。真正要写下来的是**为什么 CSS 那半没用**：sizer 永远不会小于视口——`fitScale()` 为
  「装得下」这个目标反解出的宽度恰好就是视口宽（`viewport = laidW × s + 2×PAD`），而 sizer 的行内尺寸又
  正是滚动范围的来源；于是 `justify-items: center` / `place-items: center` 没有任何「比容器小」的东西
  可挪。能挪的只有缩放后多出来的那点余量——图被压到 40% 下限时 sizer 比视口宽 `2×PAD×(1−0.4)`，也就是
  上面那个 `(sizer − viewport) / 2` 真正在起作用的全部场合，这恰好就是题目说的「缩小到适应档时同样居中」。
  纵向同一个道理，只是横向的余量在 100% 档就出现（卡片盒 46px、sizer 高 = 车位数×56 + 2×PAD，图比视口矮
  时被 `min-height: 100%` 撑到视口高），所以「进页时纵向也正好居中」只在图被缩过时成立。故 `style.css`
  里没留 `justify-items`，只留 `.graph-viewport` 的 `display: grid` 与 `.graph-sizer` 的
  `min-width` / `min-height: 100%`：后者是滚动位置与图的坐标不滑开的**下限保护**（少了它，被饿瘦的 grid
  轨道会把图的左/上边缘推进够不到的溢出区），前者是这个下限能成立的前提。
- **顺带补上了一个既有缺陷：Ctrl+滚轮的锚点算错了**。`applyZoom` 原先从 `scrollLeft` 反推指针下的图
  坐标（`(scrollLeft + vx − PAD_X) / zoom`），并读一份**过期的 `this.zoom`**——居中加入后前者不再成立。
  现在改成量 sizer 的盒子、取它与视口的偏移（`ox`/`oy`），回设时再减掉同一段偏移：锚点与图停在哪里无关。
  这也是「进入居中之后还能顺滑拖动/缩放」的实测前提。
- **量具补了两件缺件**，否则这次改动根本量不到：`scripts/dom-shim.ts` 的 `getBoundingClientRect()` 不再
  恒返回 0×0（`branch-view.ts` 正是靠 viewport 与 sizer 两个 rect 相减定位），`clientWidth` / `clientHeight`
  在没人显式写过时回读行内 `style.width` / `style.height`——sizer 的尺寸**就是**这两个行内值。
- **`scripts/smoke-branch.ts` 新增第 3 节（7 项）**：图比视口大时滚动位置等于两个溢出量的一半、该用例
  确实滚进了里面、图装得下时公式被夹到零（不是另写一条路）、sizer 的两条 `100%` 下限、以及「适应」按钮
  同样居中且确实滚到过别处。
- 验证：`npm run check` 通过；README 全量 smoke 清单逐条跑过、全绿（含 `smoke:boot` 与两个 desktop smoke；
  `smoke-api` 需要服务器，另外起了一个 `npm run start` 跑过）。提交：`c1e183f`（hunks 被同一时刻的票 02
  复审提交一起带走）+ `999d115`（本票自己的收尾：注释与断言改成与实际机制一致）。
- **未做：真窗口里的目视确认**。试了 `npm run desktop:screenshot` 与 `--click .branch-chip`（以及一个
  完全脱离 shell 的 detach 捕获），在本会话的 harness 下 Electron 一律被中途杀掉（exit −1 / 1、无输出），
  只截到过 `about:blank` 与对话页。所以「看着是居中的」这一条没有证据；有证据的是滚动的算术与样式表的
  两条下限。窗口一开着的话，一眼可验：`npm run desktop` → 点右上「当前分支」，图应落在视口中间而不是角上。
- 已知偏离：无。票面提示的两条（滚动中点在 `homeZoom()` 之后、适应档同样居中）都按原意落地；`place-items`
  那条按上面的理由换成了下限保护，理由记在 `style.css` 与 `branch-view.ts` 的注释里。
