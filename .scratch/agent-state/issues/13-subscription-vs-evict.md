# 13：订阅与驱逐——被清掉的会话不能静默失聪

Type: task
Status: resolved
Blocked by: 04, 12

## Question

mux 的订阅表是「连接 × 会话」（ADR-0001：**订阅不拿 claim**，也不让会话保持打开）。驱逐一旦发生，被清掉的
`AgentState` 连同它的两个 listener 集合一起消失，而连接那边的订阅表仍然记着「我订了它」——之后的帧再也不会到，
而且是**静默**的：窗口以为自己在看，其实什么都没收到。

现在这个问题被 `reap` 的「删 host → announceHost → close」顺序掩盖着（观察者先被告知「没了」），
但新规则下驱逐的触发点从「reap」变成「最后一个 observer 离开」，且 `send` 引用可能在驱逐之后仍然存在
（`packages/web/src/main.ts:861` 的 `releaseSend`）。

要定并落地：

- 驱逐时**先**通知观察者与 `hostListeners`，**再**删表（沿用 reap 的顺序，不能反）；
- `mux` 的订阅表在 host 消失时是否要主动清行（现在是靠客户端自己 `release`）；
- `send` 引用保留、pane 引用已释放的场景：`evict` 应该拒绝（那说明还有人在等结果），还是照清并把 fetch 的
  连接掐掉？——推荐**拒绝**：`claims > 0` 已经覆盖「改变会话的请求」，`send` 引用需要另给一个不拿 claim 的
  信号，否则它会被清掉；
- ADR-0010 的 `retain` 语义要不要补一句：「被驱逐后的 retain 是一次重新打开，基线是新的」。

## Answer

**2026-11-04 注（04 号票定形了触发器的一半）**：最后一个订阅离开是驱逐边沿之一，由服务端跨连接自数、mux 只
报告不删表，删除权在 `Agent.evict`（判据见 04 §1，边沿清单见 04 §3）；send 引用按票面推荐照批（evict 拒绝，
给 send 一个不拿 claim 的信号）；「驱逐先通知再删表」照票面。余下两问（mux 的订阅表在 host 消失时是否主动清行、
ADR-0010 的 retain 语义补句）仍归本票执行时定。

### 结论（一句话）

send 引用的信号落地为协议新增的一对上行帧 `wait` / `unwait`（客户端 retain/release `"send"` 源时各发一帧，
重连重放补发），hub 记一张与 `observers` 同构的 `waiting` 表，驱逐判据从六条变七条（hub 侧加「没有等待结果的
引用」）、边沿清单加「最后一个等待结果的引用释放」，`evict` 在有人等结果时拒绝；订阅表清行问题按现状记账
（live 行已随拆流清，冷行归客户端）；ADR-0010 补句照批。`npm run check` 绿，`smoke-mux` 全绿（新增第 9 节：
等待挡 reap 尾的驱逐、unwait 即边沿、重复 wait 不泄漏、连接死亡释放等待、未知会话的 wait 容忍）。

### 落地形状

- **协议**（`protocol.ts` / `client-frame.ts`）：`ClientFrame` 从两个动作变四个——`wait` / `unwait` 各带
  `sessionId`，语义是「这条连接还在等这个会话的一轮运行的结果」。它不拿 claim：claim 说的是「有人在改会话」，
  wait 只说「答案还有地方落」。解析器照旧宽容——未知会话的 wait 照记（一行表 + 一个 unwait 的代价），不是错误。
- **hub**（`hub.ts`）：`waiting: Map<string, Set<() => void>>`，公开 `awaitResult(id): () => void`——与
  `observe` 同构（一个等者一条目，返回值是停法），mux 逐帧持有一条。原 observers 删除点的边沿体抽成私有
  `tryEvict(id)` 漏斗：全量重查 `observers` / `waiting` / `hosts` 三样，两边沿（最后订阅离开、最后一个等待
  释放）都过它；reap 尾的 `evict` 加同一判据的门（close 照旧——run 已 settle，停不了什么，host 的去留是
  claim 的话，不是 wait 的）。等待者拿到的保护是**袋**：reap 拆流照旧（endStream + end 帧，客户端不聋），
  但状态留到 unwait 到达——切回来的 pane 在窗口内找到的是仍被握着的会话。
- **mux**（`mux.ts`）：`MuxConnection.waits: Map<string, () => void>`（会话 → hub 停法），刻意独立于订阅表
  ——wait 可先于它旁边的 `open` 到达、独立于 `end` 存活、不进 baseline/backlog 机器；幂等（重连重放重复报告
  即同一条目）。`close()` 先拆订阅后放等待：等待的释放是一条驱逐边沿，订阅的拆除先清空它要重查的另一条判据。
- **客户端**（`client.ts`）：retain 对 `send` 源**每次都报告** `wait`（服务端按「连接 × 会话」幂等去重；
  「这条引用是不是新的」是客户端表格无法诚实回答的区分——`end` 帧与它的 `releaseSend` 之间残留的源副本
  不该吞掉一次真正的新等待，code-review 判定后由票面「不重发」改判为恒报）；release 在源**确被移除**时发
  `unwait`（顺手补上旧代码缺的布尔守卫）；`replaySubscriptions` 对带 `send` 源的未结束条目补发 `wait`
  ——旧连接已死，等待必须在连接上重立；`ended` 条目无需单独豁免（end 处理器在同一拍里已释放 send 引用）。
  `write` 的丢帧语义两面自洽：丢掉的 wait 由重放补、丢掉的 unwait 无需补（服务端的等待随连接死亡已清）。
  `main.ts` 零改动——`releaseSend` 的四条出口经 `release("send")` 自动过帧。
- **ADR**：0011 §6 判据六条改七条、边沿清单加一条、`wait` 是唯一客户端自报的例外照实记；0010 决定 1 补句
  「被驱逐后的 retain 是一次重新打开，基线是从盘上重放的新状态」。architecture.md 的 ClientFrame 小节
  （上行帧四个成员 + `wait` / `unwait` 一段话）与 §API 引言同步改——帧清单与实况矛盾是硬违规，不归 14。

### 余下两问的定夺

- **mux 的订阅表在 host 消失时是否主动清行**：不新增逻辑，现状已对。live 行的清随 host 消失的拆流完成
  （`observer(undefined)` → `endStream` → teardown 删行 + end 帧）——这是 12 号票「先通知再删表」顺序的直接
  推论，本票只需记账；冷订阅的行归客户端自己的 retain/release 治——它从未绑定 feeds，行里只有「这条连接想
  看」一个事实，host 消失对冷读无影响，服务端代清反而是越权（行是连接的，不是会话的）。
- **ADR-0010 的 retain 语义补句**：照批，见上。

### 边界与代价（照实记）

- 客户端若在收到收尾帧后不发 `unwait`（旧版客户端、或窗口在处理 end 前被杀而连接未断），袋多驻留到
  unwait / 连接死亡 / 进程退出——失败方向是「多留」，与 04 §3 的边沿漏接同号，安全。
- `wait` 不挡 reap 的 settle 与 host 删除：等待者不阻止会话停止运行，只阻止袋被清——host 的寿命是 claim 的
  语义，wait 沾上它就等于「订阅让会话保持打开」的后门重开。

### code-review 记录

两轴跑完，四处处置：

**Standards 轴**
1. **architecture.md 的 ClientFrame 小节与新协议矛盾（硬违规，已修）**——「只有两个成员」与类型块照旧写
   `open` / `cancel`；本票落地时已把该小节（含 §API 引言那句「上行帧（open / cancel）不走 URL」）改成四个
   成员并补 wait 的一段话。AGENTS.md 术语的 transport 条目未提 wait（判断项）——术语是索引，细节在 ADR 与
   本票，归 14 号票顺手收账。
2. `waiting` 与 `observers` 同形孪生（Duplicated Code，判断项）——保留：判据本就「hub 侧两样人」，同构是
   语义，不是抄写；`tryEvict` 漏斗已消掉第二处重复。
3. 解析器三分支合一行（Repeated Switches，判断项）——现状两行，不改。
4. `tryEvict` 名字低估职责面（Mysterious Name，判断项）——保留：注释已把「evict 或走 reap」说全，改名收益
   不及名字变长。
5. smoke 容错检查的 `sleep(100)`（时序脆弱，判断项）——已改成「心跳计数增长」的确定性标记。

**Spec 轴**
1. **reap 尾的删除点只重查 `waiting`（已修）**——04 §3「删除点同步全查是硬要求」；现补上 `observers` 的
   读取（claims 已由 settle 门回答），注释写明「读，而不是论证前置条件」。
2. **「重复 retain 不重发」可能吞掉一次真正的新等待（已改判）**——审查给出的时序（end 帧后、releaseSend
   前）在现行单线程处理里不可达（onStreamEnd 同步调 releaseSend），但「源是否新增」确实是表格无法诚实回答
   的区分，且服务端本就幂等——改为**每次 retain 恒报 `wait`**，宁可多余一帧，不赌时序。
3. replay 跳过 `ended` 的注释与机制不符（已修）——end 处理器同一拍释放 send 引用，`ended` 条目天然没有
   `send` 源，注释照实改。
4. mux close 顺序注释夸大必要性（已修）——漏斗全量重查使两种顺序都安全，注释改为「便利而非承重」。
5. release 的布尔守卫（scope creep，判断项）——已申报，保留：它同时是 unwait 不配对的守卫。

### 验证

- `npm run check` 绿（core / server / web tsc + token 审计）。
- `smoke-mux` 全绿：原 8 节无回归，新增第 9 节七条断言全过（等待挡驱逐、unwait 即边沿、重复 wait/unwait
  幂等不泄漏、连接死亡释放等待、未知会话容忍）；`smoke-mux-client` 适配三处计数断言（open 计数改走 `opens`
  过滤器）并加三条 wait 断言（send 恰报一次 wait、释放发 unwait、重放补 wait），全绿。
- 相邻十四个：sessions / liveness / projection / mux-live / boot / approval / approval-endpoint /
  approval-queue / approval-recovery / session / stream / desktop-close / desktop-observability /
  backpressure 全绿；`smoke-api` FAIL（mux 连不上 127.0.0.1:8080，07/08/12 已登记的本机环境问题，与改动无关）。
