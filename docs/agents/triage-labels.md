# 分诊标签（Triage Labels）

各 skill 用五个规范的分诊**角色**来说话。本文件把这些角色映射到本仓库 issue tracker 实际使用的标签字符串。

| mattpocock/skills 里的标签 | 本仓库 tracker 里的标签 | 含义 |
| -------------------------- | -------------------- | ---- |
| `needs-triage`             | `needs-triage`       | 维护者需要评估这个 issue |
| `needs-info`               | `needs-info`         | 等待报告者提供更多信息 |
| `ready-for-agent`          | `ready-for-agent`    | 已完整规格化，可以交给 AFK agent |
| `ready-for-human`          | `ready-for-human`    | 需要人来实施 |
| `wontfix`                  | `wontfix`            | 不予处理 |

当某个 skill 提到一个角色时（例如"打上 AFK-ready 分诊标签"），使用本表中对应的标签字符串。

本仓库使用本地 markdown 追踪（见 `issue-tracker.md`），没有标签系统，所以这些字符串**不是** GitHub 标签，而是写在 issue 文件顶部 `Status:` 行里的值。

要改成你实际使用的词汇，就编辑右侧那一列。
