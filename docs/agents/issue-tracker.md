# Issue tracker：本地 markdown

本仓库的 issue 与 spec 以 markdown 文件形式存放在 `.scratch/`。

## 约定

- 一个功能一个目录：`.scratch/<feature-slug>/`
- spec 是 `.scratch/<feature-slug>/spec.md`
- 实施类 issue 是一个 ticket 一个文件，位于 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始编号，**绝不**写成单个合并的 tickets 文件
- 分诊状态记录为每个 issue 文件顶部附近的 `Status:` 行（角色字符串见 `triage-labels.md`）
- 评论与对话历史追加到文件底部、`## Comments` 标题之下

## 当某个 skill 说"发布到 issue tracker"

在 `.scratch/<feature-slug>/` 下创建一个新文件（必要时创建目录）。

## 当某个 skill 说"取出相关 ticket"

读取被引用路径上的那个文件。用户通常会直接给出路径或 issue 编号。

## Wayfinding 操作

供 `/wayfinder` 使用。**map** 是一个文件，每个 ticket 对应一个**子**文件。

- **Map**：`.scratch/<effort>/map.md`（承载 Notes / Decisions-so-far / Fog 正文）。
- **子 ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 开始编号，正文放问题。`Type:` 行记录 ticket 类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录 `claimed`/`resolved`。
- **阻塞**：顶部附近一行 `Blocked by: NN, NN`。当它列出的每个文件都是 `resolved` 时，该 ticket 即为未阻塞。
- **前沿（Frontier）**：扫描 `.scratch/<effort>/issues/` 中处于打开、未阻塞、未被认领状态的文件；编号最小者优先。
- **认领（Claim）**：在做任何工作之前设为 `Status: claimed` 并保存。
- **解决（Resolve）**：在 `## Answer` 标题下追加答案，设为 `Status: resolved`，然后向 `map.md` 的 Decisions-so-far 追加一条上下文指针（要点 + 链接）。
