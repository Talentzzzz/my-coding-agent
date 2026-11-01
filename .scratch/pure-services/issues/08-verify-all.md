# 08:全量验证与文档总校

Type: task
Status: open
Blocked by: 07

## Question

收尾验证,标准与前作票 18 相同:

- `npm run check` + smoke 全套一次跑绿;任何失败先判「真回归还是按新生命周期
  该重写」,真回归回修,语义变化的 smoke 按新形状重写并在票下登记。
- 桌面手测清单(开窗、对话、审批、分支、队列、改模型/档位、设置面板、模式切换)
  人工执行——窗口客户端预期零改动,这是它的验收线。
- 文档总校:`AGENTS.md` `## 术语`(session / model / transport / assembly 词条的
  持有模型表述)、`docs/architecture.md`(持有模型一节、请求流程)、ADR-0006 与
  ADR-0007 交叉引用一致;`CONTEXT.md` 尚不存在,若 03 票的命名沉淀了新术语
  (OpenSession 候选),随本票评估是否落 glossary。
- 密钥红线抽查:`GET /api/models` 仍只报 `hasApiKey`,无回显密钥的新字段。
