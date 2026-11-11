# 04：文档收账——ADR + AGENTS.md + architecture.md

Status: ready-for-agent
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