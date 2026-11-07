# 04 core 实施：Agent 门面方法与构造改造

Type: task
Status: closed
Blocked by: 01, 02

## Question

按 01 与 02 的决议改 core：Agent 新增门面方法（三类），`createSessionAgent()` 吸收 Manager 构造，
`Agent` 公开字段与 `agentState` 的可见性按决议收。core 自身的 check 与 smoke-tools /
smoke-models / smoke-sessions 保持绿。

## Answer

已落地（commit 189b5a0）。`npm run check` 绿；smoke-tools / smoke-models / smoke-sessions 全绿，
smoke-api / smoke-mux / smoke-approval* / smoke-session / smoke-projection / smoke-settings /
smoke-boot / smoke-liveness / smoke-backpressure / smoke-mux-live / smoke-default-model 逐条同色。
smoke-approval 有一条预存在的偶发闪失（wire 层收到非 JSON 下行），已在未改动的基线上复现（约
1/4 次率），与本票无关。

### 范围比票面宽的部分（check 全绿所迫，票 05/06 因此收缩）

`npm run check` 编译整个仓库（server + scripts 同一 tsconfig），工厂改签名与 hub 字段删除必然
波及调用点，所以本票一并做了：

- **hub.ts**：构造缩成 `createSessionAgent({settingsHome, modelsHome, api})` 一行；
  `sessions` / `settings` / `tools` 三字段删除；全部调用点改走门面（`has`→`exists`、
  `snapshotOf` 冷支并入门面、`fork`→`forkFrom`、`rename`→`setTitle`、`remove` 的
  `isOnDisk`/`isSubmitting`/`removeFromDisk`、`open`→`adoptFromDisk`+`workDirOf`、
  `createUnpersisted`/`adoptFromDisk`/`openOptions`/`sessionOptions` 四个私有全删）。
  **票 05 剩下的只有注释按新形态改写（引用新 ADR）。**
- **controllers/sessions.ts**：约 10 处 `hub.settings.…` 改走门面；`settingsOf` 改吃 `Settings`
  纯数据（票 01 的裁定）；`listSessions` 自由函数改收 `Agent`。
  **票 06 的机械迁移随之完成，剩下注释。**
- **projection.ts**：`hub.agent.sessionManager` + `agentState().session` 清零——`getTitle` 两处
  改 `titleOf`，entry 直读改 `timestampOf` + `messageRoleOf`，扫描静态改
  `findSessionRowById`/`listDirectories`；本地 `messageTime` 删除（规则进了门面）。
- **scripts**：smoke-approval ×3 + smoke-approval-endpoint 改临时 homes +
  throwaway `SettingManager` 播种（`applySettings` + `replaceModels`，复用 coercion，票 02 裁定），
  播种块收进 `seedApprovalGate` 助手；smoke-sessions:887 改 `createSessionAgent({settings})`；
  `hubSessions` 接缝改取 `agent.sessionManager`（字段按票 02 保持公开）；mount-session 的
  `HubOptions.settings` 注释改指两个 homes。

### 对票 01/02 的四处偏离（动手时发现，理由如下）

1. **HubOptions 保留 `model` / `thinkingLevel` 两个 pin**：票 02 的五字段清单漏了它们——
   boot 的 `--model` 在传（boot.ts:106-107），删掉就红。落法是票 01 `create` 签名里的 `pinned?`：
   `create` / `adoptFromDisk` / `snapshotOf` 各收一个可选 `ModelPins`（`model` + `thinkingLevel`，
   定义在 assembly.ts），hub 用私有 `get pins()` 现取现传，Agent 不持有 pin。
2. **窄读多出一个 `messageRoleOf(id, entryId)`**：票 01 的 `timestampOf` 统一了 projection 的
   时间读法，但 projection 的 title 刷新还要看落地的消息是不是 user 的——票 01 没有覆盖这一半。
   纯数据返回（role 或 undefined），与雾第三条一致。
3. **`Agent.settings` 字段改名私有 `settingsManager`**：门面方法 `settings(workDir)` 与公开字段
   同名，TS 不容。核过全仓，`.settings` 字段在 server/scripts 没有任何消费者（票 02 的判断成立），
   让位给票 01 定下的方法名。`sessionManager` 字段照票 02 保持公开（smoke 消费，票 03/07 处理）。
4. **`agentState()` 未从公开面删除、加 `@deprecated`**：smoke-tools / smoke-sessions /
   smoke-session 仍在直读（断言改写在票 07），现在删除必红。收口随票 07 的断言改写一起落。

### 实施细节对账

- 三类方法签名照票 01 的表落地；`exists` = 表内 `has` || 盘上 `isOnDisk`（hub.has 的两支整体），
  `isOnDisk` 是 remove 用的盘上单半。
- 冷写契约按裁定 a 落在各自方法文档：`setTitle`（一冷写一次同步块、不拿 claim）、
  `snapshotOf`（不留痕：无 host、无 run、无 claim、不追加任何 entry）、`removeFromDisk`
  （纯文件 I/O、不触表/hosts/observers）、`adoptFromDisk`（无写窗口可保护——replay 与 assembly
  都不写盘，进表本身就是它的目的）。
- `openOptions` / `sessionOptions` 构建对进 Agent 私有（`openOptions` / `coldOptions`），
  冷读经 `readSessionSnapshot` 携带编排层自己的三个 Manager 与 transport。
- `Agent.snapshot`（同步、held-only）原样保留：hub.`snapshotNow` 与 projection.`liveOf` 仍用它，
  与新 `snapshotOf`（异步、held/cold 统一）并存。
- `OpenAgentOptions.sessionManager` 对 `openAgent` 已成死缝（工厂不收 ledger），字段文档已注明
  它只服务于冷读；形状按票 02 未动。
- `docs/architecture.md`、`setting-manager.ts` 头注释等处「hub 持有/注入 Manager」的旧叙述未改，
  归票 08。
