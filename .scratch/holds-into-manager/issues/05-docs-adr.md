# 05 - 文档：ADR-0023 + AGENTS.md 术语 + architecture.md

Type: task
Status: resolved
Blocked-by: 03

## 背景与指针

- Spec：`Z:/my-coding-agent/.scratch/holds-into-manager/spec.md`（Implementation Decisions 最后一条「文档与 ADR」+ User Story 11、12）。
- 探索笔记：`C:/Users/Administrator/WorkBuddy/spaces/2026_11_17_14-35-39/holds-into-manager-notes/exploration.md` §7（全部需改写段落的行号）、§8.13（上一棒交接文档）。
- 代码已落地（票 01-03）；本票与票 04 并行，不碰 scripts/。

## 改动

### 1. 新 ADR：`docs/adr/0023-holds-into-session-manager-veto-delete.md`

记录两件事并明确取代/修订关系（沿用仓库 ADR 格式，参照 0006/0013 的「部分取代」先例写法）：

1. **holds 迁入 SessionManager、按文件对键控**：
   - **修订 ADR-0001**：「hold 住在 hub、hub 的 hold/release 是全部通道」半句——住址与持有者变了；「core 的 Agent 不再有 hold / release 动词」半句**保持成立，本 spec 不推翻它**；
   - **修订 ADR-0006**：SessionManager 成为第二个持有常驻表的服务（第一个 ToolManager，ADR-0011）——有意识的修订：表是易失簿记（重启即空、不落盘、不可重建也不需重建），无状态门面的其他一切不变；
   - 键从 sessionId 改为文件对（`.jsonl` 规范键 + win32 折叠）：锁的单位与锁保护的东西重合，id 只是进闸前的一次地址解析；
   - 持有者内化：Manager 方法自己进出闸，`remove` 是唯一跨 await 的持有者；Agent 门面零动词、controller 的 holding() 括号删除；
   - 计数表 = **存储原缺失税**：文件系统没有「存在才写」的原子原语（引 `.scratch/fs-race-test/test.mjs` 的实证）；换事务型存储那天这张表跟着消失。
2. **删除语义反转（否决式）**：
   - **取代 ADR-0022 的「守卫刻意只有三道」**：守卫变成动作（中止 → 等收尾复查 → 闸内 rm 先 `.json` 后 `.jsonl` → 出表）；
   - ADR-0022 *没有被取代的*一节曾为 holds 留住 hub 给出理由（跨 await 短命令的唯一现形手段 + closing 串行化）——本 ADR 说明：目的保留、实现更换，跨 await 的保护从「现形后拒绝」改为「先停运行 + 闸内拒绝」，串行化原样活着，只是闸的主人从传输层换成存储层、单位从 id 换成文件；
   - 409 退场与 health `held` 字段退场的理由（借不来的数字比少一个字段更糟）；
   - 删除端点 202（分离式否决序）的 wire 变化。
   - 更新 `docs/adr/README.md` 的索引。

### 2. AGENTS.md

- **`hold` 术语条目（L116-124）整条改写**：hold 是 SessionManager 的**文件级**簿记（`Map<fileKey, { holds, closing? }>`，键为 `.jsonl` 规范键）；Manager 触碰文件对的公开方法各自进出闸，`remove` 唯一跨 await；server 与编排层**不感知**；计数语义（纯计数、宽容 release、归零删条目）不变；引 ADR-0023。
- **`service` 术语条目（L26-37）**：补第二个常驻表例外（SessionManager 的易失持有簿记，与 ToolManager ADR-0011 并列）。
- 其余提及 hold 的地方（exploration §7.2：L236 等）随上下文改写。

### 3. docs/architecture.md

exploration §7.3 的 12 处，逐段改写（保留各节论证结构，只换 holds 相关的事实）：

- L15、L19-21（package 职责）、L61（目录树注释）、L71、L83（装配）；
- L221（SessionManager 是真相之源——「无状态对象」句按 ADR-0023 修订）；
- L264-291（§谁拥有一个会话——主段：簿记搬家、ASCII 图重画为 Manager 内的文件闸、删除守卫清单换成否决式三步、closing 槽位段落换成 Manager 的闸）；
- L435-436（请求流程）、L472（偏离表）。

## 验收

- 仓内 grep `holdsOf|heldSessionIds|closing` 在 docs/ 与 AGENTS.md 无过时残句（历史沿革叙述除外）；
- 新 ADR 编号、格式与既有条目一致；README 索引更新。
