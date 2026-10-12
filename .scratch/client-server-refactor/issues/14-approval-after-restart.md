# 审批跨重启之后变成一个点了没反应的按钮

Type: grilling
Status: open
Blocked by: 05

## Question

**现象**（审计第 4、5 节）：服务端重启后，待审批集合纯内存、凭空消失（`packages/server/src/hub.ts` 的 `close()` 直接 `hosts.clear()`），JSONL 里**没有任何待审批记录**。客户端的 `approvals` 状态却没人清——`stream_end` 只置 `streaming: false`（`packages/web/src/main.ts:142-147`）。于是**横幅一直挂着**，用户点"允许"：请求打到新 `Agent` 上，未知的 `toolCallId` 是**静默 no-op**（`packages/core/src/agent.ts` 的审批表里没有这个 id），而端点的回答是 **200**（`packages/server/src/controllers/sessions.ts:453-460`）。一个既无反馈也无效果的按钮。

**DSH 在这方面有一条明确的规则**（研究票 01，`../research/dsh-portability.md` §4.4）：它的"通知类不重放"**只覆盖 `emit`**；**未结算的 waterfall（审批、提问）会重投给新的 generation**（`gateway/src/index.ts:512-513`）。也就是说 DSH 对"重连之后待审批还在不在"的答案是"**重投**"，而不是"假设它还在"。这直接支持下面第 1 条的第一个方向，但要注意本票的场景比 DSH 的更狠：DSH 是**连接**换代而 Host 进程还在，本仓库是**进程**重启，待审批集合已经从内存里消失了——"重投"没有东西可投。

要钉死的是**真相在哪**：

1. **待审批要不要跨重启存活？** 两个方向：
   - **不存活，但客户端要学会清掉**。那么"这份横幅所属的运行已经不存在了"这件事必须能从某处推出来。基线的快照里带 `pendingApprovals`（`packages/core/src/protocol.ts:213`），所以重连后**拿一份新基线就能发现它空了**——这正是本图"以基线为准"的性质在起作用。那么需要决定的是：横幅的撤除以基线为准，还是以一次显式通知为准？
   - **存活**。那就必须落盘——而 `docs/architecture.md` 明确说 transcript 只记"模型看到了什么"，待审批是一个**运行中的内存事实**，不是 transcript 的成员。落盘意味着新引入一条 entry kind，且要回答"重启后谁来继续这次运行"（今天重启后运行本身就没了，工具调用永远不会被恢复）。
2. **未知 `toolCallId` 的审批请求该答什么。** 今天是 200 + 静默 no-op。这里有一条本仓库已经写好的规则可以直接照用：`packages/server/src/controllers/events.ts:42` —— "一个 id 命名不了任何会话不是 bug，是 404"。同一条理由下，"一个 id 命名不了任何待审批"应该是 **409**（或 404），而不是 200。这是本票里唯一明确无争议的一半。
3. **`denyAllApprovals` 的 reason 被丢弃。** `approvalGraceMs` 到期时服务端说的是 `"No window answered this approval."`，而 `packages/core/src/agent.ts` 里明确 `void reason`——transcript 里只留下一次"被拒绝的工具调用"，看不出是被遗弃还是用户按了拒绝。这与票 08 共用同一个根：**只属于"当下"的事实没有落点**。本票决定它要不要进 transcript。

**前置**：票 05 定了帧协议之后，才能定"撤横幅以哪一帧为准"。

## Answer

<!-- 解决时在下面追加。 -->

## Comments

**2026-10-12，票 08 解决时追加（本票仍 open，这里只登记它回答了本票的哪一问，免得重复决定）**：本票的第 3 问（`denyAllApprovals` 的 reason 要不要进 transcript）**已由票 08 回答并定了形状**——reason 骑着那次解答走（`pendingApprovals` 的解答从 `Promise<boolean>` 变成 `{ approved, reason }`），落点是 `beforeTool` 的 block reason，也就是 transcript 里的 toolResult 文本与客户端那张工具卡片，**不新增 entry kind、不改 `tool_approval_settled` 那帧**。票 08 顺带更正了一处比"丢弃"更重的事实：`authorize()`（`packages/core/src/agent.ts:1243-1256`）在 `denyAllApprovals` 路径上返回的是写死的 `The user denied permission to run X.`，所以今天写进文件的是"用户拒绝了"这句假话；`abort()` 传的 reason 则永远到不了那里（循环在块分支之前先判信号，`packages/agent/src/agent-loop.ts:675-681`），那条不动。**本票的第 1、2 问（待审批要不要跨重启存活、未知 `toolCallId` 答 409 还是 404）不受影响**，仍归本票；票 08 明确不碰它们。
