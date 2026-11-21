# Map：设置归属重构——拆散 SettingManager

Label: wayfinder:map

## Destination

一份 spec：`SettingManager` 整体退场（无壳残留），global 设置按关注点拆给各自的持有者——
ToolManager、SessionManager、新建 ModelManager、一个最小的 UI 持有者、编排层自身——
wire 与 REST 面不变。spec 已产出：[spec.md](spec.md)。

## Notes

- 领域：my-coding-agent 的 core 设置架构。动手前先读
  [ADR-0019](../../docs/adr/0019-settings-two-layers.md)（被本 effort 取代）与
  `docs/architecture.md` 的设置节。
- 相关 ADR：0004（模式是设置里的预设）、0011（ToolManager 实例表）、0012（server 只认编排
  门面）、0013（每次现读、不留副本）、0021（会话随第一条消息出生）。
- 重大决策（Q1–Q6）在制图会话经 grilling 与用户逐条对齐；余下细节（07、08）由用户显式委托给
  推荐案。实施本身不在本图内：目的地是 spec，不是代码变更。

## Decisions so far

- [无壳全删](issues/01-literal-deletion.md)：`SettingManager` 类与文件整体退场，存储抽象
  一并删除，测试改走 home 接缝。
- [UI 簇独立持有](issues/02-ui-cluster-owner.md)：appearance、hiddenDirectories、
  directoryNames 归一个最小的新持有者（`ui.json`），不并入工具或会话。
- [模型目录归新建 ModelManager](issues/03-model-manager.md)：models.json、默认模型 ref、
  defaultModelSeeded 归新建的 ModelManager，ModelConfigStore 被吸收。
- [每持有者一份文件 + 读时迁移](issues/04-files-and-migration.md)：五个文件各归其主；旧
  settings.json 只作一次性迁移源，此后被忽略、不删不写。
- [resolveSettings 保留](issues/05-composite-view-kept.md)：组合视图不动摇，只换输入来源。
- [范围仅设置拆分](issues/06-scope.md)：其他 manager 的重构另立 effort。
- [wire 与 REST 面不变](issues/07-wire-face-unchanged.md)：协议形状与 Agent 门面动词不变，
  server / web 零改动。
- [retry 归编排层](issues/08-retry-engine-owned.md)：RetrySettings 落 `engine.json`，由
  Agent 编排层自己持有。

## Not yet specified

（无——决策已全部落进 spec；实施顺序与切分归实施者。）

## Out of scope

- ToolManager / SessionManager 自身形态的其他重构：另立 effort（见 06）。
- 代码实施：目的地是 spec，实施在 spec 评审通过后另起。
