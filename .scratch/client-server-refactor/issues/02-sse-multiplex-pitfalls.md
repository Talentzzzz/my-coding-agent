# 把一条 SSE 当作多路复用通道时，浏览器与 Node 的既有陷阱

Type: research
Status: resolved

## Question

本图选定"一条常驻的多路复用 SSE（每标签页一条）"作为流式通道（见 `map.md` 的 Notes）。这条路上有若干**必须提前避开**的平台行为，别用猜的。请以规范与实现为准，逐条给出结论与出处：

1. **`EventSource` 的重连语义**：正常结束与连接掉线对它是否可区分？`retry:` 字段服务端没写时的重连间隔由谁决定（规范怎么说、Chromium/Firefox 实际怎么做）？`Last-Event-ID` 在什么条件下会被发回来？
2. **心跳可读性**：注释行（`: ping`）与命名事件（`event: ping\ndata: {}\n\n`）在浏览器 JS 里分别可观察到吗？本仓库今天用的是注释行（`packages/server/src/http/event-stream.ts:63-67`），客户端只监听 `message`（`packages/web/src/client.ts:131`），所以那个心跳**根本读不到**——请确认这就是规范行为而不是本仓库的用法问题。
3. **`411 Length Required` 之外的写侧行为**：`ServerResponse.write()` 返回 `false` 意味着什么、什么时候该等 `drain`？Node 的 `server.close()` 与一条永不结束的响应是什么关系（本仓库 `docs/architecture.md:263` 声称"一条泄漏的流就是一台关不掉的服务器"，请核实这个断言的准确性）。
4. **连接上限**：HTTP/1.1 同源 6 连接上限对 `EventSource` 的确切表现是什么？HTTP/2 或 HTTP/3 是否改变它？本地回环（`127.0.0.1`）上还有别的相关限制吗（例如 Node 的 `server.maxRequestsPerSocket`、`headersTimeout`、`requestTimeout`、`keepAliveTimeout` 对长连接的影响）？
5. **一条响应承载 N 个逻辑流时的队头阻塞**：单一串行写链上，一个慢消费者是否真的会拖住其他逻辑流？DSH 的总结（`deepseek-harness-master/tmp/dsh-client-server-summary.md` §9）声称会——请找独立证据或反证，并说明在回环 + 单用户场景下这是否是现实风险。
6. **Electron / Chromium 特殊性**：桌面外壳（`packages/desktop`）用 `loadURL(http://127.0.0.1:<随机端口>)`，`port: 0` 意味着每次启动都是一个新 origin。这会不会让上面的连接上限、缓存或重连行为与普通浏览器不同？

**产出**：`.scratch/client-server-refactor/research/sse-multiplex.md`。每条给出结论 + 出处（规范链接、源码行号、或可复现的最小实验）。区分"规范保证"与"实现细节"。不要给本仓库的改造建议。

## Answer

> 完整结论、出处与实测原始数据见 [`../research/sse-multiplex.md`](../research/sse-multiplex.md)。下面是压缩版；每条都标了证据等级（规范保证 / 官方文档 / 实现细节 / 未确认）。

**1. 重连语义** —— 正常结束与掉线**不可区分**：两条路径都让 `readyState = CONNECTING` 再 fire 一个 `error`（**规范保证**；Chromium `DidFinishLoading` 与 `DidFail` 都收敛到 `ScheduleReconnect()`）。唯一判据是 `readyState`：`CONNECTING` 会自动重连，`CLOSED` 才是放弃。间隔由客户端定：Chromium 默认 **3000 ms**、Firefox **5000 ms**（实现细节）；Chromium 不做退避，Firefox 把 `retry:` 夹到 500 ms–30 min。**`retry:` 是 `EventSource` 对象的属性，效果跨重连保持，刷新即失**。`Last-Event-ID` **只**在客户端持有的 last event ID string 非空时才发 —— 服务端不发 `id:` 就永远收不到（**规范保证**，实现照做）。`204` / 非 200 / 错误 `Content-Type` 是**仅有的**"别再连了"手段，三者实测都只 fire 一次 `error`、`readyState = CLOSED`、重连 **0 次**。

**2. 心跳可读性** —— 注释行（`: ping`）在 JS 里**完全不可观察**，这是规范原文 "Ignore the line"（**规范保证**；Chromium parser 落到 `// Unrecognized field name. Ignore!` 兜底分支）。实测：只发注释行的流，3 秒内只观察到 `open` 与重连的 `error`。**所以 `event-stream.ts:63-67` 的心跳读不到是规范行为，不是本仓库用法问题**，它只能防代理超时。命名事件读得到但要配 `data:`：`event: ping\ndata: {}\n\n` 需要 `addEventListener("ping", …)`；**只有 `event: ping\n\n` 的帧不 dispatch 任何事件**（data buffer 为空即返回，规范保证）。

**3. 写侧** —— `write()` 返回 `false` = 内部缓冲已达 `highWaterMark`，**必须停下等 `'drain'`**；不等的话官方文档原话是 "Node.js will buffer all written chunks until maximum memory usage occurs, at which point it will abort unconditionally … may lead to a remotely exploitable vulnerability"（**官方文档**）。`ServerResponse` 默认 HWM **16384**（官方文档 + 实测一致；实测写第 4 帧、共 16416 字节时返回 `false`）。回环上 `false → 'drain'` 只差 **约 1 ms**。`server.close()` 与永不结束的响应：**只要有一条响应没结束，`'close'` 与回调就不发生**（官方文档 "finally closed when all connections are ended" + 实测 3 秒挂起）；`server.closeAllConnections()`（v18.2.0+）连 active 连接一起关，实测调用后回调立刻发生。**判定 `architecture.md:263`：结论成立，"在进程的整个生命周期里占着 socket"这个机制描述不准确** —— 正确说法是"必须自己结束流，否则 `server.close()` 不会完成"。

**4. 连接上限** —— Chromium 源码里是**每 origin 6 条**，`kDefaultMaxStreamSocketsPerGroup = 6`，且 group 的键是 `SchemeHostPort`（实现细节，**不是"每标签页 6 条"**）。达上限时**排队不是失败**（源码术语 *stalled on the group limit*）。实测：6 条 `EventSource` 占满后，第 7 个 `EventSource` **10 秒内一直 `CONNECTING` 且服务端从未看到请求**，**同时的同源 `fetch` 一起被饿死**；释放一条后两者立刻完成。**h2c 未确认**，所以 `http://127.0.0.1` 走 HTTP/1.1、6 上限原样适用；上到 HTTP/2 则改由 `SETTINGS_MAX_CONCURRENT_STREAMS` 约束（RFC 9113，**规范保证**）。Node 侧的超时**都不会掐断一条正在写的响应**：`requestTimeout` 计的是"收请求"、`keepAliveTimeout` 只在响应写完之后才开始计（**官方文档**）。

**5. 队头阻塞** —— 单响应 = 单个 `Writable`，所有逻辑流共用一个 `writableLength`，**这是定义**；TCP（以及 HTTP/2 单连接）层面同样如此。应用层真正的风险不是"某个流被卡"而是**背压没人处理时的无界缓冲**。**回环 + 单用户下不是现实风险**：背压窗口只约 1 ms，没有丢包、没有带宽竞争。**残余风险是"整条通道静默"**（渲染器停止读取时，所有会话一起停；现状是每会话一条流，只停一个）—— 这是**隔离性的损失**。DSH §9 那句是设计者自述，**没找到独立一手证据**，实测部分标为未确认。

**6. Electron / Chromium** —— `port: 0` ⇒ OS 分配临时端口 ⇒ **每次启动都是新 origin**，缓存与 socket 池天然为空（socket 池按 origin 分组有源码依据：`GroupId` = `SchemeHostPort`）。**连接上限与重连行为不因此改变**（6 仍是 per origin per NetworkContext，但这后一半没实测）。`webPreferences.backgroundThrottling` 在 Electron 里默认 **`true`**，它对隐藏窗口里 `EventSource` 的影响**未确认** —— 已确认的只是：设成 `false` 时隐藏窗口里重连与计时一切正常。

**最可能推翻"多路复用 SSE"的一条：Q5。** 它的形态是**故障隔离的损失** —— 一个停住不读的消费端会让这条通道上**所有**会话一起停，而"每会话一条流"只会停一个；"每标签页一条"把这个半径从"一个会话"放大到"整页"。**但它不足以推翻选型**：单连接 + 应用层串行是 TCP 的性质，WebSocket 一样中招（DSH §9 就把它列在 WS 的代价里），所以它不构成改用 WebSocket 的理由；而且换来的正是验收第 1 条。结论是它是**设计约束**（必须处理背压，一个停滞的订阅者不能拖垮整条通道），不是否决项。

## 核实到的一处文档漂移 + 一处实数

- **`docs/architecture.md:263`** 的断言：结论成立、机制描述不准确（见上面第 3 条），另有明确出口 `server.closeAllConnections()` 未被提及。
- **`RELEASE_GRACE_MS = 2s` 的跨浏览器前提**（`docs/architecture.md:248`，map 里"claim 比响应多活两秒"）：Chromium 默认重连 **3000 ms** > 2 s，但 **Firefox 默认 5000 ms** > 2 s —— 只按 Chromium 定的这个数在 Firefox 下不够。
