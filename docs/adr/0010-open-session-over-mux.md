# 0010：会话的打开与切换只走 mux 基线

- 状态：**已接受**（2026-11-03 用户拍板，已落地——01–04 号票跑绿 check、build:web 与 smoke 全套，见 `.scratch/mux-only-open/`）
- 取代或失效：`packages/web/src/main.ts` `openSession()` 的"REST 读先画、channel baseline 幂等替换"双源结构（取代）；`packages/server/src/mux.ts` `open()` 对重复订阅的拒绝行为（取代，改为重发基线）；`packages/web/src/client.ts` `retain()` "已订阅则只记账不发帧"的分支（取代，retain 恒发 `open`）

## 为什么会有这份 ADR

窗口切换会话时，今天有**两份**基线先后到达：一份来自 `openSession()` 里的 REST 读（`api.read`，先画，追求快），一份来自 mux 流打开时的 `writeBaseline`（后到，幂等替换，是事件流的锚点）。两份内容同为 `SessionSnapshot`，读代码的人必然会问：**为什么不用一份？** 这份 ADR 记录这个问题的两个答案——"为什么当初是两份"与"为什么最终定成一份"——免得下一个人把中间态当成两边的妥协。

## 背景：被改主意前的形态

- **REST 读**（`openSession`，`main.ts`）：一次 `GET`，拿到快照立刻（deferred）画出来。它承担导航的即时性与失败语义——失败可归属（404 / 网络错 → `unreachable`，旧对话留在屏上）、可作废（`openSeries` 让连点两行时迟到的旧答案整体丢弃）。
- **mux 基线**（`writeBaseline`，`mux.ts`）：每条逻辑流打开的第一帧，是"现在长什么样"的恢复锚点（[0001](0001-transport-websocket-mux.md)），后续事件全部相对它追加。
- 两份**必须同时存在**的理由：REST 读无法当流锚点用（它取在 T1，流开在 T2，T1→T2 之间的事件谁也不补）；mux 基线无法当导航用（要排写侧队列、失败是连接上的一个 error 帧、没有请求级作废）。

## 决定

**窗口对会话的打开、切换、页面加载，只依赖 mux 订阅：`retain` 即导航，`baseline` 帧即第一次绘制。REST 读从前端的导航路径退场。**

配套的三条：

1. **`open` 的语义改为幂等的"给我现在的快照 + 之后的事件"。** 服务端 `mux.ts` `open()` 的重复订阅分支从拒绝（"这条连接已经订阅了这个会话"）改为**重发一份基线**（`pushBaseline`）。这是本方案的地基——没有它，"send 还持有引用时切走又切回"（retain 不产生新帧）会永远等不到基线；有了它，"切走正在跑的会话再切回"天然拿到一份带 `partial` 的新快照。**被驱逐后的 retain 是同一条语义的一次普通调用，不是一条特殊路径**：驱逐删的是编排层手里的袋，不是会话——盘上的记录仍在，重开拿到的基线是从盘上重放的新状态，而不是任何被缓存的旧账（13 号票）。
2. **客户端恒发 `open`。** `retain()` 不再区分"订阅已存在"——每次 pane 落点都发 `open`；引用计数（`pane` / `send` 两个 source）原样保留，`cancel` 仍然只在计数归零时发。
3. **导航的完成与失败是一层本地状态机，不是协议。** 协议**零新增帧类型**。`MuxClient` 新增 pending-open 记账：发出 `open` 时挂一个 per-session 的 promise，`baseline` / `error` / `end` 帧 settle 它，本地超时兜底——取值 3 s，定稿依据见文末未决事项。

### 三个必须答清的行为

| 问题 | 定成什么 |
|---|---|
| 连点两行，旧基线迟到 | `openSeries` 语义保留，判定点移到**基线帧到达时**：series 不匹配 → 整帧丢弃，不画、不报错；被作废的流由引用计数自然收尾（pane 引用早已 release，若 send 还在则订阅留给 send） |
| 超时怎么处理 | 报错（`unreachable`，错误条）、旧画面保留、pending 记账清掉；订阅**不主动撤**（迟到的大帧仍在写侧队列里，撤了 cancel 帧也排在它后面）。用户重试即可；若真实原因是写侧积压，最终由服务端 10 s 停滞上限 → `1013` → 重连 → 重放订阅 → 新基线自愈（[0001](0001-transport-websocket-mux.md) 的背压联动） |
| 通道断开时点会话 | **明确接受**：导航不可用，点击报"通道未连接"。浏览能力与通道健康耦合是本决定买单一时接受的代价；不为它留 REST 后备——留了就回到两条路 |

### REST 读端点的去留

`GET /api/sessions/{id}` 与 `GET /api/sessions/current` **保留**：它们是资源式命令面的读一半（[0001](0001-transport-websocket-mux.md)），mux 是推送通道、不是命令面，两者不相干；脚本与诊断仍可用。**前端**不再用 `read` 打开会话——`api.read` 的窗口侧调用点删除；`current` 例外，它在页面加载时回答"该开哪一个"，然后由一帧 `open` 打开（见文末未决事项）。

## 换来了什么

- **导航路径只有一条。** "先 REST 画一版、channel 基线再替换"的双源结构、两源之间的一致性论证、`deferred` 绘制在两条路径上的重复——全部消失。窗口只有一个基线来源：帧。
- **`open` 变成幂等原语。** 重连重放（`replaySubscriptions`）、分支移动的 `pushBaseline`、页面加载、日常切换，全走同一个动作，服务端一个分支服务所有场景。
- **串台风险收敛到一处。** 作废判定只看"基线帧到达时的 series"，不再有"REST 答案属于哪次点击"的第二套判定。

## 背上了什么

- **切换时延从确定的 RTT 变成"排写侧队列的时长"。** 别的会话流式刷屏时，基线大帧排在 delta 后面；极端积压靠 1013 重连自愈，普通积压靠超时报错。
- **通道断开 = 不能浏览**（见上表第三行）。
- **页面加载多一拍**：先等通道 live，再 open current，再画。桌面外壳是本机进程，握手代价以毫秒计——接受。
- **新增一层本地状态机**（pending-open），以及它自带的测试面。

## 验收边

1. 切换会话的全过程不产生任何**会话** REST 请求（`GET /api/sessions/{id}` 与 `GET /api/sessions/current` 都为 0，网络面板可证）。侧边栏列表的修复仍会发 `GET /api/directories`——那是列表，不是打开会话。落地记录见 `.scratch/mux-only-open/issues/03-web-open-session.md`。
2. 切走正在运行的会话再切回，画面立即包含运行中的 `partial`，无需等下一个 delta。
3. 连点两行：先到货的旧基线不画、不报错；最终画面是最后一次点击的会话。
4. 打开一个不存在的会话：错误条报错，旧对话留在屏上（与今天 REST 404 的行为一致）。
5. 通道断开时点击会话：立即得到明确的错误提示，而不是静默等待。

## 不可逆性与代价

**中等，且可回退。** 全部改动集中在 `packages/server/src/mux.ts`（一个分支）、`packages/web/src/client.ts`（retain + pending-open）、`packages/web/src/main.ts`（`openSession` 重写）、以及两张 smoke 脚本（客户端一张新增一节、wire 一张改断言）；`git revert` 单提交可退。

**重开这条决定的人要重新回答**：重复 `open` 的幂等语义要不要保留（建议保留——它独立成立）、断线浏览要不要 REST 后备、以及超时取值在慢机器/大会话上的实测依据。这三条都答了才谈得上推翻。

## 未决事项

- **超时取值（3 s）**：落地时按判据实测过一半——`JSON.parse` 一份基线信封（3000 条消息 / 1.93 MiB）约 3.5 ms，CPU 不是约束，三个数量级余量在 3 s 面前没有意义。真正的等待是基线排在大帧后面，所以 3 s 买的是**排队余量**，现在它是"有下限论证的初始值"而不是随手写的数；往下收紧会把"忙"报成"坏"，而"坏"这一格今天没有别的机制兜。**仍未测**：真实大会话 + 流式刷屏下的写侧排队时长（要真 provider 跑大会话）。依据与实测数据见 `.scratch/mux-only-open/issues/02-client-pending-open.md`。
- **页面加载的 current 会话**：通道建立前 `GET /api/sessions/current` 的"上一次活跃会话"记忆仍走启动参数/存储（现路径），不在本次范围内重开。

## 落地清单（ADR 到此为止，代码是另一件事）

| 落点 | 内容 |
|---|---|
| `packages/server/src/mux.ts` | `open()` 重复订阅分支：拒绝帧 → `pushBaseline`；删除"这条连接已经订阅了这个会话"的错误文案 |
| `packages/web/src/client.ts` | `retain()` 恒发 `writeOpen`；新增 pending-open 记账（promise + series + 超时）；`baseline` / `error` / `end` / reconnect 各路径对它的 settle；`replaySubscriptions` 重放后同样 settle |
| `packages/web/src/main.ts` | `openSession()` 重写：`series → retain(pane) → 等 baseline → 作废检查 → apply(deferred)`；失败/超时 → `unreachable`；`refreshLists` 的顺序与理由原样保留；页面加载路径同步改走 mux |
| `packages/web/src/api.ts` | `read(id)` 的窗口侧调用点删除（REST 端点本身保留，见上）；`current()` 留着——页面加载还要问它"该开哪一个"，那正是下面那条未决事项 |
| `scripts/smoke-mux-client.ts` | "重复 open 被拒绝"的断言改为"重发基线"；补一条"基线迟到 + series 作废" |
| `scripts/smoke-projection.ts` | envelope 断言不变；核对无 REST 导航路径残留 |
| `docs/architecture.md` | "谁拥有一个会话 / wire / API"三节中关于打开会话的描述；`openSession` 注释的承诺（"viewing an idle conversation costs one request"）改为帧的说法 |
| `docs/adr/README.md` | 清单表加一行 |
