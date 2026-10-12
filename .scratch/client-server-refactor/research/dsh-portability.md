# DSH 传输机制的可移植性

对 `.scratch/client-server-refactor/issues/01-dsh-portability.md` 的回答。

**范围与方法**：以 `deepseek-harness-master/` 的实际源码为准。本报告不引用该树的
README 与 `tmp/dsh-client-server-summary.md` 作为证据（那两份是二手材料），只把它们
当作待验证的说法：凡总结里的断言，都在下面标注"证实 / 证伪 / 部分"。每条结论带
`文件:行号`。路径相对 `deepseek-harness-master/`。固定阅读面：
`packages/api/gateway/src/`（含 `client/`）、`packages/api/session-controller/src/`
（含 `client/`）、`packages/client/connection/src/`、`packages/host/webserver/src/`、
`packages/api/remotes/src/`，以及两份 agent note
（`.agents/notes/implemented/architecture/2026-09-19-remote-duplex-stream.md`、
`2026-08-18-session-history-and-event-transport.md`）。

**一处方法学自纠**：最初的引用来源清点只扫了 `.ts`，因此漏掉了
`packages/client/ui-subagent/src/client/sidebar-chat/index.tsx` 里的 `sidebarChat`
——权威文件扩展名在本树里同时有 `.ts` 与 `.tsx`。§1.3 的表是补扫 `.tsx` 之后的结果，
并已注明哪些消费点只是**读**计数而不新增 source。

**先说一句贯穿全篇的事实**：本树里有两套互不相干的"retain/release"。
一套是**客户端的订阅引用计数**（`ClientSessions.retain`，本报告第 1 节的主题）；
另一套是**host 侧的观察租约**（`SessionQuery.observeSession` 的 `SessionObservation`，
增减点见 `packages/session-query/session-query/src/observation.ts:248`、`:261`、`:267`；
消费点 `packages/api/session-controller/src/history.ts:179`、`:205`）。后者是"冷读缓存被
钉住直到最后一个观察者释放"，按 host 进程计数，与"谁在看这个会话"无关。下面凡说
"引用计数"，都指前者。

---

## 一、引用计数订阅

### 1.1 计数由谁持有：**客户端的 object layer**，不是 gateway，也不是 client connection

计数器的所有者是 `ClientSessions`——`packages/api/session-controller/src/client/`
里的无 React 对象层。计数不在 host 上，也不在连接层。

发放引用的位置：

```ts
// packages/api/session-controller/src/client/sessions/service.ts:533-539
private retainScope(id: SessionId, source: SessionReferenceSource): ClientSessionReference {
  const record = this.scopes.get(id) ?? this.materializeScope(id)
  const previous = record.retention
  record.retention = Object.freeze({
    referenceCount: previous.referenceCount + 1,
    retainedBy: freezeRetainedBy({ ...previous.retainedBy, [source]: (previous.retainedBy[source] ?? 0) + 1 }),
  })
```

计数存在 `ScopeRecord.retention`（`service.ts:151-158`），挂在每个会话一个的
`scopes` Map 上（`service.ts:243`）。释放回调在 `service.ts:540-550` 里递减，
`count === 0` 时调 `retireScope`（`service.ts:548`）。

公开面是 `ISessions.retain/using/retainInfo`（
`packages/api/session-controller/src/client/contract/sessions.ts:58`、`:66`、`:74`），
计数被投影成 `SessionRetainInfo`（`contract/sessions.ts:42-46`），并写进列表行
`SessionSummary.retainedBy`（`.../sessions/service.ts:38-39`，投影在 `service.ts:562-574`）。

**server 侧没有任何计数**。Gateway host 的连接对象只持有"活跃逻辑流表"：

```ts
// packages/api/gateway/src/stream-server.ts:135-137
class RemoteStreamMuxConnection {
  private readonly streams = new Map<string, ActiveStream>()
  private writes = Promise.resolve()
```

`RemoteStreamMuxServer` 的字段只有连接 Promise 集合与心跳计数
（`stream-server.ts:43-47`），**没有**任何 per-session 或 per-client 的引用表。
客户端连接侧同样没有（`packages/client/connection/src/client/connection.ts:77-86`
只有 generation/attempt/abort 控制器）。

值得单独记下的是：订阅计数的**方向**是"服务端不问、客户端自己数"。host 根本不知道
有几个客户端在看哪个会话——host 只知道哪些逻辑流当前开着。这是这份设计里最可移植的
一条性质，也是最容易被误读为"服务端引用计数"的一条。

### 1.2 归零时服务端到底停止做什么：**什么都不会主动回收，只有一个取消帧**

归零触发的是**纯客户端的收尾**，链路如下：

1. `ClientSessionReference.release()`（`service.ts:215-223`）中止自己的
   `AbortController` 并调用 `releaseReference`（幂等：置空后只调一次，
   `[Symbol.dispose]` 委托给它，`service.ts:225-227`）；
2. `retainScope` 里的闭包（`service.ts:540-550`）把计数减到 0 后调
   `this.retireScope(id, record)`；
3. `retireScope`（`service.ts:576-585`）：

```ts
record.live = false
if (this.scopes.get(id) === record) this.scopes.delete(id)
record.session.unbindScope()
const sessionDisposal = this.manager.drop(id, record.session)
this.projectList()
this.publishRetention(id)
this.startScopeDrop(id, record, disposeFiber, sessionDisposal)
```

4. `manager.drop`（`.../sessions/manager.ts:184-191`）把实例从 `sessions`/`addresses`
   里摘掉，`pruneEngagement` 清掉"engagement"标记，然后 `session.dispose()`；
5. `Session.dispose()`（`.../sessions/session.ts:599-611`）递增 `openGeneration`
   （使在途结果失效）、丢下 `this.events`，并 `await events?.dispose()`；
6. `SessionEventStream.dispose()`（`.../client/transport.ts:137-169` 继承的
   `RemoteJournalStream.dispose`，`packages/api/gateway/src/client/journal-stream.ts:223-233`）
   先 `this.stream.dispose()`，最终走到 `RemoteStreamMuxClient.open()` 的 `finally`
   （`packages/api/gateway/src/client/stream-client.ts:135-144`）：

```ts
this.streams.delete(streamId)
stream.pump?.stop()
if (opened && !terminal && carrier?.readyState === WebSocket.OPEN) {
  this.send(carrier, { type: 'cancel', streamId })
}
```

7. **host 侧效果**：`stream-server.ts:189-191` 的 `case 'cancel'` → `stop()`
   （`:212-215`：`abort.abort(reason)` + `inbox.fail(reason)`）→ host 的
   `SessionHistoryController.follow()` 生成器 unwind，其 `finally`
   （`packages/api/session-controller/src/history.ts:234-239`）只摘掉该 follower 注册在
   `session/event`、`session/created`、`agent/assistant-stream` 上的监听器。

同时客户端拆掉对象层作用域：`startScopeDrop` → `dropScope`（`service.ts:682-709`）
在 `sessionDisposal` 完成后 `record.fiber.dispose()`，销毁该 Agent 作用域 fiber 上的
一切注册（`service.ts:588-606` 建立，`.../client/scope.ts:44-58` 铸造）。

所以归零做的是**四件事同时发生**：拆客户端对象层作用域 + 从实例表丢弃 + 从投影 store
表移除 + 关闭该会话的逻辑流（发一个 `cancel` 帧）。**不是"停止发布"**——发布动作由
`publishRetention`（`service.ts:562-574`）完成，恰恰是在归零时把该行的 `retainedBy`
刷成 `{}`。

**host 上不动任何东西**：agent 不停、文件不删、也不留"这个会话没人看了"的标记。
host 唯一感知到的是一个 `streamId` 的逻辑流被取消。

一处必须写明的**例外**：跟随一个**已持久化（prepared）**的会话时，host 会在**开流**
那一刻做一次 promote，把冷会话激活成 live Agent（
`packages/api/session-controller/src/history.ts:204-212` 的 `source.retain()` →
`this.promote(...)` → `packages/api/session-controller/src/index.ts:201-212`）。这个激活
**不随客户端取消而回滚**：它挂在 host 自己的 `this.promotions` 任务集上
（`index.ts:210`），`index.ts:146-150` 的注释也明确"先关所有 follower，再等已受理的
promotion"。所以"订阅一个冷会话"是有宿主副作用的——但那个副作用来自**开流**，不是
来自**归零**。

**结论**：计数归零既不停发布，也不回收会话，也不关连接；它关掉那个会话自己的逻辑流
并从客户端对象层摘除实例。多个消费方看同一个会话时共用同一个计数与同一条逻辑流——
这正是 `retainInfo` 能按 source 分列计数的原因。

### 1.3 上游引用来源有哪几类，各自在哪一行 retain

source 标签是一个可声明合并的映射，基座只有两项：

```ts
// packages/api/session-controller/src/client/index.ts:80-88
export interface SessionReferenceSourceMap {
  /** Temporary Client Controller work, including fork-title preparation. */
  controllerOperation: unknown
  /** A Client Gateway invocation's synchronous Context ownership. */
  gateway: unknown
}
export type SessionReferenceSource = Extract<keyof SessionReferenceSourceMap, string>
```

各 feature 插件通过 declaration merging 追加。**生产代码里共 10 个标签**：

| source | 声明处（interface 合并） | 实际 retain/using 调用点 | 消费方是什么 |
|---|---|---|---|
| `controllerOperation` | `packages/api/session-controller/src/client/index.ts:82` | **无生产调用点**（全树只有测试用，如 `tests/sessions-service.client.spec.ts:158`） | 无。JSDoc 说"含 fork 标题准备"，但 `fork` 实走 `manager.fork()`/`manager.rename()`（`service.ts:451-473`），不取引用 |
| `gateway` | `packages/api/session-controller/src/client/index.ts:84` | `.../sessions/service.ts:491`（经 `client/index.ts:144`） | 一次 Client Gateway 调用对 Agent-scoped Context 的同步持有 |
| `mainView` | `packages/client/ui-session/src/client/index.ts:183-185` | `packages/client/ui-workspace/src/client/navigation.ts:382` | 会话列表里选中的"主视图"（对话区当前会话）；ui-session 只读计数 |
| `sidebarView` | `packages/client/ui-sidebar-right/src/client/session-view.ts:7-9` | `packages/client/ui-sidebar-right/src/client/session-view.ts:33` | 右侧栏里打开的一个会话视图 |
| `workspaceOperation` | `packages/client/ui-workspace/src/client/index.ts:80-82` | `packages/client/ui-workspace/src/client/index.ts:162` | 重命名会话这一目录操作 |
| `commandCatalog` | `packages/client/ui-commands/src/client/service.ts:40-43` | `packages/client/ui-commands/src/client/service.ts:103` | 斜杠命令目录拉取 |
| `skillCatalog` | `packages/client/ui-skill/src/client/index.ts:51-54` | `packages/client/ui-skill/src/client/index.ts:115` | skill 目录拉取 |
| `goalActivation` | `packages/client/ui-goal/src/client/index.ts:44-47` | `packages/client/ui-goal/src/client/index.ts:107` | goal 条带的实时读取 |
| `referenceCandidates` | `packages/client/ui-reference/src/client/index.ts:34-37` | `packages/client/ui-reference/src/client/index.ts:62` | `@` 提及的候选（文件 + 会话） |
| `sidebarChat` | `packages/client/ui-subagent/src/client/sidebar-chat/index.tsx:30-32` | `packages/client/ui-subagent/src/client/sidebar-chat/index.tsx:109` | **子代理面板**：侧栏里一个子代理会话的只读对话体 |

**关于"子代理面板"那一条**：issue 问的"挂着的 subagent 面板"就是 `sidebarChat`
（`sessions.retain(address, { source: 'sidebarChat', signal })`，`index.tsx:109`；
`address` 是 `SubagentAddress`，注册点在 `.../sidebar-chat/index.tsx:176-198` 的
`registerSidebarChat`）。它**存在**，只是不在我最初只扫 `.ts` 的那一遍里——
**它在一个 `.tsx` 文件里**。另有 `packages/client/ui-agent-preset/src/client/index.ts:86`
与 `packages/experimental/client-ui-agent-team/src/client/mount.ts:40` 这两处**读**
`retainedBy.mainView`，它们只是消费计数、不新增 source。
`packages/experimental/**/src` 里没有任何 source 声明。

另外，测试替身按同一形状再实现一份（
`packages/test-support/client-runtime/src/sessions.ts:25-30`），可见这套计数
是**框架级契约**，不是某个 UI 页面的临时状态。也有一处声明位于测试文件内
（`packages/api/session-controller/tests/reference-ownership.client.spec.ts:14-19`）。

`gateway` 这条最容易被忽略，单独说清楚：`client/index.ts:141-147` 把
`ClientSessions.retainAgentScope(sessionId)` 注册成 Typert 的 client 侧 Agent
Context 解析器，用 `typertOwnedValue(...)` 绑定生命周期——

```ts
// packages/api/session-controller/src/client/index.ts:144-145
const reference = sessions.retainAgentScope(sessionId)
return typertOwnedValue(reference.binding.ctx, () => { reference.release() })
```

**取引用**发生在宿主转发一条 Agent-scoped waterfall 时：客户端
`ClientRemoteEvents.answer()` 调 `adapter.resolve(frame.agentId)`
（`packages/api/gateway/src/client/remote-events.ts:191-194`）→
`retainAgentScope`（`service.ts:489-492`，**同步、不校验 catalog**，注释明说
"without history or catalog I/O"）→ `retainScope(id, 'gateway')`。**释放**在同一次调用的
`finally`（`remote-events.ts:225-227` 的 `owned?.[Symbol.dispose]()`）。所以
"一次 Remote 调用携带 Agent 身份"这件事本身**会短暂地 +1**，使被寻址的作用域
Context 在调用结束前不被拆掉。

注意一处**校验不对称**：普通 `retain` 遇到未知 id 会抛错
（`.../sessions/manager.ts:136-143` 的 `sessions.retain: unknown session`），
`gateway` 路径**故意绕过**（`service.ts:489-492`）。

还有一处**用引用计数当答案**的用法值得记录（它不是"又一个来源"，而是计数的反向
读取）：主视图并不是另存一个"当前会话"指针，而是从计数里读出来——

```ts
// packages/client/ui-session/src/client/index.ts:437-443
const currentIsMain = currentId !== undefined
  && (this.sessions.retainInfo(currentId).getSnapshot().retainedBy.mainView ?? 0) > 0
const nextId = currentIsMain
  ? currentId
  : Object.values(byId).find(candidate => (candidate.retainedBy.mainView ?? 0) > 0)?.id
```

`watchMainRetention`（`ui-session/src/client/index.ts:452-459`）订阅 `retainInfo`，
让计数的变化直接触发 UI 重新选主。

### 1.4 五点补充事实（会影响搬运判断）

- 计数是**纯内存**的：`ScopeRecord.retention` 没有任何持久化路径。契约写得很直白：
  `contract/sessions.ts:41` —— "Local ownership counts, independent of catalog
  membership and **never persisted**." 刷新页面即归零重建。
- 计数是**每个客户端各一份**：`ClientSessions` 由客户端插件的 `apply` 构造
  （`packages/api/session-controller/src/client/index.ts:115`）并经
  `ctx.reflect.provide('sessions', this, undefined)`（`service.ts:279`）暴露。
  两个浏览器 = 两份独立计数；host 不合并、也不知道任何一份。
- **`retain` 会顺带实例化整个对象层**：`retainScope` 的
  `?? this.materializeScope(id)`（`service.ts:534`）→ `createScope` +
  `manager.get(id)`（`service.ts:588-606`）→ `Session.bindScope`。所以"取引用"不只是
  加一，它是客户端 `Session` 实例的创建触发器。
- **`retainInfo` 的观察者永久驻留**：`retainObservers`（`service.ts:245`）从不删除；
  契约明说它 "remains allocated until the Client root is disposed, even after its
  final subscriber leaves"（`contract/sessions.ts:69-72`）。
- **取消等待 ≠ 取消打开**：`service.ts:166-178` 的注释是
  "A cancelled waiter releases only its own reference, not the shared opening."——
  被 abort 的 `ready` 只是自己退出，共享的 `Session.open()` 继续跑。
- **一处类型漂移**（不影响行为，但会误导搬运）：`retainedBy` 被写进列表行
  （`service.ts:562-574`、`:622`、`:646`、`:671`），但渲染用的扁平行类型
  `SessionListEntry`（`.../sessions/lineage.ts:17-35`）**没有声明**该字段；而
  `lineage.ts:70-74` 只剔除 `agentAvailable` 后整体展开。因此
  `list.getSnapshot().items[i]` 运行时带着 `retainedBy`，类型上看不见。全树没有消费者
  读它——都读 `byId[...]` 或 `retainInfo(id)`。

---

## 二、客户端的窗口与基线

### 2.1 开场基线由谁决定：**客户端提出边界，服务端给一份完整快照**

不是"服务端自己挑一个窗口推过来"，也不是"客户端说给我 N 条原始事件"。请求的边界由
客户端在打开时写死：

```ts
// packages/api/session-controller/src/client/sessions/session.ts:51-62
/** Minimum message count for ordinary history windows. */
export const PAGE_MESSAGES = 50

const HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: PAGE_MESSAGES, minTurns: 2 } }

/** Minimum messages per page while a turn jump loops backwards. */
export const JUMP_PAGE_MESSAGES = 200
```

`HISTORY_PAGE_OPTIONS` 被 `Session.doOpen` 用作 `events.open(...)` 的实参
（`.../sessions/session.ts:631`），而 `RemoteJournalStream` 会把它当
`initialRequest` 留着，重连与补洞时由 `repairRequest` 派生
（`.../client/transport.ts:238-245`）。所以 **500 条消息 / 至少 50 条且至少 2 个 turn
是客户端的选择**；host 只是它的下界兜底：

```ts
// packages/api/session-controller/src/history.ts:38
const DEFAULT_MAX_MESSAGES = 50
```

`:103` 与 `:184` 两处都是 `request.maxMessages ?? DEFAULT_MAX_MESSAGES`，
`:320-334` 做校验（`maxMessages` 必须是正整数；`turnWindow.minMessages` 不得大于
`maxMessages`）。分页本身是**从尾部往前**截的，见 `history.ts:395-421`
（命中 turn 起点即停，或到 `maxMessages` 即停）。

**"两个东西"必须分清**，这是本节最容易出错的地方：

- **开启路径根本不发 `session.page`**。`readPage` 只被 `prepend`
  （`journal-stream.ts:190`）与缺口修复（`:347`、`:409`）调用。跟随的**首帧 snapshot
  就是基线**，由 gateway 直接落窗、无第二次调用（`journal-stream.ts:288-303`）。
  测试把这一点钉成契约：开启后 `expect(mock.log.requests(PAGE)).toEqual([])`
  （`packages/api/session-controller/tests/session.client.spec.ts:89-90`）。
- **两者的线上形状不同**：follow snapshot 携带
  `header/cursor/records/hasMore/projections/assistantStream`
  （`.../src/types.ts:552-561`），而 `SessionPage` 只有 `records/hasMore`
  （`types.ts:545-549`）。注释也明说
  `/** Opening metadata carried only by a follow snapshot, never by loadOlder pages. */`
  （`.../client/transport.ts:43-47`）。

所以开场基线是"一份完整快照 + 它自己的游标"，而不是"先给个页、再补元数据"。
快照上记录的 `cursor` 就是后续所有读的**同步游标**：`session.page` 请求必须带显式
`throughSeq`（`types.ts:474`、`history.ts:79-98`），该值是**包含式**切点
（`history.ts:399` 的 `Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1)`）。
观察期间提交的事件会被缓冲、在快照之后按序发出，见
`.agents/notes/implemented/architecture/2026-08-18-session-history-and-event-transport.md:184`。

### 2.2 本地窗口是原子替换还是追加：**两者都有，替换是每次新代的入口**

本地窗口是 `MutableSessionEventSource`（
`packages/api/session-controller/src/client/contract/events.ts:120-205`），内部是一棵
不可变的 rope（`EventWindowLeaf` / `EventWindowConcat`，`:37-50`）：

```ts
// packages/api/session-controller/src/client/contract/events.ts:148-151
replace(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void {
  this.window = leaf(entries)
  this.publish(hasMore, { kind: 'replace', entries })
}
```

追加走 `concat(this.window, leaf(entries))`（`:167-174`），前插走
`concat(leaf(entries), this.window)`（`:158-161`）。每次变更都同步推一个新 `revision`
与一条**精确 delta**（`SessionEventChange`，`:97-106`）。

"原子替换"落在 `RemoteJournalStream.replaceFromOpening`
（`packages/api/gateway/src/client/journal-stream.ts:289-303`）：一次生成的开场页在
校验完"页尾游标等于开场游标"（`assertPageThrough`，`:574-579`）之后，整块发一条
`replace`。消费侧 `Session.acceptEventChange` 的 `case 'replace'`
（`.../sessions/session.ts:648-655`）进 `installWindow`（`:667-690`），其中 `:687` 是
一次性 `this.eventSource.replace(visible, hasMore)`。所以是**一次性整体换**，不是"逐条
累加再对账"。而且晚到的结果不会覆盖更新的状态：

```ts
// packages/api/session-controller/src/client/sessions/session.ts:621-623
publish: (change) => {
  if (generation !== this.openGeneration || this.events !== events) return
  this.acceptEventChange(change)
},
```

**重叠消解**（三个入口各不相同，值得分开记）：

- **新代开场**：整块换，旧的 prepend 历史随之从内存消失（`replaceFromOpening`）。
- **live 追加**：`acceptEntry` 丢掉 `cursor <= last` 的回放帧、对"部分重叠"报协议违规
  （`journal-stream.ts:310-316`）。
- **补洞**：页请求与实时追加并发时，`readPageWhileFollowing`（`:397-445`）把实时 entry
  收进 `queued`、把通知收进 `notifications`；`mergeReplacement`（`:473-493`）按游标排序、
  丢掉已被页覆盖的、遇到不连续就返回 `undefined` 触发第二页；最后**只发一条** `replace`
  （`:385-390`），通知在其后补发（`:391-393`）。旧窗口在整段修复期间一直可读。

另外，**历史前插也会去重**：`prepend` 只收 `first < firstCursor` 的条目，并要求尾部紧接
头（`journal-stream.ts:194-203`）；不连续时发一条空 prepend 并 fail-soft，而不是默默拼
上去。

### 2.3 中心问题——**证实**：客户端窗口代码里没有任何淘汰常量，被引用的会话窗口持续增长

我按"找淘汰"的思路查了这些地方，结论一致：**没有淘汰**。

1. 窗口本身只有 `replace/prepend/append/settleAssistant` 四个变更入口
   （`contract/events.ts:148/158/167/181`），没有 `trim/evict/cap/slice/splice`，
   也没有字节或条数预算。`append` 只做一件事：`concat(this.window, leaf([entry]))`。
2. 会话对象里也没有。`.../sessions/session.ts` 的窗口相关方法只有 `installWindow`
   （`:667-690`）、`prependWindow`（`:737-748`）、`appendLive`（`:751-761`）；
   `baseSeq` 只是记录窗口头部的 seq（`:678`、`:745`），不是上限。
3. 历史拉取是**只增不减**的：`loadOlder` 走 `events.prepend(...)`（`:408-413`），
   跳转走 `JUMP_PAGE_OPTIONS` 循环 `prepend`（`:427-461`），两条路都只往窗口里加。
4. 唯一边界常量是**每次拉多少**，不是**最多留多少**：
   `HISTORY_PAGE_OPTIONS.maxMessages = 500`、`JUMP_PAGE_MESSAGES = 200`
   （`session.ts:54`、`:57`）。`hasMore` 表达的是"host 侧还有更旧的"，不是"窗口满了"。
   附带一个疑点：`PAGE_MESSAGES` 与 `JUMP_PAGE_MESSAGES` 虽然被 `export`
   （`session.ts:52`、`:57`），全树却查不到消费者，意图无法从代码确认。
5. 换手的是**瞬态行**，不是窗口：`settleAssistant`（`contract/events.ts:181-196`）
   把某个 attempt 的 `assistant/live-chunk` 行换成对应的落盘 entry，其余条目一条不动。

**穷举式 grep 证据**（避免"没找到"是搜得不够）：

- `maxEntries|MAX_ENTRIES|retainEntries|trim|evict|dropOldest|ringBuffer|maxBytes|budget|MAX_WINDOW|windowLimit`
  于 `packages/api/session-controller/src/client` → **零命中**；
- `MAX_|_LIMIT|LIMIT|SIZE` 同目录 → 只有搜索功能的 `SESSION_SEARCH_RESULT_LIMIT` /
  `..._SNIPPET_MAX_CODE_POINTS`；
- `implements SessionEventSource|class .*EventSource` 于 `packages` → 只有
  `MutableSessionEventSource`（`contract/events.ts:120`）一个实现；
- `evict|retention|trim|prune|discard|forget` 于客户端目录 → `retention` 就是第 1 节的
  会话实例引用计数，`pruneEngagement` 是列表簿记（`manager.ts:312-314`），
  `projection-store.ts:85`/`:186` 丢的是投影缓存行。**没有一条属于事件窗口。**

**唯一的释放点是实例寿命**：引用计数归零 → `retireScope` → `manager.drop`
（`service.ts:540-550`、`:576-585`；`manager.ts:184-191`）→ `Session.dispose()`
（`session.ts:599-611`）。在此之前窗口常驻。

因此总结 §9 那个未确认点成立：`RemoteJournalStream` 的类注释也把"保留已发布窗口"
当成本质属性而不是可调策略——

```
// packages/api/gateway/src/client/journal-stream.ts:86-88
* The domain retains its published window during reconnection. A replacement is
* published only after the opening page reaches the generation's cursor.
```

**边界要说准**：窗口相对**会话内容**是持续增长的；相对**引用**，它会在引用归零时随
整个 `Session` 实例一起被丢掉（第 1.2 节的收尾链）。也就是说：

- 一个长时间被主视图引用的会话，其内存窗口在整段被引用期间只增不减；
- "没人看"的会话不会因为窗口太大被回收——它只因为**没人引用**才被回收；
- `replace` 只在**新代开场与补洞**时触发，**不参与容量控制**。

**还有一笔要一并承担的代价**：rope 只是让追加便宜，不是让读取免费。
`windowSnapshot.entries` 是惰性记忆化的（`contract/events.ts:85-95`），每个 revision 的
**首次**读取要 O(n) 展平（`:60-77`），而 `settleAssistant` 每次都全量 `materialize`
（`:182`）。也就是说"不淘汰"买到的是追加成本，代价落在读取与瞬态结算上。

### 2.4 什么被丢弃且不补发

`assistant/live-chunk` 是**客户端独有**的瞬态行：它不占 durable 序号，而是合成一个小数
seq 插在 durable 游标之间（`.../sessions/assistant-stream.ts:88`、`:158`；类型见
`contract/events.ts:6-17`、`:20`、`:34-35`）。

窗口里两种都留（瞬态入窗 `session.ts:730-733`，durable 入窗 `:751-761`），但 journal
的 `append` 变更**只接受 durable**（`.../client/transport.ts:57`）；瞬态以**无游标通知**
抵达（`transport.ts:75-77`；`journal-stream.ts:247-253`、`:526-531`）。

不重放的具体触发点：

- **代替换**只发布新页的 durable，瞬态全灭；仅当前活 attempt 从前缀基线重建，且止于
  `nextIndex`（`assistant-stream.ts:84-99`，清空在 `:58-65`）；
- **settle** 折进 durable 后删行（`contract/events.ts:181-196`）；
- **无匹配 attempt 的 chunk** 静默丢弃（`assistant-stream.ts:144-148`）；
- **abandon** 不留下 durable 替代（`assistant-stream.ts:177-181`、`session.ts:721-724`）；
- **rebaseline** 走整条流 `restart()`（`session.ts:707-714`）。

一条连续性判据也在这里：assistant 帧的 `revision` 必须逐次 +1，跳号直接抛
`RemoteStreamCarrierError`，**借逻辑流的重开机制来修复**：

```ts
// packages/api/session-controller/src/client/transport.ts:206-213
if (frame.type === 'assistant-stream') {
  const expected = (assistantRevision ?? 0) + 1
  if (frame.frame.revision !== expected) {
    throw new RemoteStreamCarrierError(`session assistant stream skipped revision ${String(expected)}`)
  }
```

### 2.5 重连时窗口是否存活，何时被换掉

存活。`RemoteStream.read()` 在 carrier 失败后并不清空消费侧状态，它只是把失败交给重试
策略（`packages/api/gateway/src/client/remote-stream.ts:126-142`）；新一代的开场帧到齐并
校验通过后，才由 `replaceFromOpening` 发一条 `replace`（`journal-stream.ts:289-303`）。
`Session` 侧也不清窗：`resync()` 只处置流并重开（`session.ts:486-498`），错误路径只改
状态位（`:876-886`）。

一条硬约束值得单独记：重开的游标**不得落后于已应用的最后一条**，否则判协议失败并终止
（`journal-stream.ts:277-282`）。这是"不允许悄悄回退"的机制本体。

---

## 三、概况与内容分道

### 3.1 四个事实各走哪条路

这是本节最要紧的一张表。要点是：**概况不是一个通道，至少三条**，而且"是否在跑"的权威
不在流里，在列表 RPC 的返回里。

| 事实 | 通道 | 协议身份 | 证据 |
|---|---|---|---|
| 投影值（title、`sessionListMetadata` 等） | `session.control()` 快照流 | **一条 host 全局逻辑流**（不是每会话一条） | `packages/api/session-controller/src/control.ts:42-53`、`:22-30`；`types.ts:566-581` |
| 是否在跑（running） | ①`api-session/status` 的 `$on` 通知（活的增量）②host `session.list` RPC 的 `running` 字段（基线）③`api-session/added` 里的 `running` | 一元通知 + 一元 RPC；**不在 control 流里** | 发射 `packages/api/session-controller/src/index.ts:180-182`；allowlist `packages/api/remotes/src/remote-events.ts:27`；host 行 `list.ts:114`；客户端 `client/index.ts:118-120` → `manager.ts:705-710` |
| 时间（列表序） | ①`api-session/activity` 的 `$on` 通知 ②列表行 `updatedAt = max(createdAt, lastPromptAt)` ③`sessionListMetadata.lastPromptAt` 投影 | 一元通知 + 一元 RPC + control 流 | 发射 `index.ts:196-197`；allowlist `remote-events.ts:23`；计算 `list.ts:327-329`；客户端合成 `manager.ts:764` |
| 标题 | ①control 流的 `projection` 帧 ②列表行的 `projections` 块 ③`session/rename` 的一元回显 ④follow 首页的 `projections` | 四种来源 | ①`control.ts:22-30`；②`manager.ts:657-671`；③`session.ts:372-378`；④`.../client/transport.ts:43-47` → `session.ts:686` |

`session.control` 的帧类型只有两种（`.../src/types.ts:579-581`）：

```ts
export type SessionControlFrame =
  | { readonly type: 'baseline'; readonly value: SessionControlBaseline }
  | ({ readonly type: 'projection' } & SessionProjectionUpdate)
```

**它明确不携带 running**——`SessionControlBaseline` 只有一个 `projections` 字段
（`types.ts:566-568`），而投影键表里没有 `running`：基座只有 `sessionListMetadata` /
`imageLimits` / `modelSelection`（`types.ts:15-31`），`title` 由
`packages/session/session-title/src/index.ts:263-270` 追加。所以 running 永远不可能从
control 流来。这与 note 的说法一致：
`.agents/notes/.../2026-08-18-session-history-and-event-transport.md:216`
"Session added, removed, activity, running status, and Agent error without a turn
position do not enter the stateful control stream; they are `ctx.remote.$on`
notifications that are either repairable from a list baseline or need no replay."

**没有任何一个事实走 transcript 内容流**。内容流是每会话一条 `session.follow`
（`.../client/transport.ts:179-183`），只产出 `replace/prepend/append/assistant-stream`
（`transport.ts:50-58`）。侧栏不读它：`projectList`（`service.ts:609-680`）只读
`manager.getListSnapshot()`。

### 3.2 投影 store 由谁维护

客户端是 `SessionManager` 持有的**每会话一个** `ProjectionValueStore` 字典，而 list 行
只是它的一个**只读投影**：

```ts
// packages/api/session-controller/src/client/sessions/manager.ts:96-101
/** Per-session projection value stores, retained independently of instance arrival (the
 *  title-snapshot precedent, generalized): push frames land here whether or not the Session
 *  is instantiated (list rows read the 'title' key), and an instantiated Session adopts the
 *  same store so history-baseline seeding and frames converge on one row set. */
private readonly projectionStores = new Map<SessionId, ProjectionValueStore>()
```

写入入口是 `handleControlFrame`（`manager.ts:619-626`）：baseline 走
`replaceControlBaseline` → `store.seed(...)`（`:628-636`），增量走
`store.apply(frame.key, frame.value, SessionSeq(frame.seq))`（`:624`）并
`notifier.markDirty()`。同一批 store 也被列表块与页基线写（`applyListBlock`，`:657-671`；
页上的 `projections` 经 `manager.ts:562` 落地），并按 `kind: 'sequenced' | 'cached'`
决定能否与当前连接的 seq 比较（`types.ts:58-69`）。合并规则：higher-seq-wins
（`projection-store.ts:159-166`），`cached` 只填没有 `sequenced` 行的键（`:176-182`）。

同一实例被 `Session` **采纳**（`manager.ts:286`：
`projections: this.projectionStore(sessionId)`），所以历史基线播种与 control 帧收敛到
**同一份行**。store 最终被投影进 `SessionListState.projectionsBySession`
（`manager.ts:793`）与每行的 `projectionValues`（`service.ts:625-627`）；列表行读 title
在 `manager.ts:756-757`。

**结论**：既不是每会话私有实例，也不是 host-wide 单例——是 **manager 作用域的
per-session store 字典**；`ClientSessions.list` 是它的只读投影。

### 3.3 更新时机，以及"没人 retain 的会话是否照常更新"

**是，照常更新。** 触发点共五类——control baseline、control delta、`$on` 通知、
list 刷新、RPC 回显——**没有一类检查引用计数或 transcript 流**。

1. control 流由客户端插件在 `apply` 里创建并随连接代启动，与任何会话的引用无关：

```ts
// packages/api/session-controller/src/client/index.ts:128-140
const control = createSessionControlStream(remotes, {
  accept: (frame) => { sessions.handleControlFrame(frame) },
  failed: (error) => { console.error('[session-controller] control stream failed:', error) },
})
const connected = (): void => {
  if (connection.generation.getSnapshot() === undefined) return
  sessions.handleConnected()
  control.restart()
  control.start()
}
```

它的 host 端基线读的是 `this.ctx.sessions.list()`
（`packages/api/session-controller/src/control.ts:55-59`），即 host 的 live 会话列表，
**不 resume 任何 agent**（note 亦如此说，`:208`）。

2. `$on` 通知在客户端插件里注册一次，与引用无关（`client/index.ts:116-126`）：

```ts
// packages/api/session-controller/src/client/sessions/manager.ts:705-710
handleSessionStatus(sessionId: SessionId, running: boolean): void {
  if (!this.disposed && running) this.engagedSessions.add(sessionId)
  this.recordMutation({ kind: 'status', sessionId, running, agentAvailable: true })
  this.updateParentAvailability()
  this.sessions.get(sessionId)?.handleRunning(running)
}
```

`this.sessions` 是**实例**表，`?.` 在无实例时静默跳过；`recordMutation` 直接改
`this.summaries` 并 `markDirty()`（`manager.ts:577-582`）。**没有一处检查
`retainedBy`。** 投影 store 同样是实例无关的（上引 `manager.ts:96-101` 注释明说
"push frames land here whether or not the Session is instantiated"）。

3. 重连时 `handleConnected()`（`manager.ts:736-749`）清空所有投影 store、丢掉在途列表
   请求、重新 `refreshList()`，并用 queryable baseline 修复。running 就靠这次列表刷新
   回来（host 行里 `running: this.ctx.agents.get(session.id)?.status === 'running'`，
   `list.ts:114`）。

**两条必须一并说清的成立条件**：

- **`status` 与 `activity` 只改不插**：`applyMutation` 的 `case 'status'`
  （`manager.ts:831-837`）是 `summaries.map(...)`，注释写着"Running converts display
  state; it does not establish durable history."；`case 'activity'`（`:838-842`）也只在
  `updatedAt >` 时更新。所以 running 通知要落进**侧栏行**，该 sessionId 必须已经有一行
  ——来自 list 拉取或 `api-session/added` 的 upsert（`:805-807` 起才允许插入）。而"没人
  retain"恰恰不影响这一点：行来自 host 的 `session.list`（`list.ts:126-144`，遍历
  `sessionQuery.listSessions`），与客户端保留无关。
- **UI 侧还有一条完全绕开 list 行的通道**：`ui-session` 自己维护
  `private readonly running = new Map<SessionId, boolean>()`
  （`packages/client/ui-session/src/client/index.ts:284`，写入在 `observeRunning`，
  `:483-491`；`publishStatus` 把它并入 id 集，`:520-526`）。侧栏最终取
  `status?.running ?? s.running`
  （`packages/client/ui-workspace/src/client/tree.ts:410`，另一处在 `:609`），即
  **通知态优先、list 行兜底**。

所以"概况照常更新"这条**证实**，而且比总结说的更强：概况的正确性根本不依赖任何流是否
开着，只依赖 ①连接代的 control 流 ②一元列表 RPC。反向也成立——**概况的更新不需要、
也不会建立任何会话引用**。

（保留一处怀疑：以上是**读码推导**，我没有运行任何测试。推导链完整，但没有找到专门
断言"无人 retain 时侧栏仍更新"的 spec。另外若 host 侧根本没有 live Agent，就不会有
running 通知，那时 running 只能来自 list 的 `false` 快照。）

### 3.4 协议层：分开的两条流，还是同一条流上的另一类帧

**分开。** 三层身份必须分开说：

| 层 | 身份 |
|---|---|
| 物理 | 一个页面**一条** WebSocket，固定路径 `/api/remote.mux`（`stream-protocol.ts:6-7`；客户端只持有一个 `socket` 字段，`stream-client.ts:51-53`；host 每连接一个 `RemoteStreamMuxConnection`，`stream-server.ts:135-136`） |
| 逻辑 | 每个业务端点**一条独立 `streamId`**（`stream-client.ts:106` 的 `randomUUID()`；开帧 `{type:'open', streamId, endpoint, payload}`，`stream-protocol.ts:236-241`） |
| 一元 | `POST /api/<ns>/<method>`，**不在 mux socket 上**（`.../client/index.ts:445`；底层 `packages/client/connection/src/client/rpc.ts:48-57`） |

逐个端点的逻辑流身份：

| 端点 | 逻辑流数量 | 开流点 |
|---|---|---|
| `session/control` | **每 client 页一条** | `.../client/transport.ts:119-126` |
| `session/follow` | **每个被打开的会话一条** | `.../client/transport.ts:179-183` |
| `$events` | **每连接代一条** | `packages/api/gateway/src/client/remote-events.ts:132-136`（端点常量 `stream-protocol.ts:10`） |

**不是"一条流上多一类帧"。** `$events` 确实是一条流上承载多类帧
（`ready/emit/waterfall/cancel`，`stream-protocol.ts:34-71`），但概况与内容的分道不是
这个维度的分法：control 与每个 follow 各有自己的 `streamId`，在 mux 上并行。

"是流还是一元"由生成描述符的 `mode` 决定（`.../client/index.ts:425-427`），
`mode: 'stream'` 来自 host 装饰器
（`packages/api/session-controller/src/index.ts:479-482`、`:514-522`），被 codegen 写进
描述符并被客户端逐个 `$mount`。

### 3.5 `session.control()` 的形状：host 全局一条，不是每会话一条

Host 端签名**没有 sessionId 参数**（`packages/api/session-controller/src/index.ts:514-522`），
`SessionControlController` 的注释就是 "Owns the Host-wide Session control stream"
（`control.ts:16-18`），内部 `private readonly streams = new Set<ControlQueue>()`（`:18`）
——每个**客户端**一条队列，每个队列先发一次完整 baseline（`control.ts:47`），之后只发
替换帧。

baseline 覆盖的是 host 进程内 live 会话集合（`control.ts:55-59` →
`this.ctx.sessions.list()`），而 `sessionId` 在**帧内**
（`types.ts:571-576` 的 `SessionProjectionUpdate.sessionId`）。

客户端只在 plugin `apply` 里创建**一次**（`client/index.ts:128-140`），`restart()` 只换
物理代、不新增逻辑流（`snapshot-stream.ts:52-55`）。

**所以一个有 50 个会话的 client 是：1 条 control 流 + 最多 1 条 `$events` + 最多 50 条
按需打开的 `session/follow`**，而不是 50 条 control 流。

---

## 四、重连的两层

### 4.1 物理层：退避表在哪、由谁拥有

**退避表**（而不是硬编码循环）在
`packages/client/connection/src/recovery-config.ts:25-31`：

```ts
export const ConnectionRecoveryConfigSchema: z<ConnectionRecoveryConfig> = z.object({
  backoffBaseMs: z.natural().min(1).max(MAX_TIMER_MS).default(500),
  backoffFactor: z.number().min(1).max(Number.MAX_VALUE).default(2),
  backoffMaxMs: z.natural().min(1).max(MAX_TIMER_MS).default(10_000),
  generationReadyWarnMs: z.natural().min(1).max(MAX_TIMER_MS).default(3_000),
  generationReadyTimeoutMs: z.natural().min(1).max(MAX_TIMER_MS).default(15_000),
})
```

对总结所称"500ms → 1s → 2s → 4s → 8s → 10s 带抖动"，判定是**部分证实，且方向要说准**：

- 步长与上限对：`backoffCap(attempt) = min(10000, 500 * 2 ** (attempt - 1))`
  （`packages/client/connection/src/client/connection.ts:139-142`），cap 序列正是
  500 / 1000 / 2000 / 4000 / 8000 / 10000 / 10000…
- **抖动不是"加一点"，是只向下取容量的 50%–100%**：

```ts
// packages/client/connection/src/client/connection.ts:144-147
private backoffDelay(attempt: number): number {
  const cap = this.backoffCap(attempt)
  return cap / 2 + Math.random() * (cap / 2)
}
```

  所以第一轮的真实等待是 **250–500ms**，不是 500ms。把 500/1000/… 读成实际延迟是
  错的；它是 **cap 表**。JSDoc 也写明 "actual delay is 50–100% of the cap"
  （`recovery-config.ts:6`）。
- 表里还有两条总结没提的：握手慢警告 3000ms 与**硬截止 15000ms**
  （`recovery-config.ts:16-18`，实现 `connection.ts:288-322`）。也就是说重连的"一次尝试"
  有一个上界，到点即取消该代并进入重试。
- **没有重试次数上限**，只有延迟上限（`backoffMaxMs`）。

**谁拥有重试节奏**：是 `ConnectionController`，而且它调度的**不是 WebSocket**，是"一条
宿主可用性握手流"。这是本节最反直觉的一点：

```ts
// packages/client/connection/src/client/connection.ts:196-198
console.warn(`[connection] connection lost, retry #${String(attempt)}`)
this.callSink(() => { this.sinks.onReconnectRequested?.() })
```

```ts
// packages/api/gateway/src/client/index.ts:169-174
loop = connection.start({
  onConnected: () => { this.ownerCtx.emit('connection/reset') },
  onReconnectRequested: () => {
    if (connection.rpc.open === undefined) this.streams.reconnect()
  },
})
```

真正的物理替换在 `RemoteStreamMuxClient.reconnect()`
（`packages/api/gateway/src/client/stream-client.ts:72-86`）：递增 `revision`、拒绝候选
连接、把当前 socket 从 `this.socket` 摘掉、`failAll(failure)` 让所有逻辑流以
`RemoteStreamCarrierError` 失败、`socket.close(4000, 'reconnect requested')`，再
`maintain()` 建立新尝试。`maintain()` 本身**只做一次尝试、没有自己的定时器**
（`stream-client.ts:335-352`；全文件无定时器）。测试把这一点钉成契约
（`packages/api/gateway/tests/gateway.client.spec.ts:2938-2949`：socket 失败后仍只有
1 个 socket，只有 `client.reconnect()` 才产生第 2 个）。

所以三方分工是：

| 角色 | 拥有什么 |
|---|---|
| `ConnectionController` | **唯一的退避时间轴**（唯一 `sleep`/定时处，`connection.ts:164-268` 的 `loop`） |
| `RemoteStreamMuxClient` | **物理 socket 的替换执行**（`stream-client.ts:72-88`、`:335-352`、`:226-275`） |
| `RemoteStream` | **每个逻辑流自己的重开节奏**（无定时器，只有"立刻一次"或"等世代"两态） |

补充一个容易看错的地方：`ConnectionController` 打交道的"世代源"不是 mux socket 本身，
而是 `$events` **逻辑流**——`ClientRemoteEvents` 在构造时注册
`connection.registerGenerationSource(this.runGeneration)`
（`packages/api/gateway/src/client/remote-events.ts:78`），它打开
`REMOTE_EVENT_STREAM_ENDPOINT`（`:132-136`）这条普通逻辑流。所以 `$events` 的重试时机
完全交给 ConnectionController；其他逻辑流则靠 `RemoteStream` + 世代订阅。
`connection.rpc.open === undefined` 的守卫意味着 worker/进程内 carrier 根本不建 mux
socket（同文件 `:163`、`:229-232`）。

**什么触发重试**：

- socket `close`/`error` → `lost` → `failAll(RemoteStreamCarrierError)`
  （`stream-client.ts:247-266`、`:324-333`、`:354-359`）；
- 打开失败 / 被拒的 upgrade（`stream-client.ts:247-253`；host 侧 401/403 在握手前拒绝，
  `stream-server.ts:433-443`）；
- `$events` 世代源的任何失败，包括**意外正常结束**、opening 不是 `ready`、帧畸形
  （`remote-events.ts:169-183`，正常结束抛
  `'client api: forwarded Remote event stream ended unexpectedly'`）；
- 物理帧非法 → `failAll` + `close(4002)`（`stream-client.ts:306-322`）；
- 世代 15s 内不 ready（`connection.ts:288-302`）；
- 浏览器 `offline`/`online`（`packages/client/connection/src/client/index.ts:185-198` →
  `setNetworkAvailable`，`connection.ts:127-137`）。注意 **`online` 不是立即重连**：
  它只 abort 等待，随后仍要睡一次 backoff（`connection.ts:188-195`）；
- 用户显式重连（设置面板
  `packages/client/ui-settings-general/src/client/index.ts:124` →
  `connection.ts:113-121`，`attempt = 0` 且跳过 sleep）。

**什么不触发**：

- **mux 自身不会自愈**：socket 失败后若没人调 `reconnect()`/`start()`，不会再有第二次
  尝试（`stream-client.ts:335-352`）；
- 单个逻辑流的**正常 `end`**：mux 只是结束该流，是否重开由领域的 `ended(accepted)`
  决定（`remote-stream.ts:128`）；
- **业务 `RemoteError` / 协议违规**：直接终止该流，不重连（`remote-stream.ts:129-132`、
  `:206-213`；`journal-stream.ts:11-14`）；
- 已经 settle 的流的迟到帧：`this.streams.get(frame.streamId) === undefined → return`，
  静默丢弃（`stream-client.ts:311-312`）；
- `dispose()`/`close()` 之后（`stream-client.ts:63`、`:73`、`:336`）；
- 离线期间不是"触发"而是**压制**：loop 顶部在 `!networkAvailable && !immediateRetry`
  时挂起（`connection.ts:167-176`）。

### 4.2 逻辑层：每条流自己重开、拿新基线

在 `packages/api/gateway/src/client/remote-stream.ts` 的 `RemoteStream.read()`
（`:95-157`）。`RemoteStreamCarrierError` 的唯一捕获点是 `:129-142`，策略由这个函数给出
（**无定时器**）：

```ts
// packages/api/gateway/src/client/remote-stream.ts:160-170
async function waitForRemoteStreamRetry(
  connection: Pick<ConnectionHandle, 'generation'>,
  error: RemoteStreamCarrierError,
  attempt: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  if (connection.generation.getSnapshot() !== undefined) {
    if (attempt === 1) return
    throw error
  }
```

翻成人话：`RemoteStreamCarrierError` 是**唯一**允许重试的失败（`:132`；其他错误立刻
`terminalStreamFailure`，`:206-213`）。若 host 仍然可用（存在当前连接代），**只允许一次
独立重开**，第二次直接终止；若 host 已不可用，就等一个新的连接代出现（`:171-196` 订阅
`connection.generation`），等待可被信号中止。`accept()`（`:119-123`）在开场基线被消费方
验收后把 attempt 归零——即"这一代的开场基线被领域校验通过"才算健康。`restart()`
（`:62-66`）只换当前物理代、保留逻辑流（用于 `session.ts:711` 的 resync）。

**"正常结束"也是重试入口之一**，而且分类很讲究：

```ts
// packages/api/gateway/src/client/journal-stream.ts:118-122
ended: accepted => accepted
  ? new RemoteStreamCarrierError(`${options.name} ended without a terminal result`)
  : protocolViolation(
    `${this.hasResumeCursor ? 'resumed ' : ''}${options.name} ended before its opening cursor`,
  ),
```

即：基线**已接受**后正常结束算 carrier 失败并重开；基线**之前**结束是终止性协议违规。

**对会话日志，新基线怎么来、窗口怎么换**：

1. 新物理代的第一帧带 `generation` 号（`remote-stream.ts:109`、`:116`）；
   `RemoteJournalStream.consume` 发现世代变了就整体替换：

```ts
// packages/api/gateway/src/client/journal-stream.ts:243-245
if (item.generation !== this.generation) {
  this.replaceGeneration(item, true)
  continue
}
```

2. `opening()` 校验新游标**不得落后**于已应用的最后一条，然后记录世代并 `accept()`：

```ts
// packages/api/gateway/src/client/journal-stream.ts:277-285
if (resumed && this.lastCursor !== undefined
  && this.options.compare(cursor, this.lastCursor) < 0) {
  throw protocolViolation(
    `${this.options.name} resumed at a cursor behind the last applied entry`,
  )
}
this.generation = item.generation
item.accept()
```

3. `replaceFromOpening()`（`:289-303`）用这一代的 opening page **原子替换**窗口并发
   `replace`。
4. 每次 reopen 都重新要一份**丢掉窗口约束**的 tail page：`follow()` 用
   `...this.repairRequest(request)` 调 `remote.session.follow`
   （`.../client/transport.ts:179-183`），而 `repairRequest` 把
   `maxMessages/turnWindow` 全部丢掉、只保留可空的窗口字段（`transport.ts:238-245`）。
5. **补洞 + 去重叠**：发现 `!follows(last, first)` 时走 `replaceThrough`
   （`journal-stream.ts:316-330`、`:338-395`），读一页覆盖到该游标，再由
   `mergeReplacement`（`:473-493`）合并：完全重复的丢掉、部分重叠的报协议违规、仍不连续
   就二次读页；第二次仍不达目标则 `'page did not reach its opening cursor'`
   （`:377-379`）。
6. 修复期间到达的 cursorless notification 被扣住，在 replace 提交后才发（`:391-393`）；
   被更新世代取代则连同旧页一起丢弃（`:327-329`、`:435`、`:465`）。
7. 领域侧落窗是 `Session.acceptEventChange` → `installWindow`
   （`.../sessions/session.ts:648-655`、`:667-690`）：重设 `baseSeq`/`hasMore`、播种
   projection 基线（`:686`）、`eventSource.replace(visible, hasMore)`（`:687`）、重建
   Assistant 瞬态基线（`.../sessions/assistant-stream.ts:58-102`）。

另外，**通知层面的缺口检测也能触发重开**：Session journal 把 assistant-stream 的
`revision` 序列当作逻辑连续性，跳号就抛 `RemoteStreamCarrierError`（§2.4 引文），而每次
opening snapshot 必须带 assistant 基线，否则报 `gateway/internal`
（`transport.ts:186-192`）。assistant 基线缺失时领域还会主动 `restart()`
（`session.ts:707-714`）。

### 4.3 三个独立计数器

| 计数器 | 声明 | 递增处 | 防止什么 |
|---|---|---|---|
| Gateway stream generation | `RemoteStream.read()` 的局部 `generation`（`remote-stream.ts:97`） | `:109` `const generationId = ++generation` | 旧物理代迟到的条目被当成新一代的数据（校验点 `journal-stream.ts:243`、`:435`、`:465`；`snapshot-stream.ts:72-75`） |
| Connection generation | `ConnectionController.generation`（`connection.ts:78`） | `:201` `const gen = ++this.generation` | 被取代的连接代迟到的 ready/失败结算写进当前状态（`connection.ts:217`、`:224`） |
| Session business open epoch | `Session.openGeneration`（`session.ts:105`） | `:488`（resync）、`:607`（dispose）、`:879`（failEventStream） | 地址替换/dispose/失败之后，在途的 `doOpen` 或 jump 分页把旧窗口写进已被换掉的流（`session.ts:622`、`:632`、`:635`） |

note 的 `:82` 就是这个三分法，与源码一致。三条计数在代码里**从不互相读写**，
这是它能成立的原因。

代码里另有两个**容易混淆但不在上述三个之列**的计数器，都是同一 id 的局部守卫：
`RemoteStreamMuxClient.revision`（`stream-client.ts:55`，`reconnect()` 时递增，`:76`，
用于拒绝旧 revision 的等待者 `:344`）与 `RemoteStream.revision`
（`remote-stream.ts:44`，`restart()` 时递增 `:64`，用于丢弃被重启世代的产物
`:114`、`:127`、`:131`）。

顺带说明：session-controller client 里**没有任何标识符叫 `epoch`**；
"business open epoch" 是 note 对 `Session.openGeneration` 的称呼。

### 4.4 "通知类不重放"在代码里的体现

规则由代码机械保证，而**不是**靠"清空一个队列"——它靠**根本不存在缓冲**。

**① emit 通知无持久载体。** host 的 `broadcastRemoteEvent` 直接往**当前**每个客户端的
队列里推，没有历史、没有持久化：

```ts
// packages/api/gateway/src/index.ts:539-547
private broadcastRemoteEvent(frame: TypertRemoteEventFrame): void {
  assertRemoteEventFrame(frame)
  const wire: RemoteEventEmitFrame = { type: 'emit', event: frame.event, args: frame.args }
  for (const client of this.remoteEventClients.values()) client.queue.push(wire)
}
```

断线期间 `remoteEventClients` 里没有该客户端的条目 → 循环 0 次 → 通知**从未被记录**。

**② 每连接队列在代结束时被 `end()`**，其内容从此不可达：

```ts
// packages/api/gateway/src/index.ts:640-644
private removeRemoteEventClient(client: RemoteEventClient): void {
  this.remoteEventClients.delete(client.id)
  for (const pending of [...client.deliveries.values()]) this.removeRemoteEventDelivery(pending, client)
  client.queue.end()
}
```

`closeRemoteEvents()` 对**每个**队列 `end()`（`:670-675`）。所以断线时队列被关闭、随后从
表里删除，缓冲帧既不会被新代取走也没有别处引用。

**③ 上游源侧关闭时也明确丢弃 emit、只 reject waterfall**：

```ts
// packages/api/remotes/src/index.ts:96-104
private end(reason: unknown): void {
  if (this.done) return
  this.done = true
  while (this.buffer.size > 0) {
    const dispatch = this.buffer.popFront() as TypertRemoteEventDispatch
    if ('context' in dispatch) dispatch.reject(reason)
  }
```

`context` 只存在于 waterfall dispatch（`:143-155`），普通 `emit` dispatch 没有它，
因此被**静默丢弃**。

**④ 客户端侧同样没有跨代事件队列**：`deliver`
（`.../client/remote-events.ts:116-120`）只是 `parallel(...)` 派发一次；代结束时统一
abort 活跃 waterfall 并等它们落定（`:172-177`），随后该代结束。没有任何本地重放结构。

**⑤ 唯一会被重放的是"仍然 pending 的 waterfall"**，按 `pendingRemoteEvents` 重投，且
沿用同一 `eventId`：

```ts
// packages/api/gateway/src/index.ts:512-513
this.remoteEventClients.set(clientId, client)
for (const pending of this.pendingRemoteEvents.values()) this.deliverRemoteEvent(pending, client)
```

pending 只在 `startRemoteEvent` 登记（`:599`），结算即删除并推 `cancel`（`:646-668`）；
`clientId + eventId` 把回答绑到当前代（`:614-633`、`:635-639`），所以旧连接的回答不能完成
新代的投递（note `:281`）。测试名即契约："replays a pending event id to a replacement
Client generation"（`packages/api/gateway/tests/gateway-stream.host.spec.ts:1384`）。

**⑥ 恢复靠查询而不是靠重放。** `handleConnected()` 在每次新代里清 store、重拉列表
（`.../sessions/manager.ts:736-749`）；`session.control` 则在 `connected()` 里
`control.restart(); control.start()`（`.../client/index.ts:136-137`），新代重发 baseline。

### 4.5 host 在 socket 关闭时做什么

`RemoteStreamMuxConnection.run()`（`packages/api/gateway/src/stream-server.ts:146-166`）
等 `close`，然后**逐个 abort 全部逻辑流并 await 它们的 done**：

```ts
// packages/api/gateway/src/stream-server.ts:162-165
await closed
const active = [...this.streams.values()]
for (const stream of active) stream.stop(new Error('Remote stream socket closed'))
await Promise.all(active.map(stream => stream.done))
```

`stop` 同时 abort `AbortController` 并 `inbox.fail(reason)`（`:212-215`），这让阻塞在
`uplink.next()` 的 host 方法能退出。当且仅当 abort 原因是 `RemoteError` 时才发终帧
（`:243-251`），普通取消不发——所以 socket 关闭后客户端只会看到 carrier 失败，不会看到
`end`/`error`。

另外两件，**都要跟"直觉版本"划清界限**：

- **socket 与 Peer 的绑定被撤销，但 Peer 本身不 dispose。** socket 结束后
  `void release()`（`stream-server.ts:83-86`），`release` 是 `bindPeer` 注册在 peer ctx
  上的 effect 撤销器，语义是"peer 离开时关闭 socket"：

```ts
// packages/api/gateway/src/stream-server.ts:410-419
function bindPeer(websocket: WebSocket, peer: PeerScope): (() => unknown) | undefined {
  try {
    return peer.ctx.effect(
      () => () => { websocket.close(1001, 'peer left') },
      'api-gateway: Remote stream socket bound to its Peer',
    )
```

  它不是"关 socket 时释放 peer"。PeerScope 是 Host 级单例：`admit()` 永远返回同一个
  operator peer（`packages/client/connection/src/rpc-host.ts:64-65`、`:110-113`），它的
  `dispose()` 只在 Connection 插件 fiber 结束时调用（`rpc-host.ts:81-82`）。

- **心跳定时器不停。** 它是**全局一个**、`unref()` 的，第一次 upgrade 时启动，只在
  `RemoteStreamMuxServer.close()` 里被 `clearInterval`（`stream-server.ts:104-124`、
  `:91-93`）。每个 interval 给所有 OPEN socket 发 Ping，`MAX_MISSED_HEARTBEATS = 2`
  （`:40`）意味着容忍两次未应答，**第三次 tick 才** `terminate()`（`:111-118`）——默认
  间隔 2000ms（`packages/api/gateway/src/index.ts:137`）时最坏约 6s。心跳间隔是
  **Host 插件配置** `websocketHeartbeatIntervalMs`（`index.ts:147-148`、`:202-203`、
  `:246`），**不在 `packages/client/connection/`**；那里只把 recovery（backoff）配置注入
  页面（`packages/client/connection/src/index.ts:139-143`）。浏览器 WebSocket 自动回
  pong，客户端**没有任何自己的 watchdog**（`stream-client.ts` 全文件无 ping/pong/定时器）。

最后，与 socket 无关的一层：WebServer 在 `upgrade` 时把 socket 记入 `upgradedSockets`，
服务关闭时统一 `destroy()`（`packages/host/webserver/src/index.ts:258-291`、`:303-315`）。

---

## 五、可搬 / 需重写 / 搬不动

判定基准：目标环境是**单进程 `node:http` + 浏览器客户端 + SSE（单向）**，没有 Cordis
插件图，没有 Typert 代码生成，没有 `ws` 依赖。每一条都回指本报告的小节。

| 性质 | 判定 | 依据 / 重写形状 |
|---|---|---|
| **客户端订阅引用计数（计数 + source 标签 + 归零收尾）** | **可搬** | 计数、source 分列、归零动作全在客户端对象层，只用 `Map` + 计数器（§1.1、§1.2）。无 Cordis 依赖。搬过来就是"一个会话一个计数器对象 + 一个按 source 分列的字典 + 一次归零回调"。 |
| **"归零时只关那条逻辑流，不回收会话"这条语义** | **可搬** | 归零链路的跨进程终点只是一个 `cancel` 控制帧（§1.2）。SSE 下换成 `AbortController` + `res.end()` / `iterator.return()` 即可。 |
| **逻辑流帧协议 `{streamId, endpoint, payload}` + `item/error/end`** | **可搬** | `stream-protocol.ts:234-257` 是纯 JSON 文本帧 + 精确键校验（`:264-315`），上行只需 `open/cancel/item/end` 四种（`:235-244`）。与 WebSocket 本身无关。 |
| **基线 + 增量：一份完整快照 + 游标 + 按游标补** | **可搬** | `RemoteJournalStream` 的游标代数（`journal-stream.ts:58-81`）与领域快照协议（`history.ts:193-203`）不依赖任何 DSH 机制（§2.1、§2.2）。 |
| **本地窗口"整体替换"而不是"逐条对账"** | **可搬** | `replace()` 是一次赋值 + 一次同步发布（`contract/events.ts:148-151`），rope 只是实现细节，可用数组替代（§2.2）。 |
| **开场预算由客户端定（500 条 / ≥50 条 / ≥2 turn）** | **可搬** | 是客户端常量与请求字段（`session.ts:51-62`），host 只校验与兜底（§2.1）。 |
| **概况与内容分道：一条全局快照流 + 每会话一条日志流** | **可搬** | 协议上就是两个独立 `streamId`（§3.4），`session.control` 的 baseline/增量两帧形（`types.ts:579-581`）是普通判别联合。 |
| **"概况更新与引用无关 / 引用与概况无关"** | **可搬** | 五类触发点都不看计数（§3.3）。这是本次最值得照抄的一条性质。 |
| **`ProjectionValueStore` 的合并语义（higher-seq-wins、cached 让位于 sequenced）** | **可搬** | 纯 TypeScript，只 import 类型与本地 notifier（`projection-store.ts:159-166`、`:176-182`）。 |
| **host 侧 `WebServer`（`node:http` + route/upgrade 注册 + 一个 fallback 座位）** | **可搬** | `packages/host/webserver/src/index.ts` 已经就是裸 `node:http`（`:9`、`:243-291`），自述 "knows no harness concepts and serves no files"（`:1-7`）。唯一第三方件是 `compression`（`:15`）。 |
| **SSE 本身（`/plugins/events`）** | **可搬** | 手写 `text/event-stream` + 注释行保活 + `res.on('close')` 清理（`packages/client/hmr/src/index.ts:158-207`），零框架依赖；gzip 中间件已特判该 content-type（`webserver/src/index.ts:97`）。 |
| **一元 RPC（`POST /api/...`）与流式通道并存** | **可搬** | 命令面走 HTTP、流面走长连接是通道选择，不是 DSH 机制（§3.4 表）。 |
| **source 标签的"声明合并"扩展方式** | **需重写** | 现在靠 `SessionReferenceSourceMap` 的 declaration merging 让每个 feature 包自己追加（§1.3）。没有模块合并的环境里改成一个**手写闭合联合或字符串常量表**；形状不变，登记点从"包自己 declare"变成"一处集中登记"。 |
| **`sidebarChat` 这条"面板持有"本身** | **可搬** | 它就是"一个视图在挂载期持有一个引用、卸载时释放"（§1.3），不依赖任何框架原语——把它当成"面板 = 引用持有者"的范例即可。 |
| **host 方法集（`session.follow/page/control/list` 等）** | **需重写** | 上游由 Typert 从 `@Remote` 装饰器 + 类型生成描述符与客户端签名，`remote.session.*` 在源码里**根本不存在**。这里手写端点表即可：一个 `createRoutes()` 式映射 + 手写请求/响应类型。**不要试图复刻生成器**。 |
| **反向事件（`$on` 的 `emit`/`waterfall` 推导）** | **需重写** | `ctx.remote.$on(event, listener)` 的键集与签名由 Cordis `Events` 声明 + allowlist（`packages/api/remotes/src/remote-events.ts:20-48`）在编译期推导。目标环境改成**一张手写事件表 + 一个手写派发函数**；`emit`=广播无缓冲，`waterfall`=可应答（§4.4）。 |
| **pending waterfall 的重放与 `clientId + eventId` 关联** | **需重写** | 机制本身可懂（§4.4⑤），但它绑在"代"这个概念上。目标环境需要自己定义"代"（建议：一条 SSE 连接 = 一代），并自带 pending 表与补投；否则审批/问答在重连后会永久挂住。 |
| **物理心跳（WebSocket Ping/Pong 控制帧）** | **需重写** | SSE 没有服务端控制帧。上游用 `ws` 的 `socket.ping()` 与 `pong` 事件（`stream-server.ts:76`、`:120`）判活。改写形状：服务端周期写一个**注释行**（`:\n\n`）保活；客户端判活改由"读超时"或复用浏览器 `online`/`offline` + 一次探测请求；`MAX_MISSED_HEARTBEATS` 的语义要换成一个客户端侧计时器。 |
| **连接退避与"物理替换"的职责划分** | **需重写** | 上游把退避放在 `ConnectionController`、把 socket 替换放进 `RemoteStreamMuxClient`，两者靠 `onReconnectRequested` 与 `$events` 代源耦合（§4.1）。SSE 下"物理连接"不再是一个可复用的 mux：一条流就是一条 HTTP 响应，所以退避与重开必须**合并到订阅层**——按订阅（而不是按连接）做退避，避免 N 条流各自退避造成 N 倍重连风暴（上游靠"一条 socket"天然避免，这里没有）。这是本次最有实质重写的形状。 |
| **`RemoteStream` 的重开策略（host 可用时允许一次、否则等新代）** | **需重写** | 逻辑很简单（`remote-stream.ts:160-170`），但它读的是 `connection.generation`。目标环境要自己定义"代"并把它暴露给每条流；语义照抄，类型换掉。 |
| **`RemoteSnapshotStream` / `RemoteJournalStream` 两个通用对象** | **需重写** | 语法上是普通 TS 类（`snapshot-stream.ts`、`journal-stream.ts`，两者都不 import Cordis），但构造依赖 `RemoteStreamFactory` / `RemoteStreamCarrierError` / 生成方法。**按这套代数重写一遍**（这是本图最值得直接抄的一份设计），而不是搬运代码。 |
| **多路复用省内存这一点** | **部分可搬** | 收益来自"一条 socket + 一条每会话逻辑流 + 引用计数合并消费方"。SSE 下"一条每会话逻辑流"仍成立，但浏览器同源连接数上限要靠"每标签页一条"化解，与最外层协议无关。 |
| **Typert 描述符、编解码、`@Remote`、SRC 回退** | **搬不动** | 整套代码生成与运行期码表。目标环境用不上；手写端点即替代（见上）。 |
| **Cordis 插件图、服务注入（`inject`/`ctx.effect`/`ctx.provide`）、fiber 生命周期** | **搬不动** | `ClientSessions`/`SessionControlController`/Gateway 的装配全在 `apply()`/`ctx.inject`/`ctx.effect` 里（如 `.../client/index.ts:112-148`、`gateway/src/index.ts:233-277`）。目标环境里对应物是"一个显式的启动与关闭函数"，需要重写装配。 |
| **Agent 作用域 fiber 本身（"会话 = 一个 scope，注册随归零销毁"）** | **搬不动** | `createScope` 用 `ctx.plugin(agentScope)` + `fiber.ctx.extend({ [CordisContext.filter]: ... })`（`.../client/scope.ts:44-58`）。**计数策略可搬，它作用的对象机制不可搬**。 |
| **`ctx.invocation` + `PeerScope`（"谁在调用我"）** | **搬不动** | note 明确说它依赖 Cordis 的 `ctx.extend` 与 `ctx.get` 的 traceable 代理语义（`2026-09-19-remote-duplex-stream.md:170-174`）。单进程单用户环境里没有第二个 Peer，这个抽象没有消费方。 |
| **`gateway` 这个 source 整体** | **搬不动** | 它是"一次 Remote 调用对 scoped Context 的所有权"（§1.3），没有 Typert 的 scoped context 与 forwarded waterfall，就没有这个引用来源。 |
| **上行进制的 inbox 限额（`streamInboxBytes`，默认 262144）** | **搬不动（本图不用）** | 为"客户端往 host 写"设计（`stream-server.ts:309-403`、`gateway/src/index.ts:138`）；note 自己说生产上还没有上行消费方（`2026-09-19-remote-duplex-stream.md:580`）。命令面保留 REST 的话不留这个缓冲。 |
| **窗口不淘汰、随引用期持续增长** | **可搬（但要自觉承担）** | 见 §2.3。它是**有意的**：`hasMore` + 按需 prepend 是设计的一部分。如果目标环境要长跑的会话，这是唯一需要**新增**（而不是搬运）的东西——上游没有可照抄的淘汰策略，只能自己定。代价还有读取侧的 O(n) 展平与 `settleAssistant` 的全量 materialize（§2.3 末）。 |

### 一句话收束

DSH 里**真正值得搬的四样东西都是"计数与语义"，不是"管线"**：
①引用计数在客户端、归零只关流（§1）；②客户端定开场预算、本地窗口整体替换、且明确
不淘汰（§2）；③概况一条全局快照流、内容每会话一条日志流、两者互不依赖引用（§3）；
④退避与流重开分层、通知不重放而靠查询恢复（§4）。

**搬不动的都是"生成与装配"**：Typert 代码生成、Cordis 插件图、`ctx.invocation` 与
Agent 作用域 fiber。

**必须重写的核心是"代"这个概念怎么在 SSE 上建立**——上游用一条常驻 WebSocket 天然提供
了"物理代"，SSE 没有，所以退避、判活、pending waterfall 补投三件事都要改成按订阅/按
连接代自己维护。
