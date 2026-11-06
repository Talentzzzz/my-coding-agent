# 06 - ToolManager 名字冲突与 ADR / 文档处置

Type: grilling
Status: open

## Question

`ToolManager` 在本仓库已有含义且**相反**：ADR-0007 决定 1 把它列为五个「无属性单例」之一，
`.scratch/stateless-agent/issues/11` 的 Answer 把 `packages/core/src/tools/manager.ts` 称作
「ToolManager 的无状态面」。本图把它用于一个持有 Map 的服务，会反转：

- ADR-0006 的 B 路线（每请求现建、不驻留内存 / 「现建现传，不进任何袋」）；
- ADR-0007 决定 1/2（无聚合袋、无属性服务）与决定 6（进程级不可变配置留作构造注入的边界）；
- ADR-0011 决定 1/2 与「被放弃的选项」里的「注入一张表等于给表的写者与删者各留第二个」；
- ADR-0015 的单一 `Tool` / `Context.tools` 必填分界（取决于 03 号票的答案）；
- `AGENTS.md` 的 service / tool 词条、`docs/architecture.md` 的工具契约节
  （「没有插件注册表」「目录里没有常驻的工作目录」「活跃集合……不在任何一处持有」）。

请裁决：

- **(a)** 另起新名避免撞车（`ToolCatalog` / `ToolSet` 之类），「ToolManager」维持历史含义。
- **(b)** 沿用 `ToolManager`（定案 1 不改），新开一条 ADR 明确「本构建重新引入持有实例表的工具服务」，
  在 0006 / 0007 / 0011 / 0015 头部加取代者指针、正文原文保留并就地标 Superseded；
  `AGENTS.md` / `architecture.md` 逐句改写，`docs/adr/README.md` 清单加行。
- **(c)** 沿用名字，但把历史 ADR 正文一并改写成新形状——注意这违反 `docs/adr/README.md`
  的「编号只增不改，新开一条取代」。

并定文档收账归哪张执行票（AGENTS.md、architecture.md、ADR README 清单、README.md 布局、
`docs/notes.md` 的结论清单是否要加一笔）。

➡️ 推荐 **(b)**：名字是用户定案，不改；ADR「只增不改」是仓库硬规则，历史正文保留、加取代指针。
新 ADR 必须写清「为什么明知 0007 / 0011 仍要反转」（终点是「一张常驻实例表 + 全量改道」，
代价是重新承担对象生命周期与失效归属），否则未来读者看不懂这次反向。
