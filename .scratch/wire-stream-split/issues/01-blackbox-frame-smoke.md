# 01 - 黑盒帧 smoke：把「观众收到什么帧」写成安全网，在未改动的生产代码上跑绿

Type: task
Status: done
Blocked-by: （无——这是图的根）

## 背景与指针

- Spec：`Z:/my-coding-agent/.scratch/wire-stream-split/spec.md`（Testing Decisions 全部 + User Stories 1-8/21/22/23）。
- 现状替代品：`scripts/smoke-subscribe.ts`（485 行，hub 级——几乎每条断言都在读 `hub.isWatched`、数 `watcher` 调用次数）。`isWatched` 与 `watcher(feeds)` 在票 03 一并退场，这份 smoke 因此是**要被替换**的东西，不是要保留的东西。
- prior art（黑盒写法）：`scripts/smoke-mux.ts`（真服务器 + 真 WebSocket 客户端，断言 `WireClient` 收到的帧序列）、`scripts/smoke-projection.ts`（喂事件、看行）。本票取 smoke-mux 的**断言风格**、smoke-projection 的**装置风格**（直接构造 hub + `scripts/fake-transport.ts` 的脚本化 transport），接缝取 `FrameSink`（`packages/server/src/mux.ts` L68-83）。
- 仓库 smoke 惯例：`node scripts/smoke-xxx.ts` 直接跑、`check(label, cond, detail)` 断言、中文小节标题、`finally` 里收摊 + `rm` 临时目录、`process.exitCode` 收尾。

**本票不改任何生产代码**（`packages/server/src/**` 一个字不改）。改的是 `scripts/smoke-subscribe.ts`、`scripts/smoke-projection.ts` 的两条断言、`README.md` 的 smoke 清单那一行。

## 判据（spec Testing Decisions 第 1/2 条）

好断言只回答一个问题：**客户端收到了什么帧——类型、顺序、次数**。不读任何内部表、不断言任何私有字段、不数 `watcher` 被调用了几次。

本票的关键约束，写进文件头注释：**断言与装配分离**。装配（造 hub / projection / mux、造假 sink、把上行帧喂进连接）收在**一个** `openRig()` 函数里并返回一个驱动面：

```ts
interface Rig {
  frames(streamId: string | null): ServerFrame[];   // 该流/该连接上收到的帧，按到达顺序
  open(sessionId: string): void;                     // 上行 {type:"open"}
  cancel(sessionId: string): void;                   // 上行 {type:"cancel"}
  closeConnection(): void;                           // 断线
  hub: SessionHub;                                   // 只用于造会话与跑一轮（驱动，不用来断言）
  ...
}
```

后续拆分的四张票（02/03/04/05）只允许改 `openRig()` 这**一个函数**，其余每一行断言必须一字不改地通过。这是本次重构唯一的正确性证据（spec Testing Decisions 最后一条）。

## 改动

### 1. `scripts/smoke-subscribe.ts` 整体重写为帧级黑盒

装置：`mkdtemp` 两个临时目录（root + store，`setSessionsDir(storeRoot)`，抄 `scripts/smoke-subscribe.ts` 现有的两个坑）+ `createFakeTransport()` + `new SessionHub({ workDirAbsPath, api, modelsHome })` + `createSessionProjection(hub)` + `createMuxServer(hub, projection, {})` + 一个记录帧的假 `FrameSink`（`send` 恒 `true`，`ping`/`close`/`terminate` 只记账，`isClosed` 跟随）。连接经 `await mux.accept(sink)` 建立，上行帧经 `mux.handle(connection, JSON.stringify(frame))` 喂入。

必须覆盖的行为（spec Testing Decisions 第 9 条逐条）：

1. **开场**：连上之后先收到**应用心跳**（`streamId === null`、`item.type === "heartbeat"`），再收到 overview（`item.type === "sessions"`）——顺序是现状契约（客户端把先到的心跳当作"这条连接活着"）。
2. **活半 baseline 同步**：一个正在跑的会话（`fake.setResponses` 里卡在门口）`open` 之后，第一个流帧就是 `baseline`，且 `session.running === true`（袋里的在飞状态，不是盘上旧状态）。
3. **冷半 baseline 异步恰一次**：冷会话 `open` → `baseline` 恰好一次（等够时间后再确认没有第二份）；期间发布的事件帧全部排在 baseline **之后**（帧序断言，不是扣帧断言——扣帧是实现的活）。
4. **重复 `open` 去重**：第二次 `open` 同一会话 → 再收到一份 `baseline`，没有 `error`、没有 `end`，且原有流继续可用（其后再发一条消息，事件帧照常到达）。
5. **未知会话**：`open` 一个不存在的 id → 该流上先一帧带 message 的 `error`，再一帧 `end`；连接本身不受影响（随后还能正常 `open` 另一个会话）。
6. **删除**：观看中的会话被删除 → 该流收到 `end`，且此后**不再有任何**该 `streamId` 的帧。
7. **分支移动的重发**：`branch` 之后该流再收到一份 `baseline`（内容是新叶子所指向的状态）。
8. **审批横幅的读者计数**：两条连接同时看同一会话，会话停在审批上 → 两边都收到 `approval_request`；经 `POST /api/sessions/:id/approvals/:toolCallId`（或直接 `mux.rememberApproval` + 恢复运行，二者择一，取当前 API 最直的那条）作答 → 两边都收到 `approval_settled` 且 `approved: true`。**另一个会话的窗口收不到它**（建第三个连接看另一个会话，断言零帧）。
9. **断线后不再造帧**：`rig.closeConnection()` 之后让那个会话跑一轮、再删除它——假 sink 上不再出现任何新帧（记录断线时的帧数，事后比较）。
10. **隐藏目录过滤**：把一个目录放进 `hiddenDirectories`（设置 patch）→ 新连接的 overview 不含它的行；该目录里某会话发生变更 → 该连接**收不到**它的 `session_row`（这一条正是"自己回来的组比从未离开的更糟"）。
11. **整表重发**：目录进出列表（`onDirectoryListingChanged` 的路径，即隐藏/取消隐藏一个目录）→ 每条连接收到一整份新的 `sessions` 帧（不是新消息形状）。

### 2. `scripts/smoke-projection.ts`：摘掉两条内部表断言

L257 `check("and the watcher let go", !hub.isWatched(afterStop))` 与 L236 一带那段订阅装配，按"只断言客户端收到什么"的判据重写：该 smoke 的主题是"喂事件、看行"，所以**删掉这两条 `isWatched` 断言**，保留"watcher 听到了事件"那条，并在删掉的位置写一行注释指向本票：*退订的可观察面在 `scripts/smoke-subscribe.ts` 的帧断言里*。装配（`hub.subscribe(afterStop, (feeds) => ..., sink)`）本票**不动**——它随票 03 的新公开面改写。

### 3. `README.md`

L141 那一行改成描述新内容：`# 订阅的帧面：baseline 与增量、恰好一次的失败、end 的次序、断线后不再造帧；不需要密钥`。

## 测试

- 本票的验收 = **`node scripts/smoke-subscribe.ts` 在未改动的生产代码上全绿** + `npm run check` 绿 + `node scripts/smoke-projection.ts` 绿。
- 按 TDD：先写 `openRig()` 与第一条断言（开场心跳 + overview），跑红/绿之后再逐条补 2-11。每加一条都跑一次，不要让一整个大文件一次写完才第一次运行。
- 不得为了让它跑绿去改生产代码。若某条断言在现状下**不可能**成立（例如现状的帧序确实与本票描述不同），停下来把它写进 ticket 的 `## Comments`，不要改断言去迁就实现，也不要改实现。

## Comments
