# 恢复边界：基线从哪来，重开一条逻辑流时怎么收敛

Type: grilling
Status: open

## Question

`docs/notes.md:19-21` 钉死了"不做序列号、游标、重放缓冲或缺口修复——错过帧的查看者**从快照恢复，不从游标恢复**"。本图**不重开**这一条。但常驻通道引入了一个今天不存在的东西：**一条逻辑流的开与关**。今天"开流"就等于"这一次运行的基线"（`packages/server/src/stream-registry.ts:242`），关了就不再开。

要钉死的是：

1. **基线是什么**。今天的基线是 `SessionSnapshot`（`packages/core/src/protocol.ts:168-214`）——整段 transcript、`branchPoints`、`messageEntryIds`、`pendingApprovals` 全在里面。窗口形态确定后（票 03），一份基线够不够？有没有"太贵、该分页"的部分？注意 `SessionSnapshot.messages` 今天**没有上限**。
2. **原子替换发生在哪**。今天在 `packages/web/src/state.ts:130-143` 的 `session` 分支整段替换 `items`。多会话之后，"替换哪一份窗口"由 streamId 决定——这条新规则写在哪一层？
3. **重开时机**。物理重连（整条连接断了）之后，每条逻辑流各自重开并各拿一份新基线；这与 DSH 的"物理层与逻辑层分开"一致。但**增量从哪接**？基线的边界与"重开那一刻"之间有没有缺口？DSH 的做法是"以现在长什么样为准"，本票要说清这个"现在"是哪一刻。
4. **`entry` 帧的命运**。今天 `entry_appended` 事件之外还发一帧 `entry`（`packages/server/src/stream-registry.ts:299-307`），把 entry id 与消息时间戳配对，好让"从这条消息 fork"在一份从未看着它被写下的 transcript 上也成立。基线替换之后这帧还需要吗？
5. **窗口会不会无限增长**。今天每次 attach 都是一份全量快照替换，所以不存在增长问题；常驻通道加上"只追加"之后就会。**研究票 01 已确认 DSH 的实际行为**（`../research/dsh-portability.md` §2.3）：客户端会话窗口**没有任何淘汰常量**，窗口是一棵 `leaf|concat` 不可变树，`append` 只往后接，唯一会缩小的 `settleAssistant()` 只丢当前 attempt 的瞬态行——所以**被引用的长跑会话窗口随每条 durable 事件线性增长**。那份二手总结 §9 声称的"窗口预算"**不存在**。于是本票没有可以照抄的先例，要自己决定**本仓库**要不要上限，以及超限时是截断、分页，还是响亮失败。

**顺带一条可搬的形状**（同资产 §2.1）：DSH 的**开窗大小由客户端给**——`HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }`，服务端只兜底 `DEFAULT_MAX_MESSAGES = 50`，且分页是一个纯函数 `paginate()`。这正好对上本票第 1 条：`SessionSnapshot.messages` 今天**没有上限**，可以照这个形状给它一个客户端指定的窗口。

**已定前提**：不引入 event id / `Last-Event-ID` / cursor（`docs/notes.md:19`）；会话日志（JSONL）仍然是权威副本，客户端内存只是窗口。

## Answer

<!-- 解决时在下面追加。 -->
