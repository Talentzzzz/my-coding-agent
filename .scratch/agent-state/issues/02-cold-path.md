# 02：冷路径——没被打开的会话怎么读、怎么改

Type: grilling
Status: resolved

## Question

`SessionManager.states`（`packages/core/src/session/session-manager.ts:1377`）删掉之后，**没被打开的会话**
如何读写。现存的冷路径调用点：

| 位置 | 做什么 | 性质 |
| --- | --- | --- |
| `hub.ts:402` | 按 entryId 找 entry（分支跳转） | 读 |
| `hub.ts:558` | 分叉时取源文件路径 | 读 |
| `hub.ts:563` | `forkFrom` | **写**（落一对新文件） |
| `hub.ts:587` | `setTitle`（侧边栏重命名） | **写** |
| `hub.ts:636` / `:648` | `remove` | **写**（删文件） |
| `projection.ts:180` | 活会话的标题/时间戳 | 读（可改从 AgentState 读） |
| `session-factory.ts:187` | `readSessionSnapshot` | 读（本来就自己 fill） |
| `findSessionFilePathById` | 扫目录 | 本来不缓存 |

两条路：

- **(a) `SessionManager.open(id): Session`**：fill 一份、**不缓存**、调用方用完就丢；冷写就是「fill → 改 →
  persist」。并发安全靠现有的 claim（同一个会话一次只有一个改变它的请求），必须在文档里写明这条前提。
- **(b) 调用方自己 `fillSession(path)`**：`SessionManager` 只留纯函数，不收 id。hub 要知道路径解析规则。

另需定：`forkFrom` 造出来的新会话要不要顺手进 AgentState（现在是 `states` 自动收，下一次 `stateOf` 拿到同一份），
还是等它自己的 open（那就会 fill 两次、读到刚写好的文件）。

➡️ 推荐 **(a)** + fork 的新会话**等自己的 open**（少一条「写入即入表」的隐式路径，代价是一次重复 fill）。

## Answer

### 结论（一句话）

**(a)**：`SessionManager.open(id)` 填一份、**不登记**、调用方拥有，冷写就是「`open` → 改 → 写盘」——而这三步
其实是**两个动作**：`open(id)` 加一个既有的 setter，写盘在 setter 自己身上（§5）。**fork 的新会话等它自己的
第一次 open**，并且由此可以再进一步：`forkFrom` 连那一份都**不填**，只写文件、返回 id 与路径（§6）。票面
➡️ 的两半都成立，只有一笔账要更正——「代价是一次重复 fill」在"forkFrom 不 fill"之后是零。

另有两条前提票面没写，本票补上：

1. **活会话永不走冷路。** `open` 只回答「这个进程**没在跑**的会话，它的文件是什么」；`hosts` 里有的 id，
   读写都必须落在 `Agent` 表里那只袋上。今天这条是 `stateOf` 的缓存**顺手**保证的（同一个 id 只有一只袋），
   缓存一删就没人保证了，而它丢的是数据不是性能（§3）。
2. **冷写的并发安全不是 claim 给的。** 票面写"并发安全靠现有的 claim"，可最要紧的那条冷写——改名——
   **明确不拿 claim**（`controllers/sessions.ts:556`，`hub.ts:574` 也一样写着 "It takes no claim"）。
   真正让冷写安全的另有其事：`open` → 改 → 写盘是**一段同步代码**（§4）。文档要写的是「活着的时候写者唯一、
   冷的时候一次同步块」，不是「靠 claim」。

### 1. 为什么是 (a)：hub 已经手写过一次 (b)

票面把 (b) 说成「`SessionManager` 只留纯函数，hub 要知道路径解析规则」，代价听起来只是一条架构洁癖。实际
代价已经在代码里付过一次了——`hub.snapshotOf` 的冷分支（`hub.ts:363-369`）：

```ts
const absPath = SessionManager.findSessionFilePathById(id);
if (absPath === undefined) throw new Error(`Unknown session: ${id}`);
const state = fillSession(absPath);
```

三行里三件 store 的事：**id 怎么变成路径**（扫每个目录的 `.json` 头，按快照 id 匹配，命中就答同 stem 的
`.jsonl`——只读快照，不解析 transcript）、**查不到时怎么说话**（`Unknown session: ${id}`，与 `stateOf` 逐字相同）、
**路径怎么变成袋**（`fillSession`，含它自己的剪枝与版本拒绝）。这三行就是 (b) 的样板。

要照抄它的地方并不算少：`hub.ts` 三处（`snapshotOf` 的冷分支、`rename` 的冷半、`open`），`smoke-sessions.ts` 那段
`stateOf` 契约（`:848-871`）里的三处，加上将来任何一处。而 (a) 只多一个方法体，就把这三件事连同失败文本收在一处：
调用方写 `open(id)` 等于说"我在读盘"，不必知道 `.json` 是 commit marker，也不必自己决定 id 查不到时说什么。
（(b) 的另一个隐藏代价在 §3：它把"这是冷还是活"的判断留给每个调用点，而这个判断错一次就是丢数据。）

更要紧的是其中一条不是格式知识而是**前提**：`.json` 是出生的 commit marker，所以"`.json` 里 id 对上"就能直接
答 `.jsonl` 路径（`session-manager.ts:2034-2036`）。把这句话抄进 server，等于让 server 也持有一份格式约定，
而这个仓库对"两处实现描述同一件事"的态度一直是零容忍（`assemble()` 拆出来就是为了这个，见 `session-factory.ts:126-133`）。

反方向的理由也顺带站不住：删掉缓存之后，账本剩下的全部价值就是两件事——**id → 文件**、**文件 ↔ 袋**。(b) 把
前一半也推出去，`SessionManager` 就只剩一组 `(Session, …) => …` 的纯函数，那是一个函数库；而"这个 id 是哪个
会话"仍然得有人回答，只是回答的人从账本变成了 server。所以 10 号票那条"`stateOf` 删除或降为 `open` 的别名——
**不留两个名字**"正是 (a) 的形状：一个名字、一个新语义（fill 一份、不登记）。

### 2. `open(id)` 的契约

```ts
/**
 * Replay the session `id` names into a bag this call owns: no registration, no cache, the caller
 * drops it. Cold only — a session this process is running is written through the Agent's bag.
 */
open(id: string): Session;
```

四句话，缺一句就会被误用：

- **只填已经出生的文件。** 找得到 `.json`+`.jsonl` 这一对才会返回，返回的袋必然 `persist: true`、
  `fileCreated: true`（`:1103-1104`）。没落盘的会话不是它的事——那一半归 03 号票（`AgentState.session` 装未出生
  的袋），也正因为如此 `open` 不必回答"文件还不存在时怎么办"。它**自己**只有一种失败：`Unknown session: ${id}`，
  文本与今天的 `stateOf` 逐字相同（`:1846`），所以 controller 的 404 一个字都不用改；文件本身打不开时，`fillSession`
  的失败照原样抛出（含它的剪枝），这一层 `open` 不翻译也不吞。
- **不登记。** 同一个 id 连调两次是两只袋，这是特性不是缺陷：调用方一次冷写用一只，用完就丢。**不要**给它加
  一层 window 内复用——那就是把缓存搬回来。
- **`stateOf` 删除，不降为别名**（10 已定）。因此"再要一次拿到同一只袋"这条指望从此不存在，任何依赖它的
  代码都是 bug，而不是性能退化。
- **失败时它会删文件。** `fillSession` 会剪掉打不开的配对（`:1079-1096`）。也就是说 `open` 不是纯读——这一点今天
  `snapshotOf` 的冷分支已经在承受（它调的就是 `fillSession`），只是名字 `open` 比 `fillSession` 更容易被当成
  只读。配对坏了两边都该剪，所以不改行为，只在文档里说清。

### 3. 活会话绝不走冷路（票面没写、删了缓存就会出事的一条）

冷袋的危险不是读到旧的，是**写回旧的**。`writeMetaFile` 写的是**整只** `meta`（`:1181-1193`，`:1188` 一句
`JSON.stringify(s.meta)`），而 `recordMeta` 在 `persist && fileCreated` 时**立刻**重写（`:1247-1250`）。所以：

- 一只在跑（或刚跑完、还没被驱逐）的会话，袋里 `meta.model` / `thinkingLevel` / `activeTools` / `approval`
  已经被跑动改成了 M2；
- 一个冷 `open` 在 M2 之前填了一份 M1；
- 冷袋 `setTitle("新名字")` → 整只 meta 落盘 → 文件里模型退回 M1、思考档位退回旧值，且没有任何报错。

今天这件事**不会发生**，但原因很不体面：`hub.rename` 走的是 `sessions.stateOf(sessionId)`（`hub.ts:587`），
而缓存里那只袋就是跑动写的那只（`hub.open` → `stateOf` → `ensureSession`（01 之后叫 `assembleSession`）→
`adopt`，同一个对象）。也就是说**正确性挂在缓存上**。10 号票删掉缓存的那一刻，同一行代码会拿到一只新袋，
事故窗口就此打开。

更值得记一笔的是，`rename` 的注释（`hub.ts:572-573`）今天就把这条理由写出来了：「the write goes through
`stateOf` — which is deliberately **not** a fresh replay: the bag it hands back is the one this process's turns
are written through」。写这段话的人已经知道冷袋会写回旧值——只是那时缓存还在，保证是免费的。12 号票要让这句
话继续成立，就必须换一个免费的东西（§3 的 `rename` 分叉），否则那两行注释会变成谎话。

所以 12 号票的 hub 侧要落的不是"`stateOf` 换 `open`"，而是**先分叉再取**：

```ts
async rename(sessionId: string, title: string): Promise<void> {
	const hosted = this.hosts.has(sessionId);
	// A running session is written through the bag its run writes through — never a replay of its
	// file: the snapshot is written whole, so a stale bag would revert whatever the run just recorded.
	const state = hosted ? this.agent.agentState(sessionId).session : this.sessions.open(sessionId);
	this.sessions.setTitle(state, title);
	…
}
```

这条规则**只有一个落点**，所以不需要一个 helper，更不需要一个开关：**经袋的写里，只有 `rename` 是两态的**——
`fork` 的两侧都不经袋（§6），`remove` 不碰会话内容，其余写只走活路（`timestampOf`、`projection`），或者只走冷路
（`snapshotOf`、`open`）。逐点见 §8。（若 12 决定不把 `agentState` 公开成读法，就改成 `agent.setTitle(id, title)`，
与 `branchTo` / `applyConfig` 同形；结论不变，只是那只袋不离开 Agent。）

顺带一处可删：`hub.ts:583-586` 那个"没在跑就先 `findSessionFilePathById` 找一下"的前置判断，是为了让
"id 什么都没指"仍然是一句 `Unknown session`——而 `open` 抛的就是同一句话（`:1846`），所以它成了第二层网。
controller 的 `has()` 才是 404 的第一道，留着它不亏，删了也不改变任何对外行为。

`snapshotOf` 的冷分支（`:363-369`）本来就在 `hosts` 之后，性质天然是"冷"，改成 `this.sessions.open(id)` 是
纯简化（同样的 fill，少抄三行 store 知识）；它头上那句"用 transient replay 而不是 `stateOf`，因为读不能留痕"
届时改写为"`open` 就是不留痕的那条路"——**理由还在，只是名字换了**。

### 4. 并发：claim 不是这条路的保护

先把票面那句拆开看。"同一个会话一次只有一个改变它的请求"今天对**改名不成立**：`controllers/sessions.ts:556`
写着 "No claim is taken"，`hub.ts:583-587` 也一样，而且理由是对的——标题是会话的事实，不是某一条路的事实，
跑动的循环从不读它。所以拿 claim 当冷写的前提，是把一条不存在的保证写进文档。

真正的保证有三条，逐条都能指到代码：

1. **`open` → 改 → 写盘是一段同步代码。** 三者之间没有 `await`，Node 单线程就不会插进任何人。这个仓库已经
   在同一个论点上站过：`settleSessionFiles` 的注释（`:647-649`）写的是剪枝「是一整个同步块，出生
   （`persistEntry`）也是一整个同步块，而且一个进程从不同时跑这两件」，所以剪枝追不上进行中的出生。冷写与它同构。
2. **冷会话在这个进程里没有写者。** 没有 `hosts` 条目 = 没有运行 = 没有第二条写文件的路径。这是 §3 那条规则
   的推论，而不是 claim 的功劳。
3. **跨进程不在章程内。** 地图的 Out of scope 已经写了「多进程共享会话状态」，`writeMetaFile` 的 temp+rename
   只保证"读者看不到撕裂"，不保证两个写者不互相覆盖——这一点今天也如此，不是本票引入的。

所以写进 `open` 文档的那句话应该是：**「活着的时候，写者是唯一的（Agent 那只袋）；冷的时候，一次冷写是一段
同步块；两者不会同时成立，因为冷路只给没在跑的会话。」** claim 的职责一个字不改：它保证"活"这段时间里写者
唯一——而 §3 的规则保证"冷"不会与"活"重叠。两句话合起来才是完整的。

### 5. 冷写没有第二个动词

票面（和 10 号票）都写成「fill → 改 → **persist**」，容易被读成三个 API。实际只有两个：

- 写 meta：`recordMeta`（`:1247-1250`）先跑 `change` 回调，回调说"没变"（返回 false）就在 `:1248` 提前返回；
  变了、且 `persist && fileCreated`，就自己调 `writeMetaFile`——所以 `setTitle` 已经**包含**落盘；
- 写 entry：`appendEntry` → `persistEntry`（`:1230-1235`、`:1205-1227`）。

所以冷写的全部形状是 `this.sessions.setTitle(this.sessions.open(id), title)`，一行，没有 dirty 标记、没有
`save()`、没有"记得调用 persist"。这条要写进 `open` 的文档，否则下一个人会去找那个不存在的第三步。

### 6. fork：不 fill、不入表

现状 `forkFrom` 结尾两句（`:1927-1928`）：`const s = fillSession(absNewSessionFile); this.states.set(...)`。
两句都删：

- **不入表**——票面 ➡️ 已经这么判了，理由是 01 号票的同一条：表的唯一入口是 `adopt`（01 §2 / §6），"写入即入表"
  是第二个写者。删掉缓存之后这甚至不是选择题：`SessionManager` 到时**没有表可写**。
- **不 fill**——票面把"等自己的 open"记成"代价是一次重复 fill"。不填就没有重复：新会话的第一只袋来自它自己的
  第一次 claim（`hub.claim` → `open` → `assembleSession`），那一次读到的正是刚写好的文件。两件事保证它一定读得到：
  `forkFrom` 在返回前**同步**写完两只文件（`:1924-1925`，`.json` 用 `wx` 且写在最后，是 commit marker），
  而返回的 id 在有人 claim 之前不会被任何人当作袋来用。

回报形状跟着变：

```ts
forkFrom(sourcePath: string, entryId: string | null, sessionDir?: string): { sessionId: string; sessionFileAbsPath: string };
```

顺手去掉 `targetWorkDirInput`：它今天**永远等于源自己的 workDir**——hub 传 `hosted?.workDirAbsPath ??
fillSession(absSourcePath).workDirAbsPath`（`hub.ts:562`），而那正是源文件头里的 `workDir`（`SessionMeta.workDir`
是必填的，`:69`）；`forkFrom` 自己**已经**把那只头读进来了（`:1895` `readMetaFile`），落点目录那一步
（`:1906`）只是还没用它。也就是说：**为了把一个参数传进来，hub 必须把源文件重放一遍**——这是本票能顺手删掉的
第二处浪费。`smoke-sessions.ts:247` 那个调用要删的是**第二个**实参：
`forkFrom(parentFile, root, null, sessionDir(root))` 里的 `root` 正是 `targetWorkDir`，删掉之后写成
`forkFrom(parentFile, null, sessionDir(root))`——别把 `sessionDir(root)` 往前挪成 `entryId`。

注意这只删了"hub 需要袋"的理由，没删 hub 需要**路径**的理由：`hub.ts:555-558` 照旧是
`hosted ? agentState(id).session.sessionFileAbsPath : SessionManager.findSessionFilePathById(id)`。fork 的两侧
（读源路径、写一对新文件）都不经过袋，`forkFrom` 读的是**文件**而不是活袋——这本来就是对的：entry 一落地就
落盘（`appendEntry` → `persistEntry`），文件才是权威。

### 7. 代价：一次冷触碰 = 一次全量重放，并且要写明

`open` 解析整个 `.jsonl`。今天改名靠缓存摊平：一只会话改十次名，重放一次。删缓存之后改十次名，重放十次。

接受，理由三条：改名是人的手势而不是热路径；同一条路的 `findSessionRowById` 早就是"一个会话变了就解析它一个"
（`:1981-1990`）；而换来的是地图要的那件事——没人看的会话不占内存。

不接受的后果也要写清楚，否则将来会被当成漏掉的优化：**如果**哪天长会话改名开始肉疼，正确的解法是给"只改快照"
一条只读头的路（`readMetaForDiscovery` 已经在，`:599`），但那要求 `writeMetaFile` 不再以"手里有一只完整 Session"
为前提——那是另一个形状的写 API，不是本票的岔路。写在这里，是为了它是"已知代价"而不是"没想到"。

fork 的额外代价是**零**（§6），`snapshotOf` 的代价与今天相同（它本来就在 fill）。

### 8. 逐点落位

| 位置 | 今天的性质 | 改成 | 备注 |
| --- | --- | --- | --- |
| `hub.ts:402` `timestampOf` | **活**（`hosts` 先行，没有就返回 undefined） | 保留 `hosts` 门，读 `agentState(id).session.sessionEntryMapById` | 同步、不 fill。绝不能在这里用 `open`：它每帧都被调 |
| `hub.ts:555-558` fork 源路径 | 活 / 冷，但只要**路径** | 活：`agentState(id).session.sessionFileAbsPath`；冷：`findSessionFilePathById` | 冷路**不 fill**，所以它不经过 `open` |
| `hub.ts:562` 取 `workDir` 的 `fillSession` | 冷（非 hosted 分支） | **删除**——`forkFrom` 从源文件头自己读（§6） | 一次无谓的全量重放 |
| `hub.ts:563` `forkFrom` | 写 | 返回 `{ sessionId, sessionFileAbsPath }`，不 fill、不入表 | `hub.fork` 只用 id |
| `hub.ts:587` `rename` | 活 / 冷 | 活袋 `agentState(id).session`，冷 `open(id)`；`setTitle` 不变 | §3，经袋的写里唯一两态的一处 |
| `hub.ts:613-651` `remove` | 写（删文件） | `SessionManager.remove(id)` 退成纯文件 I/O（`:2058-2064` 去掉 `states.delete`） | 表里的条目由 `agent.evict` 负责（12）；"缓存比文件活得久"这个失效模式随之消失 |
| `hub.ts:363-369` `snapshotOf` 冷分支 | 冷 | `this.sessions.open(id)` | 纯简化，理由同 §1 |
| `hub.ts:360-361` `snapshotOf` 的 `pending` 分支 | 冷（本进程建的、还没落盘） | 随 03 走：表里有就读 `agentState(id).session` | 本票不涉及；列出来是为了这张表是完整的 |
| `projection.ts:180` | **活**（只在 `following` 的会话上，`onEvent` 由 `onHost` 挂） | `hub.agent.agentState(sessionId).session` | 用 `open` 会让每个 token 重放一遍全文 |
| `scripts/` 9 处 | 6 处**活袋**（`smoke-sessions.ts:146` 的 `bagOf` 与 `:210`、`smoke-projection.ts:212` / `:232`、`smoke-session.ts:950`、`smoke-tools.ts:688`），3 处在 `smoke-sessions.ts:848-871` 那段 `stateOf` 契约里 | 活袋读改 `agentState(id).session`；契约段对象换 `open(id)` | `:857`"同 id 复用同一只袋"——按新语义**删**；`:867`"查不到就抛"——保留；`:858-864`"写进这只袋就到文件"——保留，它正好变成 §5 那条冷写落盘的现成证据。10 号票写的"smoke 5 处"按的是文件数，实际是 9 个调用点 |
| `session-factory.ts:187` `readSessionSnapshot` | 冷，且自带 `assemble` | **不动** | 它要的是 snapshot 不是袋；袋仍由调用方给（`snapshotOf` 的位置） |
| `findSessionFilePathById` | 扫描，本来不缓存 | 不动 | |

`hub.ts:692`（`open`）随 03/12 一起变：`pending` 删掉之后只有一条取袋的路，这条不在本票。

### 9. 名字仍然叫 `open`，但 10 号票必须防一件事

`SessionHub` 自己有一个 `private async open(id)`（`:688`），管的是"装配 + 登记 + announce"；`SessionManager.open(id)`
管的是"重放文件"。两个 open 在一行里出现（`hub.open` 里调 `sessions.open`）读起来并不矛盾——外层那个的动词
在客户端叫 claim，内层那个才是"打开文件"。所以不改名，10 号票已经按 `open` 在写。

要防的是**机械替换**。`agent.ts` 里有 15 处 `stateOf(id)`；全树的 `SessionManager.stateOf` 调用点是 **29 处**
（agent 15、hub 4、`projection.ts` 1、`scripts/` 9），地图 Not yet specified 里那个 34 是 `stateOf` 的**混计**
（把 `SettingsManager.stateOf` 的几处也算进来了），迁移时不能拿它当清单。把留着的 `stateOf` 全量换成 `open`
会**编译通过**、类型全对，而运行结果是：每次调用重放一遍全文，写入落在一只用完就丢的袋上，跑动的内容凭空消失。
所以 10 号票的答案里要写死一句：**`agent.ts` 的调用点不是改名，是换源**——它们全部变成
`agentStateOf(id).session`（08 的活）；10 号票落完之后，`SessionManager.open` 的调用者应该只剩 `hub` 与
`scripts/` 里的冷读，`packages/core` 内部一个都没有。15 号票的全量 smoke 是这条的兜底：漏一处，跑动的消息就会丢，
smoke 一定红。

### 10. 决定记录（下游可以直接依赖的）

| # | 决定 | 直接约束谁 |
| --- | --- | --- |
| 1 | `SessionManager.open(id): Session`：fill 一份、不登记、调用方拥有；只填已出生的配对；查不到抛 `Unknown session: ${id}`；`stateOf` 删除、不留别名 | 10、14 |
| 2 | **活会话不走冷路**：`hosts` 里有的 id，读写都走 `Agent` 表里那只袋；`rename` 是唯一"活也可能冷"的写，就地分叉 | 10、12、15 |
| 3 | 冷写 = `open(id)` + 既有 setter，**没有**第三个 persist 动词；文档写"一次同步块"而不是"靠 claim" | 10、06、14 |
| 4 | `forkFrom` 不 fill、不入表，返回 `{ sessionId, sessionFileAbsPath }`，签名去掉 `targetWorkDir`（源文件头自己说） | 10、12 |
| 5 | `SessionManager.remove(id)` 退成纯文件 I/O；表的删除归 `agent.evict` / `close`（01 §6） | 10、12 |
| 6 | `projection.ts:180` 与 `hub.ts:402` 读 `agentState(id).session`；`hub.snapshotOf` 冷分支改 `open(id)` | 12 |
| 7 | 10 号票**禁止**把 `agent.ts` 的 `stateOf` 机械替换成 `open`：那是语义搬家，不是改名 | 10、15 |

### 11. 对下游票正文的修正（10 / 12）

这三句按票面写会做错，10 / 12 落地时以这里为准（同 01 号票对 08 的处理）：

- **10 的「`hub.ts` 5 处……读的改 `open(id)`」**：`:402` 不是读的冷路——它头上就有 `hosts` 门，是**活**的，
  改 `agentState(id).session`。`:558` 的 hosted 半也是活的，冷的那半只要路径、不要袋。真正换成 `open` 的只有
  `:587` 的冷半、`:692` 与 `snapshotOf` 的冷分支（§8）。
- **10 的「写的保持「fill → 改 → persist」」**：没有第三步（§5）。`:563` 也不是这个形状——`forkFrom` 只写文件、
  返回 id 与路径，连那一份 fill 都删（§6）。
- **10 的「smoke 5 处」**：按文件数是 5 个脚本，按调用点是 9 处，而且 `smoke-sessions.ts:857` 那条
  "复用同一只袋"的断言按新语义**必须删**，不是"按各自语义改"（§8 表末两行）。

12 号票的正文不需要改，只多两件事：`rename` 就地分叉（§3 的代码块），以及 `snapshotOf` 的冷分支改 `open`
后把那两行注释的理由换掉（`hub.ts:365-367` 说的是"读不能留痕"，新名字里这条已经写在 `open` 的文档上）。

### 本票没有回答的

- 驱逐判据与宽限期（04）；未落盘会话算不算打开、`pending` 怎么退场（03）；设置写回扇出（05）。
- 07 之后的字段形状：本票写的 `state.workDirAbsPath` / `state.sessionFileAbsPath` 以 07 落地后的
  `sessionSetting.*` 为准，语义不变。
- 冷写的**跨进程**并发（今天就不保证，地图 Out of scope）。
- 改名之外是否还有会变成"活也可能冷"的写。今天没有：`branch` / 工具集 / 模型 / 审批都自带 claim 或只走活路。
  若 03 之后未落盘会话也能改名，`rename` 的分叉要再加一条"表里有没有"的判断——不在本票。
