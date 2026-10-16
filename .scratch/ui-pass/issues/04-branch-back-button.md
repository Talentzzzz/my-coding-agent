# 04 诊断并修复「回到对话」两个按钮失效

Type: task
Status: open
Label: feature

## Question

分支页固定标题栏上的「回到对话」/「切到这一条并回到对话」两个按钮（`branch-view.ts` 的 `this.back` → `applySelection()`）失效了。先复现诊断根因，再修。

已知线索：

- `applySelection()` 在 `this.streaming` 时直接 return——若会话状态里 streaming 卡住为真，按钮就永远没反应。
- `this.back.disabled = moving && this.streaming`——同一条线索的另一面。
- 标题栏遮挡（图2：窗口控制按钮压住工具行）也可能吃掉点击。
- `window` 级 `pointerup` 处理器与按钮的关系需要过一遍。

验收：选中别的节点后点「切到这一条并回到对话」能移动并回对话；直接点「回到对话」能回对话。
