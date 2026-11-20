# 撰写 spec 与 ADR 修订清单

Type: task
Status: open
Blocked by: 06, 07, 08, 09

## Question

把 01–09 的全部决策汇成 `.scratch/layered-modules/spec.md`——本图的终点交付物。

spec 至少含：

- 目标结构：五模块的目录树、每个模块一句话职责、模块依赖图。
- 端口清单：每个端口的接口文件位置与方法面（07 的产出）。
- ContextManager 设计（06 的产出）。
- app 组合根与启动面（08 的产出）。
- 分步迁移方案：每步的移动清单、验收命令（09 的产出）。
- 包名与依赖声明清单（`@my-agent/*` 五个新 workspace + desktop 依赖改指 app）。

同批产出 **ADR 修订清单**：

- 新增一条分层 ADR（五模块、依赖倒置、端口归消费方声明、hold 下沉）。
- 修订 ADR-0012（createSessionAgent 自造 manager → 组合根注入）、ADR-0016（填充链归
  ContextManager）、ADR-0023（hold 迁往 infra）。
- `docs/architecture.md`、`AGENTS.md`（布局与术语）、`CONTEXT.md` 的重写点列表。

本 ticket 交付即图走完：spec 交给下一个 effort 执行。
