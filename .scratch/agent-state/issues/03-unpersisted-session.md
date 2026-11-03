# 03：未落盘的会话——hub.pending 与 adopt 往哪放

Type: grilling
Status: open
Blocked by: 01

## Question

「没说过话的会话不落盘」（`persistEntry` 的 `hasConversation` 闸门）现在靠两处持有：

1. `hub.pending: Map<id, Session>`（`packages/server/src/hub.ts:267`）——建出 id 到第一条消息之间，文件不存在，
   `has()` / `snapshotOf()` / `open()` 都先查这张表；
2. `ensureSession` 里的 `sessionManager.adopt(session)`（`session-factory.ts:266`）——把调用方的袋交给账本缓存，
   让 id 立刻答得出同一个对象。

`AgentState.session` 一旦能装未落盘的 `Session`（`persist: true` + `fileCreated: false` + `sessionFileAbsPath`
暂缺），这两处就都是第三份。

要定：

1. 未落盘的会话是否也算「打开」——即建出 id 那一刻就进 Map（哪怕没人看、磁盘上什么都没有）；
2. `pending` 删掉后，`has()` / `snapshotOf()` / `open()` 三条判据改成什么（现在是「先 pending 再盘」）；
3. `SessionManager.adopt` 是否随之删除；不删的话它给谁用；
4. 首条消息落盘后，`sessionFileAbsPath` 是补进同一个 `AgentState.session`，还是换一个新的（前者显然）。

➡️ 推荐：**建 id 即入表**（它本来就活在内存里，「不落盘」靠 `fileCreated` 而不是靠没人持有）；`pending` 与
`adopt` 一起删；`sessionFileAbsPath` 原地补齐。
