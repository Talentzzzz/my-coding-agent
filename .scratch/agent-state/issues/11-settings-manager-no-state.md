# 11：SettingsManager 去 state

Type: task
Status: resolved
Blocked by: 05, 08

## Question

删掉 `private readonly states = new Map<string, SettingsState>()`（`settings-manager.ts:423`）与 `stateOf`，
`SettingsManager` 缩成一行委托的薄壳或直接消失（若没有别的公开方法，就让 `fillSettings` 裸奔——由仓库现有
「薄壳门面收调用方零改动」的惯例判断，见 ADR-0006 的 08/09 票先例）。

- `SessionHub.settingsStateOf(workDir)`（`hub.ts:301`）改成 `fillSettings(workDir, this.options.settingsHome)`
  一次；每次 open 一份新袋。
- `ensureSession` 的 `options.settingsState` 语义保持「调用方可以塞一份自己的」；不塞就 fill。**顺序**改成
  会话先、设置后（07 票的链）。
- `applySettings` 的写回语义不变（它本来收 state）。05 号票定了「只改当前会话的袋」，本票只需在注释里写清
  「其余会话下次打开时看到」。
- 相关：`hub.settingsStateOf` 的调用点（`listsDirectory`、`sessionOptions`、`snapshotOf` 冷读）逐个改。
- 收账：`npm run check` 绿；`node scripts/smoke-settings.ts`、`node scripts/smoke-modes.ts`、
  `node scripts/smoke-approval.ts` 绿。

## Answer

### 结论（一句话）

类整个消失：`states` 缓存、`stateOf` 与 `SettingsManager` 一并删除、不留壳（类除 `stateOf` 外没有别的公开方法，
`fillSettings` 裸奔回唯一入口，`index.ts` 导出随之移除）；hub 的 `settingsStateOf` 缩成一行
`fillSettings(workDir, this.options.settingsHome)` 的门面、每次调用一份新袋——门面留下是因为
`settingsHome` 是 hub 的私有选项，controller 五处调用因此零改动；`options.settingsState ?? fillSettings(workDir)`
保住「调用方可塞自己的袋」，装配链仍是会话先、设置后；`applySettings` 函数体零改动，注释写死 05 号票那句话；
`check` 与 smoke-settings / smoke-modes / smoke-approval（外加 sessions / session / tools / models /
projection / 两个 approval-recovery·queue / mux）全绿。

### 落地形状

- **settings-manager.ts**：`SettingsManager` 类连同整段 doc 删除；`SettingsState` 的 doc 重写为快照语义
  （每次 open 各 fill 一份、两只袋不再共享、盘是共享的真相）；`applySettings` doc 补上「设置是打开时读到的
  一份快照；一次写入只作用于当前会话，其余会话下次打开时看到」。
- **session-factory.ts**：`OpenAgentOptions.settingsManager` 选项删除（fallback 直灌
  `fillSettings(workDirAbsPath)`，agent home 用默认值——与旧 `stateOf` 的缺省一致）；`settingsState` 的 doc
  改写；hub 在 `sessionOptions` 里显式传袋，所以生产路径不受缺省 home 影响。
- **hub.ts**：`settings` 字段删除；`settingsStateOf` 一行门面，doc 写明「Nothing is cached behind it —
  each open fills its own bag」；`sessionOptions` 删 `settingsManager` 行；`pending` 与 `listsDirectory` 两处
  提到已删缓存的注释顺带改写。
- **config.ts**：三处提到 `SettingsManager` 的注释换成 `fillSettings` / settings operations 的措辞（文档
  architecture.md / AGENTS.md 的更新仍归 14 号票）。
- **smoke-settings.ts**：第 5 节按新语义重写（原节名「服务缓存共享同一引用」→「每次 fill 一份新袋」）——
  「同一引用」断言删，换成：另一只袋保持自己打开时的快照（写入不扇出）、重灌读回写盘的模型、另一个 agent
  home 读不到这只家的合并（按**值**断言，比旧版按引用的 `!==` 更实）。storage 注入断言保留。

### 验证

- `npm run check` 绿（core / server / web tsc + token 审计）。
- smoke-settings / smoke-modes / smoke-approval 全绿；smoke-sessions / smoke-session / smoke-tools /
  smoke-models / smoke-projection / smoke-approval-recovery / smoke-approval-queue / smoke-mux 全绿
  （session-factory 与 hub 都被本票碰到，多跑一档）。

### code-review 记录

两轴跑完：Spec 轴零缺失、零蔓延、零实质错误；Standards 轴一处硬违规、三处 judgement call。

- **硬违规（已修）**：smoke 新注释里混入了中文那句票面原文——「源码注释用英文」是硬约定，已改回英文
  （settings-manager.ts 的 `applySettings` doc 里保留英文版同一句话）。
- **已修**：smoke 两处 `fillSettings` 在 check 的 message 参数里重复内联，落成局部变量 `reread` / `other`。
- judgement call（不动）：`settingsStateOf` 是一行 Middle Man——它向全部调用方隐藏 `settingsHome` 的知识，
  删掉它每处调用都得知道全局文件在哪，留；名字不改（controller 五处调用零改动值这个价钱，doc 已澄清
  fresh-fill 语义）；快照语义的解释散在 4 处注释里——settings-manager.ts 是权威一处，其余是单行指针，
  收敛反而要把语义藏远。
