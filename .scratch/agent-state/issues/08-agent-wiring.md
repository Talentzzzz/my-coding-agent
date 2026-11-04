# 08：Agent 接线——entryOf 换成 agentStateOf，Map 落在 Agent 上

Type: task
Status: resolved
Blocked by: 07

## Question

把 `packages/core/src/agent.ts` 从「向登记处要条目」改成「自己持表」。

- `private readonly openSessions: OpenSessions` → `private readonly sessions: Map<string, AgentState>`
  （`AgentConfig.openSessions` 换成 `sessions?`，缺省自建；01 号票定的接法）。
- `entryOf(id)` → `agentStateOf(id)`：`this.sessions.get(id)`，缺失即抛（现在抛 `Session is not running: ${id}`，
  语义不变）。
- 构造函数里 `this.openSessions = config.openSessions` 换成表 + `adopt(state): void` 公开方法（工厂装配后交给它；
  测试同一条路）。
- **15 处 `this.sessionManager.stateOf(id)` 全部换成 `agentStateOf(id).session`**：`snapshot`、`getApprovals`、
  `hasPendingApprovals`、`prompt`、`abort`、`moveBranch`、`setActiveTools`、`applyConfig`、`settle`、
  `respondApproval`、`denyAllApprovals`、`compact` 等（`grep -n "stateOf(" agent.ts` 是清单）。
- 字段搬家：`entry.runtime.steeringQueue` → `state.live.steeringQueue`；`entry.runtime.activeRun` →
  `state.live.activeRun`；`entry.run` → `state.live`（本票先把 `entry.run` 读成 `state.live`，`RunScope` 的删除
  留给 09 号票）；`entry.listeners` / `entry.eventListeners` → `state.listeners` / `state.eventListeners`；
  `entry.workDirAbsPath` → `state.session.sessionSetting.workDirAbsPath`；`entry.settings` → `state.setting`；
  `entry.modelSelection` → **`state.session.sessionSetting.model`**（见下）。
- **`modelSelection` 的去向**（拍板的一部分）：`applyModelSelection` 直接改 `sessionSetting.model`
  （`{ name, modelId?, thinkingLevel }` 的合并），`prepareRequest` 的 `recordSelection` 仍只在这里写盘；
  `snapshot` 的 `model` = `live.model ?? modelFor(sessionSetting.model, this.models.list())`——**运行中读 Live，
  空闲读袋**，这就是「输入框之外的都是 Live」。
- `modelFor(entry.modelSelection, …)` 的 4 处调用改成 `modelFor(sessionSetting.model, …)`（`modelFor` 现在的入参
  是 `ModelChoice`，形状够用；若 `modelId` 多余，就在本票顺手把 `ModelChoice` 与之一并）。
- `finalizeToolResult(state, entry, message)` 这类自由函数改收 `AgentState`。
- 收账：`npm run check` 绿；`node scripts/smoke-sessions.ts`、`node scripts/smoke-tools.ts`、
  `node scripts/smoke-models.ts` 绿（smoke 里手建 entry 的两处等 10/12 票）。

## Answer

### 结论（一句话）

接线全部落地，且按 01 号票答案的**修正形状**接：`AgentConfig` 不收表（票面「换成 `sessions?`」那句作废），
`private readonly sessions: Map<string, AgentState>` 自建，`adopt` 是唯一入口；`entryOf` → `agentStateOf`，
15 处 `stateOf(id)` 全部改从 `agentStateOf(id).session` 取袋；字段搬家逐条照票面；`modelSelection` 落在
`sessionSetting.model`、装配时种子、请求时写盘；`check` 与 `smoke-sessions` / `smoke-tools` / `smoke-models`
（加 `smoke-session` / 三个 approval smoke / `smoke-mux`）全绿；`smoke-api` 的 mux 连不上是 07 号票已登记的
本机环境问题，与改动无关。

### 落地形状

- **agent.ts**
  - 表与门：`private readonly sessions = new Map<string, AgentState>()`；`adopt(state)` **先到先得**（已有
    该 id 不覆盖、不抛，继承 `OpenSessions.ensure` 的语义）；`agentStateOf(id)` 缺失即抛
    `Session is not running: ${id}`，语义不变。表上的删除动词一并立起（hub 本票就得编译）：`evict(id)` 按
    04 号票的 Agent 侧判据（`activeRun === undefined && !suspended && fileCreated === true`）判后删、不满足
    返回 false；`drop(id)` 无条件删——用户删会话的收摊路径，判据之外（03 §7）。
  - 15 处 `stateOf(id)` 全部换成 `agentStateOf(id).session`；方法内部的**穿透参数从
    `(state: Session, entry: OpenSession)` 收成 `state: AgentState` 一个**，袋内的 Session 在用到的那行
    `state.session` 现取。字段搬家逐条照票面：runtime 两条队列与 `activeRun` → `live`；listeners 两组 →
    `state.listeners` / `state.eventListeners`；`workDirAbsPath` → `state.session.sessionSetting.workDirAbsPath`；
    `settings` → `state.setting`。
  - **`entry.run` 读成 `state.live`，RunScope 的字段原地搬到 Live**（09 只删壳）：run 写 `live.model` /
    `live.partial` / `live.retrying` / `live.retryAttempt` / `live.suspended`，`startRun` 的 `finally` 把五样
    抹掉——这就是「运行中读 Live，空闲读袋」能成立的原因；`retryMaxAttempts` 降为 `retryCallbacks` 的闭包
    局部。`RunScope` 接口本身留着（`open-session.ts` 的 `run` 槽还引用它），09 删。
  - **modelSelection**：`applyModelSelection` 直接改 `sessionSetting.model`——内存合并
    （改名时丢掉旧 `modelId`，level 取 `selection.thinkingLevel ?? normalize(旧值)`，与旧行为逐字对齐），
    **不落盘**；`recordSelection` 仍是唯一的写盘点（`setModel` 补 `modelId`、`setThinkingLevel` 补档）。
    `snapshot` 的 `model` = `live.model ?? modelFor(sessionSetting.model ?? {}, catalog)`；`modelFor` /
    `rowFor` 的 4 处调用点全部改传 `sessionSetting.model ?? {}`——`ModelChoice` 没动（形状子类型兼容，
    `modelId` 多余但无害），没有顺手扩它。
  - `finalizeToolResult(state, message)` 改收 `AgentState`。
- **session-factory.ts**：`ensureSession` 改名 **`assembleSession`**，返回 `{ sessionManager, state }`；
  `SessionServices` 删除，`SessionAgentServices` 断开 `extends`；`OpenAgentOptions.openSessions` 删除；
  `createSessionAgent` 不再收表；`openAgent` 改为「`assembleSession` → `createSessionAgent` →
  `agent.adopt(state)`」。**装配时把模型选择种到 `sessionSetting.model`**（03 §7 的「创建即装配、第一条消息
  之前就有值」）：内存合并，不落盘——没有这一步，空闲快照与 `prepareRequest` 对一个没说过话的会话会拿
  占位行建模，票面自己的设计就不成立。`index.ts` 导出换名（`ensureSession` / `SessionServices` 移除）。
- **hub.ts**（机械适配，生命周期对齐仍是 12 的活）：`openSessions` 字段删除；`open()` 改为
  `assembleSession` + `agent.adopt`；remove 路径的删表 → `agent.drop`（用户删会话，无条件）；reap 的删表 →
  `agent.evict`（判据判定；未落盘的会话 `fileCreated === false` 被拒，状态留到 remove/进程退出——这正是
  03 §7 定的寿命）；`close()` 的 `openSessions.clear()` 删除（表随编排层对象消失，不造第二个写者）。
- **scripts**：`mount-session.ts` 改走 `assembleSession` + `hub.agent.adopt`，`HubInternals` 的
  `openSessions` cast 删除；`smoke-sessions.ts` 的 `entryOf` 探针改为穿透 `agent` 的私有表（cast）——身份
  断言全部保留、原样通过，12 号票改读行为时一并清。

### 两处 smoke 断言的改向（不是放松）

`smoke-session.ts` 两处「选了不记录」的断言原来读 `getRecordedSettings`——旧设计里它看不见 entry 上的
选择，等价于盘；新设计里内存的 `sessionSetting.model` **就是**在 force 的选择（03 §7），`getRecordedSettings`
如实报告它。断言改读盘：两个块里的会话都还没说过话（`fileCreated === false`），盘上无文件可写——「请求
之前什么都不记」的契约没变，变的是探针的位置。

### 验证

- `npm run check` 绿（core / server / web tsc + token 审计）。
- `smoke-sessions` / `smoke-tools` / `smoke-models` / `smoke-session` / `smoke-approval` /
  `smoke-approval-recovery` / `smoke-approval-queue` / `smoke-mux` 全绿。
- `smoke-api` FAIL（mux 连不上 127.0.0.1:8080）：07 号票已登记的本机环境问题，stash 后干净 master 同样失败。

### code-review 记录

两轴跑完，Standards 一条硬伤、Spec 一条真实回归，均已处置；其余为 judgement call，登记归属。

**Standards 轴（5 条）**

1. `AgentConfig` 的 `tools` 与 transport doc 块缩进被改成两 tab——硬伤，已修回一 tab。
2. 「内存合并 modelChoice」形状重复（factory 种子 vs `applyModelSelection`）——保留重复：两处语义有
   细微差别（种子从不带 `modelId`，改名才丢），抽帮手反而要把差别藏进参数里。
3. `state.session.sessionSetting.workDirAbsPath` 消息链 ~10 处——票面字段映射就是这么定的，不动。
4. 本文件末尾缺换行符——已补。
5. `mount-session.ts` 的 `(await assembleSession({...})).state` 改为 hub 同款解构
   `{ state: assembled }`——顺手统一，`AgentState` import 随之删除。

**Spec 轴（4 条）**

1. **真实回归（已修）**：`recordSelection` 的写盘基线失效。`applyModelSelection` 现在把选择（含档位）
   直接写进内存的 `sessionSetting.model`，而 `recordSelection` 用 `getRecordedSettings`（读同一个袋）做基线
   比较——自比自恒等，永不再写盘。后果：已落盘会话上**只改档**的场景，`setModel` / `setThinkingLevel`
   的内存闸都看不见差别，档位永远到不了盘，重开回到旧档。修法：`SessionManager` 新增两个**最小面**方法
   （10 号票重整时一并收编）——`recordedOnDisk(session)` 会话已出生时读 `.json` 回盘上那份
   `{ model?, thinkingLevel? }`（未出生回 `{}`，出生写自然兜住）；`flushMeta(session)` 按袋强制重写快照
   （setter 的闸对的是袋，袋里已对的差别只有它看得见）。`recordSelection` 改为：盘上
   (name, modelId, level) 与在 force 的一致即早退（「一次移动一次写」保住）；不一致则跑两个 setter
   （把内存补成 name+modelId+level）再 flush。doc 已补：写盘基线现在是盘上 meta，不再是内存袋。
   核对脚本 `.scratch/agent-state/level-record-selection.mjs`（仿 `level-roundtrip.mjs`）复现全链：
   prompt at high → 盘 high → 只改档 max → 盘仍 high → prompt → 盘 max → `fillSession` 读回 max；
   另盖「同一选择再跑一轮不重写」（mtime + 内容）与改名整行落盘。`npm run check` 与
   smoke-sessions / tools / models / session / 三个 approval / mux 重跑全绿。
2. **抛词冲突，裁决保留旧词**：03 §8 曾把「`entryOf` 抛词改 `Session is not open`」派给本票，但票面
   明写「语义不变」，故保留 `Session is not running: ${id}`。改词是纯改名，归 12/14 号票一并清。
3. 「建 id 即入表」（03 §8 决策 1）未做，hub 仍 pending + 首次 claim open——有意留给 12 号票。
4. `evict` / `drop` 两个公开方法不在票面 Question 里——为让 hub 本票编译而加，判据对齐 04 / 03，
   Answer「落地形状」已登记。
