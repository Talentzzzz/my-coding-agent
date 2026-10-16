# 03 分支图进入时居中

Type: task
Status: resolved
Label: feature
Resolution: 2026-10-16

> 收尾待办：`## Answer` 未写。实现本身已落地并全绿（`c1e183f` 的 hunks + `999d115`），
> 但当时另一个会话正在同一棵树上改 `.scratch/window-polish/` 与同几个源文件，所以这里只记状态、
> 不写正文，避免两个会话同时写一份文件。

## Question

分支页进入时图贴在左上角（`scrollHome()` 滚到 0,0）。改成进入时整图在视口中**居中**显示，之后用户可以像拖地图一样自由拖动（按住左键拖动已存在，确认顺滑即可）。

实现提示：`homeZoom()` 之后把滚动位置设为 `(sizer 尺寸 − viewport 尺寸) / 2`，图小于视口时用 `place-items: center` 一类的方式让它居中而不是贴角。缩小到「适应」档时同样居中。
