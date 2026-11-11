# 04：文档收账——ADR + AGENTS.md + architecture.md

Status: resolved
Blocked by: 01, 02

设计见 `../spec.md`（决定、崩溃窗口、被否决替代）。文档中文，源码注释英文。

## 做什么

1. 新 ADR（`docs/adr/`，下一个编号，当前应为 0021，以 `docs/adr/README.md` 索引为准）：
   - 决定：快照 `suspended` 标记是纯显示缓存，账本唯一事实不变；
   - 形状与两个翻译点；三写入点（运行收尾 / denyAllApprovals / forkFrom）与
     「respondApproval 不是写入点」的理由；
   - 显示-only 不变式：控制流不读标记；
   - 崩溃窗口两方向（漏报/误报）及自愈；
   - 被否决替代：启动全文重放、后台逐个重放（含尾读启发式为何不值）；
   - 与 ADR-0006 §5 及其「可重建缓存」口子的关系；进程内修复（projection onHost 冷读）
     是同一规则的另一半，可一并记。
   - 更新 `docs/adr/README.md` 索引。
2. `AGENTS.md` session 词条：快照当前值列表（身份 + title/model/thinkingLevel/工具/审批）
   补标记一句，注明显示缓存、账本为准。approval 词条如涉「重启继承问题」可加指针。
3. `docs/architecture.md` 会话/审批相关节同步（快照字段、扫描读侧、冷启动点的语义）。

## 验收

- ADR 编号与索引一致，交叉引用（0006 §5、0019）正确。
- AGENTS.md / architecture.md 不再含有「没有 host 就没有待审批」口径的残留表述。
- 术语与代码字段名一致（suspended / pending）。

## Comments

- 2026-11-11：文档收账完成，生产代码零改动。
  - 新 ADR：`docs/adr/0021-snapshot-suspended-marker.md`——背景（两层同族缺陷、进程内修复
    fef7347 已入库）、决定（纯显示缓存三条）、形状（磁盘/内存/写边界、两翻译点）、三写入点
    （含 respondApproval 不是写入点的理由）、读取点（含 refresh 附带闭合）、崩溃窗口两方向、
    被否决替代（含尾读启发式的 leaf entry 洞）、后果、不可逆性与代价、与 0006/0009/0019 的关系。
  - `docs/adr/README.md`：加 0021 索引行；顺带删去 fef7347 引入的重复 0020 行（两条摘要相左，
    保留与 ADR-0020 原文一致的那条）。
  - `AGENTS.md`：session 词条快照列表补标记一句（显示缓存、账本为准）；approval 词条补
    「问题比进程活得久」指针；fork 词条五值改「五值与标记随拷」。
  - `docs/architecture.md` 六处：SessionManager 节「连一份缓存都没有」改写为标记例外、
    快照字段列表补 suspended、新增「侧边栏的冷启动读标记」段、四个快照方法改五个
    （加 setSuspended）、before_tool 闸门补问题寿命与标记语义、fork 节第六值随拷。
- code-review 双轴：Standards 无硬违规；Spec 验收三条全过、代码核对全部相符。判断项已修：
  - **事实修正**（Spec 轴）：spec 原句「fork 整份复制 .jsonl」不准确——forkFrom 只复制含
    entryId 的分支（null 才整份），标记无条件随拷；ADR 写入点 3 改为准确表述，并记下
    「分支 fork 不含悬空 call 时继承误报点、首次运行收尾纠正」这一与崩溃窗口同族的边。
  - 理由不重复：AGENTS.md fork 括注与 architecture.md 扫描段/fork 段的理由复述删去，只留
    实况 + 链接（ADR 是理由唯一的家）。
  - 中文行文夹英文清理：parked / precedent / 显示 only / live overlay / 行 pass / no-op /
    gate / re-host / fill 路 → 停在闸门上 / 先例 / 仅显示 / live 覆盖 / 逐行做统计 / 空操作 /
    决定行为 / 宿主回来 / 直接点名函数。
- 验收证据：`npm run check` 绿（两次，含修正后复跑）。纯文档改动、生产代码零改动，
  smoke 不适用——行为面已由 01–03 号票的 verify-01/02 与 smoke 套件钉住（见 03 号票 Comments）。
  验收 grep：AGENTS.md / architecture.md 无「没有 host / 没有在等 / 硬编码」残留；
  0021 索引行与文件名一致，0006/0009/0019 链接实存。