# 0019：设置三层——GlobalSettings、SessionSettings 与每次现算的 Settings

日期：2026-11-15 · 状态：已接受，已落地

## 背景

「设置」在代码里是一组碎片：`Settings`（config.ts）是全局与项目两份 `settings.json` 合并后的视图，
`SessionSetting`（ledger.ts）是会话 `.json` 快照里选择字段的重组，而「这个会话此刻处于什么配置」
由三条互不相干的解析链各自回答——`toolStateOf`（工具集与审批基线，session/tool-config.ts）、
`approvalsOf` 的合成（agent.ts 内联）、`modelChoiceOf` + `modelFor`（session/model-choice.ts）。
没有一份「组合后的设置」给下游函数用，每条链都自带一次设置门读取与自己的回落规则。

同时，两份设置文件里那份项目级的 `<workDir>/.my-agent/settings.json` 从未被任何 UI 或文档之外的
流程真正拥有过：它加了一整层「字段写往声明它的那层」的路由逻辑（`SettingsScope`、`scopeOf`、
双 `declared` 集合），而窗口对 `/api/settings` 的每次读写都落在全局文件上。

## 决定

1. **三个类型名，各管一层**：
   - **`GlobalSettings`**（config.ts，原 `Settings`）——global 侧：唯一一份
     `<AGENT_HOME>/settings.json` 补默认后的视图。持有 `modes` 表（模式 → 工具集 + 审批基线）、
     默认模型、外观、bash、重试与队列模式。
   - **`SessionSettings`**（ledger.ts，原 `SessionSetting`；`Session` 上的字段随之从
     `sessionSetting` 改名 `settings`）——会话侧：会话 `.json` 快照的设置半，只持有**选择**：
     模式指针 `mode?`、审批增量 `approval?`、模型 `{ name, modelId, thinkingLevel? }`。它不持有
     工具集、不持有完整模型行——那些从 global 侧按指针与名字现查。
   - **`Settings`**（新文件 `packages/core/src/settings.ts`）——两半组合出的**有效视图**，就是
     「后续函数要用的」那一份：`tools`（指针 → `modes` 表解析出的活跃集，收窄到本构建认识）、
     `approval`（基线叠会话增量）、`mode`（座位）、`model: { config: ModelConfig; thinkingLevel? }`
     （按选择从目录现查的**完整行**）、以及原样透传的 `global`。
2. **组合是纯函数、每次现算的派生值**。`resolveSettings(session, global, rows, known, chosen?)`
   是唯一答案：输入由调用方现取（设置门的一次新读、`modelCatalog()` 的一次现查、重放出的袋、
   表上现读的工具名），产物只活在调用栈上——一次运行、一次请求、一次快照、一次审批读取各算各的，
   从不进 `AgentState`/`live`、从不落盘。这与 ADR-0013 的「每次现读、不留副本」同构，正是它把
   曾经三条解析链的语义原样收拢：工具半（`fillTools` + `toolStateOf` + `modeSeatOf`）、模型半
   （`modelChoiceOf` 的回落链：记录的选择 → `chosen` → 设置的默认 → 内置默认行 → 第一行，模型以
   分支最后一条 assistant 消息作弱回落）、审批半（全局默认/预设基线叠增量）。
3. **删掉项目层**。`<workDir>/.my-agent/settings.json` 不再被读或写；`SettingsScope`、
   `projectSettingsPath`、双层 `mergeLayers` 读取与「写到声明该字段的那层」的路由整体退场，
   `SettingManager` 收敛为四法（`getSettings()` / `applySettings(patch)` / `modelCatalog()` /
   `replaceModels()`），所有读取方法丢掉 `workDirAbsPath` 首参。磁盘上已存在的旧项目文件**不迁移
   不删除**——只是被忽略；`.my-agent/` 目录本身仍归 tool-results 归档使用。
4. **model 解析到完整行**。组合的 `Settings.model.config` 是 `ModelConfig`（含端点、窗口、compat），
   引擎在请求时刻 `createModel(config, level, transport)` 构造模型——apiKey 只骑在一次请求所用的
   `Model` 上，从不进入任何视图或快照。无行应答的选择以占位行的事实作答（`rowOrPlaceholder`，
   从 `modelFor` 抽出），拒绝发送的是传输层——这条行为原样保留。
5. **wire 类型改名跟随**。`SettingsSnapshot` → `GlobalSettingsSnapshot`（JSON 字段不变）；会话侧
   的 wire（`SessionSnapshot.mode` / `model` / `thinkingLevel`、`ConfigPatch`、`ModelSelection`）
   形状不动——会话的选择本来就只带指针与名字。

## 后果

换来的：

- 「这个会话此刻处于什么配置」有了唯一答案，闸门、prompt、请求构建、快照从同一份作答，不再各有
  自己的一次设置读取与一套回落规则。
- `SettingManager` 从十四个方法收到四个；两层文件路由（scope 判定、declared 集合、双层持久化）
  整体删除。
- `session/tool-config.ts` 与 `session/model-choice.ts` 两个文件退场，解析语义集中在
  `settings.ts` 一处可测的纯函数里。

背上的：

- **项目级设置是一次能力删除**：一份 checkout 无法再携带自己的审批与限额。已被忽略的旧文件留在
  磁盘上成为死数据，需要手工清理。
- 所有设置读取多了一次参数收敛的仪式（窄 getter 消失后读整份 `GlobalSettings`），以及
  `resolveSettings` 每次现算的成本——一次小文件的读取加几次数组扫描，与此前 `toolStateOf`
  每次现读同级。

## 与其他 ADR 的关系

- **ADR-0013**（表只装 live 半）：组合视图不是袋——它按调用栈生灭，这正是「每次现算」的又一处
  应用；`live.openedOn` 曾是唯一无处可派生的值、作为 `chosen` 进入回落链（已随
  [0021](0021-lazy-session-identity.md) 删除，回落链减为「文件记录的选择 → 设置默认行」）。
- **ADR-0018**（会话存模式指针）：决定 1 原样成立，`SessionSettings` 就是它的持有者；解析半从
  `toolStateOf` 搬进 `resolveSettings`。
- **ADR-0004**（模式是设置里的预设）：`modes` 表仍在 `GlobalSettings` 上，「默认」仍是活视图，
  名字仍是身份。
- **ADR-0008**（会话两文件）：磁盘格式不变——快照仍只存选择与指针，`SessionSettings` 只是它的
  内存重组形状改了名。
