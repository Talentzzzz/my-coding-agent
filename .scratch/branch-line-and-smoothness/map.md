# Map · 第四轮反馈：流式顺滑 / cache 读数 / 工作区底座 / 分支页主链与地图画布

Label: wayfinder:map

## Destination

用户这一轮报的五件事，在桌面窗口里都能看见结果：

1. 流式刷新不再一卡一卡，思考那一行尤其顺；
2. `cache` 那个数字不再忽高忽低，读起来是「这一轮缓存了多少 / 在缓慢变大」；
3. 侧栏的当前工作区没有底座，只有当前会话那一行有填充；
4. 没有分支时打开分支页，画的是主链上一串 user 消息组成的**一条横线**，点中其中一条、回到对话再发消息，
   就从那儿分出第二条走法；
5. 分支页画布像地图：按住左键上下左右随便拖，Ctrl+滚轮在任何位置放大缩小。

终点不是决策，是**改动落地**：`npm run check` 与相关 smoke 通过，分支页在真窗口里点过一遍。

## Notes

- 域参考：`docs/architecture.md`、`AGENTS.md`、ADR-0001（mux）、ADR-0005（模式）。
- 前序：`.scratch/ui-fix-pass/`（缺陷）、`.scratch/ui-fix-pass-2/`（分支入口 + 流式瘦身 + 渲染贴底）。
  05 号票据当时**诚实地留下了**「每帧 O(答案) 的尾块重解析」没收，这一轮的 01 号就是它。
- UI 只读设计 token（`packages/web/src/tokens.css`）；`npm run check` 会拒绝引用却不存在的 `--dsw-*`。
- **本努力携带执行**：票据解决的问题直接改在工作区里，一次一张。

## Decisions so far

- [01 · 流式尾块与思考头](issues/01-streaming-tail-and-thought.md)：已落地——尾块补写的判据改成「看最后一个
  孩子」，密标记文本每帧从 **456,053 个节点降到 1,858 个**、p95 从 2.93 ms 降到 0.03 ms（16k 字、24 字一帧，
  `research/measure-inline.ts`）；逐字符比对「增量 vs 从零重建」全一致（`verify-inline.ts`）。思考行不再是
  跑马灯——跑马灯在文本变长时不可能顺——改成只往前走的「活的结尾」，实物 `shots/05-reasoning-head.png`。
- [02 · cache 读数](issues/02-cache-reading.md)：已落地——18 次真请求证明缓存工作得很好，锯齿是**累计均值**的
  必然形状（每次新写进去的部分永远在分母里）。座位改读**这一轮**从缓存读回的 token 数（`cache 44.5k`，缓慢
  变大），完整账目与会话均值放进 tooltip。
- [03 · 侧栏当前工作区](issues/03-sidebar-current-workspace.md)：已落地——`workspace-head-current` 整套删除
  （CSS 填充、`CURRENT_HEAD`、`paintCurrent`、`SidebarState.currentWorkspace`），只留当前会话那一行的填充。
- [04 · 分支页主链](issues/04-branch-line.md)：已落地——树改成「一条线 + 挂在下面的走法」：`next` 是线上后
  一句、`branches` 是从这里离开的走法、`landing` 决定按下去是退回这一句还是跟到尽头。没有分支点的会话现在
  也有图，第一次分叉之后主链不会消失。
- [05 · 地图式画布](issues/05-canvas-pan-zoom.md)：已落地——平移从 `scrollLeft` 换成 `translate`（图比视口小
  也拖得动），滚轮平移、Ctrl+滚轮以指针为锚点缩放，「适应」回到居中；`graph-sizer` 与 `scrollHome` 删除。

## Not yet specified

- 被换掉的走法**自己**还能不能再长出分支（服务器只报活跃链上的分支点，所以那些卡现在是叶子）。真要用到
  得连着服务端一起改。
- 状态行的 `cache` 座位要不要再加一根趋势线／迷你条（02 号先只换口径与文案）。
- 分支页卡片上的「轮 N」在回退分支之后是否还对得上（轮次是按主链数的）。

## Out of scope

- transcript 虚拟化、markdown 解析器换库、结构化增量渲染重写（证据仍不支持；01 号只做「不重建、不重解析」）。
- 插件 / MCP 机制（项目规则本就排除）。
- 分支页缩略图 / 小地图（地图手势做了，小地图没做）。
