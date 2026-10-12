# 常驻连接与浏览器的连接上限

Type: grilling
Status: open
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

<!-- 解决时在下面追加。 -->

## Comments

**2026-10-13，票 15 解决时追加（本票仍 open；这里登记冒烟侧与本票相关的一条边界）**：票 15 的冒烟最多同时开**三条连接**（`smoke-approval.ts` 那段"三条流"改成三条连接），远在 Chromium 的 kWebSocket 组上限（255，未实测）之下——所以**没有任何冒烟会撞上本票第 1 问那道上限**，本票的结论只能从票 17 的实测里得到，不能从冒烟里得到。另外 `GET /api/health` 今天报的 `live` / `streaming`（`packages/server/src/controllers/routes.ts:35`）：票 15 不给它加断言（`streaming` 这个词在新模型里本来就要重命名或退场），本票第 5 问若要把它用起来，那是记录层与客户端的事。

**2026-10-13，票 17 解决时追加（本票的 `Blocked by: 17` 就此解除；下面四条是本票第 1 问要的答案，**判定归本票、本注释只给事实**）**：

1. **255 属实，但它不是"每 origin"，而是"每个 WebSocket 池一共 255 条、跨 origin 共享"。** 实测两轮：①只打一个 origin，第 1–255 条全部 `open`，第 256、257 条立刻 `error`；②先给另一个 origin（另一个端口 = 另一个 `SchemeHostPort`）开 1 条（成功），再把第一个 origin 打满 → 它停在 **254**（254+1=255），此时**再连第二个 origin 也 `error`**；在第一个 origin 上关掉 5 条之后，第二个 origin **恰好补上 5 条**（249+1+5=255）。源码侧对应的是"直连的 WebSocket 走一条**专用池**，容量判据是 `Expandability() == kCapped`（**池级**，不看 group）"。**所以"换个 origin 就有一份新额度"是错的，本票第 1 问按"每池共享"改写。**
2. **撞上限的行为是"失败"，不是"排队"**——这一条与本票第 4 问的前提**相反**：新连接**立刻** `error` + `close(code 1006, reason "", wasClean false)`，服务端**连 upgrade 都收不到**。它**不会**静默无限等待（那是 SSE 时代 `EventSource` 的行为）。所以第 4 问里"第 7 个标签页会静默无限等待"在新传输下**不成立**；需要"说出来"的场景只剩"客户端自己没把失败显示出来"。
3. **HTTP 池与 WebSocket 池是两条独立的池，名额不共享**：255 条 WS 占满时，对同一个 origin 的 3 次 `fetch('/health')` 仍然 **28 ms / 3 ms / 2 ms** 全部 200。**"页面导航 + 一条常驻 WS + 普通命令请求"在回环上没有任何压力**（本票第 1 问的最后半句）。
4. **Firefox 的对应值：默认 `200`，而且是进程级全局**（`network.websocket.max-connections`，在 `all.js`；计数是 `nsWSAdmissionManager` 静态单例里的一个 `Atomic<int32_t>`，加减都不带 key），超限同样**立刻失败不排队**（源码注释："WebSocket connections are expected to be long lived, so return an error here instead of queueing"），JS 侧见 `error` + `close(1006/false)`。**这一半只有源码实证，本机没有 Firefox，没有实测。**

**两处必须一起看**：①实测总容量 **255** 与源码的池软上限 **256** 差 1，**未解释**（候选是 2025 年新增的 `SocketPoolAdditionalCapacity` 随机化），所以"255"这个数字不要当成不动的常量用；②**多窗口 / 多个 Electron `session` 是否共享同一份额度没有实测**（只开了一个窗口）。完整出处与原始数据见 `../research/ws-multiplex.md` 的 Q3 与"未确认清单"。
