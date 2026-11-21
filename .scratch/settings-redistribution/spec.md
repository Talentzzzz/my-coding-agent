# Spec：设置归属重构——拆散 SettingManager

状态：待评审 · 制图会话产出 · 决策依据见 [map.md](map.md) 及其八张已关决策票

## 0. 一句话

`SettingManager` 整体退场，global 侧设置按关注点拆给五个各自的持有者（ToolManager、
SessionManager、新建 ModelManager、一个最小的 UI 持有者、编排层自身），每个持有者一份自己的
文件 + 一次性读时迁移，wire 与 REST 面不变。

## 1. 背景与动机

ADR-0019 把设置收拢成三个类型名与一只四法门面（`SettingManager`）。收拢解决了「三条解析链各答
一次」的问题，但所有权留下了尾巴：**一个 manager 管了所有 manager 的设置**——工具的默认集与
模式预设、会话的队列模式、模型的目录与默认行、窗口的外观，全都住在同一只类、同一份
`settings.json` 里。本次重构把所有权归还给各自的关注点：工具设置归 ToolManager，会话设置归
SessionManager，模型归一个新的 ModelManager，以此类推。ADR-0019 的另外两个成果——
`resolveSettings` 组合视图与「每次现读、不留副本」——原样保留。

## 2. 目标与非目标

**目标**

1. `setting-manager.ts` 整体退场：类、`SettingManagerOptions`、`inMemorySettingManager`、
   存储后端抽象（`SettingsStorage` 及两个实现）。无统一设置门面残留。
2. 每个设置簇有一个、且只有一个持有者；持有者各有一份自己的文件。
3. 旧 `settings.json` 的用户数据经一次性读时迁移被保住，之后被忽略。
4. wire（`protocol.ts`）与 REST 面形状不变；`packages/server`、`packages/web` 零改动
   （smoke 的 home 传递随接缝微调除外）。
5. 新 ADR 取代 ADR-0019；受影响的术语索引（AGENTS.md）同步。

**非目标**

- ToolManager / SessionManager 自身形态的其他改造（实例表 ADR-0011、持有簿记 ADR-0023 等）。
- 会话 `.json` 快照的磁盘格式与 `SessionSettings` 的形状（ADR-0008/0018 不动）。
- 设置面板（web）的任何 UI 变更。
- 项目级设置（`<workDir>/.my-agent/settings.json`）的恢复——那是 ADR-0019 删掉的能力，本次
  不回头。

## 3. 归属表

| 簇 | 字段（原 `GlobalSettings`） | 持有者 | 文件 |
| --- | --- | --- | --- |
| 工具 | `tools`（默认集）、`modes`、`approval`、`bash` | **ToolManager** | `tools.json` |
| 会话 | `steeringMode`、`followUpMode` | **SessionManager** | `sessions.json` |
| 模型 | `models.json` 的行、`model`（默认 ref）、`defaultModelSeeded` | **ModelManager**（新建） | `models.json` |
| UI | `appearance`、`hiddenDirectories`、`directoryNames` | **UI 持有者**（新建，暂名 `UiSettingsManager`） | `ui.json` |
| 引擎 | `retry` | **Agent 编排层** | `engine.json` |
| —— | （旧文件全部字段） | —— | `settings.json` 只作迁移源 |

要点：

- **bash 归工具**：超时配置的是 bash 工具的行为，`ToolRunContext` 已经把 bash 超时递给工具执行
  （`tools/types.ts`），持有者合一后这条线更短。
- **默认模型归模型**：`defaultModelSeeded` 是模型目录的标记（窗口种起始行），与行同住
  `models.json` 是它的本命。
- **retry 归引擎**：唯一消费者是编排层自己的重试泵；未来引擎级设置（压缩阈值等）落同一个文件。
- **`modes` 表归工具**：模式是「工具集 + 审批基线」的命名预设（ADR-0004），两半都是工具关注点。
  会话快照上的 `mode` 指针不动。

## 4. 磁盘布局与迁移

### 4.1 文件位置

全部在 `<AGENT_HOME>` 下（沿用 `MY_AGENT_HOME` 解析）。`models.json` 的格式不变：仍是
`{ models: [...] }` 包裹对象，新增两个可选键 `defaultModel?: string` 与
`defaultModelSeeded?: boolean`——旧文件缺键即「未设置」，天然向后兼容。其余四个是新文件，
各自形状就是自己簇的对象（如 `tools.json` 为 `{ tools?, modes?, approval?, bash? }`）。

### 4.2 读时迁移（一次性）

各持有者首次读取时执行：

1. 自己的文件**不存在**，且旧 `settings.json` **存在** → 用现有的规范化函数
   （`mergeSettings` 拆出的各簇规范化器）从旧文件捡走自己的簇，写自己的文件；
2. 自己的文件已存在 → 旧文件被完全忽略；
3. 旧文件本身**永不删除、永不写入**——与 ADR-0019 对旧项目层的处理同形。

边界情形：持有者「文件不存在但簇字段全缺省」时也写出自己的文件（补默认后的视图落盘），把
「迁移过」变成磁盘事实，避免旧文件复活。`defaultModelSeeded` 特殊：`false` 是手编文件要求
重新种回的写法，迁移时原样搬运、不得变成缺失。

### 4.3 写路径

写入只落在各持有者自己的文件上。写前重读文件（不持常驻袋）、只动被点名的字段、未知键原样
保留——这三条是今天 `SettingManager.applySettings` 的行为，按持有者各自复制实现（每个十几行，
不共享抽象）。

## 5. 各持有者的公开面

全部同形：**无状态、每次现读**（ADR-0013 的既定模式），构造只收 `home`（默认 `AGENT_HOME`，
测试递临时目录），文件读写直接内联、不引入存储抽象。

- **ToolManager**（`tools/manager.ts`，在 ADR-0011 实例表之上增加）：
  `toolDefaults()` → `{ tools?, modes?, approval, bash }`；`applyToolDefaults(patch)`。
- **SessionManager**（`session/session-manager.ts`，在会话文件职责之上增加）：
  `sessionDefaults()` → `{ steeringMode, followUpMode }`；`applySessionDefaults(patch)`。
- **ModelManager**（新 `model-manager.ts`，吸收 `ModelConfigStore`）：
  `catalog()` / `replaceRows(rows)` / `defaultRef()` / `applyModelSettings({ model?,
  defaultModelSeeded? })`。
- **UI 持有者**（新文件，暂名 `ui-settings.ts`）：`uiSettings()` / `applyUiSettings(patch)`；
  外观规范化纯函数（`clampFontSize` 等）随类型搬入。
- **Agent 编排层**：私有 `retrySettings()` / `applyRetry(patch)`——引擎簇不进公开门面，
  server 无需看见它（`SettingsPatch.retry` 经门面路由进这里）。

`config.ts` 的处置：类型与规范化函数随簇搬进各持有者的文件；`AGENT_HOME`、`settingsPath`
（改为供迁移读取旧文件）、`DEFAULT_*` 常量留在 `config.ts`。

## 6. 组合视图与消费者

- **`resolveSettings` 保留**（决策 05）：签名从
  `resolveSettings(session, global, rows, known)` 改为
  `resolveSettings(session, toolDefaults, modelView, known)`——`toolDefaults` 是
  ToolManager 的一次现读，`modelView` 是 `{ rows, defaultRef }`。工具半、模型半、审批半的
  解析语义逐行不动。`Settings` 视图删掉 `global` 透传字段。
- **零散读取改为直读持有者**：今天经 `Settings.global` 透传的 bash（→ ToolManager）、retry
  （→ 编排层私有）、队列模式（→ SessionManager）各自直读。消费者都在编排层与引擎内部，
  无越界。
- **`Agent` 门面**（ADR-0012 边界不动）：
  - `getSettings()`：从五个持有者现读、组装一份 `GlobalSettings` 形状的视图——设置面板的
    读模型，不是所有权壳；
  - `applySettings(patch)`：按字段名路由到拥有该字段的持有者（一次补丁跨簇时逐簇分发，
    每簇独立原子落盘）；
  - `modelCatalog()` / `replaceModels()`：转发 ModelManager；
  - `hiddenDirectories` 相关：转发 UI 持有者。

## 7. wire 与 REST 面

- `protocol.ts` 形状不动：`GlobalSettingsSnapshot`、`ConfigPatch`、`SettingsPatch`、
  `ModelSelection`、`GlobalSettingsSnapshot` 的 JSON 字段全保留。
- `/api/settings` GET 与补丁端点不拆；`createRoutes()` 一行不改。
- `packages/server`、`packages/web` 零改动。

## 8. 测试接缝

- `CreateSessionAgentOptions.settingManager` 接缝退场；`settingsHome` / `modelsHome` 透传给
  各持有者（各持自己的 home，默认同源）。smoke 的「内存设置」改为递临时目录——机器自己的文件
  靠边站的保证不变，且比内存后端更接近真实行为。
- 各持有者各自可独立 smoke：ToolManager 的文件行为不再牵连模型目录。
- `inMemorySettingManager` 的现有调用点逐个改为临时 home 或直接构造持有者。

## 9. 文件级影响清单（core）

| 动作 | 文件 |
| --- | --- |
| 删除 | `setting-manager.ts` |
| 新建 | `model-manager.ts`、`ui-settings.ts`、`engine-settings`（可并入 `agent.ts` 或独立小文件） |
| 增改 | `tools/manager.ts`（+toolDefaults 面、`tools.json`）、`session/session-manager.ts`（+sessionDefaults 面、`sessions.json`）、`models.ts`（ModelConfigStore 吸收、`models.json` 可选键） |
| 改 | `settings.ts`（签名换输入、删 `global` 透传）、`config.ts`（类型与规范化器随簇搬迁）、`agent.ts`（依赖表换持有者、补丁路由、retry 私有面）、`assembly.ts`、`session-factory.ts`（构造与接缝） |
| 不动 | `protocol.ts`、会话快照格式、`packages/server`、`packages/web` |

## 10. ADR 与文档

- 新 ADR（`docs/adr/00NN-settings-ownership-per-manager.md`）：取代 ADR-0019 的所有权半，
  保留其组合视图半；记录归属表、迁移规则与「无壳」裁定。
- ADR-0019 状态行改为「已被 00NN 取代（所有权半）」。
- `AGENTS.md` 的 settings 术语条目与 `docs/architecture.md` 设置节同步改写。

## 11. 风险与开放点

1. **UI 持有者的名字与落位**（暂名 `UiSettingsManager`，core 内）：若评审时认为「UI 设置归
   宿主」更诚实，可平移到 server 包，core 只导出类型与规范化函数——wire 不变，影响面是
   `Agent` 门面的 appearance 相关转发改为宿主应答。实施前定稿即可。
2. **迁移的并发**：单进程内五个持有者各自迁移，互不碰对方的文件，无竞争；多进程同时跑（两个
   桌面实例）可能出现重复迁移——写自己是原子的，最坏结果是旧文件的簇被写两次同值，无害。
3. **`applySettings` 跨簇补丁的原子性**：逐簇独立落盘意味着跨簇补丁不再单文件原子。现有调用
   点（server controllers）每次只动一个簇，此风险当前为零；spec 要求门面按簇分发而不是先组装
   再拆，正是为了保住「每簇原子」。
4. **`modes` 表的审批规范化**依赖全局默认 `approval`（`modesOr` 用它补缺键）——拆分后该默认
   在 ToolManager 的 `tools.json` 里，规范化函数随之同文件，语义不变，但两个簇在同一持有者
   内的耦合要写进 ADR，防止将来把 `approval` 从工具簇挪走时踩断模式规范化。
