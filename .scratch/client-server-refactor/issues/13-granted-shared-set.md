# 缺陷：`granted` 是共享 Set，被每条流各自 `delete`

Type: task
Status: resolved

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

### 一句话

`granted` 从「整个 registry 一个 `Set`、读到就 `delete`」换成**按 toolCallId 记一条"谁在看着它、它被答成了什么"**的小表：答案只在至少一条流还把它画在屏幕上时才被记下，**每条流各自读自己那一份**，最后一条不再显示它的流放手时才丢弃。

### 1. 复现（先红）

`scripts/smoke-approval.ts` 新增一段（第一段与第二阶段之间）：同一个会话挂**三条**流、三条都在 `POST /messages` **之前**挂上（所以审批请求在三条流上都是差量帧，而不是基线的一部分），回答一次 `approved: true`，然后各读到这次运行结束，断言三条流报**同一个**答案。修之前：

```
  ok   every stream was told the approval was settled
  FAIL and every stream was told the same answer: the one that was given [true,false,false]
```

与票面推的完全一致：`granted.delete(toolCallId) || false` 让**先跑差分的那条流**把事实吃掉，其余每条都报拒绝。取 **N=3** 而不是票面示范的 2，是因为判据那句话写的是"N 条流"：两条只能证明"第一个之外还有别人错"，三条才把"错多少条与流数有关"钉在同一段断言里（评审 Spec 轴指出 N=2 只覆盖了第一半，已改）。

**没有去改第一段**（它只挂一条流，且它的 `new SessionHub({ workspaceRoot: root })` 明令保持原样）：那段是手工把会话塞进 `hosts` 的旧测试台，加第二条流要动它的单 reader 结构；新的一段用第二阶段已有的 `openRig()`（真 hub、真路由、真 claim），并把端口取成 8091——避开了 `smoke-stream.ts` 的 8090。

### 2. 修法：方向按票 05，改的是差值的**来源**

票 05 已经钉死"`tool_approval_*` 是**逻辑流的一帧**，差值表本来就是每个会话一份"（第 2 条：抬到连接级等于把一个会话的审批广播给所有栏），所以 wire 一字节未改、帧名未改、控制器一侧也未动。要修的是**这条差值的事实来源不能是一次性消费的**：`delete` 不是"谁先谁得"的补丁所在，它就是 bug 本身。

`packages/server/src/stream-registry.ts`：

- `granted: Set<string>` → `createApprovalAnswers()`，一个 `Map<toolCallId, { approved, showing }>`：`approved` 是答案，`showing` 是**几条流正把它画在屏幕上**。两者放一条 entry 里，因为它们本来就是一件事（一条流显示着它，就是它的答案唯一的读者）。
- `show()`：一条流开始显示这条审批（打开时基线里就有，或差值里出现）。
- `wasApproved()`：读答案，**不删**；没记录过就是 `false`（中止、关闭会话、显式拒绝都落到这个默认值，与旧行为一致）。
- `hide()`：一条流不再显示它了（差值里消失，**或者流自己走了**——`release()` 里补一遍），计数归零时才把 entry 丢掉。
- `rememberApproval()` → `remember()`：**`showing` 为空就不记**。

判据各自的落实：

1. **N 条流报同一个答案**：答案是共享且只读的，每条流 hide 自己那一笔，最后一条才丢；N=3 由新复现钉住，更大的 N 是同一段代码的同一条路径（计数按流累加）。
2. **无人在看时的回答不再累积**：不是"记得更久再清"，而是**没有入口**——一条流都没显示这条审批时，答案一个字节都不写。所以第二段那个后果（审批在无人观看时被回答、`granted` 攒到进程退出、`close()` 也不清）随入口一起消失；也因此 `close()` 不需要额外的清理：所有会写这张表的流在关闭时都会走 `release()`，各自把自己那几笔计数还回来。
   这一半**没有黑盒断言的余地**（评审 Spec 轴指出它只有靠读代码验证，是对的）：一条从没显示过这条审批的流，在修前修后都收不到任何关于它的帧，所以它在两边都不可观测。它是结构性的，冒烟那一段的头注里也这么写了，免得下一个人以为这里漏了检查。
3. **没有"哪条先跑"的竞态**：删掉的是"读"这件事本身，不是把 `delete` 挪到别处。

注释按 `packages/server/src`（46 个 `.ts` 文件零 CJK）与 `scripts/snapshot.mjs`（票 03 新写的脚本）的既有惯例写英文。这与 `AGENTS.md:78`"源码注释一律中文"冲突，与 `docs/notes.md:71`"注释……保持英文"一致——**本条不在本票里裁决**，只登记：AGENTS.md 那句与全树不符（评审 Standards 轴判它按字面是硬违规、同时也承认这是全树继承来的）。

### 3. 评审留下的两处，以及它们的去向

评审（Standards + Spec 两个并行子代理）提出的问题，处理如下：

- **Data Clumps（已改）**：`answers` + `showing` 两张同键表被判为把一件事拆成两处，且留下了 `?? 0` / `?? 1` 的不对称。已合并成一条 `ShownApproval` entry：`approved` 与 `showing` 一起创建、一起消失，`hide` 不再需要对"不知道"的兜底。
- **契约改了算不算越界（不算）**：`remember` 现在会丢弃"没人在看时"的答案，评审 Spec 轴把这读成"票面没要求的额外行为"。票面 `:18` 把它列为**第二个后果**、`:24` 把它写进判据第二半（"无人在看时的回答不再在内存里累积"），而"不再累积"唯一的实现方式就是"没人在看就不写"——这一条不是顺手改的，是被要求的那一条。
- **跨会话撞 id（开成票 19，不在本票修）**：那张表**仍按 `toolCallId` 单独索引**（`wasApproved(toolCallId)` 不带会话身份），所以两个会话的审批碰巧同 id 时会串——会话 B 的审批被 abort 时，B 的窗口会读到 A 的"准予"。这是**既有**缺陷（票 13 修掉的那个错误的上一层：票面点名的 `:123`"整个 registry 一个"说的就是这种共享），但不在本票判据里，而且修它要动一条本票没被要求动的接缝（`SessionListener.onApproval` 的签名里没有会话 id）。已按追踪器的约定开成 [`19-approval-answer-key.md`](19-approval-answer-key.md)，并在地图的 *Not yet specified* 里留了指针。
- **"计数在票 05 之后没有生产者"（不成立）**：票 05 的粒度是**连接 × 会话**，两个标签页看同一个会话就是**两条**逻辑流、两个 `toolCallId` 相同的待答审批各有一条流在看——所以这个计数在票 05 之后照样有生产者。票 09 / 地图否定的那种计数是**会话生命周期的引用计数**（"服务端的计数没有消费者"说的正是它），而这里数的是"还有几条流在看这条审批"，是那张差值表自己的读者数。

### 4. 验证

- `node scripts/smoke-approval.ts`：修前 1 项 FAIL（上面的 `[true,false,false]`，用 `git stash` 把修复摘掉复跑确认），修后 38 项全绿（连跑 3 次）。
- `npm run check`（tsc ×4 + token 审计）绿；`smoke-boot`、`smoke-tools`、`smoke-sessions`、`smoke-session`、`smoke-models`、`smoke-stream` 全绿；`smoke-api.ts` 对着一个临时 `MY_AGENT_HOME` + 临时 `--cwd` 起的服务器也绿。都不需要供应商密钥。
