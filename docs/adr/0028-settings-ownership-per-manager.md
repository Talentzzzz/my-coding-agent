# 0028：设置归属按持有者拆散——每簇一个持有者、一份文件，`SettingManager` 退场

日期：2026-11-20 · 状态：已接受，已落地
取代：[0019](0019-settings-two-layers.md) 的**所有权半**（global 侧设置住进一只 `SettingManager`、
一份 `settings.json`）；0019 的**组合视图半**（`resolveSettings` 是唯一答案、每次现算、不留副本）
原样保留——变的只是它的输入来源

它满足 `docs/adr/README.md` 的三条：改回去要把五份文件合成一份 `settings.json`、把五个持有者
的读写重新收进一只类和一层存储抽象；下一个人读 `packages/core/src/` 会问「为什么没有
`setting-manager.ts` 而设置却处处有家」，而这一次答案是**故意的**——设置的归属归还给各自的
关注点，一只 manager 管所有 manager 的设置是 ADR-0019 留下的尾巴。放弃的是「所有 global 设置
共用一个文件、一条写路径」的聚合，换来的是每簇一个持有者、一份自己的文件——`tools.json` 上
的一次编辑不再牵连模型目录，模型目录的一次改名也不再路过工具设置。

## 背景

ADR-0019 把设置收拢成三个类型名与一只四法门面（`SettingManager`）。收拢解决了「三条解析链各答
一次」的问题，但所有权留下了尾巴：**一个 manager 管了所有 manager 的设置**——工具的默认集与
模式预设、会话的队列模式、模型的目录与默认行、窗口的外观，全都住在同一只类、同一份
`settings.json` 里。`setting-manager.ts` 由此背上两种不相关的职责：它是磁盘的唯一入口，也是
五簇互不相干的字段的合租房东。

它工作得很好，但代价随文件变大而显形：工具设置的一次读写要经过一个认识所有簇的类；模型目录
与 `ModelConfigStore` 被它私藏，而仓库里没有 `ModelManager` 存在；`retry` 的唯一消费者是编排层
自己的重试泵，却要经 `Settings.global` 透传；UI 的外观偏好既不关工具也不关会话，同样挤在
这份文件里。归属表上五簇五口人，住的是一间房。

## 决定

1. **归属表：每簇一个、且只有一个持有者，各有一份自己的文件。** 全部在 `<AGENT_HOME>` 下
   （沿用 `MY_AGENT_HOME` 解析）：

   | 簇 | 字段（原 `GlobalSettings`） | 持有者 | 文件 | 公开面 |
   | --- | --- | --- | --- | --- |
   | 工具 | `tools`（默认集）、`modes`、`approval`、`bash` | **ToolManager**（`tools/manager.ts`，在 ADR-0011 实例表之上增加） | `tools.json` | `toolDefaults()` / `applyToolDefaults(patch)` |
   | 会话 | `steeringMode`、`followUpMode` | **SessionManager**（`session/session-manager.ts`，在会话文件职责之上增加） | `sessions.json` | `sessionDefaults()` / `applySessionDefaults(patch)` |
   | 模型 | `models.json` 的行、`defaultModel`（原 `GlobalSettings.model`）、`defaultModelSeeded` | **ModelManager**（新建 `model-manager.ts`，吸收 `ModelConfigStore`） | `models.json` | `catalog()` / `replaceRows(rows)` / `defaultRef()` / `modelSettings()` / `applyModelSettings(patch)` |
   | UI | `appearance`、`hiddenDirectories`、`directoryNames` | **UiSettingsManager**（新建 `ui-settings.ts`） | `ui.json` | `uiSettings()` / `applyUiSettings(patch)` |
   | 引擎 | `retry` | **Agent 编排层**（`EngineSettings`，`engine-settings.ts`） | `engine.json` | 私有 `retrySettings()` / `applyRetry(patch)`——引擎簇不进公开门面，`SettingsPatch.retry` 经门面路由进这里 |

   旧 `settings.json` 只作迁移源（`config.ts` 的 `settingsPath` 为迁移保留），此后被忽略。
   四条归属要点：**bash 归工具**——超时配置的是 bash 工具的行为，`ToolRunContext` 已经把 bash
   超时递给工具执行，持有者合一后这条线更短；**默认模型归模型**——`defaultModelSeeded` 是模型
   目录的标记（窗口种起始行），与行同住 `models.json` 是它的本命；**retry 归引擎**——唯一消费
   者是编排层自己的重试泵，未来引擎级设置（压缩阈值等）落同一个文件；**`modes` 表归工具**——
   模式是「工具集 + 审批基线」的命名预设（ADR-0004），两半都是工具关注点，会话快照上的 `mode`
   指针不动（ADR-0018）。

   所有持有者同形：**无状态、每次现读**（ADR-0013 的既定模式），构造只收 `home`（默认
   `AGENT_HOME`，测试递临时目录），各持自己的 home、默认同源（`createSessionAgent()` 递
   `settingsHome` / `modelsHome`）。写路径三条语义与 ADR-0019 的 `applySettings` 逐条一致——
   写前重读文件（不持常驻袋）、只动被点名的字段、未知键原样保留——按持有者各自内联实现。
   `config.ts` 的处置：类型与规范化函数随簇搬进各持有者的文件；`AGENT_HOME`、`settingsPath`、
   `DEFAULT_GLOBAL_SETTINGS` 等留守。

2. **读时迁移，一次性：四张新文件按「文件级」，`models.json` 按「键级」。** 各持有者首次读取时
   执行：自己的文件**不存在**，且旧 `settings.json` **存在** → 用现有的规范化函数
   （`tools/manager.ts` 的 `bashOr` / `modesOr` 等各簇规范化器）从旧文件捡走自己的簇，写自己的
   文件；自己的文件已存在 → 旧文件被完全忽略；旧文件本身**永不删除、永不写入**——与 ADR-0019
   对旧项目层的处理同形，但这次用户数据先被保住再被忽略。边界情形：持有者的文件不存在但簇字段
   全缺省时**也写出自己的文件**（补默认后的视图落盘），把「迁移过」变成磁盘事实，避免删掉新
   文件后旧文件复活。
   `models.json` 是例外：它今天就存在（上面一直住着行），不能整文件一刀切。迁移按**键**裁决——
   `defaultModel` 与 `defaultModelSeeded` 各自检查：缺这个键、且旧 `settings.json` 带着对应字段
   （`model` / `defaultModelSeeded`）才捡走、原子写回；没有东西可捡时一个字节都不写。
   `defaultModelSeeded` 的 `false` 是**值**不是缺席——它是手编文件要求窗口重新种回内置默认行
   （`packages/web/src/default-model.ts`）的写法，迁移时原样搬运、不得变成缺失。

3. **无壳：字面删除。** `setting-manager.ts` 整个文件退场——类、`SettingManagerOptions`、
   `inMemorySettingManager`——不留任何统一设置门面或协调壳，设置的门就是各关注点自己的持有者。
   存储后端抽象（`SettingsStorage` / `FileSettingsStorage` / `InMemorySettingsStorage`）一并退场：
   每个持有者直接读写自己的文件（各约十几行），不共享抽象——共享抽象是又一个合租房东的雏形。
   测试接缝从内存后端换成临时 home：`CreateSessionAgentOptions.settingManager` 接缝退场，
   `settingsHome` / `modelsHome` 透传给各持有者——机器自己的文件靠边站的保证不变，且比内存后端
   更接近真实行为；各持有者各自可独立 smoke，ToolManager 的文件行为不再牵连模型目录。

4. **门面路由（ADR-0012 边界不动）：读模型按簇现读，补丁按簇分发。**
   - `Agent.settings()`：从五个持有者现读、组装一份 `GlobalSettings` 形状的视图——这是设置面板
     的读模型，**不是所有权壳**；各簇真实的家在各自的持有者与文件里。可选字段按「未设置」保持
     undefined，与五个文件各自的缺席规则一致。
   - `Agent.applySettings(patch)`：按字段名路由到拥有该字段的持有者（工具 → `applyToolDefaults`、
     UI → `applyUiSettings`、会话 → `applySessionDefaults`、模型 → `applyModelSettings`、retry →
     私有 `applyRetry`）。一次补丁跨簇时**逐簇分发，每簇独立原子落盘**——门面按簇分发而不是先
     组装再拆，正是为了保住「每簇原子」；各持有者的写路径只动被点名的字段，所以空簇是零次落盘。
   - `Agent.modelCatalog()` / `Agent.replaceModels()` 转发 ModelManager；`Agent.hiddenDirectories()`
     转发 UiSettingsManager。
   - 命名按代码既有形态：门面的读模型方法是 `Agent.settings()`——spec 文本写作的 `getSettings()`
     是 wire/api 层的叫法，实现沿用 master 既有的 `settings()`，wire 与 REST 面不受名字差异影响。
   - 结果：wire（`protocol.ts`）与 REST 面形状不变，`packages/server`、`packages/web` 零改动
     （smoke 的 home 传递随接缝微调除外）。

5. **组合视图保留，输入换窄（ADR-0019 的另一半原样）。** `resolveSettings` 仍是闸门、prompt、
   请求构建与快照共同的唯一答案，签名从 `resolveSettings(session, global, rows, known)` 改为
   `resolveSettings(session, toolDefaults, modelView, known)`——`toolDefaults` 是 ToolManager 的
   一次现读，`modelView` 是 `{ rows, defaultRef }`（ModelManager 的一次现读）。工具半、模型半、
   审批半的解析语义逐行不动。原来 `Settings.global` 原样透传的零散读取改为消费者直读持有者：
   bash（→ ToolManager）、retry（→ 编排层私有）、队列模式（→ SessionManager）——它们本来就是
   跨会话常量，不属于组合视图；`Settings` 视图的 `global` 透传字段删除。

## 后果

换来的：

- 每个设置簇有一个、且只有一个持有者与一份文件——`tools.json` 上的一次编辑不再牵连模型目录，
  各持有者各自可独立 smoke 与独立理解；`setting-manager.ts` 与存储抽象整体退场，没有需要
  「哪个簇归谁管」的口头知识。
- 旧 `settings.json` 的用户数据经一次性迁移被保住，之后被忽略——「迁移过」是磁盘事实。
- 工具、会话、模型、UI、引擎五条线的归属由文件名直接回答；门面只剩路由与组装两种职责。

背上的：

- 五份文件代替一份——设置面板的一次跨簇补丁（如今 server controller 只动单簇）落在多个文件上，
  跨簇原子性不复存在，逐簇原子由门面的分发方式保住。
- 写路径的三条语义（写前重读、只动点名字段、未知键保留）在五个持有者里各有一份内联实现，刻意
  不共享抽象——复制是买的保险，防止抽象层重新长成一只壳。

**已知耦合，写下来防止将来踩断**：`modes` 表的审批规范化依赖全局默认 `approval`——`modesOr`
用它补预设的缺键。拆分后该默认与 `modes` 表**同住工具簇**（同一份 `tools.json`、同一个
`tools/manager.ts`），规范化函数随数据同文件，语义不变。这是刻意为之的归属：把 `approval`
挪出工具簇（比如归给引擎或独立的审批持有者）会踩断模式规范化——动它之前先重读 ADR-0004。

**内联副本的已知分歧**：三条写纪律按持有者各自内联，副本之间有两处已知的真实分歧，记录在此，
不改行为：

- **空文件与缺文件的裁定各持有者不同。** `ModelManager` 对不是 JSON 对象的 `models.json`
  拒绝读取、从不覆盖——继承退场的 `SettingManager` 对 settings.json 的立场；其余四个持有者对
  **空文件**当空层读（trim 后为空串即空层）、对不是 JSON 对象的文件同样拒绝且从不覆盖。缺文件
  的语义也不同：四个文件级持有者把缺文件读作迁移的触发器，`models.json` 把它读作空目录（迁移
  按「键」走，没有东西可捡时一个字节都不写）。
- **两份 `mergeLayers`，一份跳 `undefined`、一份不跳。** `tools/manager.ts` 与
  `engine-settings.ts` 的副本在合并时跳过值为 `undefined` 的覆盖键——显式 undefined 不抹掉已有
  键；`ui-settings.ts` 的副本不跳——它的补丁字段先经「只动被点名的字段」过滤才进入合并，嵌套
  补丁里残留的 `undefined` 经 JSON 序列化自然消失、由读取半回落默认值。分歧在各自的调用点内
  自洽，冒烟各自钉住各自的行为；统一它们不是本 ADR 的事，动之前先读两边的冒烟。

**并发**：单进程内五个持有者各自迁移、互不碰对方的文件，无竞争；多进程同时跑（两个桌面实例）
可能出现重复迁移——写自己是原子的，最坏结果是旧文件的簇被同值写两次，无害。

## 被取代的是什么

ADR-0019 的**所有权半**：

- 决定 1 的 `GlobalSettings` 归属——「global 侧：唯一一份 `<AGENT_HOME>/settings.json` 补默认
  后的视图，`modes` 表、默认模型、外观、bash、重试与队列模式都在这里」——被本 ADR 的归属表
  取代：每簇有自己的持有者与文件，`GlobalSettings` 类型留守 `config.ts`，但只作门面读模型
  （`Agent.settings()`）与补丁（`SettingsPatch`）的形状，不再是磁盘视图。
- 决定 3 的「`SettingManager` 收敛为四法」——连它的四法一起退场；磁盘入口从一只类变成五份
  各自的读写。
- ADR-0019 「与其他 ADR 的关系」一节里「`SettingManager` 是设置与模型行唯一的门」的陈述随之
  作废；ADR-0004 的「`modes` 表在设置里」改读作「在工具簇里」（`tools.json`）。

## 没有被取代的

ADR-0019 的**组合视图半**，逐条成立：三个类型名里的 `SessionSettings` 与 `Settings` 原样；
`resolveSettings` 是唯一答案、每次现算的派生值、产物只活在调用栈上——变的只是输入来源（本
ADR 决定 5）。其余一切：删掉项目层（旧项目文件不迁移不删除）由本 ADR 的迁移规则继承并加强
（旧全局文件同样不删除不写入）；`model 解析到完整行`、占位行作答、apiKey 只骑在 `Model` 上
——原样；wire 类型改名（`GlobalSettingsSnapshot`）与 `ConfigPatch` / `SettingsPatch` /
`ModelSelection` 的形状——本 ADR 决定 4 明确不动。
