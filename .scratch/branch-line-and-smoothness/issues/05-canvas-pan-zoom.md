# 05 · 分支页画布：地图式平移与缩放

Type: task
Status: resolved
Blocked by: 04

## Question

用户第四轮：**分支页的画布不能上下左右拖动**，要像地图一样，放大缩小没问题。

现状：平移靠 `viewport.scrollLeft/scrollTop`，滚动范围由 `.graph-sizer` 撑（`max(视口, 缩放后尺寸
+ 2*PAD)`）。图装得下视口时 sizer 恰好等于视口 —— **没有滚动范围，按住左键拖动什么都动不了**。
而「装得下」正是 `enter()` 里 `homeZoom()` 的结果，所以默认状态下画布就是拖不动的。

要定的是：把平移从「滚动」换成「自由位移」（`translate` 直接跟着指针走），滚轮/触控板怎么分工，
以及缩放的锚点在这个新模型里怎么算。

## Answer

**平移从「滚动」换成「位移」。**

原来那套：`.graph-sizer` 撑出滚动范围，`applyZoom()` 写 `layerX/layerY` 做居中，拖拽写
`viewport.scrollLeft/scrollTop`。图装得下视口时 sizer 恰好等于视口 → 滚动范围为零 → **拖拽完全不动**，
而这正是 `enter()` 的默认状态。所以不是手势没接上，是那套模型对这种状态根本没有自由度。

现在：

- `.graph-viewport` `overflow: hidden`（不滚动、`touch-action: none`、`user-select: none`），里面只有
  一层 `.graph-zoom`，`transform-origin: 0 0`，它带着**一个** `translate(x, y) scale(z)`。
- 拖拽直接改 `x / y`（超过 4px 才算拖，指针捕获保留），到哪都拖得动，图比视口小也拖得动 —— 地图本来
  就是这样。
- 滚轮：裸滚轮平移（`deltaX/deltaY` 直接减），Ctrl/⌘+滚轮缩放。
- 缩放锚点：指针下的图坐标是 `(px - x) / z`，缩放后要落在同一个像素上，于是 `x' = px - gx * z'` 是解
  出来的，不是挪出来的。没有滚动范围要夹，也没有内容尺寸要算。
- 进入页面与「适应」都走 `homeZoom()`：`z = min(1, fitScale())`、`x = (vw - w*z)/2`、`y = (vh - h*z)/2`。

`.graph-sizer` 这个元素与 `scrollHome()` 一起删了；CSS 与 `branch-view.ts` 里对它的讨论都改成了对新
模型的说明（为什么不能再靠滚动）。

验证：`scripts/smoke-branch.ts` 第 3 节用真事件驱动 —— 拖 60/30 后 transform 的 translate 正好 +60/+30；
裸滚轮 `deltaY 40` 让 y 减 40；Ctrl+滚轮把 94% 放大到 105% 且**指针下那一点不动**（误差 < 0.001 图像素）；
「适应」把拖走的画布拉回居中。真窗口：`shots/02-panned.png`（拖过）、`shots/03-zoomed.png`（105%）。
