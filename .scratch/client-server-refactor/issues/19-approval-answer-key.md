# 缺陷：审批答案的表只按 `toolCallId` 索引，跨会话会串

Type: task
Status: resolved

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

### 一句话

那张表从"`Map<toolCallId, …>` 整个 registry 一张"换成**每个会话一张**（嵌套
`Map<sessionId, Map<toolCallId, ShownApproval>>`，`showing` 计数跟着一起分层）；会话身份从
`SessionListener.onApproval` 的签名走——加上 `sessionId`，与它旁边的
`onRunFailure(sessionId, message)` 对齐；修在**今天**而不是随 mux 落地消失，理由在下面第 3 节。

### 1. 键：嵌套的每会话一张表，计数跟着分层

`packages/server/src/stream-registry.ts` 的 `createApprovalAnswers()` 现在持有
`Map<sessionId, Map<toolCallId, ShownApproval>>`。四个方法（`remember` / `wasApproved` / `show` /
`hide`）全部走 `(sessionId, toolCallId)` 两级键；`hide` 在最后一笔放手时把空的内层表也删掉，与
`detach()` 对 `watchers` 的卫生一致。

**选嵌套不选复合键**：复合键（`sessionId + 分隔符 + toolCallId`）要把"两段 id 都可能含任意字符"
这个事实用一个分隔符去赌；嵌套表把"先按会话分、再在会话内找"这个真实结构直接写进数据，读代码的人
不用问"分隔符撞了怎么办"。`showing` 计数**跟着一起分层**——它和答案是同一条 entry 的两个成员
（票 13 已定"两者本来就是一件事"），拆开分层等于把一件事又拆成两处。

调用侧零新增概念：`open()` 里的 `show` / `hide` / `sendApprovalChanges` 本来就拿着 `host.id`，
把它传下去即可；流与会话的绑定在 `open()` 入口就定了，差值路径上不存在"不知道自己在哪个会话"的
时刻。

### 2. 身份从哪来：`SessionListener.onApproval` 加宽，端点不直接对 registry 说话

选了票面第 2 问的前一个方向：`onApproval?(sessionId, toolCallId, approved)`。三个理由：

1. **与旁边的 `onRunFailure(sessionId, message)` 一致**——同一个接口里两个方法对"要不要带会话
   身份"给出两种答案，是给下一个读者埋的问题，不是设计。
2. **分层不变**：`SessionController.approve()`（`sessionId` 就在它手上）→ listener →
   `StreamRegistry.rememberApproval` → 表。控制器仍是唯一把 HTTP 请求翻译成会话操作的地方，
   registry 仍然只被 `boot.ts` 的接线喂——"让审批端点直接对着 registry 说话"会把 `SessionHub`
   之外第二个持有 registry 的位置放进来，为省一层回调把装配图撕开，不值。
3. **接线处只多一个参数**：`boot.ts:91` 与 `scripts/smoke-approval.ts` 三处 rig 的 lambda 从
   `(toolCallId, approved)` 变成 `(sessionId, toolCallId, approved)`，一行一处，没有第三个位置
   需要知道这个签名。

### 3. 修在今天，不随 mux 落地消失（但落地时会被**吸收**）

票面第 3 问的答案是"两者都对"：**这张表在票 09 的新模型里确实并入按会话存条目的订阅表**
（`Subscription` 是连接 × 会话，差值是逐订阅状态，票 09 第 4 条那张表自己就写着"含它自己那份
`pending` 审批差值"）——所以本票的键控在落地时**不再是独立决定**，落地清单只需执行"搬进订阅层"
一个动作，键随条目落位，不欠新决定。但**不修等落地**不成立，三个理由：

1. **落地没有日程**。票 04–18 全部是 grilling，代码一行未动；而缺陷是**确定性的**——不依赖任何
   并发边缘，只要 `models.json` 的 `baseUrl` 指到一个按对话编号的 Anthropic 兼容端点、两个会话
   同时停在审批上，第 3 步必发生。让一个可复现的跨会话串号活着等一个没排期的落地，是拿"以后会
   重写"当不修正确性的理由。
2. **修复的形状就是新模型要的形状**。按会话键控的表搬进订阅层是**搬运**；不键控的表搬进去之前
   还得先做一遍本票做的事。现在修，落地时不欠这笔。
3. **复现装置已经由票 15 摆好**（本票 Comments 里那条），写这段冒烟的边际成本接近零。

**给落地清单登记一条**（不另开票）：mux 落地把审批答案并入订阅表时，键随 `Subscription` 落位，
本票的嵌套表退场；`smoke-approval.ts` 那段"两个会话不得串号"的断言**保留**，换运载（SSE 差值帧
→ WS 逻辑流帧）不改语义。

### 4. 会话内唯一：是契约，不是断言

票面第 4 问钉死的事实：**`toolCallId` 在一个会话内唯一，是被全树假定、由 provider 的 `tool_use`
id 语义背书，没有任何一处代码保证它**。按 id 建表的读者不止本票那张：`Agent.pendingApprovals`
就是一张按 `toolCallId` 键的 `Map`（`agent.ts:332`），`approve()` 按 id 取 entry（`agent.ts:1045`）
——同一个会话里 id 重复，"答案"这个概念本身就没有主了。所以按票面的判据，某个端点连这个都不保证
时，要修的地方确实比本票大，而本票做的是把契约**写在它承重的地方**：stream-registry 里每条流的
差值表（`pending`）声明处注明"按 `toolCallId` 键，假定会话内唯一；跨会话相撞是另一个事实，答案表
已按会话键控挡住"。它是一条**文档化的契约而不是冒烟断言**——fake transport 遵守契约，冒烟无法从
外部对一个"不唯一"的 provider 断言什么；假装有断言才是错的。

### 复现与验证

复现段落在票 15 指的那份 rig 上（`scripts/smoke-approval.ts` 新增第四节
`openCrossRig()`）：一个 registry、两个会话、两份脚本化 transport 都发**同一个** `toolCallId`
（`call_shared`——票 13 的修复后仍然红，证明票 13 与本票修的是两层），各挂一条流；回答 A 为
`true`，然后 B 走 abort（`denyAllApprovals` 路径）。

- 修前：`FAIL the aborted session was told a denial, not the other session's grant [true,true]`——
  B 的窗口被告知准予，与票面第 3 步的推导一字不差。
- 修后：`[true,false]`——A 报自己的准予，B 报自己的拒绝。

`node scripts/smoke-approval.ts` 44 项全绿（修后连跑 2 次）；`npm run check`（tsc ×4 + token 审计）
绿；`smoke-boot` / `smoke-stream` / `smoke-sessions` / `smoke-session` / `smoke-tools` /
`smoke-models` 全绿；`smoke-api.ts` 对着一个临时 `MY_AGENT_HOME` + 临时 `--cwd` 起的服务器绿。
都不需要供应商密钥。

## Comments

**2026-10-13，票 15 解决时追加（本票仍 open；这里只登记舞台在哪，不碰本票的任何决定）**：票 15 把 `scripts/smoke-approval.ts` 里票 13 那段"三条流都听到同一个答案"改成**三条连接**（票 05 第 1 条），那份 rig 正好是本票那条"两个会话撞上同一个 `toolCallId`"的可复现舞台：同一份 rig、两个会话、一个共享 id、两条连接，然后断言**各自的窗口只被告知自己的答案**。票 15 **不为本票写这条断言**（本票有一个候选答案是"随 mux 落地一起消失"，那时舞台会换），只把位置指出来。另外票 15 要求 409 那条闸门"回答不了就不再写那张表"（票 14 第 3 节的顺序）——它顺带拆掉了本票串号的一个现成触发器，但**不妨碍本票的题面**：那张表仍然只按 `toolCallId` 索引。
