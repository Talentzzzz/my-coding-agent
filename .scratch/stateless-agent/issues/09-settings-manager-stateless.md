# 09:SettingsManager 无状态化——SettingsState 每工作区共享

Type: task
Status: resolved
Blocked by: 07

## Question

把 `packages/core/src/settings-manager.ts` 改造为无状态单例 + 纯数据状态:

- 拆出 `SettingsState`:`{ storage, layers, declared, settings }`(对应现有
  `settings-manager.ts:144-151` 的四个私有字段)。
- 粒度是**每工作区一份**(现状 hub 按 `absWorkspaceRoot` 缓存
  `Map<string, SettingsManager>`,hub.ts:169/227-230):hub 改为缓存
  `Map<string, SettingsState>`,单例不再自带缓存。
- 读写路径语义保持:合并视图、`declared` 决定「变更写回提供该字段的那一份」、
  `getApprovals` / `modes` 表 / 会话级覆盖的合并点。
- 提供 `fillSettings`(种子=工作区根路径,读两份 json 补齐整袋),供编排层
  首次装配与设置变更后的重灌调用。
- `npm run check` + 相关 smoke 通过;调用方适配留到票 14/16。

## Answer

已落,完全照票 08 的形状:

- 拆出 `SettingsState`:`{ storage, layers, declared, settings }`,四私有字段原样
  对应;`storage` 按票面留在状态里(注入的后端,`persist` 重读要用)。
- 全部操作改为首参收状态的文件级函数:`getSettings` / `getModel` / `getTools` /
  `getAppearance` / `getHiddenWorkspaces` / `getWorkspaceNames` / `getApprovals` /
  `isApprovalRequired` / `getSteeringMode` / `getFollowUpMode` / `getRetrySettings` /
  `getBashSettings` / `applySettings`;`persist` / `refresh` / `scopeOf` 收成模块内
  私有函数。读写语义零改动。
- 三个入口:`fillSettings(absCwd, agentDir?)`(种子=工作区根路径,读两份 json
  补齐整袋)、`settingsStateFromStorage(storage)`(自备后端)、
  `inMemorySettingsState(settings?, scope?)`(测试)。
- `SettingsManager` 收成一行委托的薄壳门面(`create` / `fromStorage` / `inMemory`
  三个静态保留),调用方零改动;hub 改缓存 `Map<string, SettingsState>` 留给票 16,
  编排层改传状态留给票 14。
- core index 导出无状态面;smoke-settings 补「无状态面」一节:fill→patch→重灌
  同视图、无状态写/门面读互通、自备存储注入。
- `npm run check` 通过;smoke-settings / smoke-tools / smoke-sessions / smoke-api /
  smoke-mux / smoke-approval(±endpoint)/ smoke-modes / smoke-boot / smoke-models /
  smoke-model-form 全过。smoke-sidebar(2 处)与 smoke-session(27 处)的失败在
  干净树上同样存在,与本票无关,系既有欠账。
