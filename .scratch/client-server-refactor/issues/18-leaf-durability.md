# leaf 可持久化

Type: grilling
Status: resolved
Blocked by: 09

## Question

票 09 给"回退分支再输入"在新模型下装了一条**没有计时器的**守卫：`hub.reap()` 不关闭有未落盘 leaf 的
会话（`SessionManager.hasUnrecordedLeaf()`）。它让行为正确，代价是那个 `Agent` 会一直组装着，直到
进程退出或有人再动这个会话——而 `docs/notes.md:67-80` 早就把这处技术债记下来了，本票要把它连根拔掉。

现状（票 09 查过并写进它的 Answer）：leaf 只在内存。`SessionManager.buildIndex()` 每次加载都把
`leafId` 设成**最后一条 entry**（`session-manager.ts:928-936`），`branch()` 只改内存里那个字段
（`:1386-1389`），`branchTo()` 除了移动它之外只发一个 `branch_changed`
（`packages/core/src/agent.ts:874-892`）。于是有两件事今天都靠"有人恰好持着会话"：

1. 同一个会话里"回退分支、再输入"——新模型下由票 09 的守卫兜住；
2. 关掉窗口之后、进程重启之前做出的那次移动——**今天就是丢的**，守卫也救不了它（`close()` 与进程
   退出都不写它）。

要钉死的是：

1. **leaf 怎么落盘**。今天文件是一棵树、每条 entry 带 `id`/`parentId`，而"现在在哪"只是读的时候按
   最后一条 entry 推出来的。候选：**(a)** 一条新的**状态 entry**（`tool_config` / `model_change` /
   `prune` / `compaction` 是同类，而"未知 kind 原样带过"是既有约定），由 `buildIndex()` 认它；
   **(b)** header 上的一个字段——但 header 只在建会话时写一次，而"**这种格式从不重写一行**"是
   `docs/architecture.md:226` 的承诺；**(c)** 一个独立的 sidecar 文件。
2. **认下来之后，哪些遍历要跟着改**。三处各有各的规则，不能一句话带过：`getBranchPoints()` 有一条
   既有的「状态 entry 被穿过去」规则（`session-manager.ts:1165-1173`，`docs/architecture.md:273` 讲的
   就是它），它要认这条新记录；`buildSessionPath()`（`:278-298`）只沿 `parentId` 走链、**不过滤任何
   kind**，`buildContextEntries()`（`:364-374`）在它之上施加 compaction / prune / argtrim——这两处要
   各自回答"一条 `leaf` entry 算不算 transcript 的一部分"（直觉：它是状态，所以不进上下文）。
   `entry_appended` 与基线里的 `leafId`（`packages/core/src/session/snapshot.ts:66`）也各要说一句话。
3. **老文件怎么办**。没有这条记录的会话按今天的行为（最后一条 entry）读，还是要补写一条？
4. **守卫的退场**。leaf 一旦可持久化，票 09 那条 `hasUnrecordedLeaf()` 守卫就该删掉——本票要顺带
   确认它真的可以删，也就是"这个会话没有别的只在内存里的状态"这条断言成立。
5. **与票 09 的边界**。本票不重开它的任何决定（订阅不拿 claim、运行持有自己的 claim、`observe`、
   `claim(sessionId)` 的签名）；它只回答"leaf 怎么活过一次没有任何持有者的时期"。

## Answer

### 结论（一句话）

**leaf 变成一种状态 entry（kind 叫 `leaf`），由 `branch()` / `resetLeaf()` 在位置真的移动时写出，
`buildIndex()` 重放它**——文件继续只追加、永不重写一行，重开一个文件的进程从最后一条 `leaf` entry
恢复"现在在哪"。票 09 的守卫**从未落地**（票 09 只产出决定、代码一行未动，`hasUnrecordedLeaf()`
今天不存在于任何源文件），而本票查实它的判据在新世界里**没有"真"可取**，所以处置不是"删"而是
**从落地清单上划掉**：守卫永远不落地，leaf entry 取而代之。

下面按票面五问答。

---

### 1. leaf 怎么落盘：一条状态 entry

三个候选的死活：

- **(b) header 字段 —— 死。** header 只在建会话时写一次（`newSession()`），落一个字段进 header 意味着
  每次移动都要重写第一行，而"这种格式从不重写一行"（`docs/architecture.md:226`）是这个格式**唯一**不做
  的事；且 `forkFrom()` 复制 header 换新 id，一个 header 里的位置会作为一份**立刻过期的事实**被复制进
  每个 fork。
- **(c) sidecar 文件 —— 死。** "一个会话 = 一个 JSONL 文件"是发现（`findAnywhere` / `findById` /
  `findMostRecentSession` 只扫 `.jsonl`）、fork（只复制 entry 行）、列表、`snapshotOf()` 冷读共同假设的
  事实。sidecar 不随 fork 旅行、不随文件移动，缺席与过期会成为第二份要和解的真相——而它要记录的东西
  一行 entry 就装下了。
- **(a) 状态 entry —— 胜出。** 文件已经用 entry 记状态（`tool_config`、`model_change`、
  `thinking_level_change`），"未知 kind 原样带过"是既有约定，本构建是唯一写这个格式的构建；而
  `buildIndex()` 本来就是 `leafId` 的唯一拥有者，认一条新记录不引入第二个读取方。

形状：

```ts
export interface LeafEntry extends SessionEntryBase {
	type: "leaf";
	/** The position the conversation moved to: an entry id, or null for "before the first entry". */
	leafId: string | null;
}
```

（片段的注释随 `session-manager.ts` 既有英文惯例——该文件 669 行 doc 注释零 CJK；这与 `AGENTS.md`
字面规则的冲突已由票 13 查明并登记，本票沿用其裁决"不在本票里裁决"。）

写法三条规则：

1. **谁写**：只有 `branch()` 与 `resetLeaf()`（后者今天没有任何调用者，但它的语义同样是"位置变了"）。
   `appendMessage` 等追加推着 leaf 走，不需要记录——文件最后一条 entry 就是位置。
2. **何时写**：位置**真的移动了**才写。这是 `recordSelection` 的同一条规则（"只追加移动了的那些"，
   `agent.ts:519-531`）：移动到当前所在之处不写，所以连续的 no-op 移动不增长文件。
3. **怎么写**：作为**当时的追加头**（pre-move leaf）的子节点追加，然后这次追加**不推进** leafId，
   `branch()` 紧接着自己设置目标。树的位置记的是"这次追加发生在哪"，`leafId` 字段记的是"对话去了哪"
   ——两个事实，各占一个字段。

重放规则（`buildIndex()`，`session-manager.ts:928-936`，**唯一改变规则的遍历**）：按文件序处理，
`leaf` entry 把 `leafId` 设成它**记录的**位置（id 或 null），其他每种 entry 把 `leafId` 设成自己。这
精确重放了内存序列——包括"追加继续发生在一条更早的 `leaf` entry 之下"的情况（见第 2 节
`getBranchTip` 行）：后写的 entry 是最后的话，`leaf` entry 里记录的位置像一条旧的 `model_change` 一样
自然过期，不需要任何人去清理它。

两条兜底：记录的目标 id 不在文件里（只有手改的文件能造出来）时，回落到 entry 自己的树位置——与
`buildSessionPath` 对未知 id 的兜底同一家族，文件保持可读；`CURRENT_SESSION_VERSION` 保持 3——它钉的
是线格式的代（扁平 → 树 → role 改名），kind 集合本来就开放，没有第二个构建按这个数字分支。

一条与 `persistEntry` 的交互要登记（`session-manager.ts:979-995`）：flush 闸在第一条消息之前不写盘，
那时的 `leaf` entry 与同期的 `model_change` / `tool_config` **同一命运**——活在内存缓冲里，随第一条
消息的整份冲刷一起落盘；从未得到过消息的会话留不住任何状态。这是既有行为，不是本票新病；本票落地
清单里的 close → reopen 断言要在首条消息之后做，别踩这个既有闸。

---

### 2. 哪些遍历跟着改：一处规则改变，其余各一句话

票面点名的三处加两件 wire 侧的事，逐个回答"一条 `leaf` entry 算不算 transcript"——**不算，它是
状态**，而这个直觉被既有机制逐字兑现；需要新规则的遍历只有 `buildIndex()` 一处：

| 读取方 | 改什么 |
|---|---|
| `buildIndex()` | 唯一的规则改变，见第 1 节 |
| `buildSessionPath()`（`:278-298`） | **不改**。它不过滤任何 kind，一条在链上的 `leaf` entry 是状态：`sessionEntryToContextMessages` 对 message 与 compaction 之外的每个 kind 回 `[]`，`leaf` 落进这个默认臂——它留在路径里、不进消息，与 `tool_config` 同款 |
| `buildContextEntries()`（`:364-374`） | **不改**。它施加的三步（compaction / prune / argtrim）命名的都是**别的东西**（切口、被清的结果、被短的参数），`leaf` 命名的是位置；它不新增第四步 |
| `sessionEntryToContextMessages()` | **不改**（联合类型多一个成员，默认臂照旧穷尽） |
| `getBranchPoints()`（`:1165-1173`） | **规则不改，两条既有规则已经覆盖**：「子节点只在有一条消息能通过它抵达时才算数」把一条刚写下的 `leaf` entry 排除在选项之外（它没有后代，`message: false`）；「消息之前的状态 entry 被穿过去」覆盖它后来有了后代的情况——那时它是一次**真实的**继续（"从移动前的位置再写一条"），把它当选项提供是对的。变的只有注释里的 kind 枚举（补 `leaf`），`docs/architecture.md:273` 同步 |
| `getBranchTip()`（`:1204`） | 一句话：下降跟随"最后写的孩子"、不分 kind，所以一条 `leaf` entry 可以是 tip。落上去意味着"这条子树最后长在这里"，从这里继续，重放按文件序取最后的话——记录的位置自然让位，没有悬空的指针 |
| `getRecordedSettings()` / `getRecordedToolConfig()` / `getTitle()` / `getContextMessageEntryIds()` | **不改**：各自匹配自己的臂，`leaf` entry 匹配不进任何一条。同族的 `getSessionContextSettings()`（`:301-320`）与 `declareConversation()`（`agent.ts:929`，走 `sessionEntryToContextMessages`）同答 |
| 追加时的 `branch_changed` 判定（`agent.ts:1411-1412`） | 一句话登记：`appendMessage` 读 `getLeafId()` 与 `getChildren(parent)` 的**原始**计数来决定要不要发 `branch_changed`，没有 getBranchPoints 那条 message-reachable 过滤——一条挂在链上节点之下的 `leaf` entry 会进计数，让一次普通续写多发一帧快照。**与既有 state-entry 先例同形**（消息前写出的 `model_change` 今天已产生同形），多发的一帧无害（窗口整份重画、看不到多余分支点），落地时补一句注释、不改行为 |
| `entry_appended`（`agent.ts:211`） | **不发**。一次移动已经由 `branch_changed` 的整份快照报告（`stream-registry.ts:229` 的头注说的正是这件事），而 `entry` 帧的配对（"fork from here"）只对 message entry 有意义——`getContextMessageEntryIds` 永远不会点名一条 `leaf` entry。协议与 `protocol.ts` 一个字节不改 |
| 基线里的 `leafId`（`snapshot.ts:66`） | **代码不改，语义变实**：`getLeafId()` 的答案从"最后一条 entry"变成"文件记录的位置"，冷读路径（`snapshotOf()`）从此报出移动后的 leaf。这正是本票第 1 问第 2 半——"关掉窗口之后移动还在不在"——**第一次可观察**的地方：一份快照的 `leafId` 就是那句回答 |
| `forkFrom()`（`:1466`） | 整份日志的 fork（entryId 为 null）照抄 `leaf` entry，重放的目标必在副本里（目标永远是文件里已存在的 entry）；按分支的 fork 沿 `buildSessionPath` 走树，只沿 `parentId`——**链上的** `leaf` entry 会被带上、链外的不被带上。所以一句诚实的更正：悬空记录**可以**被复制——仅当有人手点名一条链上的 `leaf` entry 为 fork 入口（它记录的目标恰在链外时），而 Answer 第 1 节的回落规则接住它，终值仍是"以此处结尾"的诚实读法。UI 的两个入口（`messageEntryIds` 与分支选项）都不含 `leaf` entry，这条路人手够不着 |
| 列表 / 侧边栏（`buildSessionInfo`） | **不改**：只数 message entry，一次纯移动不推进 `modified`，排序不受影响 |

---

### 3. 老文件：不补写

**按今天的行为读（最后一条 entry），不补写。** 补写被一条更硬的规则否掉：冷读路径 `snapshotOf()`
经 `SessionManager.open()` 打开文件，而"读 transcript 不得在它里面成为一次事件"
（`session-factory.ts:148` 的原话是 "Reading a transcript must not be an event in it"）——open 时补写
一条 `leaf` entry，等于让每一次读都变成一次写，读路径"不留痕迹"（`hub.ts:171-179` 那段注释的全部
要点）就此作废。（诚实半句：`open()` 今天并非绝对零写——缺尾换行的修复追加一个 `\n`
（`session-manager.ts:512-513`）、空文件的收养重写（`:870-881`）是类文档点名的 repair 例外；它们修的
是**可读性**，补写 leaf 记录的却是一条**新事实**，性质不同，不构成先例。）第一条 `leaf` entry 由升级
后的**第一次移动**写出；在那之前，老文件的行为与今天逐字节相同——这同时就是"没有迁移"约定的又一次
成立：这份格式从不为旧文件做任何事，它只是开始在新位置留下记录。

---

### 4. 守卫的退场：它从未落地，而且它的判据在新世界没有"真"可取

**先钉事实**：票 09 的提交自己写着"本票只产出决定，代码一行未动"；全树 grep `hasUnrecordedLeaf` 零
命中。所以"删掉"的准确形式是：**把票 09 的决定 8 从落地清单上划掉**——在守卫和新模型的其余部分
一起落地之前，本票先让它失去被落地的理由。这不是重开票 09：它的 Answer §5 自己写着"那时这个谓词
本来就该删"，而把 leaf 可持久化指给本票的是它的**决定 9**（决定 8 的"直接约束谁"栏里写着本票）。

**机制性的理由，不止 deference**：守卫的判据是"`getLeafId()` 不在文件最后一条 entry 上"
（票 09 Answer §5）。落 leaf entry 之后，每次移动都写下一条 entry——文件**最后一条** entry 变成那条
`leaf` entry 本身，而 `leafId` 在它记录的目标上。于是"leafId 不在最后一条 entry 上"对**最后一次文件
事件是一次移动**的会话恒真——恰是"点过分支又走开"的那群人；之后再追加一条会把它翻假，但那个会话
恰好没有未记录的移动，守卫本来就不该拦它。守卫会把每个点过分支又走开的会话永久钉在内存里——
"没有计时器的钉子"从一处技术债变成**每一个用过分支的用户**的技术债。判据在新世界里连"什么是未
记录的移动"都区分不出来（已记录的移动恰恰就是 leafId 偏离**文件尾**），它不是过时了，是
**不可定义了**。

**断言成立，逐项清点"重开必须恢复、而文件里必须有"的东西**：

| 状态 | 活在哪 |
|---|---|
| transcript | entries |
| 对话位置（leaf） | 本票的 `leaf` entry —— **最后一条** |
| 模型 + thinking level | `model_change` / `thinking_level_change`（`getRecordedSettings`；构造器 `agent.ts:417-419` 用它初始化 `recordSelection` 的基线） |
| 活跃工具 + 审批映射 | `tool_config`（装配在 `session-factory.ts:135` 重放，`applyBranchToolConfig` 在移动处重放） |
| 队列（steer / followUp） | 只在一次运行期间存在，而运行持有自己的 claim（票 09 决定 2）——无 claim 的会话队列按构造为空 |
| 待回答审批 | 票 14 判定不跨重启的运行时事实；回收在 close 之前有自己的审批宽限路径处理它们 |

leaf 是最后一条，断言成立。**边界的诚实一句**：子代理的后台 job 是进程内存货，随 `close()` 一起死
——但守卫从来不保护它们，重开也从来不恢复它们，票面没有开它，这里只登记不裁决。

---

### 5. 与票 09 的边界

不重开它的任何决定：订阅仍不拿 claim、运行仍持有自己的 claim、`observe` 与 `claim(sessionId)` 原样、
`reap()` 的唯一计数输入仍是 claim。本票只回答"leaf 怎么活过一次没有任何持有者的时期"，而且它让
决定 1 **更纯**：那条守卫是"唯一一个不计数、却能让一次回收半途而废的东西"，划掉它之后，
"订阅集合的任何状态都不能阻止一次回收"这句话第一次没有脚注。

---

### 决定记录（下游可以直接依赖的）

| # | 决定 | 归属 | 直接约束谁 |
|---|---|---|---|
| 1 | leaf 落盘为一条**状态 entry**（kind `leaf`，`leafId: string \| null`），不是 header 字段、不是 sidecar；`CURRENT_SESSION_VERSION` 保持 3 | 本票 | 落地票 |
| 2 | 只有 `branch()` / `resetLeaf()` 写它，位置真的移动才写（`recordSelection` 同款守卫）；entry 的树位置是当时的追加头，`leafId` 字段是去的地方；这次追加不推进 leafId | 本票 | 落地票 |
| 3 | `buildIndex()` 重放：`leaf` entry 把 leafId 设成记录的位置，其他每种 entry 设成自己；文件序是最后的裁判；目标 id 不在文件里时回落到 entry 自己的树位置 | 本票 | 落地票 |
| 4 | `leaf` entry 是状态、不是 transcript：不进消息（`sessionEntryToContextMessages` 的默认臂）、不发 `entry_appended`（移动由 `branch_changed` 的整份快照报告）；`protocol.ts` 一个字节不改 | 本票 | 15、落地票 |
| 5 | 老文件不补写：读路径不得为补一条记录而开始写（首条记录由升级后的第一次移动写出） | 本票 | 落地票 |
| 6 | 票 09 决定 8 划掉——守卫**永不落地**：它的判据（leafId 不在文件尾）在 leaf entry 落地后对移动过的会话恒真、对"未记录的移动"不可定义；"重开必须恢复的东西文件里都有"经第 4 节逐项清点成立 | 本票 | 09、15、落地票 |
| 7 | 与票 09 的边界：它的任何决定不重开；本票只让决定 1（"reap 只听 claim"）第一次没有脚注 | 本票 | 09 |

**本票没有回答的**（别当成已定）：

- 子代理后台 job 随 `close()` 一起死：守卫从不保护它们、重开从不恢复它们。票面没开，这里只登记。
- 注释语言（`AGENTS.md` 字面规则与全树英文实践的冲突）：票 13 的登记适用，本票沿其裁决不裁决。
- `Agent.appendMessage` 的原始子节点计数会让挂在链上节点之下的 `leaf` entry 多发一帧快照：与既有
  state-entry 先例同形、无害，落地时补一句注释，不改行为——是否收紧成 message-reachable 过滤，
  本票没有开。

### 落地清单（本票只登记，实现归落地票）

1. **`packages/core/src/session/session-manager.ts`（唯一的生产代码文件）**：`LeafEntry` 类型 +
   `SessionEntry` 联合；`branch()` / `resetLeaf()` 记录（位置真的移动才写、追加不推进 leafId）；
   `buildIndex()` 重放（含未知目标回落）；`getBranchPoints()` 的注释枚举补 `leaf`。`Agent` 一行不改：
   `branchTo` 调的仍是 `sessionManager.branch()`，记录发生在存储层，客户端报告仍走 `branch_changed`
   的整份快照。
2. **文档（随落地一起改，今天它们说的仍是事实）**：`docs/architecture.md` —— `:197`"存在七种 kind"
   改八种并加一条 bullet；`:273` 的枚举补 `leaf`；`:281`"leaf 本身活在内存里"整段改写；`:430-438`
   的"未决"一节删除（它的两个方向：一个是本票，另一个——"分支移动自己拿一个长寿命 claim"——从未
   有人选，且票 09 决定 2 已把 claim 的两类持有者钉死）。`docs/notes.md` §三改写为**已解决的记录**：
   洞是什么、什么时候闭的、以什么形式。`AGENTS.md` 术语里 entry kind 的"等"字照旧覆盖。
3. **冒烟**：`scripts/smoke-api.ts` 树那段按票 15 登记的形状落地，并落成它的最终形式——**移动之后
   不 attach 任何东西**，等会话被回收，然后一条**冷读**（`GET /api/sessions/{id}`）报出移动后的
   `leafId`（这就是"因为 leaf 落盘了"的可观察形式：证明移动活在文件里，不活在某个恰好驻留的
   `Agent` 里），下一条 prompt 仍从它继续；`scripts/smoke-session.ts` 补一组 close → reopen 断言
   （移动活过 close；一份没有 `leaf` entry 的文件按最后一条 entry 读——手写一份 fixture 即可）。
4. **登记**：票 09 的 Comments 记决定 8 划掉；票 15 的 Comments 记那条断言的最终形式；`map.md` 的
   Not yet specified 那条改写，并向 Decisions so far 追加一条上下文指针——票 09 那条指针里
   "（后面那条守卫不是第二个输入：它不计数、也不因订阅触发）"的括号随决定 8 的划掉一并交代。

## Comments

**2026-10-13，票 15 解决时追加（本票仍 open；这里登记一条随本票落地会变形的冒烟断言）**：票 09 的守卫（`hub.reap()` 不关闭有未落盘 leaf 的会话）在冒烟里有了一条断言——`scripts/smoke-api.ts` 的树那一段删掉"脚本必须另持一条 claim"这个前提，改成"移动之后**不 attach 任何东西**，下一条 prompt 仍从移动后的 leaf 继续"（票 09 给的形式）。**本票落地时它能变形的前提是你让 leaf 可持久化**：那时这条断言要重新表述成"因为 leaf 落盘了"，**不是删掉它**——否则"关掉窗口之后移动还在不在"会重新变成一个没人测的行为，而那正是本票第 1 问的第 2 半（今天就是丢的）。顺带把两段**今天仍然为真**、但随票 09 的守卫（或随本票的落盘）一起变假的文字登记给本票：`docs/notes.md` §三 与 `docs/architecture.md` 的*会话树*那段（`:434`）都写着"`scripts/smoke-api.ts` 的绕法是：为移动之后的那次运行 attach 一条流"——落地后那句话不再需要，要跟着改。
