# 02 - 客户端 pending-open 状态机：retain 恒发 open

Type: task
Status: resolved
Blocked by: [01 - 服务端 open 幂等](01-server-mux.md)

## Question

`packages/web/src/client.ts`：`retain()` 不再区分订阅是否存在——**每次 retain 都发 `open`**（幂等，服务端重复分支已改为重发基线）；并为导航新增 pending-open 记账，让"打开一个会话"重新拥有请求般的完成/失败语义。ADR-0010 决定 2、3 与「三个必须答清的行为」表是本票的规格。

## 要点

- **引用计数原样**：`pane` / `send` 两个 source、计数归零才发 `cancel`、`ended` 复活逻辑——全不动。改的只是"已 subscribed 也照发 open"。
- **pending-open 记账**：发出 `open` 时挂 per-session 的 `{ promise, series, timer }`；settle 点四类：
  1. `baseline` 帧到达 → resolve（交出快照给调用方画）；
  2. 该流的 `error` 帧（如 `failStream` 的"未知的会话"）→ reject；
  3. 该流 `end` 帧 → reject（服务端宣告结束的流等不到基线）；
  4. 本地超时（初始 3 s，收账时按 ADR-0010 未决事项校准）→ reject。
- **超时/失败不清订阅**：pending 记账清掉即可，cancel 帧反正排在写侧队列里迟到的基线后面；重试由用户再点一次。真实积压由服务端 10 s 停滞上限 → `1013` → 重连 → `replaySubscriptions` 自愈。
- **重连联动**：`replaySubscriptions` 重放订阅后，pending 中的 open 要么随之 settle（重放会带来新基线），要么作废——实现时核对这条路径，别留一个永不 settle 的 promise。
- series 号由调用方（main.ts，票 03）持有并传入；`MuxClient` 只负责"settle 时把快照交回"，作废判定不在本层。

## 收账

- `npm run check` 绿；`smoke-mux-client` 绿（断言更新归 04 号票）。
- Answer 节记录：状态机形状、超时实测取值与依据、重连路径的核对结论。

## Answer

**`retain` 恒发 `open`；导航的完成是一层本地记账，四条 settle 路径。**（`packages/web/src/client.ts`）

**状态机形状**

- `retain(sessionId, source, series?)`：引用计数照旧（`pane` / `send` 两个 source、归零才 `cancel`、`ended` 复活），**每次都发 `open`**——原来"已 subscribed 就只记账不发帧"的分支删了。不带 `series` 的 retain（send 的引用）返回 `undefined`：它没有要完成的导航。
- 记账一条 per-session 的记录 `{ waiters: [...], timer }`，放在**订阅表之外**（`release` 不碰它——"pane 看走了"不是关于会话的答案，且 send 的 release 不该替 pane 的问题作答）。
- settle 四类，全部经同一个 `settleOpen()`（先删记录、清 timer，再答）：该流 `baseline` 帧 → resolve 交出快照；该流 `error` 帧 → reject（消息用帧里的）；该流 `end` 帧 → reject；本地超时 → reject。帧照原样继续交给 `onStreamMessage` / `onStreamError`，记账是**并联**的一层，不改变路由。
- 两处边角，票面没列但必需：`close()` 把还在等的全部 reject（窗口关闭，没人可答，否则就是一个永不 settle 的 promise）；**通道非 live 时带 series 的 retain 立即 reject**（"通道未连接，无法打开会话。"，ADR 表第三行），订阅意图照记、留给重放——否则会等出一个"服务端慢"的超时，而那个服务端根本没人问过。
- **同一会话的第二次导航加入等待，不判第一次作废**：一个会话一条流，下一份基线同时答清两次提问；"谁该画"由调用方的 series 比，本层不比。这一条是 review 后改的——早先版本在第二次 retain 时 reject 第一次，那等于本层替窗口作了"哪次更新"的判定（票面明确说不在本层），而且会让被取代的一次点击冒出一个错误条（ADR 表第一行要的是"不画、不报错"）。

**超时取值：保留 3 s（`openTimeoutMs` 可覆盖，smoke 用它压到 120 ms）**

实测（本机 Node 22，`JSON.parse` 一份基线信封，5 次均值）：200 条消息 / 0.13 MiB → 0.3 ms；1000 条 / 0.64 MiB → 1.4 ms；3000 条 / 1.93 MiB → 3.5 ms。序列化同量级。

**依据**：CPU 不是这个数字的约束——三数量级余量在 3 s 面前毫无意义；真正的等待是基线排在写侧队列后面（一个大帧 = 整份 transcript）。所以 3 s 买的是"排队余量"，往下收紧只会把"忙"报成"坏"，而"坏"这一格今天没有别的机制兜（服务端 10 s 停滞上限要等到 1013 才动）。故不改 3 s，把它记成**判断**而非测量值。**仍未测**：真实会话 + 流式刷屏下的写侧排队时长（要真 provider 跑大会话），ADR 未决事项因此不作废，只是从"随手写的初始值"变成了"有下限论证的初始值"。

**重连路径核对（票面要求）**

- `replaySubscriptions` **零改动**是对的：重放会在该会话上再发一次 `open`，随之而来的基线就是那份等待要的东西，直接 settle。
- 被重放跳过的两种——`ended` 的流、引用已归零的流——不会再有帧，等待由 3 s 超时收尾。**没有永不 settle 的 promise**：记录创建时 timer 就 arm 了，四条 settle 路径都走同一个出口，删记录与清 timer 是同一步。
- smoke §9 实测覆盖：掉线 → 退避重连 → 重放 open → 新基线完成导航。
- 一条如实记下的语义：任何 `baseline` 帧都算答案，包括分支移动 `pushBaseline` 产生的那份——它是同一条流的"现在长什么样"，等它的人等的就是这个。

**连带，留给 03 / 04**

- **03 必看**：`main.ts` 的 `settled()` 把 `baseline` 且 `submitting:false` 也算"run 已落定"，于是 `prompt()` 里 `retain(target,"send")` 引发的**多出来那份基线**会立刻放掉 send 引用。今天无碍（pane 引用还在），但"导航走开后 send 的引用仍在，跑完的帧还有人读"（ADR-0006 §5）在这条路径上需要重新看一遍。
- **03 的调用形状**：返回值是 `Promise<SessionSnapshot> | undefined`；非 live 时是 rejection。catch 里必须先比 series 再 `unreachable`（现有 `openSession` 已是这个模式），否则被取代的那次点击会冒错误条。
- **04 的断言**：本票只做"必须绿"的最小改动——§3 的"同一会话的第二个理由不再发帧"改成"每次 retain 都发 open"——另加 §9 一节（导航的完成与失败，13 条）。"重复 open 重发基线 + 迟到基线 + series 作废"的整轮断言仍归 04。

**验证**：`npm run check`、`build:web` 绿；`smoke-mux-client`（含新 §9）、`smoke-mux-live`、`smoke-mux`、`smoke-projection`、`smoke-liveness`、`smoke-replay`、`smoke-backpressure`、`smoke-session`、`smoke-transcript` 全绿。
