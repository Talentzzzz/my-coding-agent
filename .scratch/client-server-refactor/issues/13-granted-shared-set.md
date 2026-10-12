# 缺陷：`granted` 是共享 Set，被每条流各自 `delete`

Type: task
Status: open

## Question

这是一个纯缺陷，没有待决的设计问题——但**先复现再修**，因为它的可见性取决于流数。

**证据链**（我已逐行核对过 `packages/server/src/stream-registry.ts`）：

- `:123` —— `const granted = new Set<string>()`，**整个 registry 一个**，不是每条流一个（对比 `:152` 的 `pending` 与 `:191` 的 `sawRun`，那两个是「每条流一份」）。
- `:331` —— 每条流做差分时都**删除**：`approved: granted.delete(toolCallId) || false`。
- `:267-270` —— `rememberApproval()` 由审批端点在**会话级**调用（`packages/server/src/boot.ts:91`）。

**后果**：同一个会话上有 N 条已挂上的流时，最先跑差分的那一条报 `approved: true`，**其余每一条都报 `approved: false`**。今天看不见，因为客户端只用这帧撤横幅、忽略该字段（`packages/web/src/state.ts:178-179`）；但对任何别的消费方它就是错的，而且这个错误随流数变化——两个标签页看同一个会话时必现。

**第二个后果**（审计第 5 节）：审批在**无人观看**时被回答，`granted` 会被写入却没有流来消费它，于是它在进程内存里累积到退出——`close()`（`:272-278`）也不清。

**要做的事**：

1. 先写一个能红的复现：两条流挂同一个会话，回答一次审批，断言**两条流都报 `approved: true`**。现有 `scripts/smoke-approval.ts` 只挂了**一条**流（第一段），所以这个缺陷在套件里是隐形的。
2. 再修。修法的方向由票 05 的帧协议决定（"审批已结算"这件事是流的差量还是会话级的通知），但**不要**用"只在第一条流上删除"这种补丁——那只是把错误从 N-1 条挪到了"哪条先跑"这个竞态上。
3. 判据：修复后同时挂 N 条流，N 条都报同一个答案；无人在看时的回答不再在内存里累积。

**注意**：`scripts/smoke-approval.ts` 前半段那个 `new SessionHub({ workspaceRoot: root })` 的怪异**明令保持原样**（`docs/notes.md:35-37`），别顺手改它。

## Answer

<!-- 解决时在下面追加。 -->
