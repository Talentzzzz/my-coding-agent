# 10：SessionManager 去 states——34 个调用点迁移

Type: task
Status: resolved
Blocked by: 02, 08

## Question

删掉 `private readonly states = new Map<string, Session>()`（`session-manager.ts:1377`）与 `adopt`（若 03 号票
判删），`SessionManager` 退成「收 `Session` 的纯函数 + 文件 I/O」的薄壳。

- 新增 `open(id): Session`（02 号票的答案）：`fillSession(filePath)` 一份、**不缓存**，并在文档里写明
  「冷路径的一次性袋：fill → 改 → persist，并发靠 claim」。
- `stateOf` 删除或降为 `open` 的别名——**不留两个名字**。调用点迁移：
  - `agent.ts`：已由 08 号票吃掉；
  - `hub.ts` 5 处（:402 / :558 / :563 / :587 / :692）：读的改 `open(id)`，写的保持「fill → 改 → persist」；
  - `projection.ts:180`：活会话，改 `hub.agent.agentState(id).session`（需要一个公开读法，别把 Map 露出去）；
  - `session-factory.ts:148`：`assemble` 里的 `getRecordedSettings(options.session)` 保留（它本来就收袋）；
  - smoke 5 处（`smoke-sessions.ts`、`smoke-settings.ts`、`smoke-projection.ts`、`smoke-tools.ts`、
    `smoke-session.ts`）：按各自语义改。
- **smoke-sessions.ts:884 的手建 entry**（`new OpenSessions()` + `createOpenSession`）改成走新公开入口
  （`agent.adopt(createAgentState(…))` 或 `openAgent` 的等价路径）。
- 收账：`npm run check` 绿；`smoke-sessions` / `smoke-session` / `smoke-projection` / `smoke-settings` 绿。

## Answer

### 结论（一句话）

`states`、`stateOf`、`adopt` 全部删除、不留别名；`SessionManager` 退成「收袋的纯函数 + 文件 I/O」，只新立一个
`open(id)`（fill 一份、不登记，冷写 = `open` + 既有 setter 两步）；`forkFrom` 改形为
`(sourcePath, entryId, sessionDir?) → { sessionId, sessionFileAbsPath }`（不 fill、不入表，workDir 从源头
header 自己读）；`remove` 退成纯文件 I/O；调用点全部按 02 §8 的表迁移——02 §11 对票面的三句修正全部成立；
`check` 与 sessions / session / projection / settings / tools / models / 三个 approval / mux 全绿。

### 落地形状

- **session-manager.ts**
  - `states` 字段连同它的整段 doc 删除；类 doc 重写为「纯函数 + 文件 I/O」——它拥有的是 store 的格式知识
    （id → 路径、文件 → 袋、写入落盘），不再持有任何袋。
  - `open(id): Session` 立在 `stateOf` 的位置：`findSessionFilePathById` 定位、查不到抛
    `Unknown session: ${id}`（与旧 `stateOf` 逐字同句，controller 的 404 一字不动）、`fillSession` 一份返回。
    doc 按票 02 §2/§3/§5 写足四件事：只填已出生的配对（`.json` 是 commit marker）；不登记，同 id 两次是两只袋；
    冷写是**两步**不是三步（`open` + setter，setter 自己落盘，没有第三个 persist 动词）；安全前提是
    「活着的时候写者唯一（编排层那只袋），冷的时候一次同步块，两个窗口不重叠」——**不是**票面写的「靠 claim」。
  - `adopt` 删除（03 §5），不留 deprecate；`persistEntry` doc 里一句「prune rather than adopt」顺手改成
    「rather than keep」，避免指向不存在的机制。
  - `forkFrom`：签名去 `targetWorkDirInput`（02 §6），落点目录改从 `sourceMeta.workDir` 自己读（header 是
    唯一权威）；结尾的 `fillSession` + `states.set` 两句删，返回 `{ sessionId, sessionFileAbsPath }`。
  - `remove`：`states.delete` 删，退成纯文件 I/O；表的删除归 `agent.drop`（hub.remove 已在 08 落好）。
- **agent.ts**：`private agentStateOf` → 公开 **`agentState`**（03 §4 定的名字，约 20 个内部调用点机械替换），
  新增公开 **`has(id)`** 布尔面。两处 doc（`AgentConfig.sessionManager` 与 `Agent.sessionManager`）里
  「`stateOf` 缓存保证同一只袋」的说法按新事实重写。
- **session-factory.ts**：`assembleSession` 末尾的 `sessionManager.adopt(session)` 与其注释删除（03 §5）。
- **hub.ts** 四处（票面 :402/:558/:563/:587/:692，行号已漂移）：
  - `timestampOf`：`hosts` 门保留，读 `agent.agentState(id).session.sessionEntryMapById`（02 §8：这里绝不能用
    `open`，它每帧都被调）。
  - `fork`：hosted 半 `agentState(id).session.sessionFileAbsPath`，冷半 `findSessionFilePathById`（只要路径，
    冷路不 fill）；**删掉取 `workDir` 的那次 `fillSession`**——`forkFrom` 从源头 header 自己读。
  - `rename`：按 02 §3 / 03 §4 的最终形状就地分叉——`agent.has(id)` ? `agentState(id).session` :
    `sessions.open(id)`。02 §11 把 rename 分叉派给了 12，但 `stateOf` 删除后这行**必须**在本票变形才能编译且
    不丢数据，故按 03 的最终代码落在这里；doc 同步改写（不再提 claim 保证，改写同步块前提）。
  - `open()`：`pending ?? this.sessions.stateOf(id)` → `pending ?? this.sessions.open(id)`。对非 pending 的
    id，旧 `stateOf` fill 后的缓存条目本来就是多余的——同一只袋已包进 `AgentState` 被 `agent.adopt` 收走，
    service 的缓存从此没有读者（projection 的读者本票已改走表）。02 §8 说「这条随 03/12 一起变」指的是
    pending 删掉后的单一取袋路，本票只做让它编译且行为等价的最小换源。
  - `sessions` 字段 doc 重写（不再说 fill-at-open cache）。
- **projection.ts:180**：改 `hub.agent.agentState(sessionId).session`，注释写明为什么禁走冷路（每 token 重放）。
- **scripts**（9 处调用点 + 1 个块，按 02 §8 的 9 处清单）：
  - `smoke-sessions.ts`：`bagOf` 改 `hub.agent.agentState(id).session`（不再需要 cast）；:212 活袋取路径；
    :249 `forkFrom` 新返回形 + `fillSession` 读回（脚本本来就要读文件内容）；契约段按 02 §8 改写——
    「复用同一只袋」断言**删**，冷写落盘与「查不到就抛」保留改词；:884 手建 entry 块整体改写为 Agent 表的
    公开入口（`createSessionAgent` + `adopt` 先到先得 + `evict` 拒绝未出生会话 + `drop` 无条件删 +
    `agentState` 出表即抛），`OpenSessions` / `createOpenSession` import 随之删除。
  - `smoke-projection.ts` :212 / :232、`smoke-session.ts` :950、`smoke-tools.ts` :688：活袋读改公开
    `agentState(id).session`。
  - `smoke-settings.ts` 的三处是 `SettingsManager.stateOf`——另一个类的另一张表（05 号票），**不动**。
- `smoke-sessions.ts:287` 一处票面没列的隐藏依赖，顺带修掉：它在 reap **之后**读活袋与盘上重放比对长度。
  旧行为成立靠的正是 states 缓存「比文件活得久」——host 关掉、`agent.evict` 之后那只袋还在缓存里。缓存一删
  这里当场炸。按新语义改成 release **前**捕获消息数，比较对象换成捕获值；断言方向不变（文件保住了关掉时的
  全部内容），探针不再依赖任何一张表。

### 对票面的修正（02 §11 全部成立）

- 「hub.ts 5 处，读的改 `open(id)`」：:402 是**活**的（hosts 门在前），改 `agentState(id).session`；:558 的
  hosted 半是活的、冷半只要路径不 fill；真正换成 `open` 的只有 rename 的冷半与 hub.open 的非 pending 半。
- 「写的保持 fill → 改 → persist」：没有第三步（02 §5）；:563 的 forkFrom 连 fill 都删。
- 「smoke 5 处」：按文件数 5、按调用点 9 处，且「复用同一只袋」那条断言是删除不是改写。

### 留给下游

- `OpenSessions` / `createOpenSession` 在 core 里成了死代码（生产无读者，只剩本票改写前的 smoke 用过）——
  14 号票删。
- `snapshotOf` 的冷分支仍是手写定位 + `fillSession`（换成 `open` 归 12，与 pending 退场一起）；`hub.ts` 里
  `fillSession` 的最后读者就是它。
- `agentState` 出表的抛词仍是 `Session is not running`——改词归 12/14（03 §2 已登记）。
- 文档（`docs/architecture.md:67`、`docs/adr/0011`、`AGENTS.md` 的 OpenSessions 术语）仍描述旧缓存——14 号票。

### 验证

- `npm run check` 绿（core / server / web tsc + token 审计）。
- `smoke-sessions` / `smoke-session` / `smoke-projection` / `smoke-settings` / `smoke-tools` / `smoke-models` /
  `smoke-approval` / `smoke-approval-recovery` / `smoke-approval-queue` / `smoke-mux` 全绿。
- `smoke-api` 不跑（07 号票登记的本机 mux 环境问题）。

### 决定记录

| # | 决定 | 直接约束谁 |
| --- | --- | --- |
| 1 | `SessionManager.open(id)`：fill 一份、不登记；查不到抛 `Unknown session: ${id}`；`stateOf`/`adopt` 删除不留别名 | 14 |
| 2 | 冷写 = `open` + setter 两步；安全前提是「活写者唯一 / 冷写一段同步块」，不是 claim | 12、14 |
| 3 | `forkFrom` 去 `targetWorkDir`，返回 `{ sessionId, sessionFileAbsPath }`，不 fill 不入表 | 12 |
| 4 | `Agent.agentState(id)`（抛）与 `Agent.has(id)`（布尔）公开，取 03 §4 的形状 | 12 |
| 5 | hub `rename` 就地分叉在本票落地（stateOf 删除逼出），`agent.has` 是门 | 12 |
| 6 | hub `open()` 只做 `stateOf` → `open` 的等价换源；pending 退场与 snapshotOf 冷分支归 12 | 12 |
| 7 | reap 后的活袋读是 states 缓存的最后一个隐藏读者（smoke-sessions :287），已按新语义改写 | 15 |
