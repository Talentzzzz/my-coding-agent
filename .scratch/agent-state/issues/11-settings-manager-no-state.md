# 11：SettingsManager 去 state

Type: task
Status: open
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
