# 10 会话栏「收起」按钮随展开出现

Type: task
Status: resolved
Label: feature

## Question

工作区分组的分页行为（`sidebar.ts` 的 `moreFor`/`collapseFor`）按用户要求改：点击「展开其余 N 个会话」后，在它**右侧**多出一个「收起」按钮；「收起」撤销**上一次展开多出来的那一页**（退一页），而不是现在这样只在全部展开后出现、且一口气重置回第一页。

细节：

- 没有可收的（只有第一页在屏）时不显示「收起」。
- 两个按钮同行并排；分页状态仍记在 appearance 的 paging 里（窗口拥有写回）。
- 现有 `collapseFor`「全部展开后才出现」的语义被本 ticket 取代，实现时删旧逻辑。

## Answer

分页行从「先后两个 drawn 节点」并为一个：`sidebar.ts` 的 `moreFor`/`collapseFor` 换成 `pagingRowFor`（键 `paging:<cwd>`），一个 flex 行容器装两个按钮——「展开其余」在前、「收起」在后（右侧）——各自的存在性按渲染补 `hidden` 属性，不重建，与列内其余节点同一套原地补丁。展开过至少一页（`page > 1` 且会话数超过一页）时「收起」在屏；点一下退一页（`Math.max(1, page - 1)`），不再一口气回第一页；第一页与一页装得下的工作区不显示。旧「全部展开后才出现、重置回第一页」的语义整体删除，无残留引用。

一个票面之外的决策，记在这里：**`savedPage` 随退页一起回退**（`main.ts` 的 `onCollapseWorkspace` 写 `savedPage: page`，`config.ts` 的字段注释同步改写）。旧语义「收起刻意不碰 savedPage」服务的是「重置回第一页」——退页语义下反转它取的是对称：退页即退读，表头收起再重开落在的是真正读到的页。`onPageWorkspace` 写 savedPage 是 HEAD 已有行为，未动。

CSS 新增 `.session-paging`（flex、gap 2px、`margin-left: 22px` 沿用原对位），`.session-more` 摘掉自己的对位 margin。`smoke-sidebar` 第 13 节按新契约重写：右侧顺序、同行并排、逐页展开与逐页退回、第一页隐藏、一页装得下无分页行；驱动 `pagingDriver` 的「收起」同步为退一页（有意复制 `main.ts` 的规则，漂移即红）。`npm run check`（token 审计 137/110）与 smoke-tools/models/sessions/mux/sidebar 全绿；smoke-api 未跑（需要常驻服务端，本次未碰服务端）。
