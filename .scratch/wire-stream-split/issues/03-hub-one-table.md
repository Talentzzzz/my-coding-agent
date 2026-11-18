# 03 - hub 合表：一张 `Map<sessionId, Set<订阅>>` + 一个全局通道，删掉 `watchers` / `feedMap`

Type: task
Status: ready-for-agent
Blocked-by: 02

## 背景与指针

- Spec：`Implementation Decisions / ### hub` 全节、`不变量` 第 2/3 条、User Stories 13-20。
- 现状代码：`packages/server/src/hub.ts`
  - `SessionFeeds` L51-56、`SessionWatcher` L65、`SubscriptionSink` L74-79
  - 两张表：`watchers` L115、`feedMap` L123
  - 编排层 sink（`onEvent`/`onState` 按 id 查 `feedMap`）L135-143
  - `subscribe` L254-272、`rebaseline` L293-295、`deliverBaseline` L309-332、`isWatched` L335-337、`feeds` L458-477、`remove` L426-432、`close` L440-445
- 消费方：`packages/server/src/mux.ts` L244-266（`open` 里的 `subscribe(id, watcher, sink)`）、L371（`rebaseline`）；`packages/server/src/projection.ts` L119-141（`follow` 用 `feeds`）、L257（`isWatched` 断言，票 01 已删）。

## 改动

### 1. `hub.ts`：两张表合成一张 + 一个全局通道

```ts
/** 一个会话的一个订阅者：要什么由实现了哪几个可选方法说，不要由某个标志位说。 */
interface 订阅 {
  event?(event: AgentSessionEvent): void;
  state?(snapshot: SessionSnapshot): void;
  /** 声明它 = 要初始状态。没有这个方法就不读盘、不交 baseline。 */
  baseline?(snapshot: SessionSnapshot): void;
  /** baseline 的失败半，与 baseline 成对：要初始状态的人必然也要它的失败。 */
  baselineFailed?(error: unknown): void;
  /** 会话被删除 / 进程收摊。 */
  gone?(): void;
  /** 一次运行在会话自己的流上说的那句失败（原 `MuxServer.announce` 的收件人）。 */
  failure?(message: string): void;
}

/** 这台机器上的列表：无键，所以不是按会话的订阅。 */
interface 全局订阅 {
  rows?(row: SessionRow): void;
  gone?(sessionId: string): void;
  /** 整表变了（目录进出列表）——没有载荷，客户端要的是一整份新的列表。 */
  resync?(): void;
}
```

- 表：`Map<string, Set<订阅>>`（一条 entry = 一个会话的全体订阅者）+ `Set<全局订阅>`。`watchers` / `feedMap` / `SessionFeeds` / `SessionWatcher` / `feeds()` / `isWatched()` **全部删除**。
- 编排层 sink 改成遍历订阅者：`for (const sub of this.subscribers.get(id) ?? []) sub.event?.(event)` / `sub.state?.(snapshot)`。第一句仍须是"编排层只认这一个出口"的意思，注释按两张表合一改写。
- 公开面：

| 方法 | 语义 |
|---|---|
| `subscribe(sessionId, sub): () => void` | 注册；**有 `baseline` 就在返回前的同一同步块内交付**（活半同步、冷半读盘异步恰一次、失败 `baselineFailed` 恰一次）；返回宽容且幂等的退订——只清"这一次订阅占的那一格"，迟到的退订不得替同 id 上后来的订阅清表 |
| `subscribeGlobal(sub): () => void` | 登记全局订阅，返回同样的宽容退订 |
| `publishRows(row)` | 扇给全局订阅的 `rows` |
| `publishGone(id)` | 扇给全局订阅的 `gone` |
| `publishResync()` | 扇给全局订阅的 `resync` |
| `publishFailure(id, message)` | 扇给该会话订阅者的 `failure`（**spec 的公开面清单漏了这一条**：`mux.announce` 退场后，`onRunFailure` 的那一帧没有别的路可走。形状与 `publishRows` 同一条原则——hub 只转发载荷、不看内容。在 ADR-0024 里记一笔） |
| `snapshotFor(id, sink)` | 原 `rebaseline` 改名：一次性交付（活半同步 / 冷半异步 / 失败交原始 `error`），不注册、不返回退订 |

- 活冷分岔仍然只有 `deliverBaseline` 一处，判定、读取、恰好一次的守门都不动（票 01 的黑盒 smoke 是它的验收）。
- `remove(id)`：`for (const sub of subs) sub.gone?.()`，随后照旧 `void deleteSessionBySessionId(...)`（删除顺序不变量：流的 `end` 在 `gone()` 里，行的 `session_gone` 在 controller 的 `onRemoved` → 投影 → `publishGone` 之后）。
- `close()`：`Agent.closeAll()` 之后对每个订阅 `gone?.()`，然后清两张表。
- 注释里落地 `不变量` 第 2/3 条（恰好一次；删除顺序），并在 `subscribe` 的 JSDoc 里保留现有那份"hub 半"的机制论证（票 03 只是换了订阅者的形状，论证一字不改）。

### 2. `mux.ts`：订阅元素化（**本票不动**它其余的会话语义）

`open()` L225-267 里那段 `hub.subscribe(id, watcher, sink)` 改成一个元素：

```ts
hub.subscribe(sessionId, {
  baseline: (snapshot) => this.writeBaseline(sessionId, subscription, snapshot),
  baselineFailed: (error) => this.failBaseline(sessionId, error),
  event: (event) => { this.push(...); if (event.type === "branch_changed") this.pushBaseline(...); ... },
  state: (snapshot) => { this.pushStatus(...); this.pushApprovalChanges(...); },
  gone: () => this.endStream(sessionId),
})
```

- 原 `watcher(feeds)` 里的 `live` 标志与 `bind()`（L298-317）退场：feed 不再是一等物。
- `baselineSink()` L381-393 的"这份 baseline 还有人要吗"守卫**保留**：它守的是 `!this.closed && this.subscriptions.get(id) === subscription`，与会话订阅无关。
- `pushBaseline` 里的 `hub.rebaseline` → `hub.snapshotFor`。

### 3. `projection.ts`：`follow` 改用订阅元素

`follow()` L119-141 里的 `hub.feeds(id)` + `onEvent`/`onChange` 改成：

```ts
const stop = hub.subscribe(sessionId, {
  event: (event) => onEvent(sessionId, event),
  state: (snapshot) => { /* 原 onChange 的那段：liveRow + publish */ },
});
```

**不声明 `baseline`**——这正是"要不要初始状态由元素自己声明"的第一个真实用户：投影的行来自磁盘扫描，不需要 hub 为每一行读一次盘（spec User Story 16）。

## 测试

- `node scripts/smoke-subscribe.ts`（票 01）全绿，**除 `openRig()` 外一字未改**。若它需要改断言，说明本票改变了可观察行为——停下来，不要改断言。
- `npm run check` 绿（尤其：`hub.isWatched` / `hub.feeds` 的引用必须一个不剩）。
- `node scripts/smoke-projection.ts`、`smoke-mux.ts`、`smoke-stream.ts`、`smoke-backpressure.ts`、`smoke-approval.ts`、`smoke-approval-endpoint.ts`、`smoke-sessions.ts` 全绿。
- 新契约的两条 smoke 断言若尚未被票 01 覆盖，补在票 01 的装置上（不新建文件）：**删除时流先 `end`、行后 `session_gone`**（spec 风险节点名的一条）。

## Comments

- **删除顺序断言已补**：`scripts/smoke-subscribe.ts` 原「删除」区只断言流 `end` 是最后一帧，没有 `session_gone`（该装置直接 `hub.remove`，不走 controller 的 `onRemoved`）。新增「删除顺序：流先 end、行后 session_gone」一节，分两拍驱动：`hub.remove`（断言流已 `end` 且 `session_gone` 尚未到达）→ `rig.forgetRow`（controller 的 `onRemoved`，断言随后到 `session_gone`）。为此给 `Rig` 加了一个 `forgetRow` 驱动方法（内部就是 `projection.forget`）；`openRig()` 的 hub/projection/mux 构造与既有断言一字未改。
- **`smoke-projection.ts` 随公开形状迁移**：它原先用旧的 `hub.subscribe(id, watcher, sink)` 三元组看事件（且不关心 baseline）。改为订阅元素，只声明 `event`。这是测试装置对公开面的跟随，不涉及本票三条生产文件之外的行为。
- **`publishFailure` 本票没有消费方**：`boot.ts` 仍走 `mux.announce`，而 `boot.ts` 本票不动。按 ticket 公开面清单已加入 hub；等 session stream 那票让 `mux.announce` 退场时再接 `onRunFailure`。ADR-0024 的记一笔属于文档票，本票未动 docs。
- **残留 grep**：三条生产文件内 `SessionFeeds` / `SessionWatcher` / `feeds()` / `isWatched` / `watchers` / `feedMap` / `rebaseline` 零引用。全仓仅剩 `packages/core/src/agent.ts`、`packages/core/src/session/events.ts` 的既有注释，以及 `scripts/smoke-subscribe.ts` 头部说明「本 smoke 不读 isWatched/watchers/feedMap」的文案——前者不在本票范围，后者是票 01 的装置说明，均未改动。
