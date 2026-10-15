# 左栏右键 fork 的服务端现状与缺口

对应议题：`.scratch/window-polish/issues/02-fork-facts.md`（Type: research）。

本文只记录**读代码**得到的现状，不改动 `packages/` 下任何代码。凡未能从代码确认的，一律写「未查证」。

涉及的真实调用链（一句话）：

```
web 右键 → POST /api/sessions/{id}/forks { entryId }
      → controllers.sessions.fork   (packages/server/src/controllers/sessions.ts:309)
      → hub.fork                    (packages/server/src/hub.ts:419)
      → SessionManager.forkFrom     (packages/core/src/session/session-manager.ts:1584)
新会话出现 → hub.announceHost(id, undefined) (hub.ts:428,480)
      → projection.onHost(host=undefined) (packages/server/src/projection.ts:239,175)
      → SessionManager.rowForId → publish   (projection.ts:162,79)
      → mux onRow → connection.sendRow      (packages/server/src/mux.ts:858,576)
      → client onConnectionItem → rows.put  (packages/web/src/main.ts:394)
```

---

## 1. `POST /api/sessions/{id}/forks { entryId }` 的规格与 `entryId = null` 的语义

### 路由与控制器

- 路由：`POST /api/sessions/:id/forks`，成功 `201`。
  见 `packages/server/src/controllers/routes.ts:144-150`（`sendJson(response, 201, await controllers.sessions.fork(...))`）。
- 帮助文本：`packages/server/src/main.ts:113`（`POST /api/sessions/{id}/forks { entryId }`）。
- 控制器：`packages/server/src/controllers/sessions.ts:309-316`。
  - 校验：`entryId` 只接受 `undefined | null | string`，否则 `400 "`entryId` must be a string or null"`（`sessions.ts:311-313`）。
  - 归一：`typeof entryId === "string" ? entryId : null`（`sessions.ts:314`）——**缺省、`null`、非字符串一律归为 `null`**。
  - 调用 `hub.fork(sourceId, <归一后的 entryId>)`。
  - 返回 `{ sessionId, sessions: SessionRef[] }`（`sessions.ts:315`，`sessions` 是 `listSessions(hub.cwd)` 的结果，`sessions.ts:25-27`）。

注意归一的方向：**只有非空的字符串才会当作「某个 entry」**；`null` 与「没传」在服务端是同一件事。

### `entryId = null` 从哪里分叉：是「整份日志」，既不是当时的 leaf，也不是「最后一个已完成的轮次」

`SessionManager.forkFrom`（`session-manager.ts:1584-1625`）里决定分叉点的是两行：

```
const entries = sourceEntries.filter((entry): entry is SessionEntry => entry.type !== "session"); // :1600
const branch = entryId === null ? entries : buildSessionPath(entries, entryId);                    // :1601
```

- `sourceEntries` 是源文件**按行读出来的全部 entry**（`loadEntriesFromFile`，:1593）；`entries` 再去掉唯一的 header（`type === "session"`）。
- `entryId === null` 时 `branch` **就是 `entries` 本身**：即源文件里**所有非 header entry，按文件顺序**。
- 它的语义在 docstring 里写得很直白：`"...or null for the whole log."`（`session-manager.ts:1578`）。

因此：

1. **不是「源文件当时的 leaf」**。若想取 leaf 链，得走 `buildSessionPath(entries, <最后一个 entry 的 id>)`（`buildSessionPath` 在 `session-manager.ts:303-323`，缺省 leafId 时取 `entries[entries.length - 1]`）。`entryId = null` 走的是 `?` 的另一支，**根本没有做 leaf 计算**。
2. **不是「最后一个已完成的轮次」**。代码里没有任何按「轮次完成」过滤的逻辑；分支里没有这种边界概念。
3. **是「整份日志」**：包括源文件里所有分支上的 entry（append-only 文件若曾用分支切换器切过分支，文件里会同时留存多条分支的 entry 与 `leaf` 记录，见 `LeafEntry` / `appendLeafRecord`，`session-manager.ts:1501-1512`）。对一条**线性**会话，`entries` 恰好等于活动链，因此表现上等价于「从最后一条消息继续」；但这是「源恰好线性」的**结果**，不是 fork 给出的承诺。

新会话的活动链回到哪里：新文件 = header + `branch` 逐行写入（`session-manager.ts:1621-1622`）。重开时 `buildSessionInfo` 把**文件里最后一个 entry 的 id 当作 leafId**（`session-manager.ts:709`）。所以新会话的活动链结束在「`branch` 的最后一条」，对 `entryId = null` 即源文件当时的最后一条 entry。

**对左栏语义的结论**：从一条左栏会话行发起的 fork，客户端手上只有 session id（行里没有 entry id），只能传 `null`。所以语义宜表述为**「把这条会话继续下去（复制整份日志，活动链停在源的最后位置）」**；对线性会话即「从最后一条消息继续」。不要表述成「复制一份」——源文件确实被整份复制，但新会话是独立会话且从末尾继续。

---

## 2. 新会话的标题现在是什么：header 里根本没有标题字段

- `SessionHeader`（`session-manager.ts:42-55`）字段为 `{ type, version?, id, timestamp, cwd, parentSession? }`——**没有 `title`**。
- `NewSessionOptions`（`session-manager.ts:57-60`）只有 `{ id?, parentSession? }`——**也没有 `title`**。
- `forkFrom` **新造** 一个 header（`session-manager.ts:1613-1620`），带 `parentSession: <源文件路径>`；它**不复制源 header**，也无标题可复制。
- 标题是**派生**的，不是存储的：
  - 列表/扫描路径：`titleOfBranch`（`session-manager.ts:767-786`）——从 leaf 回溯到 root，取**分支上第一条 user 消息**，截断到 72 字符（`shortenTitle`，:1846-1849）。
  - 活会话路径：`SessionManager.getTitle()`（`session-manager.ts:1459-1461`）= `deriveTitle(<branch 的消息>)`（`deriveTitle` 在 :1830-1837，同样取分支上第一条 user 消息）。
  - 两边都拿不到 user 消息时返回占位符 **`"新会话"`**（`session-manager.ts:1836` 与 `:785`）。这正是「05 号把默认标题改成『新会话』」的落点。

**由此得到的直接事实**：`forkFrom` 既不复制也不改写标题。新会话的标题由**被复制进去的分支**重新派生。因为 `entryId = null` 复制了源的第一条 user 消息（线性会话），**新会话标题就等于源标题**（不是「新造一个别的」）。

**要得到「原标题（1）」，两条路谁更省——分清「显示」还是「持久」：**

- **客户端算**：只需源行的 `title`（清单里有，见第 3 节）与同族最大 N。**不用动服务端，不用动协议**——但这是**纯显示**的重命名。因为标题在服务端永远是「派生自 transcript」，客户端自造的标题会被服务端随后推来的 `session_row`（整行替换，`mux.ts:576-578`）**覆盖**，且**重载后丢失**（重载走 `GET /api/workspaces` 又拿回派生标题）。
- **服务端在 fork 时改写**：需要先给会话格式增加一个**可写的标题存储**（header 加 `title` 字段，或新增一种「改名」entry），并让 `deriveTitle` / `titleOfBranch` / `getTitle()` 的派生逻辑在有该字段时让位。属于**格式 + 协议改动**，成本明显更高。

**结论（判断，非代码可验证项）**：如果「（1）」只需**当场显示**、可接受 reload 后消失、且能容忍被服务端行覆盖，则**客户端算更省**（零服务端改动）。如果要求**跨窗口一致 + 重载后仍在**，则服务端当前**没有**可写标题的位置，只能走「加字段/加 entry」这条路，客户端算是不够的。这一点请在 01 的算法里定死「是否需要持久」。

---

## 3. 客户端算序号需要什么：清单里**已经有** `title` / `parentId` / `createdAt`

- `GET /api/workspaces`：路由 `packages/server/src/controllers/routes.ts:69-74` → `controllers.system.workspaces()` → `packages/server/src/controllers/sessions.ts:123-124`：`{ workspaces: await SessionManager.listWorkspaces() }`。
- 返回类型是 `WorkspaceGroup[]`：`packages/core/src/protocol.ts:53-56`（`{ cwd, sessions: SessionRow[] }`）。
- `SessionRow`（`protocol.ts:38-45`）继承 `SessionRef`（`protocol.ts:11-24`），因此每行含：
  - `id`、`cwd`、**`createdAt`**、**`title`**、`parentId?`（可选），外加 `modified` / `running` / `pending`。
- `SessionManager.listWorkspaces()` 的每行经 `toSessionRow`（`session-manager.ts:1815-1822`）→ `toSessionRef`（:1796-1804），其中 `title: info.title`、`createdAt: info.created.getTime()`、`parentId` 仅在存在时带上。
- `parentId` 的来源：header 记的是源文件的**路径**（`parentSession`，`session-manager.ts:54,1619`）；在**一次清单**里才知道两端，由 `linkForkParents`（`session-manager.ts:827-837`）把路径解析成 id。**前提**：父会话与 fork 在**同一目录**才解析得到。fork 恰好把新文件写在源的目录里（见第 4 节 `hub.fork` 的 `targetCwd`），所以同族 fork 的 `parentId` **能**解析出来。
- 同样的字段也随 WebSocket 的连接级 `sessions` / `session_row` 帧下发（`protocol.ts:336-342`，`mux.ts:571-578`），所以 `live` 与 `REST` 两种模式都能拿到 `title` / `parentId` / `createdAt`。

**缺口结论：协议层没有缺口**。源标题、`parentId`、`createdAt` 都在清单/行里，客户端可以直接拿源行的 `title` 与同族（同 `parentId`）行算「（1）」。左栏也已经按 `parentId` 建树（`packages/web/src/render/sidebar.ts:646-695`，`forkMark`/`parentTitle`/`depth`），排序与缩进无需新服务端事实。

（唯一需要注意的不是「取不到」，而是第 2 节的**持久化**：算出来的标题写不回服务端。）

---

## 4. 一个会话被 fork 之后左栏怎么知道：靠连接级 `session_row` 帧，客户端**不需要自己插行**

`hub.fork`（`hub.ts:419-430`）在写完新文件后：

```
const id = SessionManager.forkFrom(sourcePath, targetCwd, entryId).getSessionId(); // :426
this.current = Promise.resolve(id);                                                // :427
this.announceHost(id, undefined);                                                  // :428
```

- 注意第二参是 **`undefined`（没有 host）**：新会话刚建、还没被任何连接 claim。（`fork` 只返回 id，claim 交给随后的 mux `open`，见 `hub.ts:407-418` 的注释。）
- `announceHost`（`hub.ts:480-482`）同步广播给 `hostListeners`。
- 投影注册了 `hub.onHostChange(onHost)`（`projection.ts:239`）。
- `onHost(sessionId, host = undefined)` 走「**无 host 且无 row**」这一支（`projection.ts:175-195`）：因为这是全新会话，`rows.has(id)` 为假 → 执行 `void probe(sessionId)`（`projection.ts:189-193`）。
- `probe = (id) => SessionManager.rowForId(id)`（`projection.ts:162`）：**只读这一个新文件**（不是全量扫描），`rowForId` 在 `session-manager.ts:1723-1727`。
- 读到 row 后 `publish(scanned)`（`projection.ts:191`）。`publish`（`projection.ts:79-84`）在行有变化时通知监听者。
- mux 在构造时注册 `projection.onRow((row) => for (conn of connections) conn.sendRow(row))`（`mux.ts:858-860`）。
- `connection.sendRow` 下发 **连接级帧** `{ streamId: null, item: { type: "session_row", session: row } }`（`mux.ts:576-578`）。
- 客户端 `onConnectionItem`（`packages/web/src/main.ts:388-400`）：`item.type === "session_row"` → `rows.put(item.session)` → `renderSidebar()`。

**关键点**：

1. 左栏看到新会话，**走的是服务器主动推来的连接级 `session_row` 帧**，不是某条会话流（`streamId`），也不是客户端自己去拉清单。
2. 客户端**不需要**在右键菜单选完那一刻自己往列表里插一行——服务端会推。
3. 客户端的 `fork()` 确实也没有拿回列表：`api.forkSession`（`packages/web/src/api.ts:92-95`）只返回 `{ sessionId }`（丢弃了服务端返回的 `sessions: SessionRef[]`）；`fork()`（`main.ts:850-859`）随后只 `await openSession(created.sessionId)`。
4. `openSession` 里会调 `refreshLists()`（`main.ts:749`），但 `refreshLists` 走 `GET /api/workspaces` 后用 `rows.loadFrom(workspaces, channel === "live")`；**channel 为 live 时 `loadFrom` 直接返回 `false` 不动表**（`packages/web/src/rows.ts:63-71`，注释在 `main.ts:761-764`）。也就是说 `live` 模式下新行**只能**靠 `session_row` 帧进来；`REST`（通道断）模式下才由 `loadFrom` 整表替换带进来。两种模式都覆盖到了。

**因此**：右键 fork 后，客户端**依赖服务端帧**即可；若为了「瞬时反馈」想乐观插入一行，必须让它与随后到达的服务端行一致（否则会被 `rows.put` 盖掉或闪动，`rows.ts:50-53`）。

---

## 5. 一句话汇总各问

1. `entryId = null` = **整份日志（所有非 header entry）**，既不是 leaf 链也不是「最后完成的轮次」；对线性会话等价于「从最后一条消息继续」，但这是源线性的结果而非承诺。`sessions.ts:311-314` / `session-manager.ts:1578,1600-1601,303-323,709`。
2. header **没有标题字段**，`forkFrom` 新造 header 且不改写标题；标题永远派生自分支首条 user 消息，故 fork 后**等于源标题**，拿不到时占位为 `"新会话"`。要「（1）」：客户端算=零服务端改动但**不持久/会被行覆盖**；服务端改写=需**先给会话格式加可写标题**。`session-manager.ts:42-60,1613-1620,767-786,1830-1837,785,1836,1459-1461`。
3. 清单行**含** `title` / `createdAt` / `parentId?`（`SessionRow extends SessionRef`），协议层**无缺口**。`protocol.ts:11-24,38-45,53-56`，`session-manager.ts:1796-1804,1815-1822,827-837`，`sessions.ts:123-124`。
4. 左栏通过**连接级 `session_row` 帧**看到新会话（服务器主动推），客户端**不需要自己插行**；`live` 模式尤其如此。`hub.ts:419-430,480-482`，`projection.ts:239,175-193,162,79-84`，`mux.ts:858-860,576-578`，`main.ts:388-400,850-859`，`rows.ts:63-71`。
