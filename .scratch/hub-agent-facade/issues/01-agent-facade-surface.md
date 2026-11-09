# 01 Agent 公开面清单与签名

Type: grilling
Status: closed

## Question

把 hub、controllers、projection 现在触碰 Manager / `agentState().session.*` 的每一个调用点列全
（见 map Notes 里已定的三类），为每个点决定它落到 Agent 的哪个新方法上，并定下方法签名。

要覆盖的现存调用点（不完全清单，需逐一对账）：

- hub.ts：`userModels`（`modelCatalog`）、`setModelConfigs`（`replaceModels`）、`listsDirectory`
  （`getHiddenDirectories`）、`snapshotOf` 的 cold 分支（`sessions.open` + `readSessionSnapshot`）、
  `has`（`findSessionFilePathById`）、`fork`（`forkFrom` + `sessionFileAbsPath`）、`rename`
  （cold `open` + `setTitle`）、`remove`（`sessions.remove` + `snapshot.submitting`）、
  `timestampOf`（`sessionEntryMapById`）、`open` / `createUnpersisted`（`createSession` +
  `sessionSetting.workDirAbsPath`）。
- controllers/sessions.ts：约 10 处 `hub.settings.…`（`applySettings` / `getHiddenDirectories` /
  `modelCatalog`）。
- projection.ts:178：`hub.agent.sessionManager` + `agentState().session`。

问题包括（不限于）：

1. 三类方法各自的确切名字与签名；held / cold 两路在 Agent 内部统一还是分成两个方法？
2. cold 路径进 Agent 后，「一冷写一次同步块」的安全性和「读不留痕」（no claim、不进 hosts）由谁
   保证——Agent 方法的契约怎么写？
3. `readSessionSnapshot` / `sessionOptions` 这对构建安置在哪？
4. 窄状态读方法的返回类型：纯数据还是允许暴露状态对象（与 map 的 fog 第三条联动）？

## Answer

对账后全部调用点落实（比票里列的多三类：扫描类静态方法、`hub.tools` 无消费者、
`settingsOf` 的源），六问均按推荐答案收账。

### ① 会话生命周期（held/cold 两路在 Agent 内部统一，调用点不再写分支）

| 新方法 | 签名 | 替代的调用点 |
|---|---|---|
| `exists` | `(id: string): boolean` | hub.`has` 的 `\|\|` 右半；现有 `has`（表内）语义不动 |
| `snapshotOf` | `async (id: string): Promise<SessionSnapshot>` | hub.`snapshotOf` 变一行转发（held 走表、cold 走 open + readSessionSnapshot） |
| `setTitle` | `(id: string, title: string): void` | hub.`rename` 的 held/cold 三行分支 |
| `forkFrom` | `(sourceId: string, entryId: string \| null): string`（同步，返回新 id） | hub.`fork` 的源路径解析（held bag / 磁盘扫描两路）+ `forkFrom`；`current` / `announceHost` 留在 hub |
| `create` | `async (workDirAbsPath: string, pinned?): Promise<string>` | hub.`createUnpersisted`（`createSession` + open）；返回 id 而非 state |
| `adoptFromDisk` | `async (id: string): Promise<string>` | hub.`adoptFromDisk`；hub 随后经 `workDirOf` 现取目录 |
| `removeFromDisk` | `async (id: string): Promise<void>`（未知 id 抛错，404 语义不变）＋ `isOnDisk(id): boolean` | hub.`remove` 的 onDisk 判断与 `sessions.remove` |

命名裁定：`snapshotOf` 与 fanout 的 `snapshotOf(state, services)` 同名不同模块，可接受；
`adoptFromDisk` 返回 `id`（hub 多一次 `workDirOf` 现取），不造返回袋。

### ② 窄状态读（全部 held-only、纯数据，状态对象不出 core）

- `workDirOf(id): string | undefined`、`fileAbsPathOf(id): string | undefined`、
  `isSubmitting(id): boolean`（map 已列的三个）
- `timestampOf(id, entryId): number | undefined`——统一 hub 帧与 projection 两种读法，
  规则取 scan 的顺序（`message.timestamp` 优先，缺失回落 entry 时间戳）。
  **微变更**：hub 的帧对「有 entry 时间戳但无 message 时间戳」的消息现在带数字而不是
  undefined；客户端本就两种都处理。
- `titleOf(id): string`（map 没列，projection 两处 `getTitle` 需要）

返回类型策略：**纯数据**，`AgentState` / `Session` 不出 Agent——`agentState()` 从 Agent
**公开面**除名（assembly / `openAgent` 的去留在票 04/05 处理，本票只管 server 侧不再触碰）。

### ③ 设置与模型目录（map 已定四名照用）

`modelCatalog()` / `replaceModels(models)` / `hiddenDirectories(workDir)` / `applySettings(workDir, patch)`，
另补 **`settings(workDir): Settings`**——纯数据转发，`settingsOf` 的窄化（wire 形状）留在
controller、改吃 `Settings` 而不是 `SettingManager`；Agent 保持无状态转发。

### 票外对账补充

- **扫描类静态方法**：Agent 出同签名转发（`listSessions` / `listDirectories` /
  `findSessionRowById`）——目的地「hub 及以下只通过 Agent 的公开方法操作会话」字面成立，
  不留「自由函数例外」清单。
- **`hub.tools: ToolManager` 字段**：server 包无任何消费者，直接删；表进 Agent 内部（票 02 的构造吸收）。
- **`sessionOptions` / `openOptions` 构建对**：整个搬进 Agent 成私有方法，hub 删除
  （`readSessionSnapshot` 的调用随之进 Agent）。

### cold 安全契约（票的问题 2）

**per-method doc 契约**（裁定 a）：`setTitle` / `removeFromDisk` / `snapshotOf` /
`adoptFromDisk` 各自声明自己的写窗口（「一冷写一次同步块」）与不留痕性质（no claim、
不进 hosts / observers）；hub 侧只留一行「为什么敢直接调」。不收成类级统一段落——两个
性质是 per-method 的，分开放才不会在某一侧腐化。

### 现有 `Agent.open(options)` 的去留（票的问题 3 的另一半）

本次**只加新方法**，`open(options)` 原样留给 assembly / `openAgent()` 与 smoke 的构造接缝；
assembly 的收口与签名收缩是票 04 的题（fog 第一条）。

