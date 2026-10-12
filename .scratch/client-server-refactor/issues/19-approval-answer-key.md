# 缺陷：审批答案的表只按 `toolCallId` 索引，跨会话会串

Type: task
Status: open

## Question

票 13 修掉了"共享 `Set` 被每条流各自 `delete`"（一条流读走答案、其余每条都报拒绝），但那张表
**仍然是整个 registry 一张、而且只按 `toolCallId` 索引**：`createApprovalAnswers()` 里的
`Map<toolCallId, ShownApproval>` 与它的 `wasApproved(toolCallId)` 都不带会话身份，`showing`
计数也一样。于是票 13 的 Answer 里那句"每条流各自读自己那一份"在一处不成立：**两份指的不是同一
个问题**。

票 05 第 2 条把这件事说得很直白——`stream-registry.ts:318-336` 那套差值表"**本来就是每个会话
一份**（一条连接上看两个会话就要两份）"；票 13 只把"读"改成非破坏性的，没有把"键"改成每个会话
一份。

**可复现的序列**（先决条件是两个会话的一条待答审批碰巧同 id）：

1. 会话 A 与会话 B 各自停在一个待答审批上，两条审批的 `toolCallId` 相同（下称 `X`）。各挂着一条
   流 → `showing[X] = 2`。
2. 有人回答 A 的 `X`（准予）。`remember` 写进这条**共有**的 entry，A 的流跑差分：读到 `true`，
   `showing[X] = 1`。entry 因为 B 的流还在看它而**留在表里**。
3. B 的 `X` 走了**另一条**路消失——abort、`denyAllApprovals`、会话关闭——而 B 的流仍然显示过它，
   于是 B 的差值帧去读 `wasApproved(X)`，读到 A 的 `true`。

结果：B 的窗口被告知"这条审批被准予了"，而它实际上是被拒绝的。这正是票 13 修掉的那个错误的
另一个面（"没在看这条审批的消费方被告诉了不属于它的答案"），只是从"同一会话上的 N 条流"升到了
"同一个 registry 里的 N 个会话"。

**今天为什么是潜伏的**：`packages/ai` 只实现了一个 wire（Anthropic Messages），它的 `tool_use`
id（`toolu_…`）是随机的；`scripts/fake-transport.ts:51` 也是 `randomId("tool")`。但 `models.json`
的 `baseUrl` 可以指向任何 Anthropic 兼容端点，而**有些实现是按对话编号 `call_0` / `call_1` 的**，
两个同时停在审批上的会话因此很容易撞上同一个 id。它不依赖任何并发边缘情况：只要 id 相同、两条
都挂着流，第 3 步就是确定发生的。

**为什么不顺手在票 13 里修**：修它要动一条票 13 没被要求动的接口——答案从审批端点走到 registry
的路是 `SessionController.approve()`（`controllers/sessions.ts:457`，`sessionId` 就在它手上）
→ `SessionListener.onApproval`（`:48`，**签名里没有会话 id**）→ `StreamRegistry.rememberApproval`
→ 这张表；也就是"端点必须把会话身份带上"，而这是加宽一个面向传输层的接缝，属于设计改动而不是
缺陷修复。票 09 也已经把 `stream-registry.ts` 的退场记成落地阶段的题目
（`issues/09-claim-vs-subscription.md`：没答的"`stream-registry.ts` 怎么退场"），而新模型里
订阅表**本来就按会话存条目**——即"答案该挂在哪个键上"很可能随那次落地一起消失。

要钉死的是：

1. **键**：`sessionId` + `toolCallId`（嵌套的 `Map<sessionId, Map<toolCallId, …>>`，还是一个
   复合键？），以及 `showing` 计数是否跟着一起分层。
2. **身份从哪来**：`SessionListener.onApproval` 加上 `sessionId`（与它旁边的 `onRunFailure(sessionId,
   message)` 一致），还是让审批端点直接对着 registry 说话。
3. **会不会被落地取代**：如果 mux 落地时这张表本来就并入按会话存条目的订阅表，那么本票的答案是
   "不修，随落地消失"——那就把这条记进那次落地的清单，别留一个悬空的修复。
4. **一条附带断言**：`toolCallId` 在**一个会话内**唯一（今天 `pending` 按它建表就假定了这一点）。
   如果某个端点连这个都不保证，那要修的地方比本票更大。

## Answer

<!-- 解决时在下面追加。 -->

## Comments

**2026-10-13，票 15 解决时追加（本票仍 open；这里只登记舞台在哪，不碰本票的任何决定）**：票 15 把 `scripts/smoke-approval.ts` 里票 13 那段"三条流都听到同一个答案"改成**三条连接**（票 05 第 1 条），那份 rig 正好是本票那条"两个会话撞上同一个 `toolCallId`"的可复现舞台：同一份 rig、两个会话、一个共享 id、两条连接，然后断言**各自的窗口只被告知自己的答案**。票 15 **不为本票写这条断言**（本票有一个候选答案是"随 mux 落地一起消失"，那时舞台会换），只把位置指出来。另外票 15 要求 409 那条闸门"回答不了就不再写那张表"（票 14 第 3 节的顺序）——它顺带拆掉了本票串号的一个现成触发器，但**不妨碍本票的题面**：那张表仍然只按 `toolCallId` 索引。
