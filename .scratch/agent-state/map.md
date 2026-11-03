# Map：AgentState——Agent 持一张 Map，四层登记结构合一

Status: open

## Destination

`Agent` 单例持一张 `Map<sessionId, AgentState>`，`OpenSessions` / `OpenSession` / `SessionRuntime` / `RunScope`
四层全部删除；`AgentState = { listeners, eventListeners, setting, session, live }`；构建链固定为
`fillSession` → `fillSettings` → `live`（先会话后设置——会话记着自己选了哪个模型、哪档思考强度）；
打开即建、**无人看且无运行**即清；`SessionManager` 与 `SettingsManager` 都不再持有任何按 id / 按目录的缓存。

终点：代码落地、`npm run check` 与 smoke 全套 + 桌面手测通过、ADR-0011 落档、`AGENTS.md` / `docs/architecture.md`
与实况一致、旧类型与死代码清零。

## Notes

**2026-11-03 用户拍板（本图不再重开）**

- 终点含执行：决定 + 落地到代码，ADR 作为第一张施工票。
- `Agent` 依然是**单例**，只是多了一个 Map 属性；这不是把编排层变成有状态会话类。ADR 要按这个调子写：它是
  「登记处从 hub 搬进 Agent」，不是「Agent 变成会话」。
- `SessionManager` 删掉 `private readonly states = new Map<string, Session>()`（session-manager.ts:1377）；
  `SettingsManager` 删掉 `private readonly states = new Map<string, SettingsState>()`（settings-manager.ts:423）。
- 驱逐：**无人看 + loop 没在跑，同时满足才清**（接管者是 hub，Agent 提供 `evict` 并自己再判一次）。
- `Live` 是**正在运行的那一份**：运行中改了什么，袋里可能没跟上，所以运行中**输入框之外的一切显示读 Live**，
  输入框显示用户刚改的值。快照的 `model` 因此 = `live.model ?? modelFor(session.sessionSetting.model)`。
- `retryMaxAttempts` 字段删除；`retry_scheduled` / `retry_start` 的 `maxAttempts` 在发点现取
  `getRetrySettings(setting).maxAttempts`（`pumpAttempts` 本来就读它）。
- `sessionSetting.model` 合并现在的 `meta.model` + `meta.thinkingLevel`，并兼作「在 force 的选择」；
  **盘上 `.json` 形状不动**，写盘仍只发生在 `prepareRequest`（`setModel` / `setThinkingLevel` 已同值不重写）。

**授权**：决定票（01–05）的推荐已写在票面；用户一次批准即按票面 resolve，这是本 effort 对「一票一会话」的
唯一例外，仅限决定票。执行票仍一票一会话。

**动手前必读**：`docs/architecture.md` 的 core / server / Agent / hub 四段；`AGENTS.md` 的 `## 术语`
（service、OpenSessions、assembly 三条要重写）；`docs/adr/0007`（§4、§6 被推翻）与 `0006`（§2 种子→补齐）。

**每票收账跑**：`npm run check`；相关 smoke（`node scripts/smoke-sessions.ts` 等，见各票）；14 号票全量。

**惯例**：文档中文、源码注释英文；tab 缩进、双引号、相对 import 带 `.ts`；编辑源码用编辑器工具，绝不走 shell
文本往返；不用 `any`。

**编译纪律**：07 票只加类型不接线，08–13 逐层接线，14 票才删旧类型 —— 任一票收账时 `npm run check` 必须是绿的。

## Decisions so far

**01 号票（2026-11-03 解决，装配点）**：**(a)**，且接法收到一个门——`assembleSession`（原 `ensureSession`）
在工厂造出 `AgentState`，调用方 `agent.adopt(state)` 交表；`Agent` 不新增 `SettingsManager` 依赖，
`AgentConfig.openSessions` **整条删掉**（不改成 `sessions?: Map`）。`adopt` 先到先得、不覆盖、不抛，
表私有不公开 getter，删除权（`evict` / 进程收尾）随表归 Agent。**与票面 `➡️` 的差异一处**：票面把
「注入 `sessions?: Map`」和「`adopt` 公开」并列，本票只取后者——注入一张表等于给 hub 留回 `clear()` 的权力，
与「Agent 自己再判一次」冲突（详见票内 §3、§6）。下游：07 的构建链由 `assembleSession` 产出、08 的表落在
`Agent`、12 的两处 `openSessions.delete` 改 `agent.evict`（`clear()` 取消——表随编排层对象消失）、14 删类、15 全量。

**02 号票（2026-11-03 解决，冷路径）**：**(a)** —— `SessionManager.open(id)` fill 一份、**不登记**、调用方拥有；
`stateOf` 删除不留别名；冷写 = `open(id)` + 既有 setter（`recordMeta` / `persistEntry` 自己落盘，**没有**第三个
persist 动词）。**fork 不 fill 也不入表**（票面 `➡️` 只说不入表、"代价一次重复 fill"；改成不 fill 之后代价是零），
`forkFrom` 返回 `{ sessionId, sessionFileAbsPath }` 并去掉 `targetWorkDir`（源文件头里就有）。**补票面两条前提**：
① **活会话永不走冷路**——`hosts` 里有的 id 读写都走 `Agent` 表里那只袋，否则 `writeMetaFile` 写整只快照会把
跑动刚记的模型/档位/工具集**静默写回旧值**（今天这条正确性挂在 `stateOf` 缓存上，缓存一删就露，落点是 `rename`，
它本就"活也可能冷"）；② **并发不是 claim 给的**——`rename` 明确不拿 claim，冷写安全靠"open→改→写盘是一段同步块"
（与 `settleSessionFiles` 的论点同构），文档不许写"靠 claim"。**10 号票禁止把 `agent.ts` 的 15 处 `stateOf`
机械替换成 `open`**（编译通过、语义错），那是换源不是改名；15 的全量 smoke 是兜底。

**03 号票（2026-11-03 解决，未落盘的会话）**：**建 id 即入表**——不是取舍，是删掉 `pending` 之后剩下的唯一一条：`newSession` 交出 id 之后客户端的第一件事是**订阅**（`retain` 恒发 `open`），`open` 先问 `hub.has`，
而这一刻磁盘上一个文件都没有，所以「这个 id 存在」只能由表回答；不给表就只能把 `pending` 换个名字留着。
**「打开」从此指「这个进程握着它」**（不是「有人看」也不是「在跑」），`hosts ⊆ 表`——**12 的「两者同生同灭」作废**；
`observers` 与 claim 各自独立；`entryOf` 的抛词改 `Session is not open`（与 `hub.snapshotNow` 那句 "not running" 刻意
不同），`observe` 的回调仍只认 `hosts`（否则 `live` 一翻，从没跑过的流会在驱逐时收到 `end`）。**三条判据压成两分支**
（表 / 盘）并给了实现：`has` = `agent.has || 盘上找得到`；`snapshotOf` = 表里就 `agent.snapshot`、否则 fill 一份冷读
（hosted 分支被「表」吸收，冷读集合从「没在跑」缩成「不握」）；`open` = 表里取、否则 `open(id)` + `assembleSession` +
`adopt` 再**读回来**。**创建因此变成一次装配**（`createUnpersisted` 变 `async`，两个调用方都已是 `async`）。
`remove` 的第一句 `pending.delete` 拆成 `held = agent.has` 加一个新公开面 **`drop(id)`**（不带判据，宿主收摊用）——
与 `evict` 是两个动词；`rename` 的 `isHosted` 旗子整个去掉，改「表里就用袋，否则 `open(id)`」，副作用是未落盘的会话
可以被命名（404 → 200，标题只留内存随出生写出）。**`SessionManager.adopt` 删**（唯一调用点 `session-factory.ts:266`），
且它其实是「最后写赢」，别照抄进 `Agent.adopt`（那个是先到先得）。**更正票面一处前提**：`sessionFileAbsPath` 出生就
在袋上（`newSession` :1142），问题 4 的两个选项都不适用，真正翻的是 `fileCreated`；`pendingManager` 的 `existsSync`
探针是它的替身，随 `pending` 一起死。**给 04 补一条判据**：驱逐加 `fileCreated === true`——盘上没有另一半的会话，
一清就是删掉这个 id（`has` 变假、`snapshotOf` 404、`open` 无处 fill）。**给 07/08 的约束**：创建即装配，所以
`sessionSetting.model` 在第一条消息之前就有值，只能读作「在 force 的选择」而非「记下的选择」，`modelId` 必须可选。

## Not yet specified

- **迁移顺序的中间态**：`SessionManager.stateOf` 在树里的调用点是 29 处（agent 15、hub 4、`projection.ts` 1、
  `scripts/` 9；另有 5 处 `SettingsManager.stateOf` 与本迁移无关，别混进清单）如何在「每票都绿」的前提下搬；
  要不要先给 `Agent` 加一个临时兼容读。02 号票已定：agent 那 15 处是**换源**（`agentStateOf(id).session`），
  不是把 `stateOf` 改名成 `open`。
- **常驻内存的代价**：`jsonlEntries` 从「每请求重放」变成「常驻」之后，长会话的内存占用；`evict` 之外要不要再加
  空闲超时或按 token 上限淘汰。**03 号票加了新的常驻者**：未落盘的会话（`fileCreated === false`）按判据不进驱逐，
  寿命到首次消息或 `remove`／进程退出为止——与今天的 `pending` 条目同长；要不要再收紧归这一条。
- **`dropQueued` 与 `evict` 的交界**：驱逐时清队列是否等价于一次 drop；`suspended` 会话的队列要不要保（04 号票
  只决定「清不清」，不决定「清之前要不要把队列还回去」）。
- **smoke 覆盖**：现有 smoke-sessions 只覆盖 host 生命周期，要不要新增「切走即清 / 在跑不清」一节。
- **desktop 外壳**：进程内启动、单窗口，驱逐是否影响 `packages/desktop` 的关闭与重开路径。

## Out of scope

- 队列或整个状态袋落盘（零袋 / C 路线）：已裁决，桌面单进程不需要外部状态存储。
- 把 `models.json` 的行清单搬进 `AgentState.setting`：行清单是进程级 `ModelSource`，不是会话的事。
- 多进程共享会话状态。
- 压缩 / 清理策略本身（`compaction`、`trim_tool_call_arg`、`clear_tool_result` 的算法不动）。
