# 常驻连接与浏览器的连接上限

Type: grilling
Status: resolved
Blocked by: 17

## Question

这条是**研究票 02 新翻出来的**，它的前提在 2026-10-12 传输重开后被改写了。

**原有事实**（SSE 时代，`../research/sse-multiplex.md` Q4，Chromium 源码 `SchemeHostPort` 分组 + 实测）：并发上限**每 origin 6 条**（不是每标签页 6 条）；达到上限**排队，不是失败**，第 7 条 `EventSource` 和同源的普通 `fetch` 一起被饿死；Node 侧的 `headersTimeout` / `requestTimeout` / `keepAliveTimeout` 都不会掐断一条正在写的响应——被饿死的请求会一直等下去。桌面外壳用 `port: 0`，每次启动都是新 origin，额度是干净的。

**2026-10-12 传输改为 WebSocket mux 后，这条分析换了承载对象**：Chromium 对 WebSocket 组的池上限是 **255**（`g_max_sockets_per_group` 的 kWebSocket 值，`sse-multiplex.md` Q4 引的源码常量，**未实测**）。若属实，6 连接的压力蒸发，本票的大部分前提跟着蒸发——但在票 17 核实之前，255 只是一个源码常量，不是结论。

**要钉死的是**：

1. **WebSocket 的实际上限**。255 实测是否成立；Firefox 的对应值是多少；HTTP 池与 WebSocket 池是否共享名额；"页面导航 + 一条常驻 WS + 普通 `fetch` 命令"在回环上的实测。这些归**票 17** 核实，本票拿结论。
2. **这算不算问题**。若 255 属实：单窗口桌面应用几乎不可能撞上，本票降级为"记录结论 + 一条防御性冒烟"。若不是：再摆原来的取舍。
3. **要不要让常驻连接携带一元命令**。原票里这是"把当初否决 WebSocket 的理由拿回来"的连锁；现在传输本来就是 WebSocket、上行帧天然可用（DSH 帧协议的 `open/cancel` 判"可搬"），这条取舍**必须重新摆**——但命令面保留 REST 仍是地图决定，推翻它要回地图（`map.md` 的 Out of scope 给了本票这个例外条款）。若票 17 证实上限根本撞不上，这条可以直接判"不摆"。
4. **降级行为**。若上限真的存在，第 7 个标签页（或被饿死的普通命令）会**静默无限等待**——因为 Node 不掐断、浏览器只排队。今天审计记录的现象是"该标签页什么都不显示、`connected` 保持旧值、发送卡在 `ATTACH_TIMEOUT_MS = 10s` 后报'连接不到该会话'"。新模型至少要让这件事**说出来**，而不是卡住。
5. **连接数要不要可见**。`GET /api/health` 今天报 `live` 与 `streaming`（`packages/server/src/controllers/routes.ts:35`），而客户端两个都不读（`api.ts:106-108` 只声明 `live`，`main.ts` 只用 `cwd`）。这条信息是不是该用起来。

**已定前提**：命令面保持 REST 资源式——除非本票的答案明确要求推翻第 3 条，那时它要回到地图上重开。HTTP/2 一问随传输切换退场（WebSocket 走 HTTP/1.1 upgrade；WS over HTTP/2 不在本图范围）。

## Answer

### 结论（一句话）

**票 17 的实测把本票的前提拆掉了：上限从"每 origin 6 条、排队、同源 `fetch` 一起饿死"变成"每池 255 条、跨 origin 共享、撞上立刻失败、HTTP 池分立"——单窗口桌面应用撞不上，也不再有"静默饿死"这回事。本票按票面自己的条款降级为"记录结论 + 一条防御性冒烟"：冒烟落 `smoke-mux.ts`（8 条常驻连接之下 `/api/health` 照常在预算内答出），不复现 255；第 3 问判"不摆"，命令面 REST 恢复为**无例外**的已定决定；第 4 问的前提反转，"说出来"由票 07 的连接状态机承担，无需新机制；第 5 问判"不用起来"，`streaming` 随 `EventController` 在落地时退场，不为连接数加字段。**

---

### 第 1 问：上限的实测形状——"每 origin"改写成"每池共享"

事实全部来自票 17（`../research/ws-multiplex.md` Q3，装置 `../prototype/ws/`；Chromium 152 / Electron 44.5.1 实测，Firefox 为源码实证）：

- **Chromium：255 实测成立，但它是池级共享，不是每 origin。** group 的键虽是 `SchemeHostPort`，但直连的 WebSocket 走**专用池** `WebSocketTransportClientSocketPool`，容量判据是**池级**的 `Expandability() == kCapped`、不看 group。实测：只打一个 origin 恰好 255 条全部 `open`、第 256/257 条立刻 `error`；先给 origin B 一条再把 A 打满，A 停在 254（254+1=255），此时再连 B 也 `error`；A 关 5 条后 B 恰好补 5 条。**"换个 origin 就有一份新额度"是错的。**
- **撞上限是失败，不是排队**：新连接立刻 `error` + `close(1006, "", wasClean=false)`，服务端连 upgrade 都收不到。与 SSE 时代 `EventSource` 的无限 `CONNECTING` 相反——这一条直接改写第 4 问的前提。
- **HTTP 池与 WS 池分立，名额不共享**：255 条 WS 占满时，同源 `fetch('/health')` 仍 28/3/2 ms 全 200。"一条常驻 WS + 页面导航 + 普通命令请求"在回环上没有任何压力。
- **Firefox：默认 200、进程级全局**（`network.websocket.max-connections`，`nsWSAdmissionManager` 静态单例里的 `Atomic<int32_t>`），超限同样立刻失败不排队（源码注释即判据）。源码实证，未实测。
- **两条不许当常量用的**：实测 255 与源码池软上限 256 差 1，未解释（候选 `SocketPoolAdditionalCapacity` 随机化）；多窗口 / 多 Electron `session` 是否共享那 255 名额未实测（未确认清单第 3 条，实测只开了一个窗口）。

### 第 2 问：这算不算问题——不算，降级

数量级：本图终点形态是"每标签页一条常驻 WS"，而桌面外壳是**单窗口、并排两栏**（票 03）——生产形状是**一条**连接；就算用户多开标签页或多窗口，撞上 255 也需要常驻连接总数达到池上限——多窗口是否共享同一份额度**未实测**（未确认清单第 3 条），但无论共享与否，这个数量都不是这个应用的形状。就算真撞上：失败**立刻且可见**（`error` 与 `close` 同一毫秒），命令面**不受影响**（HTTP 分池），客户端退避会持续重试（票 07）。三道保险都在，原票防的那种"静默饿死"没有存活路径。**判定：降级为"记录结论 + 一条防御性冒烟"。**

#### 防御性冒烟（唯一的代码落点，随落地票实现）

它防御的是**服务端那一半**——"常驻连接的存在不吞掉命令面"，这正是原票所惧之事的服务器侧镜像。可判定形式：**`smoke-mux.ts` 加一条——开 8 条 mux 连接、每条挂着活跃逻辑流，断言 `GET /api/health` 在预算内 200。**

- **K=8 的理由**：SSE 时代的上限是 6，取 8 是"越过旧上限一个小台阶"——这条断言在旧传输下恰好做不到，在新传输下便宜且确定。
- **不复现 255**：那是**浏览器池**的事实，Node 的 undici `WebSocket` 根本没有这个池——冒烟从原理上测不到它（本票 Comments 里 2026-10-13 票 15 解决时追加的那条已登记："本票的结论只能从票 17 的实测里得到，不能从冒烟里得到"）；原始数据留在 `prototype/ws/`。
- **不断言**：255 这个数字、任何连接上限、排队/失败语义——全是浏览器池行为。

### 第 3 问：要不要让常驻连接携带一元命令——不摆

三个理由，逐条对着票面的连锁：

1. **动机蒸发**。原票把它当"把当初否决 WebSocket 的理由拿回来"的连锁，而那个理由（6 连接排队 + 饿死同源 `fetch`）已被票 17 实测消灭：上限 255、失败立刻、HTTP 分池。
2. **就算撞上限也没有绕行的激励**。SSE 时代绕开排队的收益是"把命令从饿死里救出来"；现在撞限的连接当场报错、重试即可，不存在"值得拿常驻连接去 escape"的场景。
3. **DSH 的先例原样**：上行 mux 帧在生产中没有命令消费方（研究票 01），命令面走 REST 是它自己的形状，也是本图的已定前提。

判定按票面条款执行：**不推翻第 3 问，命令面 REST 恢复为无例外的已定决定，地图 Out of scope 的例外条款就此作废**（随本票解决改掉）。`open`/`cancel` 走 mux 帧（票 04）不受影响——它们是**订阅控制**，不是命令。票面"已定前提"里 HTTP/2 一问照旧随传输切换退场，无新话可说。

### 第 4 问：降级行为——前提反转，剩下的由票 07 覆盖

票面那个场景（第 7 个标签页静默无限等待、`ATTACH_TIMEOUT_MS = 10s` 后报"连接不到该会话"）在 WS 下**不成立**：撞上限的连接立刻 `error` + `close(1006/false)`，浏览器侧不会进入无限 `CONNECTING`；Node"不掐断正在写的响应"那条事实（研究票 02 Q3/Q5）随之失去这个应用场景——服务端根本收不到第 256 条的 upgrade，没有任何"正在写但没人读的响应"被创造出来。今天审计记录的现象（`connected` 保持旧值、发送卡 10 秒）是 SSE 时代 attach 流程的产物：`ATTACH_TIMEOUT_MS`（`packages/web/src/client.ts:23`）与 `whenOpen()` 依附的"先 attach 再 POST"正是验收第 3 条要拆的东西，随落地删除，不单独修。

剩下的唯一场景是票 17 注释里那句"**客户端自己没把失败显示出来**"，它的答案是**已经定了的**：连接失败与掉线同形（`1006/false`），走票 07 的退避与 `channel` 状态机，连接指示器画在窗口级标题条——用户看到的是"连不上、在重试"，不是沉默。**不需要新帧、新字段、新超时。**

### 第 5 问：连接数可见性——不用起来；`streaming` 随 EventController 退场

现状核实（票面引用行号今天仍准）：`GET /api/health` = `{ ok, cwd, live }`（`sessions.ts:65`）+ routes 叠的 `streaming`（`routes.ts:35`，经 `events.ts:52` 读 registry）；客户端 `api.ts:106` 只声明 `{ ok, cwd, live }`、`main.ts:525-526` 只读 `cwd`——`live` 连类型声明了都没人读值，`streaming` 连类型都没进。判定分三半：

- **`streaming`：退场**。它是 SSE 时代的词（"挂着事件流的会话 id"），新模型里对应的对象是 mux 订阅表，而那张表的内容已经在往客户端走的路上——`sessions` 投影基线（票 10）告诉每一栏"有哪些会话、各自 `running`/`pending`"，比一个裸 id 列表信息量大且有人读。落地时 `streaming` 随 `EventController` 一起删除，`/api/health` 回到 `{ ok, cwd, live }`；冒烟对 health 只做往返断言（`smoke-api.ts:267`、`smoke-boot.ts:9`），没有形状断言，删除无连带。
- **`live`：原样**。它是 claim 的投影（持有 claim 的会话 id），形状不变；不为它加读者。
- **连接数：不加**。"这台服务器此刻有几条常驻连接"没有消费者：单窗口、每标签页一条、连接自己的状态由票 07 的指示器显示；调试时 `live` 的会话数与 mux 内部日志已经够。为一个没有读者的字段扩 API 面，违反本仓库"加端点 = 控制器方法 + 路由表一行"的那条口味——健康端点不豁免。将来真要（比如诊断多窗口），加 `connections: number` 是一行的事，今天不为它预支。

### 决定记录（下游可以直接依赖的）

| # | 决定 | 直接约束谁 |
|---|---|---|
| 1 | 上限按"**每池 255、跨 origin 共享、立刻失败、HTTP 分池**"改写（票 17 实测）；本票降级为记录结论 + 一条防御性冒烟，**不复现 255**（浏览器池事实，冒烟测不到） | 落地 |
| 2 | 防御性冒烟落 `smoke-mux.ts`：**8 条常驻连接各挂活跃逻辑流之下 `/api/health` 在预算内 200**；不断言任何浏览器池行为 | 15、落地 |
| 3 | 第 3 问判"**不摆**"：命令面 REST 恢复为无例外的已定决定，地图例外条款作废 | 地图 |
| 4 | 第 4 问无需新机制：撞限立刻失败，"说出来"由票 07 的 `channel` 状态机承担；`ATTACH_TIMEOUT_MS`/`whenOpen()` 随 attach 流程在落地时删除 | 07、落地 |
| 5 | 第 5 问判"**不用起来**"：`streaming` 随 `EventController` 退场（`/api/health` 回到 `{ ok, cwd, live }`）；`live` 原样；**不为连接数加字段** | 落地 |

### 落点

| 落点 | 内容 | 归谁 |
|---|---|---|
| 本票 Answer 与 Status | 判定记录 | 本票（随本票解决完成） |
| `../map.md` Decisions 加一条票 16；Out of scope 的例外条款改写 | 第 3 问的判定 | 本票（随本票解决完成） |
| `scripts/smoke-mux.ts`（票 15 的新脚本） | 决定 2 的防御性断言 | 落地 |
| `packages/server/src/controllers/routes.ts:35`、`controllers/events.ts` | `streaming` 随 `EventController` 退场 | 落地 |
| `packages/web/src/client.ts`（`ATTACH_TIMEOUT_MS`、`whenOpen()`） | 随"先 attach 再 POST"的拆除一起消失 | 落地 |
| `docs/adr/0001-transport-websocket-mux.md:109`（"未确认的平台事实"） | 该行今天仍写着"255（源码常量，未实测）"——票 17 已实测、本票已判，落地时按"255 已实测、每池共享；Firefox 200 源码实证"改写，并带上"命令面 REST 无例外" | 落地 |

### 本票没有回答的（别当成已定）

- **多窗口 / 多 Electron `session` 是否共享那 255 名额**（票 17 未确认清单第 3 条，实测只开了一个窗口）。若将来做多窗口，回这张票重看第 2 问的数量级——但即使往更坏的方向共享，Firefox 那个"进程级全局 200"的先例也说明全局共享的形状照旧撞不上。
- **255 与源码 256 差的那 1 条**：未解释，但不影响本票判定——差的是余量，不是有无。
- **Firefox 的一切运行时行为**只有源码实证；本仓库交付面是 Electron（Chromium），Firefox 只进"余量更大"那一半，不承重。

## Comments

**2026-10-13，票 15 解决时追加（本票仍 open；这里登记冒烟侧与本票相关的一条边界）**：票 15 的冒烟最多同时开**三条连接**（`smoke-approval.ts` 那段"三条流"改成三条连接），远在 Chromium 的 kWebSocket 组上限（255，未实测）之下——所以**没有任何冒烟会撞上本票第 1 问那道上限**，本票的结论只能从票 17 的实测里得到，不能从冒烟里得到。另外 `GET /api/health` 今天报的 `live` / `streaming`（`packages/server/src/controllers/routes.ts:35`）：票 15 不给它加断言（`streaming` 这个词在新模型里本来就要重命名或退场），本票第 5 问若要把它用起来，那是记录层与客户端的事。

**2026-10-13，票 17 解决时追加（本票的 `Blocked by: 17` 就此解除；下面四条是本票第 1 问要的答案，**判定归本票、本注释只给事实**）**：

1. **255 属实，但它不是"每 origin"，而是"每个 WebSocket 池一共 255 条、跨 origin 共享"。** 实测两轮：①只打一个 origin，第 1–255 条全部 `open`，第 256、257 条立刻 `error`；②先给另一个 origin（另一个端口 = 另一个 `SchemeHostPort`）开 1 条（成功），再把第一个 origin 打满 → 它停在 **254**（254+1=255），此时**再连第二个 origin 也 `error`**；在第一个 origin 上关掉 5 条之后，第二个 origin **恰好补上 5 条**（249+1+5=255）。源码侧对应的是"直连的 WebSocket 走一条**专用池**，容量判据是 `Expandability() == kCapped`（**池级**，不看 group）"。**所以"换个 origin 就有一份新额度"是错的，本票第 1 问按"每池共享"改写。**
2. **撞上限的行为是"失败"，不是"排队"**——这一条与本票第 4 问的前提**相反**：新连接**立刻** `error` + `close(code 1006, reason "", wasClean false)`，服务端**连 upgrade 都收不到**。它**不会**静默无限等待（那是 SSE 时代 `EventSource` 的行为）。所以第 4 问里"第 7 个标签页会静默无限等待"在新传输下**不成立**；需要"说出来"的场景只剩"客户端自己没把失败显示出来"。
3. **HTTP 池与 WebSocket 池是两条独立的池，名额不共享**：255 条 WS 占满时，对同一个 origin 的 3 次 `fetch('/health')` 仍然 **28 ms / 3 ms / 2 ms** 全部 200。**"页面导航 + 一条常驻 WS + 普通命令请求"在回环上没有任何压力**（本票第 1 问的最后半句）。
4. **Firefox 的对应值：默认 `200`，而且是进程级全局**（`network.websocket.max-connections`，在 `all.js`；计数是 `nsWSAdmissionManager` 静态单例里的一个 `Atomic<int32_t>`，加减都不带 key），超限同样**立刻失败不排队**（源码注释："WebSocket connections are expected to be long lived, so return an error here instead of queueing"），JS 侧见 `error` + `close(1006/false)`。**这一半只有源码实证，本机没有 Firefox，没有实测。**

**两处必须一起看**：①实测总容量 **255** 与源码的池软上限 **256** 差 1，**未解释**（候选是 2025 年新增的 `SocketPoolAdditionalCapacity` 随机化），所以"255"这个数字不要当成不动的常量用；②**多窗口 / 多个 Electron `session` 是否共享同一份额度没有实测**（只开了一个窗口）。完整出处与原始数据见 `../research/ws-multiplex.md` 的 Q3 与"未确认清单"。
