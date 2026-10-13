# 07 - 审批三处修复

Type: task
Status: resolved

## Question

旧图票 13/14/19 定下的三处修复随落地一起进：①`denyAllApprovals` 的 reason 骑着解答走（票 08）；②未知 `toolCallId` 答 409，`approve` 顺序为只读检查 → `onApproval` → `approve`（票 14）；③答案表嵌套 `Map<sessionId, Map<toolCallId, ShownApproval>>`（票 19，落位随票 04 的订阅表）。

## Comments

**2026-10-13，落地时登记**：

1. **③ 已随票 04 落位，零新代码**：`mux.ts` 的 `ApprovalAnswers` 就是嵌套 `Map<sessionId, Map<toolCallId, ShownApproval>>`，`showing` 跟着分层，空的内层表随最后一笔 `hide` 删掉；`onApproval` 的签名已带 `sessionId`。本票只补了票 19 §4 要求的契约注释（`Subscription.pending` 按 `toolCallId` 键、假定会话内唯一，跨会话相撞由答案表的会话键控挡住）。
2. **① 落在 `packages/core/src/agent.ts`**：`PendingApprovalEntry` 的解答变成 `ApprovalAnswer { approved, reason? }`；`approve()` 不带 reason（落到今天那句 "The user denied permission…"，只有那一句在"用户真的按了拒绝"时是真话）；`denyAllApprovals(reason)` 把 reason 带进解答；`authorize` 在 `false` 时优先用解答的 reason。abort 那条由循环自己归一化，一字未动（票 08 §2 点名的那条）。`tool_approval_settled` 与 `protocol.ts` 一个字节没改。
3. **② 落在两处**：`Agent.hasPendingApproval(toolCallId)` 只读谓词；`SessionController.approve` 的顺序改为 ①只读检查（为假抛 `httpStatus.conflict`，文本 "`${toolCallId}` is not a pending approval"）→ ②`onApproval` → ③`approve`——拒绝时 ②③ 都不发生，票 14 §3 那个"先 approve 再判会让每次准予报成拒绝"的坑照原样避开。原来那句"no longer pending is not an error"的注释已反过来写。`routes.ts` 的 API 表与 `docs/architecture.md` 的 status 说明各补 409 一句；ADR 正文留给票 09 的重写。
4. **冒烟**：`scripts/smoke-approval-endpoint.ts`（新）钉住端点契约——未知 id 答 409 且说清被拒的是什么、拒绝不写答案监听者、真答案 200 且恰好记一次、已结算的 id 再答也是 409。`smoke-session.ts` 新增 `approval denial reason` 段：denyAll 的 reason 进 transcript 的工具结果、"The user denied permission" 不出现；`approve(id, false)` 仍落到那句默认文案。`smoke-api.ts` 的 REST 半边补一条未知 id 答 409。**票 15 登记的"失败请求没有污染差量帧"断言留给票 08**：它要一条活的流上的差量帧，而答案表在 mux 里唯一的写者就是 `onApproval`（`boot.ts` 一处接线），"拒绝不触达监听者"已是它不写表的全部路径。
5. 验证：`npm run check` 绿（tsc ×4 + token 审计）；smoke-tools / smoke-models / smoke-sessions / smoke-projection / smoke-mux-client / smoke-mux-live / smoke-session / smoke-approval-endpoint 全绿。smoke-boot / smoke-stream / smoke-approval 的既有 SSE 破损照票 08 的清单归它，本票未动。
