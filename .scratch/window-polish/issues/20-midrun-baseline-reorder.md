# 20 重连基线把排队消息重排到它打断的回答之前

Type: task
Status: open
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
