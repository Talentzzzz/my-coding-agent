# 05 工作区当前标记改为阴影

Type: task
Status: open
Label: feature

## Question

侧边栏工作区分组标题现在用一个「当前」文字标记（`sidebar.ts` 的 `workspace-current` span，`groupFor()` 里挂）。按已定决策：

- 去掉「当前」文字标记。
- 当前工作区的标题（或整个分组头部）改用阴影表达（token 里加阴影变量，遵守「UI 只读设计 token」规矩）。

注意 `groupFor()` 里已有 mark 的增删补丁逻辑，删掉后这段要清干净。
