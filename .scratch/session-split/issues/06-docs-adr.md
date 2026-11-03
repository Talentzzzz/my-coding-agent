# 06 - 文档与 ADR

Type: task
Status: open
Blocked by: [03 - 写侧改造](03-writers.md)、[04 - server 连带](04-server-fork-listing.md)

## Question

文档改写到与落地后实况一致：

- 新 ADR：两文件磁盘格式的取舍（快照 vs 日志的分界、为什么旧文件直接删）。
- ADR-0002 加 superseded 注记（rename 的「文件序最后一条赢」被 JSON 单字段取代）。
- `docs/architecture.md` 会话与格式章节；`AGENTS.md` 术语（session、fork、branch、compaction、settings 等条目涉及处）。
