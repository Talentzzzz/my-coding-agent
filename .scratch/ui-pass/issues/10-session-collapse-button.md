# 10 会话栏「收起」按钮随展开出现

Type: task
Status: open
Label: feature

## Question

工作区分组的分页行为（`sidebar.ts` 的 `moreFor`/`collapseFor`）按用户要求改：点击「展开其余 N 个会话」后，在它**右侧**多出一个「收起」按钮；「收起」撤销**上一次展开多出来的那一页**（退一页），而不是现在这样只在全部展开后出现、且一口气重置回第一页。

细节：

- 没有可收的（只有第一页在屏）时不显示「收起」。
- 两个按钮同行并排；分页状态仍记在 appearance 的 paging 里（窗口拥有写回）。
- 现有 `collapseFor`「全部展开后才出现」的语义被本 ticket 取代，实现时删旧逻辑。
