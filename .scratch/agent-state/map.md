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

## Not yet specified

- **迁移顺序的中间态**：34 处 `stateOf`（15 在 agent、5 在 hub、5 在 smoke-sessions、其余零散）如何在「每票都绿」
  的前提下搬；要不要先给 `Agent` 加一个临时兼容读。
- **常驻内存的代价**：`jsonlEntries` 从「每请求重放」变成「常驻」之后，长会话的内存占用；`evict` 之外要不要再加
  空闲超时或按 token 上限淘汰。
- **`dropQueued` 与 `evict` 的交界**：驱逐时清队列是否等价于一次 drop；`suspended` 会话的队列要不要保（04 号票
  只决定「清不清」，不决定「清之前要不要把队列还回去」）。
- **smoke 覆盖**：现有 smoke-sessions 只覆盖 host 生命周期，要不要新增「切走即清 / 在跑不清」一节。
- **desktop 外壳**：进程内启动、单窗口，驱逐是否影响 `packages/desktop` 的关闭与重开路径。

## Out of scope

- 队列或整个状态袋落盘（零袋 / C 路线）：已裁决，桌面单进程不需要外部状态存储。
- 把 `models.json` 的行清单搬进 `AgentState.setting`：行清单是进程级 `ModelSource`，不是会话的事。
- 多进程共享会话状态。
- 压缩 / 清理策略本身（`compaction`、`trim_tool_call_arg`、`clear_tool_result` 的算法不动）。
