# 06 - 文档与 ADR

Type: task
Status: resolved
Blocked by: [03 - 写侧改造](03-writers.md)、[04 - server 连带](04-server-fork-listing.md)

## Question

文档改写到与落地后实况一致：

- 新 ADR：两文件磁盘格式的取舍（快照 vs 日志的分界、为什么旧文件直接删）。
- ADR-0002 加 superseded 注记（rename 的「文件序最后一条赢」被 JSON 单字段取代）。
- `docs/architecture.md` 会话与格式章节；`AGENTS.md` 术语（session、fork、branch、compaction、settings 等条目涉及处）。

## Answer

纯文档票，零代码改动。**验证：`npm run check` 绿**（文档票跑一遍确认没碰坏什么）。

**新 ADR-0009**（`docs/adr/0009-session-two-file-format.md`）：会话是两个文件——`.json` 快照管「是什么」，`.jsonl` 日志管「说过什么」。分界标准 = 变更是「覆盖」还是「追加」：当前值（title、model、level、工具、审批）是覆盖语义，进快照、每次变更整体原子重写（temp + rename）、历史有意丢弃（本来就无人读）；对话、压缩检查点、视图改写记录、leaf、账目是追加语义，进日志、一行不重写。「没说过话不落盘」纪律不变，`.json` 是 commit marker（先日志后快照出生）。**「为什么旧文件直接删」单独成节**：格式由本构建拥有、收养 v≤4 等于把已删的 header 重放与归一化层加回来、保留只给每次扫描上税、丢失代价有限且诚实。「被取代的」对照表含 v4 单文件、ADR-0002 的 rename entry 机制、四种状态 entry、跨版本兼容改为整对删除；「没有被取代的」明确不动日志本身、0006 骨架、0005 的模式施加方式。

**ADR-0002 加取代注记**：按编号规则不改正文，只动头部——「取代者」指向 0009 的**部分取代**（rename entry 的存储机制被快照 `title` 字段取代、重放语义失效；「标题可写」决定本身保留，正文按当时实况读）。

**ADR README**：清单加 0009 行，0002 行补取代说明。

**`docs/architecture.md`**（会话与格式相关章节逐节校正）：
- 技术栈表：会话持久化 = 快照 + 日志配对。
- 设置/模式：会话级选择记在快照 `activeTools`/`approval` 字段；模式施加写的是快照既有字段。
- 模型选择：`recordSelection` 改写快照、四种「最后一条赢」配置 entry 消失、没说过话不落盘。
- 工具契约：`ToolState` 从快照字段派生；`setActiveTools` 改写快照。
- Hook：删「老文件 `tool_result_view` 照旧生效」句（重放层随 v≤4 删除一起消失）；fork 只复制 entry 流。
- `SessionManager 是真相之源`：整节重写磁盘格式段——两文件、v5 判定在 `.json`、六种 kind 清单、未知 kind 原样带过、prune/argtrim 归一化层消失、配对残缺即删、写入面 = 六 append + 四快照方法、出生顺序与 commit marker。
- 事件表：`config_changed` 发出者 = `applyModelSelection`/`applyConfig`/`setActiveTools`（branchTo 已不发）。
- 会话树：分支点状态 entry 清单更新；「工具选择也属于分支」改写为「选择是会话的，不是分支的」；leaf 记录一节去掉「版本保持 3」的说法、老文件不补写改为「没有 leaf 记录的文件不补写」。
- fork：`forkFrom` 从源的两个文件开始——日志复制分支 entries、快照带新 id 与随拷的五个当前值。
- 其余单文件措辞（snapshotOf、两个标签页、回收、API 表、偏离表）逐处改「两个文件 / 快照」。

**`AGENTS.md` 术语**：session（两文件、六种 kind、commit marker、残缺即删）、settings（快照字段）、model selection（改写快照）、approval / tool set（快照字段）、mode（写快照既有字段）、fork（一对新文件、五个当前值随拷）、compaction（日志保留全文）、workDirAbsPath（从快照的 `workDir` 取）。

**`docs/notes.md`**（顺手两处，避免直接矛盾）：D1 后果句的「不写 header」改为「两份文件随第一条消息同时出现」；leaf 闭洞段的「版本保持 3」标注「当时如此」，指向 0009。
