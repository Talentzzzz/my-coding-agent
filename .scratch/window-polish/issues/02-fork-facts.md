# 02 左栏 fork 的服务端现状与缺口

Type: research
Status: resolved

## Question

「对左栏一个会话行右键 → 派生新会话」这条路，服务端**已经到哪里了**、还缺什么。

要查清并给出带路径行号的结论：

1. `POST /api/sessions/{id}/forks { entryId }` 的完整规格：`entryId` 传 `null` 是什么意思、
   走到的 `SessionManager.forkFrom(sourcePath, targetCwd, entryId)`（`packages/core/src/session/session-manager.ts:1584`）
   在 `entryId` 为 `null` 时**从哪里分叉**——是源文件当时的 leaf，还是"最后一个已完成的轮次"。
   这条决定了左栏 fork 的语义能不能直接说成"从最后一条消息继续"。
2. 新会话的**标题**现在是什么：`forkFrom` 是复制源的 header（含标题）还是新造一个？查
   `session-manager.ts` 里 header 的写法与默认标题（前一个 effort 的 05 号已把默认标题改成「新会话」）。
   如果 `forkFrom` 直接复制标题，那"（1）"就只能在客户端算或让服务端在 fork 时改写，**说清哪条更省**。
3. 客户端算序号需要什么：`GET /api/workspaces` 返回的每个会话行**是否有标题、`parentId`、`createdAt`**
   （`packages/core/src/protocol.ts` 的 `SessionRow` 定义）。如果清单里没有源标题就取不到，得说清
   缺口在哪一层。
4. **一个会话被 fork 之后左栏怎么知道**：`hub.fork()` 里 `announceHost(id, undefined)` 之后，
   客户端是靠哪条帧 / 哪次清单拉取看到新会话的（`packages/server/src/hub.ts` 的 observer 链 +
   `packages/web/src/client.ts`）。这决定右键菜单选完那一刻要不要客户端自己往列表里插一行。

**不要动代码。** 结论写进 `../research/sidebar-fork.md`，并在本文件的 `## Answer` 里给要点 + 链接。

## Answer

完整结论见 `../research/sidebar-fork.md`。要点（每条都带文件行号）：

1. **`entryId = null` 的语义 = 整份日志，不是 leaf，也不是「最后一个完成的轮次」。**
   控制器把缺省/`null`/非字符串一律归一为 `null`（`packages/server/src/controllers/sessions.ts:311-314`）。
   `forkFrom` 里 `entries` = 源文件全部非 header entry；`branch = entryId === null ? entries : buildSessionPath(entries, entryId)`，所以 `null` 直接复制**所有 entry**（`packages/core/src/session/session-manager.ts:1600-1601`，docstring「whole log」:1578）。没有任何「按轮次完成」过滤。新文件重开时 leaf = 文件最后一条 entry（:709）。
   → 左栏只有 session id（行里无 entry id），只能传 `null`；语义宜说成**「把这条会话继续下去（复制整份日志，活动链停在源最后位置）」**；对线性会话等价于「从最后一条消息继续」，但这是源线性的结果，不是 fork 的承诺。文案不要写成「复制一份」。

2. **标题：header 里根本没有标题字段，`forkFrom` 新造 header 且不改写标题。**
   `SessionHeader`（`session-manager.ts:42-55`）与 `NewSessionOptions`（:57-60）都**没有 `title`**；`forkFrom` 新造 header 只带 `{type,version,id,timestamp,cwd,parentSession}`（:1613-1620）。标题永远**派生**自分支首条 user 消息（`titleOfBranch` :767-786、`deriveTitle`/`getTitle` :1830-1837/:1459-1461），拿不到则占位 **`"新会话"`**（:785,:1836，即 05 号的默认值）。因 `entryId=null` 复制了源首条 user 消息，**新会话标题 == 源标题**（不是另造一个）。
   要「原标题（1）」：**客户端算**零服务端改动，但只是**显示**——会被服务端推来的整行 `session_row`（`mux.ts:576-578`）覆盖、且 reload 后丢失；**服务端改写**则需先给会话格式加一个**可写标题**（header 字段或改名 entry）并让派生逻辑让位，属格式+协议改动。**哪条更省取决于 01 定「（1）是否需要持久/跨窗口一致」**；若需持久，客户端算不够（当前无存储位置）。

3. **清单里已经有 `title` / `parentId` / `createdAt`——协议层无缺口。**
   `GET /api/workspaces` → `SessionManager.listWorkspaces()`（`controllers/routes.ts:69-74`、`controllers/sessions.ts:123-124`）返回 `WorkspaceGroup[] { cwd, sessions: SessionRow[] }`（`packages/core/src/protocol.ts:53-56`）；`SessionRow extends SessionRef`，含 `id/cwd/createdAt/title/parentId?/modified/running/pending`（`protocol.ts:11-24,38-45`）。`parentId` 由 `linkForkParents` 把 header 里的**路径**解析成 id（`session-manager.ts:827-837`），因 fork 写在源同目录，**能**解析。live（WS 帧）与 REST（清单）两路都带这些字段。左栏已按 `parentId` 建树（`packages/web/src/render/sidebar.ts:646-695`），排序/缩进无需新服务端事实。

4. **fork 后左栏靠连接级 `session_row` 帧得知，客户端不需要自己插行。**
   `hub.fork` 结尾 `announceHost(id, undefined)`（无 host）（`packages/server/src/hub.ts:426-428`）→ `projection.onHost(host=undefined)` 走「无 host 无 row」支 → `probe(id)` 只读这一个新文件（`packages/server/src/projection.ts:239,175-193,162`）→ `publish`（:79-84）→ mux `onRow` → `connection.sendRow` 下发 `{streamId:null,item:{type:"session_row"}}`（`packages/server/src/mux.ts:858-860,576-578`）→ 客户端 `rows.put` + `renderSidebar()`（`packages/web/src/main.ts:388-400`）。
   客户端 `fork()` 也没拿回列表（`api.forkSession` 只返回 `{sessionId}`，`packages/web/src/api.ts:92-95`；`main.ts:850-859`）。`live` 模式下 `refreshLists` 的 `loadFrom(..., channel==="live")` 会**拒绝**落地（`packages/web/src/rows.ts:63-71`），故新行只可能来自该帧；REST 模式才由整表替换带进来。两模式均覆盖。若为瞬时反馈做乐观插入，必须与服务端随后到达的行一致（否则被 `rows.put` 覆盖/闪动）。
