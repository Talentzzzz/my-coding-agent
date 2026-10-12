# 概况通道与内容分道

Type: grilling
Status: resolved
Blocked by: 05

## Question

DSH 的性质是："**没人引用的会话，内容根本不发**……但**概况照常更新**：侧边栏那一行还是会变成'运行中'、标题时间会动。概况走的是另一条很轻的目录投影通道，与逐条内容分开。"

本仓库今天**两样都没有**，而且第二样比想象中更坏——不是慢，是**没有这个数据**：

- 侧边栏那一行**根本没有"运行中"这个状态**：`packages/web/src/render/sidebar.ts:180-183` 只渲染 `title` + `relativeTime(session.createdAt)`。
- `SessionRef` 只有 `id / cwd / createdAt / title / parentId`（`packages/core/src/protocol.ts:11-15`）。真正表示最后活动的 `info.modified` 在服务端**算了**（`packages/core/src/session/session-manager.ts:688-701`，排序用它，`:739`）却**没有上线**。
- 于是"会话 A 在后台跑完一轮而你在看 B"时，**那一行永远不变**——不是 1 秒也不是 1 小时；连手动 `refreshLists()` 都改不了它的文本（`render/sidebar.ts:70-80` 的 signature 只含 id/parentId/title）。
- 客户端全局无 `setInterval`，列表刷新只发生在 `openSession`、`follow`、启动三处（`packages/web/src/main.ts:365,386,547`）。**一轮运行结束永远不会刷新侧边栏。**

要钉死的是：

1. **概况携带什么字段**。至少：是否在跑（是否 `submitting`）、最后活动时间（`modified` 要不要上线）、标题（今天从第一条有文本的用户消息推导，活会话与列表一视同仁）。还有别的吗？
2. **分道的粒度**。**研究票 01 查实 DSH 分的是三条逻辑流，不是两条**（`../research/dsh-portability.md` §3）：每会话一条 `session.follow` journal（内容）、全 Host 一条 `session.control` 快照流（投影值，`title` 走这条）、以及全 Host 一条 `$events` 转发事件流——而 **`running` 既不在前两条上，它走 `$events`**。三者同在一条 WebSocket 上按 `streamId` 分道，**不是同一条流上的两类帧**。

   这对本仓库是个直接的反问：今天 `submitting` 只在流的 `onChange` 快照里（`packages/server/src/stream-registry.ts:220-228`），而 `title` / `modified` 在会话 header 里。本仓库要不要照三条分？还是两条就够（内容 + 概况），把"通知"并进概况？票 05 定了信封之后本票才能定。**取舍的判据**：概况必须能在"没有订阅任何内容"时照常更新，否则后台会话那一行又会冻住——而 `running` 属于概况还是通知，决定了后台会话能不能显示"运行中"。
3. **谁维护投影**。今天列表是"请求时读目录"（`SessionHub.snapshotOf` 的冷读路径 + `SessionManager` 的列表扫描）。要不要像 DSH 那样有一个内存投影 store？还是每次变更时从目录重读（代价：N 个会话 × 每次事件一次文件扫描）？
4. **概况的推送时机**。会话事件里已经有 `entry_appended`、`config_changed`、`queue_update` 等（`packages/core/src/protocol.ts`），哪些该触发概况更新？`submitting` 只在 `onChange` 快照里（`stream-registry.ts:220-228`），没有人在看的时候它谁都不发——这正是要解决的问题。
5. **侧边栏排序**。今天同工作区内按 `modified` 排序、工作区分组按 `createdAt`（`session-manager.ts:739,1611-1613`）。概况上线之后，这一行会不会在用户眼前跳动（正在看的会话因为收到一条消息而跳到顶部）？如果会，UX 上怎么处理。

## Answer

### 结论（一句话）

**概况是一条连接级的新逻辑流**——占票 05 留出的 `streamId: null` 座位、与票 07 的心跳同一个座位——携带**三个新字段**（`modified`、`running`、`pending`）的**整行值**；**内容仍是每会话一条逻辑流，所以是两条分道，不照 DSH 分三条**。投影由服务端**进程内一份 store** 维护（目录扫描只是它的 seed，绝不按事件重扫），**行变了才发**，发的永远是可幂等的整行替换（没有 seq、没有按键合并）；客户端把行存在**连接级**的一张表里（不进 `ViewState`、不进 reducer），侧边栏与它同源。**`running` 属于概况，所以一个没人看的后台会话那一行照常显示"运行中"** ——这正是票面那句判据要的东西。侧边栏按 `modified` **实时重排**（行会跳到顶部），连接指示器画在**侧边栏顶部那一行**：这两处由用户 2026-10-12 看着两个候选选定。

下面九节：第 1–5 节按票面顺序回答，第 6 节答地图与票 05/07 转给本票的两件小事，第 7、8 节是落点与决定记录，第 9 节列本票**没有**回答的。

---

### 1. 概况携带什么字段：`SessionRef` 再加三个，**不多一个**

新类型，与 `SessionRef` 并排在 `packages/core/src/protocol.ts`（`SessionRef` 今天是 `id / cwd / createdAt / title / parentId`，`:11-24`）：

```ts
/** 侧边栏的一行：存储里的那点身份，加上只有这个进程知道的活动事实。 */
export interface SessionRow extends SessionRef {
	/** 最后活动的时刻：最后一条带时间戳的 user/assistant 消息，没有就是 `createdAt`。 */
	modified: number;
	/** 这个进程现在跑着它。 */
	running: boolean;
	/** 待回答的审批数。 */
	pending: number;
}
```

**`WorkspaceGroup.sessions` 的元素类型跟着从 `SessionRef` 换成 `SessionRow`**（`:32-35`）：那条类型就是"侧边栏的那些行"，而行的值从此由投影给。`SessionRef` 本身**不动**——它是 store 的视图，唯一生产者是 `toSessionRef`（`session-manager.ts:1622`），而 core 不知道谁在跑。

**准入判据（三条，缺一不可）**，因为这条通道以后会被"顺手再加一个字段"侵蚀：

1. **它必须在没有订阅任何内容时也是对的** —— 否则后台会话那一行又冻住，那是本票存在的理由。
2. **它在冷会话上必须有一个必然的确定值** —— 否则会话被回收、进程重启之后，那一行开始撒谎。
3. **它不是内容** —— transcript、当前工具、token 数都不上这条通道（票 05 第 2 条把 `usage` 按会话留在逻辑流上，理由正是"抬到连接级等于把每个会话的 token 数发给每一栏"）。

三个字段逐条对：

| 字段 | 谁能让它变 | 今天在哪 | 为什么它非上线不可 |
|---|---|---|---|
| `modified` | 最后一条带时间戳的 user/assistant 消息落盘 | **算了但没上线**：`session-manager.ts:672-673` 逐条取最大活动时间、`:688-693` 定形成 `modified`，`:739` 用它排序，而侧边栏画的是 `createdAt`（`sidebar.ts:182`） | 今天**排序与显示用的不是同一个事实**：一行可以按活动排在第 2 位而显示"3天前"。上线后 `relativeTime` 改读 `modified`，`createdAt` 退到 tooltip |
| `running` | `snapshot.submitting` 翻转（`protocol.ts:205`） | 只在 `onChange` 快照里（`stream-registry.ts:220-228`），而 `onChange` 只发给**已经挂上的流**（`:211-240`）——没人看就谁都不发 | 这就是票面那个洞：后台会话那一行没有"运行中"这个状态 |
| `pending` | `snapshot.pendingApprovals.length`（`protocol.ts:213`） | 基线（`stream-registry.ts:242` 的 `opening`）与逐审批差值帧（`:318-336`），两者都要求有一条流 | 一个停在审批上的会话在 `running` 上和"正在干活"一模一样，而它其实**在等你**——这是第二行状态里最该被看见的一条 |

判据 2 在这三个字段上**成立得毫不勉强**：`submitting` 与 `pendingApprovals` 是"活对象才有"的输入，冷读路径把五个这样的字段写死成空闲值（`session-factory.ts:151-169` 的 `submitting: false` / `pendingApprovals: []`）。所以**冷会话的行必然是 `running: false, pending: 0`**——不是猜的，是构造上如此。

**`title` 也走这条通道，但它的推导要先统一。** 票面那句"活会话与列表一视同仁"今天**不成立**：活会话的标题是 `SessionManager.getTitle()` → `deriveTitle`（活动分支上第一条有文本的用户消息，**截到 72 字符**，`session-manager.ts:1638-1645`，由 `snapshot.ts:56` 取），而列表用的 `info.firstMessage`（`buildSessionInfo`，`:682`）是**文件里**第一条用户消息、**不截断**。两处差别都是真的：一处是截断，另一处是"文件里的第一条"与"活动分支上的第一条"——分支移动之后它们可以不是同一条消息。**一行不能因为宿主被回收就换一个文本**，所以：

> **一行的 `title` 只有一个推导：`getTitle()` 那一份**（活动分支第一条有文本的用户消息，截到 72 字符）。

冷路径的探针因此要跟着改成同一条推导，而不是继续映射 `info.firstMessage`：`buildSessionInfo` 读文件时本来就把每条 entry 过一遍（`:661-683`），顺手记一张"entry id → 父 id"的表、从最后一条 entry 走一遍分支即可，代价是同一个循环里多一个 `Map`。落地要动的是 `toSessionRef` 今天映射的那一行（`session-manager.ts:1622-1630`）。**不接受"活行用活值、冷行用文件值"**：那样一行会在宿主被回收的瞬间改文本，而它正是这张票要修的那类抖动。

**不带 `error`（"上一次运行失败"）**，这是对票 03 那张第二行状态表的一处收窄，登记在它的 Comments 里。理由只有一条，但它是判据 2：**失败活得比一次运行长**——它落在 transcript 里（一次失败的运行产出一条带 `errorMessage` 的 assistant 消息，票 08 的形状 A），所以一条冷会话的行要说"失败"，扫描就得连"最后一条消息是不是失败的"一起推。而票 06/07 已经定过 `item.error` **没有快照字段**、基线不重建它、只有一次成功的操作才抹掉它——那说的是"**这条逻辑流上刚发生过的事**"，不是行的值。两个寿命不同的东西共用一个词，下游就会长出两条清理规则。DSH 同向：研究票 01 §3.1 引的 note 把 "Agent error without a turn position" 与 `running` / `activity` 并列，判它**不进 control 流**（"either repairable from a list baseline or need no replay"）；而本仓库连"可修复"那条路都没有（不做游标）。**所以"失败"由那一栏自己的错误条（`main.ts:172-175`）与 transcript 承担，侧边栏第二行只画 运行中 / 待审批 / 已打开·空闲。**

**不带"当前工具名"**（票 03 原型画的 `● 运行中 · 读文件`，用户在同一次选定里选了不带）：它满足判据 1 与 2，栽在判据 3——工具调用**已经逐条画在它自己那一栏的 transcript 里**（`state.ts:208-236` 的工具卡片），把它再抄一份到概况通道，就是给内容开第二条通道，换来的只是"运行中"后面多一个词。侧边栏第二行说"运行中"，不说什么工具。

**"已打开·空闲"与那个 `▍` 记号不需要字段**：哪两栏开着谁**是客户端自己的状态**（票 04 第 2 条：没有会话的栏不产生引用；票 03 第 7 条把"我在看谁"留给 D1 的连带面）。它是行上的一个本地装饰，不是服务器的事实。

---

### 2. 分道的粒度：**两条**；`running` 属于概况，所以不照 DSH 分三条

| 逻辑流 | 分道键 | 谁开它 | 帧 |
|---|---|---|---|
| 内容 | `streamId = <会话 id>`（票 05 第 1 条：一条连接上一个会话至多一条） | 客户端的 `open` / `cancel`（票 04 第 2 条） | `baseline` / `event` / `entry` / `approval_request` / `approval_settled` / `status` / `error`（票 05 第 2 条的判定不变） |
| **概况** | `streamId: null`（票 05 第 2 条留出的连接级座位，票 07 的心跳已占同一座位） | **通道本身**——每个连接一份，永远在，**不按 `open` 开、不按 `cancel` 关** | 下面两种 |

```jsonc
// 下行：连接级（streamId: null），载荷不是 ServerMessage 的成员（票 05 第 2 条、票 07 第 1 条都已写明）
{ "streamId": null, "item": { "type": "sessions", "sessions": [ /* SessionRow[]，这条通道的基线 */ ] } }
{ "streamId": null, "item": { "type": "session_row", "session": { /* SessionRow，整行替换 */ } } }
```

两个成员而不是一个，理由与票 05 给 `baseline` 改名的理由同源：**"这是这条通道的基线"和"这一行变了"是两件事**，把只有一次的基线与常态的增量压进同一个成员名，会让"把第二份基线当增量吃下去"变成可能。载荷字段叫 `session`（不是 `row`）：它就是一个会话，也正是 `GET /api/workspaces` 里 `sessions[i]` 那个东西。

**为什么是两条，不照 DSH 的三条**：

1. **DSH 的第三条（`$events`）存在，是因为它的 control 流是一个带 seq 的值 store**。研究票 01 §3.2 查实：基线走 `store.seed(...)`，增量按 `key` 与 `seq` 合并（`projection-store.ts:159-166` 的 higher-seq-wins），而 list RPC 来的 `cached` 行只在没有 `sequenced` 行时填（`:176-182`）。它需要一个"**只改不插、不需要重放**"的通知面，装那些没有 key、也不需要被修回来的事实——`running` 与 `activity` 正在其列（§3.1 的发射点与 allowlist）。**本仓库没有 seq，也不打算有**（票 06 拒绝游标、拒绝重放缓冲），所以"键 + 序号 + cached/sequenced 合并"这一整套前提整体不落地；留下来的只有"两个来源写同一行"这个问题，而它在下面第 4 节被一条更简单的规则解掉了。
2. **第三条在这里的消费者只有一个：同一张侧边栏**。为它单开一类载荷与一份 store，得到的区别是"这帧会不会被重放"，而本仓库没有重放。
3. **票面给的判据只要求一件事**：概况必须能在**没有订阅任何内容**时照常更新。连接级的那条流按定义满足它（它与 `open` 无关）。把 `running` 放进去，后台会话那一行就有"运行中"；把它放进一个"通知面"，接下来要回答的还是"没人看的时候这通知发给谁"——答案仍然是这条连接级流。

**一处必须写下来的双份：`running` 与 `pending` 在两条流上各有一份**（内容侧是 `status.submitting`，票 05 第 2 条已定；`pending` 在内容侧活在基线的 `snapshot.pendingApprovals` 与逐审批差值帧里，`stream-registry.ts:242`、`:318-336`。概况侧是 `{ type: "session_row", session }` 里的 `session.running` / `session.pending`）。这不是矛盾，是**两个消费者各有各的寿命**：概况行必须与"有没有人订阅"无关，而栏的状态只在那一栏订阅着的时候才有意义（票 06：基线替换的是那份会话窗口）。规则：**栏画自己的流，侧边栏画概况**。两者在服务端同源于同一个 `snapshot`（`agent.ts:1452-1455` 的 `publish()`），所以分歧窗口只有一帧。**两个方向都不要走**：不要为了去重把 `status` 里的 `submitting` 删掉（那是重开票 05 的载荷），也不要把行改成从内容流算（那会让后台会话的行又冻住，正是本票要解决的）。

**座位够不够**：够。票 07 的 Comments 已经写过"连接级载荷本来就不是 `ServerMessage` 的成员，多一类载荷不占第二个座位"；本票就是那第二类。票 05 / 07 / 10 三票定下之后，`streamId: null` 上共有三类**载荷**：`heartbeat`、`sessions`、`session_row`（**今天树上一条都还没有**——三票都只产出决定）。这个座位上还有一个**已定义、先不实现**的形状要一起记住：票 05 第 2 条的**信封级** `{ streamId: null, error: { message } }`（"服务端无法归因到任何会话的故障"）——它与 `item` 平级而不是它的成员，所以不算那三类载荷里的第四类，本票也不动它。客户端"按 `streamId` 分派"的那一层把 `null` **全部**路由到"不属于任何一栏"的那条路径（票 05 第 6 条：只校验信封，不校验成员形状），心跳给 watchdog、行给行 store、信封级 `error` 给窗口级错误处理——同一层，三件事。

---

### 3. 谁维护投影：**进程内一份 store，目录扫描只是它的 seed**

先把今天的代价说准，因为它决定了答案。今天列表是"请求时读目录"：`SystemController.workspaces()` → `SessionManager.listWorkspaces()`（`controllers/sessions.ts:118-121`、`session-manager.ts:1552-1577`），而 `listSessionsFromDir` 对**每个**会话文件逐行读一遍（`:769-792` → `buildSessionInfo:647-710`，并发上限 10），`listWorkspaces` 还要为每个工作区先找最新的那个文件。而客户端一次刷新**并行发两次列表请求**（`main.ts:393-397` 的 `Promise.all([api.listWorkspaces(), api.listSessions()])`）——一次页面加载至少两轮全量扫描。**"每次变更时从目录重读"于是是 `N 个会话 × 每 turn 一次逐行扫描`**，直接排除。

**决定：服务端一份进程内的投影 store。**

- 新类型 `SessionProjection`（`packages/server/src/projection.ts`），`boot.ts` 里与 `createStreamRegistry(hub, …)` 并排建起来。
- 内部是 `Map<sessionId, SessionRow>`，外加向外派生 `WorkspaceGroup[]`（分组与排序都在这里，§5）。
- **seed 来自 `SessionManager.listWorkspaces()`**（同一次扫描，映射进 `SessionRow` 时补 `running: false, pending: 0`——§1 已说这两个值在冷会话上是必然的）。
- **它不是"缓存失效"机制**：这个进程是 store 上唯一的写者（会话由 `SessionManager.create` / `forkFrom` 建，内容由 `Agent` 追加），所以扫描只服务一件事——**把手工放进来的会话文件也看见**，那正是 `listWorkspaces` 今天的注释所写的意图。因此**扫描只在"有人要看列表"时发生**：`GET /api/workspaces` / `GET /api/sessions` 触发一次（并且第一次取行时惰性 seed，好让一个从不读 REST 的客户端也能拿到基线）。**通道基线不发扫描**——它读 store 里现有的行，所以**重连也不重扫**（§4 末尾）。
- **活的行由观察驱动**，观察点**不能**是 `hub.observe()`：那张表是**订阅的镜像**（票 09 §4），而票 08 的遗弃计时器读的正是它的"空/非空"——投影若挂进去，那条计时器就永远不触发（"订阅集合为空"永不成立）。所以投影用另一个 seam：**`SessionHub` 新增一个 host 级观察点**，在四处触发（新建、派生、宿主打开、宿主关闭），回调形如 `(sessionId: string, host: HostedSession | undefined) => void`：

  | 回调到达时 | 投影做什么 |
  |---|---|
  | `host` 在 | 在同一个同步段里先绑这个 `Agent` 的 `onEvent` / `onChange`（`agent.ts:780`、`:1364`）、再取 `snapshot`（票 06 §3 那条"中间没有 await 点"的同一条理由），行从快照现算 `running` / `pending` / `title`。**`modified` 不由这一步重算**：它只来自"最后一条带时间戳的消息"，而宿主打开之前写的消息都已经在文件里了，所以扫出来的那个值就是最新的，之后由 `entry_appended` 往前推。store 里还没有这一行时（seed 之后手工放进来的文件），先走一次"一个文件的探针"把它建起来，再叠上活值 |
  | `host` 不在、store 里没有这一行 | 这是"盘上多了一个会话"（新建 / 派生）：用**一个文件**的探针算出它——`buildSessionInfo` + `toSessionRef`（`session-manager.ts:647`、`:1622`）那一对（其中的 `title` 按 §1 那条统一推导来），落地时包成 `SessionManager` 上的一个方法（`buildSessionInfo` 今天是私有的）。**不是目录扫描**：新建与派生各一个文件 |
  | `host` 不在、store 里已有这一行 | 宿主被回收了：解绑，**保留旧值**（`submitting: false` 那一帧已经在关闭之前发出去了——票 08 的统一 `finally`）。解绑不是洁癖：一个还挂在死 `Agent` 上的监听器会把它连同整段 transcript 钉在内存里 |

- **与 `observe` 的分工写清楚**：`observe(sessionId, observer)` 回答"这个会话现在有哪些**订阅者**，把事件路由给他们"；新的 host 级观察点回答"这个进程**知道/持有**哪些会话"。前者是连接的事，后者是进程的事。这是本票新增的唯一一个 seam，理由是上面那条：**投影不能是订阅者，否则票 08 的计时器死掉**。
- **谁读这份 store**：① 通道基线（§4）；② `GET /api/workspaces` / `/api/sessions`（改为从投影答，顺带把"一次刷新两轮全量扫描"合成一轮）；③ 另外三个应答体里也带一份会话列表——`GET /api/sessions/current` 与 `POST /api/sessions`、`POST /api/sessions/:id/forks`（`controllers/sessions.ts:216`、`:262`、`:274`，今天都是 `{ sessionId, sessions: SessionRef[] }`）。它们的 `sessions` 跟着换成 `SessionRow[]`，**这不是顺手的扩大，而是被迫的**：客户端今天把这三个应答体直接折进列表（`main.ts:458`、`:470`），而行 store 只能有一种形状。**投影不是第二个真相**：盘上仍然只有一份 JSONL，投影是它的进程内视图，cold 路径（`hub.snapshotOf()`）不动。
- **一条诚实限度**：另一个进程正在跑的会话，这个进程只能报 `running: false`——跨进程没有通路。今天的列表同样看不见它（`hub.live` 只是本进程的 `hosts`，`hub.ts:153-156`）。

---

### 4. 推送时机：**变更即重算那一行，重算后不同才发**

触发器是闭集，而且**直接从 §1 那三个字段的来源读出来**：

| 行上会变的东西 | 谁能让它变 | 挂在哪 |
|---|---|---|
| `running` | `snapshot.submitting` 翻转 | 活会话的 `onChange`（`stream-registry.ts:220-228` 已经在收同一个快照） |
| `pending` | `snapshot.pendingApprovals` 的长度变 | 同上 |
| `modified` | 一条**带时间戳的** user/assistant 消息落盘 | `entry_appended`（`agent.ts:1406-1417`）→ 查那个 entry 取 `message.timestamp`（`stream-registry.ts:299-307` 的 `sendEntry` 已经在做同一件事） |
| `title` | 活动分支上第一条有文本的用户消息出现或改变（**派生与分支移动都能改它**） | `entry_appended`，以及 `branch_changed`（`agent.ts:1415`；票 06 已经把这帧定成"一次基线替换"） |
| 整行出现 | 新建 / 派生出一个会话 | hub 的 host 级观察点（§3） |

**但不要把它写成一张白名单 if 表。** 规则是：**每次变化重算那一行的这三个字段，算出来的行与 store 里的不同才发**。理由有据：`onChange` 今天在 `message_start` / `message_end` / `turn_end`（`agent.ts:1358-1359`）以及重试（`:641-662`）、排队与配置（`:819-1060`）、审批回答（`:1252`）等处都会响，白名单会把"哪天多一个 `publish()` 点"变成一行静默失真的行；而"重算 + 相等不发"的代价只是每 turn 几次对象比较——**反正行上只有三个字段**。同理，`message_update`（每 token 一帧）**不会**触发任何行变化：`submitting` 没翻、`pending` 没动、`modified` 要等消息落盘。

**发整行，不发按键增量，也不带 seq。** 三个理由：

1. 一行就三个字段、一百多个字节，按键增量省不下什么；
2. **整行替换是幂等的、与到达顺序无关**——所以不需要 seq，这正是票 06"不做游标"在新通道上的同一条判据（DSH 的 `{ key, value, seq }` 是为"两个来源写同一行"准备的，见 §2 第 1 条）；
3. **这里只有一个活来源**。客户端另有一个来源：`GET /api/workspaces`（页面加载与 `refreshLists()`）。一次性写入权规则解决它，不需要逐键合并：

> **通道 `live` 时，行只由通道写；`connecting` / `down` 时由 REST 写。**

于是"一个晚到的 REST 应答把刚收到 `running: true` 的行改回 `false`"这种窗口不存在。落地时 `main.ts` 的 `refreshLists()` 因此退化成"通道不是 `live` 时的兜底"，而它今天那三个调用点（`openSession` / `follow` / 页面加载，`main.ts:365,386,547`）随之不再承担"让侧边栏变新"的职责——**那件事交给通道，一轮运行结束会自己出现在那一行上**。

**重连**：`channel` 每次进 `live` 都收一份新的 `sessions` 基线，**整表替换**，所以断线期间错过的行变化不需要补（与票 04 第 3 条"连接死 = 整张订阅表消失"同一个形状）。**但重连不重扫目录**：服务端是唯一写者，"手工放进来的文件"这件事已经由 REST 那次读覆盖；每次退避重连都扫一遍全部会话文件，是拿一条真实成本换一个不存在的收益。
**顺序**：票 07 的 `live` 判据是"收到**任何**一帧"，所以概况基线早于或晚于第一条心跳都不影响状态机——两者都在同一条 socket 上，TCP 保序，客户端不需要为它们排序。

---

### 5. 侧边栏排序：按 `modified` **实时重排**（用户 2026-10-12 选定），并把"原地改行"当成落地要求

- **组内**：按 `modified` 降序——今天已经是（`sortSessionInfos:738-740`），上线后只是"排序依据开始会动"。
- **组间**：改成按**组内最新 `modified`**。今天用的是 `newestAt`（`session-manager.ts:1612-1614`），而它读的是 `createdAt`——**与它自己的注释（"The most recent activity in a group"）不符**（大概是因为 `SessionRef` 里根本没有 `modified` 可读，只能退回 `createdAt`；`modified` 上线之后这处漂移自然消失）。上线之后同一份规则要在两边一致：服务端的列表与客户端的插入都按它。
- **行会跳，而且这是选定要的**：你在看 A，后台的 B 跑完一条 assistant 消息，B 就跳到本组顶部。理由：这个列表从第一天起的意思就是"最近活动在前"，而它现在**必须**与 store 的排序一致；活动本身已经由第二行状态表达，"跳"不是唯一信号，只是顺序的诚实。
- **配套的落地要求（不是可选项）：行要原地改，不整表重建。**`sidebar.ts:82-85` 今天是 signature 一变就 `renderList()` → `replaceChildren()` 整表重建。行开始频繁变化之后，这会**在指针按住与抬起之间把按钮换掉**（`click` 落在已被移除的元素上就不触发），也会在展开状态与滚动位置上留毛刺。所以：标题、时间、第二行状态在**原来的行元素上**改，顺序变化用**移动节点**表达；`render` 的 signature 要带上那三个新字段（`sidebar.ts:70-80` 今天只含 `id/parentId/title`，那正是"连手动 `refreshLists()` 都改不了它的文本"的第二个原因）；`scrollIntoView`（`:101`）只在 `activeSessionId` 变化时做。
- **时间文本读对**：`relativeTime(session.createdAt)`（`:182`）改读 `modified`，`createdAt` 进 tooltip（`renderSession` 的 `title` 那两句，`:161-164`）。`relativeTime` 的粗粒度（刚刚 / N分钟 / N小时，`:259-266`）保持不变。
- **"刚刚"那一档需要一个低频重画，但不需要新定时器**：行的时间文本今天从不更新（客户端全局无 `setInterval`），上线后要等下一次推送才改；一条停下来的会话会一直显示"刚刚"——那是可见的谎。做法是**把重画挂在帧到达上**（票 07 的心跳每 5000 ms 一帧，反正要到），重画只做一件幂等的事：把可见行的相对时间重算一遍、**不同才写**。好处是它用的是已有的心跳而不是第二个时钟，通道断了就自然停（那时"多久没动静"本来也不该继续装作知道）。

---

### 6. 地图与票 05 / 07 转给本票的两件小事

**(a) 两栏并排时状态行画哪一份（票 05 第 2 条末留给本票）。答案是"栏的画栏的"。** 每栏一条状态行（票 03 第 5 条已定），三个数字都来自**那一栏自己的那份 `ViewState`**：基线里的 `SessionSnapshot.usage` 播种（票 05 已记"基线上的 usage 不会丢"；它是 `foldUsage(messages, contextWindow)`，`snapshot.ts:72-85`），之后由**那条逻辑流**的 `status` 帧更新（`stream-registry.ts:220-228`）。没有会话的那一栏画空态——`total —` / `cache —` / `context —`，`statusbar.ts:59-74` 已经有无数据分支。**不摊开、不合并、不挑一份显示给两栏**（那正是票 05 禁止的连接级 `usage`）。三个数字**恒定画**（票 07 §2 已定：断开也不清空），连接状态不在这条线上。票 03 的遗留问题 4（"两组三位数并排会不会互相打岔"）本票不改形态：消歧靠窗格自己的边界与标题条（票 03 已定每栏有标题条），**不**引入"只有聚焦那栏才有状态行"。

**(b) 连接指示器画在哪（票 07 定它是窗口级的，地图留给本票）。画在侧边栏顶部那一行、品牌旁边**（用户同一次选定）。它是窗口级的、并排与单会话两种形态都在、侧边栏折成 rail 时那个点还在；**不新增窗口级横条**（并排两栏的几何本来就紧，票 03 的评审记录里那一栏的宽度是已知的痛点）。形态与颜色：一个小圆点 + 文案——`live` 只有点、无文案；`connecting` 写"连接中…"；`down` 写"已断开，重连中…"，颜色只用 `--dsw-state-warn` 与 `--dsw-state-error`（与票 03 对行状态的颜色约束同一条）。它与错误条的分工不变：错误条（`main.ts:64-65`、`:172-175`）说一次请求的结果，指示器说通道的状态。落地时 `SidebarState` 多一个 `channel` 字段，**不进 `ViewState`、不进 reducer**（票 07 第 2 条已定）。

---

### 7. 落点（本票只产出决定，代码一行未动）

| 文件 | 改什么 | 归谁 |
|---|---|---|
| `packages/core/src/protocol.ts` | 新增 `SessionRow`；`WorkspaceGroup.sessions` 的元素类型换成它；新增两个连接级载荷类型（与票 07 的 `heartbeat` 归入同一个"连接帧载荷"联合） | 票 12 / 落地 |
| `packages/core/src/session/session-manager.ts` | `newestAt` 改读 `modified`（`:1612-1614`）；包一个"一个文件 → 一行"的探针（`buildSessionInfo` + `toSessionRef`，今天前者私有） | 落地 |
| `packages/server/src/projection.ts`（新） | `SessionProjection`：seed、按会话绑 `Agent`、重算与"不同才发" | 落地 |
| `packages/server/src/hub.ts` | 新增 host 级观察点（新建 / 派生 / 打开 / 关闭四处触发）；`observe()` 与那张订阅镜像**不动** | 落地 |
| `packages/server/src/boot.ts` | 建投影，把它接到通道上 | 落地 |
| `packages/server/src/controllers/sessions.ts` | `workspaces()` / `sessions()` / `current()` / `create()` / `fork()` 改由投影答（类型 `SessionRow`） | 落地 |
| `packages/server/src/stream-registry.ts` 与新的 mux/连接层 | 连接建立时发 `sessions` 基线；投影变化时发 `session_row`。**信封在连接上包**（票 05 §6：注册表只发 `StreamFrame`） | 票 05/09 的落地 |
| `packages/web/src/client.ts`（票 07 的 `MuxClient`） | 按 `streamId === null` 把 `sessions` / `session_row` 与 `heartbeat` 一起路由到"不属于任何一栏"的处理 | 票 07 的落地 |
| `packages/web/src/main.ts` | 连接级的行 store（不进 `ViewState`）；`refreshLists()` 退成兜底；相对时间的重画挂在帧到达上 | 落地 |
| `packages/web/src/render/sidebar.ts` | 行改读 `modified` + 第二行状态（运行中 / 待审批 / 已打开·空闲）；原地改行；顶部连接指示器。**私有 `interface SessionRow`（`:190`）改名**（它与新协议类型同名，指的是树里的一行） | 落地 |
| `packages/web/src/state.ts` | `ViewState.sessions`（`:84`）今天**没有任何读者**（侧边栏只读 `workspaces`）——**本票只登记，不要求删**：落地时决定删掉还是改由投影喂 | 票 12 |
| `scripts/smoke-*.ts` | 冒烟脚本要能容忍连接级帧（票 05 记的那五个按票 15 的清单算） | 票 15 |
| `docs/architecture.md` | `## wire` / `## API` / 侧边栏与列表那一段 | 票 12 |

### 8. 决定记录（下游可以直接依赖的）

| # | 决定 | 直接约束谁 |
|---|---|---|
| 1 | 概况的行是 **`SessionRow = SessionRef + modified + running + pending`**；不带 `error`、不带当前工具名、不带 `usage`；`title` **只有一个推导**（`getTitle()`：活动分支第一条有文本的用户消息、截 72 字符），冷路径的探针跟着改成同一条 | 03、12、15 |
| 2 | **分两条道**：内容（`streamId = 会话 id`）与**连接级概况**（`streamId: null`，与票 07 的心跳同一座位）；**`running` 属于概况**，不照 DSH 分三条 | 05、07、11、15 |
| 3 | 连接级帧：`{ streamId: null, item: { type: "sessions", sessions } }`（每连接一次的基线）与 `{ streamId: null, item: { type: "session_row", session } }`（整行替换；**无 seq、无按键合并**） | 05、11、15 |
| 4 | 投影是服务端**进程内一份 store**；目录扫描只是 seed，触发点是"有人要看列表"（`GET /api/workspaces` / `/api/sessions`；第一次取行时惰性 seed），**不按事件重扫、重连也不重扫**；冷会话的 `running`/`pending` 恒为 `false`/`0` | 09、12 |
| 5 | 投影**不挂进** `hub.observe()` 那张订阅镜像（否则票 08 的遗弃计时器永不触发），它用 hub 新增的 host 级观察点 | 08、09 |
| 6 | 推送时机是"**变更即重算那一行，不同才发**"；`running`/`pending` 来自活会话的 `onChange`，`modified`/`title` 来自 `entry_appended`（+ `branch_changed`），整行出现来自 host 级观察点 | 08、11 |
| 7 | 客户端行 store 是**连接级**的（不进 `ViewState`、不进 reducer）；**通道 `live` 时只有通道写行，`connecting`/`down` 时 REST 兜底**；重连收新基线**整表替换** | 06、07 |
| 8 | 侧边栏按 `modified` **实时重排**（用户选定）；组间改按组内最新 `modified`（修 `newestAt` 读 `createdAt` 的漂移）；行的时间读 `modified`；**行原地改**、不整表重建；相对时间的重画挂在帧到达上 | 03、12 |
| 9 | 两栏状态行**各画自己那份 `usage`**（票 05 的遗留）；连接指示器画在**侧边栏顶部那一行**（用户选定），不进 reducer | 03、05、07、12 |

### 9. 本票没有回答的（别当成已定）

- **`COLLAPSED_COUNT = 4` 还成不成立、一行状态够不够**（票 03 的遗留 1 与 6）：多一行状态之后每行高度变了，而"三个会话同时跑会不会一片琥珀色"是**配色与密度**问题，不是字段问题。落地时看实物。
- **第三个在跑的会话在并排画面里的记号**（票 03 的遗留 3）。
- **概况通道的背压**归票 11（本票只钉住它一帧一行、每次变化一行）。
- **冒烟怎么看见概况通道**（票 15）。
- **手工放进来的会话文件什么时候被发现**：本票只说 seed 的触发点（"有人要看列表"）。跨进程写盘不可见，这条不修。

## Comments

**2026-10-12，票 07 解决时追加（本票仍 open，这里只登记两件本票会碰到的东西）**：

1. **连接级座位已经被占了一类载荷，但座位没被占满**。票 07 往 `{ streamId: null, … }` 上放了**心跳**（`{ streamId: null, item: { type: "heartbeat", everyMs } }`，5000 ms，客户端判活用）。这不影响本票第 2 问那条"全局概况的投影流"：连接级载荷本来就不是 `ServerMessage` 的成员，多一类载荷不占第二个座位，也不需要新座位；"按 `streamId` 分派"的那一层按"不属于任何一栏"处理它们即可。唯一的实际影响是**冒烟与新客户端都要容忍连接级帧混在流里**（票 15 已记）。
2. **`status` 的 `usage` 归属已经定过一半**：票 05 判 `status` 是**逻辑流的一帧**（因为它逐字段都是那个会话的），并把"两栏并排时状态行画哪一份"留给本票；票 07 在这一块**只改了一件事**：状态行里"断开就清空三个数字"那段被删掉，token 三个数字**恒定**画，连接状态改由**窗口级**的指示器承担。所以本票在摊开两栏状态行时不必再考虑"哪一栏显示断线"——那个问题已经不属于状态行了（票 07 第 2 条）。

**2026-10-12，票 10 解决时追加**：本票的五问已在 `## Answer` 里答完（两条分道、`SessionRow` 三个字段、进程内投影 store、变更即重算、按 `modified` 实时重排），两处需要用户拍板的由用户在同一次响应里选定（字段集选 B：`running` + `pending`；排序选 A：照实实时重排；连接指示器选 A：侧边栏顶部那一行）。下游登记散在各票的 Comments 里：票 03（第二行状态的两处收窄 + 状态行/指示器落点）、票 05（`streamId: null` 上的第二类载荷、`running` 的双份规则）、票 06（连接级基线 ≠ 逻辑流基线）、票 07（`live` 判据不受基线先后影响、指示器落点）、票 08（投影不挂订阅镜像，计时器读点不变）、票 09（新增 host 级观察点的理由、`SessionRow` 是新增类型）、票 11（写量）、票 12（落点清单）、票 15（新帧种类）。**本票只产出决定，代码一行未动。**

**2026-10-12，票 11 解决时追加（本票的 Answer 一字未改；§9 里"概况通道的背压归票 11"那一行已有答案，另有一条落点补充）**：

1. **概况通道不需要任何特殊待遇，也不需要淘汰机制。** 票 11 判定：停滞期间**不丢帧**（超字节预算就结束整条连接），所以本票那两类连接级帧（`sessions` 基线、`session_row` 整行替换）既不必进任何白名单、也不必为"丢了怎么补"设计——它们**要么按序送达，要么随整条连接一起结束并由重连重建**。票 11 记下了它们"可以丢"这条性质（整行替换幂等），但没有使用它；**唯一绝不能被丢的是基线**，而本票的两条基线（连接级 `sessions` 与逻辑流 `baseline`）在票 11 的规则下都不会被丢。
2. **写量的量级被实测了**：一张连接级概况的写量与"每 token 一帧"的内容帧完全不在一个量级（本票 §4 已说"不随 token 变"），票 11 用 11 B 的小帧实测出**小帧要 ~143 KB 才把 16384 的窗口填满**——也就是说填满通道的从来是内容帧，概况帧与心跳一样是**最后**被卡住的那一类。
3. **一处落点补充给落地**：票 11 的队列与停滞策略落在**新 mux 的连接层写侧**（票 05 §6 的"信封的构造点"），`packages/server/src/projection.ts` 与 `stream-registry.ts` 的帧产出**不受影响**——它们继续只发 `StreamFrame`，"这条连接写不写得动"由连接层一个人管。本票 §7 那张落点表不需要改。

**2026-10-13，票 15 解决时追加（本票的 Answer 一字未改；这里登记 §7 里"`scripts/smoke-*.ts`"那一行的内容，以及本票 Comment 3 那条可断言验收的落点）**：

1. **Comment 3 那条（没有任何会话订阅时仍应收到那一行的 `session_row`）有了家**：新脚本 `scripts/smoke-mux.ts`，装置是共享的 wire 客户端（`scripts/wire/client.ts`）；做法是**一个逻辑流都不开**、POST 一次、断言连接级收到 `running: true` → `running: false` 且 `modified` 前进。它是"后台会话那一行照常更新"唯一的可判定形式。
2. **连接级三类载荷的到达顺序不许写进断言**：票 15 要求"`sessions` 基线与 `heartbeat` **都到**即可，不断言谁先"，并且共享客户端的 `waitFor(sessionId, …)` **永不返回 `streamId: null` 的帧**——否则一帧心跳就能让"第一帧是基线"随机失败。
3. **`SessionRow` 上线的连带面**：`GET /api/workspaces` / `/api/sessions` / `/current` 与 `POST /sessions` / `forks` 的应答体一起换成 `SessionRow[]`——票 15 不改这些断言的形状，但 `smoke-api.ts` 与 `smoke-sessions.ts` 里凡手工构造过 `SessionRef` 期望值的地方都要跟着改。
