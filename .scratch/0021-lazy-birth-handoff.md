# 0021 懒身份改造 —— 交接文档

> 写于 2026-11-15 23:53。上一个窗口完成了 core / server / web / 文档四层改造，**smoke 重写进行到一半**。
> 接手窗口请先读完本文档，再按「剩余工作」逐项推进。原始设计全文见对话中的长文计划（不再复述）。

## 一、改造是什么（一句话）

会话随第一条消息原子出生（ADR-0021）：`live.unwrittenSession`、`live.openedOn`、「未开口会话」概念
整体删除；`POST /api/sessions` 变成出生证明（body 必填 `text`）；`Agent.create` → `createAndPrompt`；
`resolveSettings` 删 `chosen` 参数；web 草稿流四步折叠为一步、无目录草稿输入框禁用。

## 二、已完成（tsc 全绿：core / server / web）

### Core（packages/core/src）
- `session/agent-state.ts`：删 `openedOn` / `unwrittenSession` 字段及文档，import 清理。
- `assembly.ts`：`OpenAgentOptions` / `AssembleAgentStateOptions` 删 `model`/`thinkingLevel`；
  `resolveSettings` 调用改 4 参；删未出生袋暂存与 openedOn 写入。
- `settings.ts`：`resolveSettings(session, global, rows, known)` 四参；回落链 = 记录的选择 → 设置默认行
  → 内置默认行 → 第一行。
- `agent.ts`：
  - `resolvedSettings(session)` 单参（5 处调用点全改）；
  - `getSessionBySessionId` 恒走 `sessionManager.open`；
  - `tryRemoveAgentStateBySessionId` 只剩「运行在途 / 审批停驻」两个拒绝条件；
  - `appendMessageEntry` 删 unwrittenSession 清除；
  - `forkFrom` / `fileAbsPathOf` 删未出生分支；删私有 `openOptions`；
  - `create()` 删除，新增 **`createAndPrompt(workDirAbsPath, text, options?: { behavior?, mode?, selection? })`**：
    铸 id → 本地袋 setter 落 mode（校验，未知名抛 Error）与 selection（走新抽的私有 helper
    `writeModelSelection`，与 `applyModelSelection` 共用）→ `assembleAgentStateBySession({ session })` →
    appendMessageEntry（文件出生）→ publishState → `run({ agentState, session, start })` → 返回 id；
    append 抛错时 `agentStateMap.delete(id)` 再 rethrow。
  - 注意：**createAndPrompt 不能复用 `startPromptedRun`**（它按 id 重开袋，出生前文件不存在），
    所以出生写入在方法内联（用本地袋）。
- `session-factory.ts`：注释里 `create` → `createAndPrompt`。`openAgent` 未动（model 覆盖已随接口删除）。

### Server（packages/server/src）
- `hub.ts`：`newSession(workDirAbsPath?)` → **`birth(input: { text, workDirAbsPath?, behavior?, mode?, model?, thinkingLevel? })`**；
  model/thinkingLevel 都缺省时 selection 为 undefined（不写默认行进快照！）；保留 `current` 与
  `announceHost`；多处文档注释同步（release / snapshotOf / observe / tryRemove / remove / fork）。
- `controllers/sessions.ts`：`create` → **`birth`**。校验顺序：text 缺失/空 → 400；workDir 类型 → 400、
  `workDirAbsPathForCreate` 失败 → 400；behavior/mode/model/thinkingLevel 类型 → 400；
  `hub.birth` 抛错（未知 mode/model）→ **409**。保留 `restoreDirectory`。应答 `{ sessionId, sessions }`。
- `controllers/routes.ts`：POST /api/sessions 改 `readObjectBody` + birth，动词文档块更新。
- `http/errors.ts`：删 `optionalObjectBody`。

### Web（packages/web/src）
- `api.ts`：`createSession(input: { text, workDirAbsPath?, behavior?, mode?, model?, thinkingLevel? })`。
- `main.ts`：
  - `DraftSession.workDirAbsPath` 变可选；`directoriesWithDrafts` 无目录草稿落空键假组（workDirAbsPath ""）；
  - `directoryForNewSession(): string | undefined`（删根目录回落；草稿打开时返回 draft 自己的目录）；
  - chip 菜单 onSelect：**写入 `draft.workDirAbsPath`**（草稿解禁的唯一路）；
  - chip 标签：无目录 → 「选择目录」；副标题：无目录草稿 → 「未选择目录」；
  - 新增 `composerDisabled()`：`!reachable || 草稿无目录`；`drawState` 与 `render` 都用它；
  - transcript 空态：无目录草稿 → 「先在下方选一个目录，再开始对话。」（见 transcript.ts）；
  - `prompt()` 草稿分支：POST birth（带 text/目录/behavior/mode/席位 model+thinkingLevel）→ openSession →
    retain，四步折叠为一步；失败时草稿保留、文字回输入框；侧栏签名加了 draft.workDirAbsPath。
- `render/transcript.ts`：新增 `setWelcomeText(text | undefined)`。
- `render/sidebar.ts`：空键组标签「未选择目录」；草稿行 tooltip 空目录同文案；空键组右键菜单只留提示行。

### 文档
- **新增 `docs/adr/0021-lazy-session-identity.md`**（决定、被否备选、fire-and-forget 取舍、对 0013 的修订）。
- ADR-0013：头部「取代者」标注 0021，正文 4 处历史叙述加「已随 0021 删除」标注；ADR-0016、ADR-0019
  各一处同样标注（保留历史原文，grep 命中处都有指路标注）。
- `docs/architecture.md`：装配段（live 半字段清单、createAndPrompt、回落链）、模型座位段（删 chosen/
  openedOn/unwrittenSession 段落）、循环 step 1（出生端点）已更新。
- `AGENTS.md`：session / model selection / assembly / AgentState 四个词条已改写。
- `CONTEXT.md` 无涉及。**全仓 grep `unwrittenSession|openedOn` 在代码 + AGENTS.md + architecture.md
  已归零**；剩余命中全在历史 ADR 的叙述里且已带标注。

## 三、关键机制发现（接手前必读）

1. **birth 会往账本写两条消息**：user（出生消息）+ assistant（无模型时的 unconfigured 错误消息
   "No model is configured yet..."）。无模型的 hub 上 birth **瞬时落定且不重试**（unconfiguredStream
   的错误不匹配 retryable 模式）。smoke 里基于消息计数的断言每个 birth 要 +2。
2. **无 api 的 hub 上 birth 是安全的**（瞬时错误消息）；有 fake transport 的 smoke 需要
   `setResponses` 喂剧本，否则 fake transport 空队列也返回 error 消息（同样瞬时）。
3. **fork/分支挂点**：出生消息就是第一条 user entry；需要挂点时用账本里第一条 user entry 的 id。
   smoke-sessions.ts 已加 helper `birthEntryId(bag)`。
4. **`writeModelSelection` 只能带非空 selection 调**：空 selection 会把默认行写进快照（用户没选过的
   「选择」）。hub.birth 已守（两者都 undefined → selection undefined）。
5. controller birth 的校验顺序 = text 先于 workDir；给 smoke 写 400 用例时注意哪个字段触发。
6. `inMemorySession` 仍导出保留，但**不能再经编排层（openAgent/Agent）驱动**（永不落盘 →
   `getSessionBySessionId` 的 open 会抛）。只操作 SessionManager 的用例仍合法。

## 四、剩余工作（按序做）

### 1. smoke-sessions.ts（改了一半，先完成它）
已做：`bagOf` → 纯重放、`birthEntryId` helper、三处 birth（landing / created / parentId fork 段，
fork 挂点已改用 birthEntryId）。还要：
- `:353` `renamedId` → `hub.birth({ text: "改名的会话" })`，删除下一行 appendMessage（标题由出生消息派生）。
- `:386` `metaId` → `hub.birth({ text: "重写的会话" })`，删 append（:388）。
- `:556` `readId` → `hub.birth({ text: "read me" })`；`:558` 只留 append "and me"；`:577` 消息数 2 → 3。
- `:643` POST /api/sessions body 加 `text`；`:652-658` 断言翻转——出生即有行（listing **应该**含它），
  其后的 `speak` 步骤可删或保留。
- `:674-679` 各 workDir 用例 body 加 text；`:680-681` 空 body POST 改为断言 400（"A JSON body is required"）。
- `:715/:717` body 加 text；`:718-726` 注释与 speak 相应改（出生已带消息，speak 可删）。
- `:783/:795` body 加 text。
- `:812` victim → birth({ text: "要删的会话" })，删 :814 append。
- `:907-930` 未出生表机制块改写：删「unborn refuses to be removed」；改为
  `tryRemoveAgentStateBySessionId === true`（无文件但空闲的状态可驱逐）；first-come-wins 检查保留；
  deleteSessionBySessionId 两次的检查保留（第二次 refused）。注释里 "unborn bag" 字样清掉。
- 跑 `node scripts/smoke-sessions.ts`，按输出逐条修余下断言（消息计数类为主）。

### 2. smoke-projection.ts
`:88/:150/:241/:262/:270/:301` 六处 `hub.newSession()` → `hub.birth({ text: ... })`；跑通修断言。
（该 smoke 未在原计划清单里，但 hub.newSession 已不存在，必须改。）

### 3. smoke-session.ts
- `:248` 本地 helper `bagOf`：`session.fileCreated ? open : session` 三元 → 恒 `open`（或按上下文改重放）。
- `:310-313` `openAgent({ model, thinkingLevel })` → 按计划改走 prompt selection：openAgent 后用
  第一条消息（`agent.createAndPrompt` 不适用——它已过时？注意 createAndPrompt 是 Agent 公开方法，
  openAgent 拿到的 agent 可以直接 `agent.createAndPrompt`？不行，openAgent 已装配了袋——
  推荐做法：openAgent({ session }) 后直接对**袋**写 selection（sessionManager.setModel/setThinkingLevel
  + flushMeta），或改用 `createSessionAgent()` + `createAndPrompt`。看该测试想要什么，保持意图。
- `:931` / `:2109` `bagOf(agent).fileCreated === false` 断言删除（能力已不存在）。
- `:1053` `openAgent({...})` 检查是否带 model 字段。
- 跑 `node scripts/smoke-session.ts` 修断言。

### 4. smoke-tools.ts
- `:639/:710/:716/:983` openAgent 段：凡「打开未出生袋」的，改为先落一条首消息再打开
  （对袋 appendMessage 后文件即出生，open(id) 就能走）。
- `:781` `inMemorySession(root)` → 真实临时目录会话（`createSession(root)` + append 一条消息）。

### 5. smoke-approval-queue.ts / smoke-approval-recovery.ts
- `:125-152` / `:149-152` `openAgent({ ..., model, thinkingLevel })`：模型覆盖没了。方案：
  openAgent 之后先对袋 append 一条 user 消息（让文件出生），再用 sessionManager.setModel/setThinkingLevel
  落选择，或让脚本 transport 的断言改从 `fakeState.thinkingLevels` 走出生 selection
  （改用 `createSessionAgent({ api, settings, tools })` + `agent.createAndPrompt(dir, text, { selection })`，
  这是和生产行为最一致的路，推荐后者）。

### 6. smoke-settings.ts
- `:272-276` 「recorded 胜过 openedOn」用例随 `chosen` 参数删除而移除（resolveSettings 已 4 参）。

### 7. smoke-api.ts
- `:204` / `:293` / `:304` 三处 `POST /api/sessions` 补 body `{ text: ... }`；建议 `:293` 附近补两条
  400 用例（无 body、缺 text）。注意：每次 birth 都会触发一次真实 run（无 provider key → 连接拒绝
  → 默认重试 ~14s；脚本 watchdog 150s 是按整个脚本计的，三个 birth run 要重新估）。`:304` 的
  treeId birth 本身就有 run，之后 `settleRun(treeId)` 要等到它落定。

### 8. smoke-mux.ts
- §2/§5/§8/§9 的空 POST → birth（带 text）；§3 未知 id 报错断言**保留**；
- `:361` 附近「没说话的会话无行」段改为「出生即有行」断言。

### 9. smoke-stream.ts / smoke-boot.ts / smoke-approval.ts
- 出生模式替换（未动过，逐个读、改、跑）。

### 10. 验证
- `npm run check`（三包 tsc + token 审计 + check-server-facade —— 前三包现已绿，卡在 scripts）。
- 逐个跑：`smoke-session` / `smoke-sessions` / `smoke-tools` / `smoke-settings` / `smoke-api` /
  `smoke-mux` / `smoke-stream` / `smoke-boot` / `smoke-approval` / `smoke-approval-queue` /
  `smoke-approval-recovery` / `smoke-projection`（均无需供应商密钥）。
- 端到端手验（计划原文）：`npm run dev` → 新建会话（无目录 → 输入框禁用 → 选目录 → 发首条消息）→
  确认 `.json`/`.jsonl` 同时出生、快照含 mode/模型选择、侧栏归组正确、草稿行被真实行接替；
  刷新后重启进程，确认不存在「无文件的会话」。

### 11. 收尾
- 全仓 grep `unwrittenSession|openedOn`（代码/活文档应为零；历史 ADR 叙述已带标注）。
- 任务清单：本窗口的任务 #5（smoke 重写）仍 in_progress、#6（验证）pending，换窗口后继续用。

## 五、验证命令备忘

```bash
npm run check
node scripts/smoke-sessions.ts
node scripts/smoke-session.ts
node scripts/smoke-tools.ts
node scripts/smoke-settings.ts
node scripts/smoke-api.ts        # 需要先起服务器：npm run start -- --workDir <临时目录>（或 MY_AGENT_URL）
node scripts/smoke-mux.ts
node scripts/smoke-stream.ts
node scripts/smoke-boot.ts
node scripts/smoke-approval.ts
node scripts/smoke-approval-queue.ts
node scripts/smoke-approval-recovery.ts
node scripts/smoke-projection.ts
```
