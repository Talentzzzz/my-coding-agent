# 撰写 spec 与 ADR 修订清单

Type: task
Status: resolved
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

## Answer

交付 [.scratch/layered-modules/spec.md](../spec.md)，票面六项全齐：

- 目标结构：§1（五包目录树、一句话职责表、依赖图）。
- 端口清单：§4（SessionRepository 11 方法逐条给出今天的对应物——07 的「名字暂定」机械核对
  完毕；三个 home JSON 端口；ToolResultsRepository 只写；hold 契约三条）。
- ContextManager 设计：§3（06 全量收录）。
- app 组合根与启动面：§5（start/StartOptions/BootedServer、端口翻译表、工厂与 HubOptions
  翻面、desktop、serve.ts、随层落位）。
- 分步迁移方案：§7（六步、每步文件级移动清单 + import 重指面 + 验收命令；12 文件 13 处
  setSessionsDir 的改形分类表）。
- 包名与依赖声明清单：§1.4（五 workspace 依赖表、子路径导出表）+ §1.5（tsconfig /
  workspaces / install-deps 的加减时机）。

ADR 修订清单：§8——新增 ADR-0030（分层五要点 + 四子包共享内核一节）；修订 ADR-0012 /
0016 / 0023 / 0006 / 0010 / 0028；architecture.md（7 点）、AGENTS.md（4 点）、CONTEXT.md
（2 点）的重写点列表。落笔时机按 09 分摊到步 4/5/6。

本票按授权做的机械定案（均有记录）：protocol 信封住 case（§2.4，trigger 域盲的推论）、
共享内核精确名单（§2.3）、守卫名 `scripts/check-layering.ts`（§6）、`BootOptions`→
`StartOptions` / `bootServer`→`start`（§5.1）、`./tool` 导出名跟随目录改名（§1.4）、
trigger 的依赖声明只有 case（§1.3 的机械细化）。
