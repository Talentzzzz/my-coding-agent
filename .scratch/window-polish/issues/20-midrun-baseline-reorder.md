# 20 重连基线把排队消息重排到它打断的回答之前

Type: task
Status: resolved
Blocked by:

## Question

16 号复现时在 wire 上抓到的传输层形状，登记为独立修复票。

**现象**（`.scratch/window-polish/research/repro-16.ts`，页内 WebSocket 探头的帧日志）：一条
新建会话里快速「发送 → 流式中再发送」后，页面的 mux 连接上出现了**三份基线**，其中一份是
`baseline [user:U1 user:U2]`——读的是 store 顺序，而排队消息是**乐观落盘**的
（`packages/core/src/agent.ts` 的 `prompt()`：流式中 accept 即 `appendMessage`，先于循环回放它），
所以在 store 链里 U2 记在**被它打断的那条 assistant 回答之前**（U1 → U2 → A1）。这份基线一旦
落在运行中途（空闲会话被 reap、lane end、下一次 `open` 复活，都会带来新基线），窗口就按 store
顺序重建 items，气泡跳到问题和回答中间；随后 A1 的 live 更新找不到 item，append 到气泡之后，
一条回答被气泡拦腰截成两段，且重开后（重放同一份 store 顺序） permanently 如此。

对照：**live echo 的到达顺序是对的**——循环只在取走点回放排队消息（`agent-loop.ts` 的
`getSteeringMessages` / `getFollowUpMessages` 都在上一条 assistant 的 `message_end` 之后），
模型实际看到的 context 是 `[…, A1, U2, A2]`，与 store 链 `[U1, U2, A1, A2]` 不一致。

要核清并拍板的：

1. 多份基线的确切来路：空闲会话 reap → `end` → 下一次 `retain` 复活 → 新 `open`，这条链在
   一次会话里会不会循环多次；页内是否真的同时存在多条同一会话的逻辑流（`client.ts` 的订阅表
   是按会话去重的， revived 之外不应重复 `open`）。
2. store 顺序与模型 context 顺序的分歧要不要收：候选是 (a) 排队消息推迟到 echo 时落盘
   （崩溃窗口内消息本来就丢在内存队列里，乐观落盘并没有救回它）；(b) 接受 store 顺序为
   真相、窗口不改（重开后读到的就是这个顺序）；(c) 其它。动 (a) 要过
   `isOptimisticEcho`/`rememberWrite` 那套防双写与 smoke-stream 的持久化破坏用例。
3. 窗口侧要不要对「运行中到达的基线」做次序补偿（不推荐——基线就是真相，补偿是第二事实源）。

复现脚本与帧日志：`repro-16.ts`（页内探头）、`repro-16b.ts`（Node 侧 wire 对照），
`repro16-probe.json` 是 DOM 顺序与计算样式。16 号已修掉的「同 id 顶替」与「气泡上的光标」
不在本票范围。

## Answer

三条待拍板事项逐一核实，证据来自新的复现脚本
[`../research/verify-20.ts`](../research/verify-20.ts)：真服务器 + 脚本化 transport + 本机 Chromium，
同一条形状（新建会话 → 发送 → 流式中再发送，followUp）走两条会读到「运行中基线」的路——
**A** 落定之后重新打开这个会话（新页面 → 读快照 → 新订阅 → 新基线），**B** 运行当中重载页面
（读数就发生在 store 还没写完的时候）。出图 `verify20-reopen.png` / `verify20-midrun.png`。

**① 基线来路：一次会话里不会同时有两条逻辑流；「reap → end → 复活 → 新 open」这条链一次运行转一圈。**

- 服务端按 `连接 × 会话` 去重（`MuxConnection.subscriptions` + `open()` 里的重订阅拒绝：报
  「这条连接已经订阅了这个会话」再 `end`），客户端 `MuxClient.subscriptions` 也按会话去重
  （`subscribed` / `ended` 两态）。**页内不可能同时存在同一会话的两条流。**
- 16 号页内探头那份「三份基线」是探头自己的口径问题：它的映射函数把 `streamId` 抹掉了，而那个
  harness 点了两次「新建会话」——于是有两份基线属于**两个空会话**，与重排无关。
- 真正会产生新基线的只有四条路：首次 `open`、`branch_changed` 的整份重发、宿主被回收后的复活
  （`end` → 下一次 `retain` 把它从 `ended` 拉回 `subscribed` → 新 `open`）、断线重连的
  `replaySubscriptions`。verify-20 的帧日志里这一轮的形状是 `baseline → 事件… → end`：prompt 的
  REST 请求**不**跨整轮持 claim（`SessionController.prompt` 回答 202 就释放），所以运行一结束、
  最后一次 release 就触发 reap，`end` 随之到页面上。**每轮结束转一圈、一轮之内不转第二次。**
- 于是「运行中基线」只剩一个来源：**运行当中有人重新订阅**（重载页面，或把 pane 指回这个会话）。
  B 场景抓的就是它——修复前那一刻的 store 是 `[user:U1, user:U2]`，正是 16 号登记的那份
  `baseline [user:U1 user:U2]`。

**② 分歧要收，选 (a)：排队消息在取走点落盘。**

分歧先被钉实（票面方向对，机制要说准）：`prompt()` 的乐观落盘发生在**接受时**，而 assistant
消息是 `message_end` 才落盘，于是文件读出来是 `U1 → U2 → A1`——修复前的 file 转储逐行可证
（`message:user:U1 ← null` / `message:user:U2 ← thinking_level_change` / `message:assistant:A1 ← U2`），
而循环回放给模型的、以及 `prepareRequest` 从 store 建出来的请求都是 `U1 → A1 → U2`。

**不只是窗口**：`prepareRequest` 从 store 建请求，所以模型自己读到的也是错的顺序。而 B 形状还会
多出第二份气泡——窗口把「已结束的 item 又收到一个 `message_start`」按 16 号那条同戳让路规则处理，
于是 `[U1, U2]` 的基线 + live 的 U2 echo 画成 `[U1, U2, A1, U2, A2]`。

判定 **(a)**，理由、被放弃的选项与代价落在 [ADR-0003](../../../docs/adr/0003-queued-writes-at-drain.md)：

- 只有收在 store 上，三处（请求、基线、恢复的进程）才读得到同一个顺序；(b)「接受 store 顺序为真相」
  等于把「模型看到的」和「文件里的」长期留成两份事实，而气泡插错只是它的第一个症状。
- (c) 窗口侧补偿不采用：补偿是第二事实源，而且只修窗口等于只修一半（同一份错顺序还在喂模型）。
- 「乐观落盘能救回崩溃里的消息」不成立：排队消息在被取走之前本来只在内存队列里，进程被杀时一样丢；
  它落盘也只是落成一条**永远不会有人回答**、且位置在它打断的回答之前的问题。
- **运行结束前没被取走的消息**（中止、失败、以及恰好在循环停止找消息之后到达的那条 prompt）由
  `flushAccepted` 在 `agent_end` 补写一次、顺序按接受先后，并**清空循环的两条队列**（留在队列上会
  被下一次运行取走、写第二遍）。这一步不是可选的：不补写，`queued` 不归零，`settle()` 永不返回、
  回收随之挂住。

**③ 窗口侧不做次序补偿。** 基线就是真相。

改动清单：`packages/core/src/agent.ts`（`prompt()` 的流式分支不再落盘、只入队与计数；
`handleEvent` 的 `message_end` 落盘并消耗计数 `takeAccepted`；`agent_end` 与 `loop.prompt` 返回处
`flushAccepted()`；`isOptimisticEcho` 收成一张表、`rememberWrite` → `rememberPrompt`）、
`scripts/smoke-session.ts`（`steer vs followUp`、`one-at-a-time` 的转录断言、`session events` 的写/队列
次序断言改判；新增 `accepted message order` 与 `abort flushes the queue`）、`docs/architecture.md`
的「流式期间的输入」一节重写、新增 `docs/adr/0003-queued-writes-at-drain.md`（ADR 清单补 0003，
并顺手补上漏登的 0002）。

验证：`npm run check` 绿；README 清单里 15 个 smoke 全绿（`smoke-api` 另起服务器跑，`api ok`）；
`verify-20` 两条场景 22 条断言全绿——**修复前同一个脚本 9 条失败**（A 场景 3 条、B 场景 6 条，
含 B 的那份重复气泡）。修复后文件序是 `U1 → model_change → thinking_level_change → A1 → U2 → A2`，
重开后 DOM 与 store 都是 `[问, 答, 问, 答]`，B 场景重载那一刻的 store 是 `[U1]`（不再是 `[U1, U2]`）。
