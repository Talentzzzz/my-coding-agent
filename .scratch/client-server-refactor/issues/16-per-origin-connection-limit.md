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
