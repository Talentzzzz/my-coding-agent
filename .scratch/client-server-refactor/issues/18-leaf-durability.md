# leaf 可持久化

Type: grilling
Status: open
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

<!-- 解决时在下面追加。 -->

## Comments

**2026-10-13，票 15 解决时追加（本票仍 open；这里登记一条随本票落地会变形的冒烟断言）**：票 09 的守卫（`hub.reap()` 不关闭有未落盘 leaf 的会话）在冒烟里有了一条断言——`scripts/smoke-api.ts` 的树那一段删掉"脚本必须另持一条 claim"这个前提，改成"移动之后**不 attach 任何东西**，下一条 prompt 仍从移动后的 leaf 继续"（票 09 给的形式）。**本票落地时它能变形的前提是你让 leaf 可持久化**：那时这条断言要重新表述成"因为 leaf 落盘了"，**不是删掉它**——否则"关掉窗口之后移动还在不在"会重新变成一个没人测的行为，而那正是本票第 1 问的第 2 半（今天就是丢的）。顺带把两段**今天仍然为真**、但随票 09 的守卫（或随本票的落盘）一起变假的文字登记给本票：`docs/notes.md` §三 与 `docs/architecture.md` 的*会话树*那段（`:434`）都写着"`scripts/smoke-api.ts` 的绕法是：为移动之后的那次运行 attach 一条流"——落地后那句话不再需要，要跟着改。
