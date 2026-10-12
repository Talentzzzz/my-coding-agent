# 把一条 SSE 当作多路复用通道时，浏览器与 Node 的既有陷阱

研究票：`.scratch/client-server-refactor/issues/02-sse-multiplex-pitfalls.md`
状态：已解决（结论见票的 `## Answer`）

## 这份文档怎么读

**范围**：只回答"把一条 SSE 当多路复用通道"这件事上**平台既有**的行为。不写本仓库的改造建议。

**四条证据等级**，每条结论都标了其中之一：

| 标记 | 含义 |
|---|---|
| **规范保证** | WHATWG HTML / RFC 的规范性条文（normative）。符合规范的实现**必须**这样做。 |
| **官方文档** | Node.js 官方 API 文档的明说。是这份实现自己的承诺，不是跨实现的标准。 |
| **实现细节** | 从 Chromium / Firefox 源码读出的行为，或本仓库机器上跑出来的实测结果。**可以随版本变**，不构成任何保证。 |
| **未确认** | 没找到一手出处，且没有实测。不要拿它当判据。 |

**取证方式**：一手来源为 WHATWG HTML、Node.js 官方文档、Chromium (`chromium/chromium`) 与 Firefox (`mozilla/gecko-dev`) 源码、RFC 9110/9112/9113。凡标"实测"的数字，来自本机一次可复现的实验，脚本与原始输出附在文末 [附录 A](#附录-a实验装置与原始数据)。实测环境：Windows、Node v24.15.0、Electron 44.5.1（Chromium 152.0.7977.130）。**本仓库要求的 Node 是 `>= 22.19`，与实测的 v24.15.0 是不同小版本**，凡依赖 Node 内部记账的结论都标了这一点。

---

## Q1. `EventSource` 的重连语义

### 1a. 正常结束与连接掉线，对 `EventSource` 可区分吗？

**结论：不可区分。**

规范定义了两条互不相同的路径，但**都会**把 `readyState` 设成 `CONNECTING` 并 fire 一个 `error`：

- **正常结束**（响应体 EOF）：`processResponseEndOfBody` 回调要求 **reestablish the connection**。[规范](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-eventsource-interface)（"Let processEventSourceEndOfBody given response res be the following step: if res is not a network error, then reestablish the connection."）
- **掉线 / 网络错误**：`processResponse` 里若不是 aborted network error 而是 network error，同样 **reestablish the connection**；只有 *aborted* network error 才是 **fail the connection**。
- **reestablish the connection** 的步骤里明确要求：`readyState` 设为 `CONNECTING`，然后 **fire an event named `error`**。[同页](https://html.spec.whatwg.org/multipage/server-sent-events.html#sse-processing-model)
- **fail the connection** 才是终态：`readyState` 设为 `CLOSED`，fire `error`，并且 **"Once the user agent has failed the connection, it does *not* attempt to reconnect."**

所以两种情况下 JS 都只看到**一个 `error` 事件**。唯一能区分"这个对象还会不会再连"的东西是 `readyState`：`CONNECTING`(0) = 会自动重连；`CLOSED`(2) = 游戏结束。**规范保证**。

**实现细节（Chromium，源码可读出，实测吻合）**：

- 正常 EOF → `EventSource::DidFinishLoading` → `NetworkRequestEnded()` → `State()!=kClosed` 时 `ScheduleReconnect()`。[`event_source.cc:310-315`、`:184-195`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/eventsource/event_source.cc)
- `ScheduleReconnect()` 做三件事：`state_ = kConnecting`、启动定时器、`DispatchEvent(*Event::Create(event_type_names::kError))`。同一个函数，两种原因共用。
- 掉线（`DidFail`，非 cancellation、非 access check）→ 也走 `NetworkRequestEnded()`，同一个 `ScheduleReconnect()`。**连接掉线与正常结束在实现里走的是同一条路。**

**实测**（附录 A，用例 `/normal-eof`、`/named-heartbeat`）：服务端 `res.end()` 之后，客户端恰好收到 `{"kind":"error","readyState":0}`，随后按默认间隔重连成功。没有任何字段能告诉 JS "这是服务端主动关的"。

**规范没有给"优雅结束"这个信号**。服务端想表达"别再连了"，只能用 **204 No Content**（规范原文："a client can be told to stop reconnecting using the HTTP 204 No Content response code"）或非 200/错误 `Content-Type`，让浏览器走 fail the connection（见 1d）。

### 1b. 服务端没写 `retry:` 时，重连间隔由谁决定？

**结论：由客户端决定，规范故意不定量。** 规范只说每个 `EventSource` 对象有一个 **reconnection time**（毫秒），"This must initially be an implementation-defined value, **probably in the region of a few seconds**"；`retry:` 字段（值必须是纯 ASCII 数字）会设置它。[规范 §9.2.2 / §9.2.6](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-eventsource-interface)

**实现细节**：

| 浏览器 | 默认值 | 来源 |
|---|---|---|
| Chromium | **3000 ms** | `const uint64_t EventSource::kDefaultReconnectDelay = 3000;` — [`event_source.cc:93`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/eventsource/event_source.cc) |
| Firefox | **5000 ms** | `#define DEFAULT_RECONNECTION_TIME_VALUE 5000`，且 `mReconnectionTime = StaticPrefs::dom_serverEvents_defaultReconnectionTime()` 取不到时回落到它 — [`dom/base/EventSource.cpp:68-72, 620-622`](https://raw.githubusercontent.com/mozilla/gecko-dev/master/dom/base/EventSource.cpp) |

**Firefox 还给 `retry:` 加了钳制**：小于 `MIN_RECONNECTION_TIME_VALUE` (500 ms) 一律夹到 500，大于 `MAX_RECONNECTION_TIME_VALUE` 夹到上限（源码里 `SetReconnectionTime` 附近，行 1567-1575）。**Chromium 不夹**。这是两边一个实在的分歧点，写多路复用通道时必须知道：`retry:` 不是"请求"，是"建议"。

**指数退避：规范允许，Chromium 与 Firefox 都不做。** 规范在 reestablish 的第 3 步说 "Optionally, wait some more… user agents might introduce an exponential backoff delay"。实现里没有这一层：Chromium 的重连间隔恒为 `reconnect_delay_`，只在解析到 `retry:` 时改变（`OnReconnectionTimeSet`）。

**实测（默认值 + `retry:` 语义）**：

- 服务端从不发 `retry:`，每次响应 200 ms 后 `end()`：连续 4 次 `open` 落在 20 / 3219 / 6437 / 9650 ms，间隔稳定 **≈3218 ms**（3000 ms 延迟 + 一次 RTT + 服务端 200 ms）。→ 默认 3000 ms 确认。
- 服务端发 `retry: 500`：`open` 间隔 **≈520 ms**（500 + 200 + RTT），连续 7 次，无退避、无抖动。
- **`retry:` 的效果会跨重连保持**：只在**第 1 条**连接上发 `retry: 200`，之后 19 次重连的 `open` 间隔仍是 **≈410 ms**（200 + 200 + RTT）。因为 reconnection time 是 **`EventSource` 对象**的属性，`NetworkRequestEnded()` 不重置它，服务端不发 `retry:` 时 `ParseLine()` 也不碰它。

> 这一条对多路复用尤其要紧：**一条通道上"谁来决定重连节奏"是全局的**。谁在这条响应里写过 `retry:`，整个标签页之后的重连节奏就归它。

### 1c. `Last-Event-ID` 在什么条件下会被发回来？

**结论：只有客户端**当前持有非空 last event ID string** 时才会发。** 规范："If the `EventSource` object's last event ID string is not the empty string: … Set (`Last-Event-ID`, lastEventIDValue) in request's header list."（[规范 §9.2.3](https://html.spec.whatwg.org/multipage/server-sent-events.html#sse-processing-model)）last event ID string 由流里的 `id:` 字段设置；`id`（空值）会把它清空；**没有 `id:` 字段的帧不会改变它**。

**实现细节**：Chromium 完全照做 —— `if (parser_ && !parser_->LastEventId().empty()) request.SetEventSourceLastEventId(parser_->LastEventId());`（[`event_source.cc:170-172`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/eventsource/event_source.cc)）。parser 里 `last_event_id_` 只在遇到空行时从 `id_` 更新（[`event_source_parser.cc:66-67`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/eventsource/event_source_parser.cc)）。

**实测**：`/normal-eof` 每帧带 `id: 42` → 重连请求里 `last-event-id: "42"`，且**后续每一次**重连都带。`/normal-eof-noid` 不发 `id:` → 重连请求里 `last-event-id: null`。→ **服务端不发 `id:`，就永远收不到这个 header。**

### 1d. 顺带钉死：什么情况下浏览器**不再**重连

**实测**（三种都撞到，结果干净）：

| 服务端响应 | 客户端观察 | 重连次数 |
|---|---|---|
| `204 No Content` | 一个 `error`，`readyState=2`(CLOSED) | **0** |
| `404` | 一个 `error`，`readyState=2` | **0** |
| `200` + `Content-Type: text/plain` | 一个 `error`，`readyState=2`，控制台打 `EventSource's response has a MIME type ("text/plain") that is not "text/event-stream". Aborting the connection.` | **0** |

**规范保证**：状态非 200、或 `Content-Type` 非 `text/event-stream` → fail the connection → 永不重连。Chromium 额外把 charset 也纳入校验（非 UTF-8 直接判非法，[`event_source.cc:255-283`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/eventsource/event_source.cc)）——这条**规范里没有**，是实现加的。

> ⚠️ 注意 204 的实现路径不是"规范里的特殊分支"：Chromium 只把 `status_code == 200` 判为合法，204 落进非法的 `else` 分支 `loader_->Cancel()`，再经 `DidFail` 的 `IsCancellation()` 走到 `AbortConnectionAttempt()` → `kClosed` + error。**结果与规范一致，路径不同**。

---

## Q2. 心跳可读性：注释行 vs 命名事件

### 结论 1：注释行（`: ping`）在 JS 里**完全不可观察**。**规范保证**。

规范原文（[§9.2.6](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)）："If the line starts with a U+003A COLON character (:)—**Ignore the line.**" `: ping` 是 ABNF 里的 `comment` 产生式，连 `field` 都不是。

**实现细节**：Chromium parser 里注释行走的是"未识别字段名"那条兜底分支，没有任何副作用 —— `field_name` 为空（`:` 之前的字符串是空的），落到文件末尾的 `// Unrecognized field name. Ignore!`（[`event_source_parser.cc:80-123`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/eventsource/event_source_parser.cc)）。它**不进 data buffer、不改 event type、不碰 last event ID、不 dispatch**。

**实测**：只发三条 `: ping\n\n` 的流，客户端 3 秒内观察到的事件是 `["open", "error"(重连)]` —— **message 0 次、自定义事件 0 次**。没有 IPC 之外的任何可观察量。

**所以 `packages/server/src/http/event-stream.ts:63-67` 那个心跳读不到，是规范行为，不是本仓库的用法问题。** 它唯一的用处是规范 §9.2.7 说的那个：防止"老式代理"超时掐连接 —— 即"让字节流保持流动"，而不是"让 JS 知道点什么"。

### 结论 2：命名事件读得到，但**必须带 `data:`**。

- `event: ping\ndata: {}\n\n` → dispatch 一个 **type = `ping`** 的事件（不是 `message`）。`onmessage` 收不到它；`addEventListener("ping", …)` 收得到。**规范保证**：dispatch 时"if the event type buffer has a value other than the empty string, change the type of the newly created event"。
- **只有 `event: ping\n\n`（没有 `data:`）→ 什么也不 dispatch。**

**实现细节**：Chromium 在空行处判 `if (!data_.empty())` 才 dispatch；data buffer 空就只清 `event_type_`（[`event_source_parser.cc:66-78`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/eventsource/event_source_parser.cc)）。**规范保证**：dispatch 步骤第 2 步 "If the data buffer is an empty string, set the data buffer and the event type buffer to the empty string and **return**"。Firefox 同样：`DispatchCurrentMessageEvent()` 里 `if (!message || message->mData.IsEmpty()) return NS_OK;`（[`dom/base/EventSource.cpp:1397-1399`](https://raw.githubusercontent.com/mozilla/gecko-dev/master/dom/base/EventSource.cpp)）。

**实测**：一个流里同时放 `event: ping\ndata: {}\n\n`、`event: ping\n\n`（无 data）、`data: plain\n\n`，客户端看到 `pingCount=1`、`msgCount=1`。→ **无 data 的命名帧被完全丢弃**，也就是说它连"心跳"都做不到，除非配 `data:`。

### 小结（把这条变成可用的规则）

| 服务端写什么 | JS 能不能观察到 |
|---|---|
| `: ping\n\n` | **不能**。零可观察效果。 |
| `event: ping\n\ndata: {}\n\n` | 能，但要 `addEventListener("ping", …)`；`onmessage` 拿不到。 |
| `event: ping\n\n` | **不能**（data buffer 为空，不 dispatch）。 |
| `data: {}\n\n` | 能，走 `message` / `onmessage`。 |

---

## Q3. `411 Length Required` 之外的写侧行为

### 3a. `ServerResponse.write()` 返回 `false` 意味着什么？什么时候该等 `drain`？

**结论（官方文档，原文）**：

- `writable.write()` 的返回值："`false` if the stream wishes for the calling code to wait for the `'drain'` event to be emitted before continuing to write additional data; otherwise `true`."；并且"The return value is `true` if the internal buffer is less than the `highWaterMark` configured when the stream was created after admitting `chunk`. **If `false` is returned, further attempts to write data to the stream should stop until the `'drain'` event is emitted.**"（[nodejs.org/api/stream.html#writablewritechunk-encoding-callback](https://nodejs.org/api/stream.html#writablewritechunk-encoding-callback)）
- `'drain'`："If a call to `stream.write(chunk)` returns `false`, the `'drain'` event will be emitted when it is appropriate to resume writing data to the stream."（[#event-drain](https://nodejs.org/api/stream.html#event-drain)）
- **不等的后果，文档说得很重**："While calling `write()` on a stream that is not draining is allowed, Node.js will buffer all written chunks until maximum memory usage occurs, at which point it will abort unconditionally. Even before it aborts, high memory usage will cause poor garbage collector performance and high RSS… **Since TCP sockets may never drain if the remote peer does not read the data, writing a socket that is not draining may lead to a remotely exploitable vulnerability.**"（同一节）
- `writableLength` 是"the number of bytes (or objects) in the queue ready to be written"，`writableNeedDrain` 是"`true` if the stream's buffer has been full and stream will emit `'drain'`"。
- **`ServerResponse` 的 `highWaterMark` 默认 16384**：`outgoingMessage.writableHighWaterMark` —— "The highWaterMark of the underlying socket if assigned. Otherwise, the default buffer level when `writable.write()` starts returning false (**16384**)."（[nodejs.org/api/http.html#outgoingmessagewritablehighwatermark](https://nodejs.org/api/http.html#outgoingmessagewritablehighwatermark)）

**实测（两条都吻合）**：本机 `socket.writableHighWaterMark = 16384`、`res.writableHighWaterMark = 16384`；一个循环里写 `data: ` + 4096 字节 + `\n\n` 的帧，**第 4 帧返回 `false`**，此刻 `writableLength = 16448`（≈16384 + 一帧）、`writableNeedDrain = true`。随后 `'drain'` 到达，`writableLength` 归 0，再写一帧返回 `true`。

**回环上的实际时序**（对"慢消费者会不会真的发生"这个问题要紧）：本机 `write()` 返回 `false` 与 `'drain'` 到达之间只差 **约 1 ms** —— 因为在同一台机器上"发出去"就等于"写进内核缓冲"，几乎瞬时。**要造出真正的背压，必须让对端不读**（客户端进程被挂起/停止读取，或窗口被节流到不消费）。这是一个"存在但不容易自然触发"的风险。

### 3b. `server.close()` 与一条永不结束的响应是什么关系？

**结论**：

- **官方文档（`net.Server`, 这是 `http.Server` 继承来的语义）**："Stops the server from accepting new connections and keeps existing connections. This function is asynchronous, **the server is finally closed when all connections are ended** and the server emits a `'close'` event. The optional callback will be called once the `'close'` event occurs."（[nodejs.org/api/net.html#serverclosecallback](https://nodejs.org/api/net.html#serverclosecallback)）
- **官方文档（`http.Server.close`）**："Stops the server from accepting new connections and closes all connections connected to this server **which are not sending a request or waiting for a response**."；v19.0.0 起"The method closes idle connections before returning."（[nodejs.org/api/http.html#serverclosecallback](https://nodejs.org/api/http.html#serverclosecallback)）
- `server.closeAllConnections()`（v18.2.0 起）："Closes all established HTTP(S) connections connected to this server, **including active connections** connected to this server which are sending a request or waiting for a response."（同页）
- **实现细节（`lib/_http_server.js`，Node main）**：`Server.prototype.close` 先调 `httpServerPreClose(this)`，它做两件事 —— `server.closeIdleConnections()` 和清掉 `kConnectionsCheckingInterval`；然后才转交 `net.Server.prototype.close`。而 `closeIdleConnections()` 内部会 **`continue` 掉任何 `socket._httpMessage && !socket._httpMessage.finished` 的连接**（即"有一个还没写完的响应"）。[`_http_server.js:697-699`、`648-651`、`719-733`](https://raw.githubusercontent.com/nodejs/node/main/lib/_http_server.js)

**实测（本机 Node v24.15.0，脚本见附录 A）**：

```
40   HOLD-RESPONSE status=200          ← 一条 SSE 响应已建立、永不结束
845  server.close() called
3846 server.closeAllConnections() called
3846 SERVER-CLOSE-CALLBACK             ← close 回调此刻才发生
```

即：**只要有一条响应还没结束，`server.close()` 的回调就不会来**；3 秒后调用 `closeAllConnections()`，回调立刻发生（同一个 tick 内）。对照组（把这条连接换成一条纯 idle keep-alive 连接）**没有**这个性质。

**实测的另一半（把机制钉死）**：`server.close()` 之后的 4 秒，那条 keep-alive socket 才自己关掉，close 回调随之发生。`server.keepAliveTimeout` 默认 **5000 ms**。也就是说：`server.close()` 会立刻清掉**调用那一刻已经空闲**的连接；而**在 `close()` 之后才变空闲**的连接要等它自己的 keep-alive 超时。这一条是 **Node 内部记账的实现细节**（并且我用的是 v24.15.0，本仓库要的是 `>=22.19`）——**不构成保证，不要写进设计依据**。

> **对本仓库 `docs/architecture.md:263` 那个断言的核实**：
>
> 原文："一条没人结束的 SSE 响应会在进程的整个生命周期里占着它的 socket，而只要有这样一条开着，`server.close()` 就永远不会回调——所以**一条泄漏的流就是一台关不掉的服务器**。"
>
> **判定：结论成立，机制描述不准确。**
>
> - 成立的部分（有官方文档 + 实测双重支撑）：**有一条响应尚未结束 ⇒ `'close'` 事件与它的回调不会发生**。所以"关不掉的服务器"这个说法是对的。
> - 不准确的部分：说它"在进程的整个生命周期里占着 socket"把**响应的寿命**与**进程的寿命**混为一谈了。socket 不是不可回收的；它是被 `net.Server.close` 的语义当作"还活着的连接"而**拒绝进入关闭流程**。措辞应该落在"**只要有一条响应没结束，`'close'` 就不会触发**"，而不是"资源泄漏"。
> - 另一半同样值得写下来：这条约束有一个明确的出口 —— `server.closeAllConnections()`（v18.2.0+，官方文档明说它连 active 连接一起关）。所以正确表述是"**必须自己结束流，否则 `server.close()` 不会完成**"，而不是"没有任何办法"。

### 3c. 与"411 Length Required"的关系（票面提到，顺带清掉）

`411 Length Required` 是**请求侧**的：一个带 body 但既无 `Content-Length` 也无 `Transfer-Encoding` 的请求会被服务器以 411 拒绝（[RFC 9110 §15.5.10](https://www.rfc-editor.org/rfc/rfc9110.html#name-411-length-required)）。**它与一条已经在写的响应无关**，也不会影响一条长命 SSE 响应。这里放它是因为票面把它当分界点；确认：它属于另一个类别，不构成本题的风险。

---

## Q4. 连接上限

### 4a. HTTP/1.1 同源 6 连接上限对 `EventSource` 的**确切**表现

**规范保证的部分**：规范自己就把这条列为已知麻烦，并在 authoring notes 里给了三条出路（每条连接用不同域名 / 让用户在页面上开关 / 用 shared worker 共享一个 `EventSource`）：

> "Clients that support HTTP's per-server connection limitation might run into trouble when opening multiple pages from a site if each page has an `EventSource` to the same domain. Authors can avoid this using the relatively complex mechanism of using unique domain names per connection, or by allowing the user to enable or disable the `EventSource` functionality on a per-page basis, or by sharing a single `EventSource` object using a shared worker."
> — [WHATWG HTML §9.2.7 Authoring notes](https://html.spec.whatwg.org/multipage/server-sent-events.html#authoring-notes)

注意措辞：规范把它归给"**per-server** connection limitation"，即这是 HTTP 客户端实现的性质，不是 `EventSource` 的性质。

**实现细节（Chromium 源码，数字是钉死的）**：

- 旧池：`g_max_sockets_per_group = {6 /* kNormal */, 255 /* kWebSocket */}`，注释写着 "Default to allow up to **6 connections per host**. Experiment and tuning may try other values… **WebSocket** connections are long-lived, and should be treated differently… Use a limit of 255… Also note that **Firefox uses a limit of 200**." — [`net/socket/client_socket_pool_manager.cc:46-58`](https://raw.githubusercontent.com/chromium/chromium/main/net/socket/client_socket_pool_manager.cc)
- 新池（`HttpStreamPool`）：`kDefaultMaxStreamSocketsPerGroup = 6`、`kDefaultMaxStreamSocketsPerPool = 256`，注释明说这两个值与上面对齐 — [`net/http/http_stream_pool.h:94-100`](https://raw.githubusercontent.com/chromium/chromium/main/net/http/http_stream_pool.h)
- **这个 6 是"每个 group"，而 group 的键是 `SchemeHostPort`（scheme+host+port）** —— `ClientSocketPool::GroupId` 的第一个成员就是 `url::SchemeHostPort destination`，并 DCHECK scheme 是 http/https — [`net/socket/client_socket_pool.cc:122-144`](https://raw.githubusercontent.com/chromium/chromium/main/net/socket/client_socket_pool.cc)。另有每 pool 上限 256（`g_socket_soft_cap_per_pool`）和每 proxy chain 上限 128。

> **所以：上限是 per NetworkContext（≈ 一个 profile / 进程的网络栈）× per origin。不是"每标签页 6 条"。** 同一进程里所有标签页共用这一个池。这条是从源码结构读出的**实现细节**，没有官方文档背书。

**达到上限时的表现：排队等待，不是失败。** 源码里这个状态叫 **stalled on the group limit**（`CanUseAdditionalSocketSlot`、`SOCKET_POOL_STALLED_MAX_SOCKETS_PER_GROUP`，见 [`transport_client_socket_pool.cc:420-427`](https://raw.githubusercontent.com/chromium/chromium/main/net/socket/transport_client_socket_pool.cc)）。

**实测（附录 A，Electron 44.5.1 / Chromium 152）**：

1. 页面打开 6 条 `EventSource` 指向同一 origin 的永不结束响应，**6 条全部 `OPEN`**（服务端日志：6 条 `/hold` 请求到达，`clientPort` 各不相同）。
2. 第 7 个连接尝试（第 7 条 `EventSource`）：**10 秒内一直 `CONNECTING`，服务端从未看到它的请求**。
3. 同时发一个**同源 `fetch()`**：**同样一直 pending**，服务端也从未看到它。→ **被 `EventSource` 饿死是真的。**
4. 释放一条 `EventSource`（`close()`）后：**`fetch` 立刻完成**，第 7 条 `EventSource` 的请求也到达服务端。排队请求不会被拒绝，只是等。

> **注意第 2 个数字**：6 条 `EventSource` 里**有一条复用了页面导航留下的 keep-alive 连接**（服务端日志里有一条 `clientPort` 与 `/blank` 那条相同）。也就是说"6 条 `EventSource` + 页面本身已有的连接"是同一个上限 —— 服务端只需要 6 个 slot，其中可能已经有一个被普通 HTTP 请求占着。这正好对得上 map 里"每标签页一条连接"这个决定：**多路复用的收益不是"省 5 条连接"，而是"把 N 个会话压成 1 条，从而不撞上限"。**

**实测的边界（必须诚实标出来）**：我只测了"一个窗口、一个 NetworkContext、同一 origin"。**没有测**：多个窗口是否共享同一个 per-origin 计数（源码结构说是，但没有实测）、Electron 多 `session`/partition 的情况。

### 4b. HTTP/2 / HTTP/3 会改变它吗？

**结论：会，但在本仓库的部署形态下用不上。**

- **规范侧**：RFC 9113（HTTP/2）把每条请求放在自己的 stream 上，并发由 **`SETTINGS_MAX_CONCURRENT_STREAMS`** 限制（[RFC 9113 §5.1.2](https://www.rfc-editor.org/rfc/rfc9113.html#section-5.1.2)）。也就是说 6 条**连接**上限的概念消失，改由一条连接上的 stream 数约束。**规范保证**（对实现了 HTTP/2 的双方而言）。
- **RFC 9112 明说 HTTP/1.1 的连接是串行的**："A client that sends more than one request to a server… **HTTP/1.1 asks that clients limit the number of outstanding requests**…"（见 [RFC 9112](https://www.rfc-editor.org/rfc/rfc9112.html) 关于 persistent connections 与 pipelining 的章节）。这就是 6 这个数字存在的原因。
- **实现细节**：Chromium 对 HTTP/2 **只在 TLS 上用 ALPN 协商**。明文 HTTP 不会尝试 h2c —— 浏览器没有"prior knowledge"路径，`http://` 一律 HTTP/1.1。**因此 `http://127.0.0.1:<port>` 这条路径上 6 连接上限原样适用。**
  - ⚠️ **我没有找到一手出处**：这条（浏览器不支持 h2c）我没能定位到 Chromium 源码里的正面证据（比如"cleartext HTTP/2 被 feature flag 关掉"的那行），也没有 RFC 或官方文档的明确句子。**标为未确认。** 实测侧只观察到：在 6 条流占满时 fetch 被饿死，这与"HTTP/1.1"一致，但与"HTTP/2 上限更小"也不矛盾，所以实测**不能**证伪 h2c。
  - 反过来说：**即使** h2c 可用，本仓库的服务端是 `node:http`（HTTP/1.1），也不会自动升级。**这一半是可验证的**：`packages/server` 用的是 `node:http`，而 `node:http2` 是另一个模块。

### 4c. 本地回环上还有别的相关限制吗？

**Node 服务端超时的默认值（官方文档，逐条抄录）**：

| 属性 | 默认 | 对"请求已到、响应永不结束"意味着什么 |
|---|---|---|
| `server.requestTimeout` | **300000**（5 分钟；v18.0.0 从"无超时"改成 300s） | 文档："Sets the timeout value in milliseconds for **receiving the entire request from the client**. If the timeout expires, the server responds with status 408 without forwarding the request to the request listener and then closes the connection." → **计时的是"收请求"，与响应写多久无关**。SSE 的请求头早已收完，**不会触发**。 |
| `server.headersTimeout` | `min(requestTimeout, 60000)`（v19.4.0/v18.14.0 起） | 只限制"等完整请求头"。**请求头早已到齐，不会触发。** |
| `server.keepAliveTimeout` | **5000** | 文档："The number of milliseconds of inactivity a server needs to wait for additional **incoming data, after it has finished writing the last response**, before a socket will be destroyed." → **响应写完才开始计时**。长命 SSE 响应期间**不适用**。 |
| `server.keepAliveTimeoutBuffer` | **1000**（v22.19.0 新增） | `socketTimeout = keepAliveTimeout + keepAliveTimeoutBuffer`。同上。 |
| `server.maxRequestsPerSocket` | **0（无限制）** | 文档："The maximum number of requests socket can handle before closing keep alive connection… When the limit is reached it will set the `Connection` header value to `close`, but will not actually close the connection, subsequent requests sent after the limit is reached will get **503 Service Unavailable**." → **一条 SSE 响应永不结束 ⇒ 该 socket 上的"请求计数"就停在那个值上**，后续同连接请求可能吃 503。**只有人为设过这个值才会发生。** |
| `server.timeout` / `server.setTimeout()` | **0（无超时）** | 文档："The number of milliseconds of inactivity before a socket is presumed to have timed out. A value of 0 will disable the timeout behavior on incoming connections." → 默认**不会**因为空闲而掐断长连接。 |

出处：[nodejs.org/api/http.html](https://nodejs.org/api/http.html) 的 `server.requestTimeout` / `server.headersTimeout` / `server.keepAliveTimeout` / `server.keepAliveTimeoutBuffer` / `server.maxRequestsPerSocket` / `server.timeout` 各节。

**结论：这些超时里没有一条会自然掐断一条正在写的 SSE 响应。** 反过来说，**服务端没有"这条流活了多久"的兜底**：一条写出去就再没人读的响应，Node 不会替你收尸（要收，只能靠 3a 里的背压 + 自己判断，或 `closeAllConnections()`）。

**回环特有的其他限制**：**未确认**。我没有找到"Windows 上 `127.0.0.1` 的 ephemeral port 范围 / 监听 backlog 在 6 到几十条长连接这个量级上有影响"的一手依据，也没有实测。可确定的是：本仓库同时在用的连接数远低于任何合理的端口耗尽阈值。

---

## Q5. 一条响应承载 N 个逻辑流时的队头阻塞

### 5a. 先看 DSH 那句断言本身

`deepseek-harness-master/tmp/dsh-client-server-summary.md:95` 写的是："**一条 WS 是串行写链，慢流会拖住同一条连接上的其他流**"，列为**代价**。

**核实结果：这是一条正确的、但需要限定层次的陈述，而且它不是"SSE 的缺点"。**

层次要分清：

1. **传输层（真实且不可消除）**：一条 TCP 连接就是一个字节序。丢包、重排、接收窗口（`SO_RCVBUF`）都是**整条连接**的属性。任一时刻，整条连接的吞吐由最慢的接收者决定 —— 这与上层怎么分帧无关。**这在 WebSocket、SSE、HTTP/2 单连接上完全一样**：HTTP/2 只是在此之上加了 per-stream 的流量控制，但 TCP 层的阻塞仍然是全连接共享的。参考 [MDN: Head-of-line blocking](https://developer.mozilla.org/en-US/docs/Glossary/Head_of_line_blocking)（我说它是"参考"而不是"出处"：MDN 是转述，我没在 RFC 里找到一条直接讲这个问题的规范条文，**规范侧标为未确认**）。
2. **应用层（可以消除，取决于实现）**：如果写侧不处理背压、把无限多的帧塞进同一个 `ServerResponse` 的缓冲，那 3a 里那条"**Node.js will buffer all written chunks until maximum memory usage occurs, at which point it will abort unconditionally**"就是真实的失败模式，而且**是全局的** —— 内存涨到崩，所有逻辑流一起死。

### 5b. 一条慢消费者会不会真的拖住其他逻辑流？

**判断：机制上会，但在"回环 + 单用户"下它不是现实风险；它的现实形态是"内存增长"而不是"某个流被卡住"。**

理由，逐条：

- **写侧是单链**：一条 HTTP 响应 = 一个 `ServerResponse` = 一个 `Writable`。所有逻辑流的帧都排进同一个 `writableLength`。**这是定义，不是观察。**
- **回环上没有真正的"慢"**：实测里 `write()` 返回 `false` 到 `'drain'` 到达只差约 1 ms（3a）。回环没有丢包、没有 RTT、没有带宽瓶颈；"慢"只可能来自**对端进程不读**（挂起、崩溃前卡住、被节流）。
- **"卡住"不会表现为某个流单独饿死**：单链意味着帧按序发出。一个消费慢的订阅者**不会造成某个特定逻辑流被跳过**；它造成的是**整条链变慢**。所以正确的说法是"**共享一座独木桥**"，而不是"某个流堵住了另一个流"。
- **真正会区分出来的，是"谁先崩"**：如果某一类帧（比如某个会话的 token 洪流）把 socket 塞满，其他会话的帧就得排在它后面。**这是公平性问题，不是队头阻塞。**

**独立证据 / 反证**：我**没有找到**任何一手来源专门测量"一条 SSE 承载多路复用时的队头阻塞"。搜索到的相关材料只有两类：(a) 一般性的 HOL blocking 概念条目；(b) 一个第三方项目把实时通道多路复用到一条 `EventSource` 上的 PR（[openstory-so/openstory#1114](https://github.com/openstory-so/openstory/pull/1114)），它只证明这种做法有人在生产里用，**不构成对本条断言的证据**。所以：**DSH 的总结是"设计者的自述"，不是独立证据；本节结论的支撑是机制推理 + 本机实测。**

**实测（附录 A 的 `/backpressure`）**：一次写 4 帧（约 16 KiB）后 `write()` 返回 `false`、`writableNeedDrain = true`；`'drain'` 在约 1 ms 后到达，缓冲归零。**回环上背压窗口极短。** 要复现"慢消费者拖住"必须人为制造一个不读的对端 —— 我**没有做**这个实验，所以"慢消费者拖住其他流"这句话在实测层面**标为未确认**。

### 5c. 那么它在回环 + 单用户场景下是不是现实风险？

**不是（现实风险低），但有一条必须承认的残余风险。**

- 单用户、回环、一个桌面窗口：接收端是同一个进程里的渲染器，正常路径下一直在读。**没有现实途径让"某个订阅者读得慢"成为常态。**
- **残余风险是"整体变慢/整体卡住"**：一旦渲染器主线程被长任务占住、或解析器实现有 bug 导致停止消费，这条通道上**所有**会话一起停 —— 而如果是"每会话一条流"，只有那一个会话停。**这是隔离性的损失，不是吞吐量的损失。** 我把这一条列为本题唯一值得写进设计的代价。
- **这不是选型的否决项**：同样的损失在 DSH 自己的"一条 WS"上完全一样（同一个渲染器、同一个 TCP 接收窗口）。

---

## Q6. Electron / Chromium 特殊性

### 6a. `port: 0` ⇒ 每次启动都是新 origin，会改变上面哪些行为？

先确认事实（本仓库代码）：`packages/desktop/main.cjs:67` 用 `port: 0` 启动内嵌服务器，`:214`/`:245` 用 `mainWindow.loadURL(server.url)`。`port: 0` 的含义是"让操作系统分配一个临时端口"（[nodejs.org/api/net.html#serverlisten](https://nodejs.org/api/net.html#serverlisten)）。所以**每次启动的 origin（scheme+host+port）都不同**。

**结论：会让缓存和连接池天然为空，但不会让连接上限或重连行为与普通浏览器不同。**

逐项：

1. **HTTP 缓存按 origin 分区** → 每次启动端口不同 ⇒ 缓存天然是冷的。**这是实现细节**：Chromium 的缓存 key 由 URL 派生（并叠加 `NetworkIsolationKey`），端口是 origin 的一部分。**我没有取到 `http_cache.cc` 里那段拼 key 的代码行来做引用**，所以**标为未确认**（可信，但未取证）。
2. **socket pool 按 origin 分组** → 端口变了就是全新的 group 和全新的池。**有源码依据**：`ClientSocketPool::GroupId` 的键是 `url::SchemeHostPort`（[`client_socket_pool.cc:122-144`](https://raw.githubusercontent.com/chromium/chromium/main/net/socket/client_socket_pool.cc)），`HttpStreamPool` 的 group 键是 `HttpStreamKey`（[`http_stream_pool_group.h:48-70`](https://raw.githubusercontent.com/chromium/chromium/main/net/http/http_stream_pool_group.h)）。**后果**：`server.close()` 之后旧连接不会带着旧端口被复用；重启不会与上一次启动的连接计数叠加。
3. **连接上限**：**不变。** 6 是"per `SchemeHostPort` **within a NetworkContext**"。换端口 = 换 group，但仍然是 6。**per NetworkContext 这一半没有实测**（4a 的边界）。
4. **重连行为**：**不变。** 重连逻辑（Q1）完全在 `blink::EventSource` 里，与 origin 是新的还是旧的无关。`retry:` 是对象属性，也不跨页面存活。
5. **缓存/重连与"新 origin"的唯一实质后果**：**刷新页面 = 新的 `EventSource` 对象 = reconnection time 回到默认 3000 ms**（1b 里测得的重连节奏不跨页面）。如果靠服务端 `retry:` 调过节奏，**刷新就没了**。

### 6b. Electron 特有的网络层行为

**未找到一手出处 / 未确认**，逐条说清：

- **进程拓扑**：Electron 的网络栈跑在独立的 network service 工具进程里（Chromium 架构）；窗口渲染器在另一个进程。**这决定了"一个窗口"与"整个应用"的 per-origin 连接计数关系**。我**没有**取到一手文档；实测只覆盖"一个窗口"。
- **`backgroundThrottling`**：Electron 的 `webPreferences` 默认 **`true`**（官方文档：[BrowserWindow / webPreferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences)）。它会节流**被隐藏窗口**里的定时器。**它是否影响 `EventSource` 的网络读取**：**未确认**。我在实验里显式设了 `backgroundThrottling: false` 并让窗口 `show: false`，重连与计时**照常工作**（Q1 的实测全部在这种窗口里跑出来）—— 但这是"在这个版本、这个配置下没问题"，不是"隐藏窗口不影响"。**这条值得单独证一次**，因为它直接关系到"没人看的标签页上的运行"。
- **`session.setProxy` / 代理**：`ProxyOverride` 与"回环是否绕过代理"我没有找到 Chromium 侧的一手依据。本机注册表里有一条 `ProxyEnable = 0`，所以这次实测**没有经过代理**，也因此**没有覆盖**"开发机上开着代理时回环会不会被代理"这个情形。**标为未确认。**
- **`http://127.0.0.1` 是否被视为 secure context / 是否豁免某些行为**：`127.0.0.1` 是 [potentially trustworthy origin](https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy)（WHATWG/W3C Secure Contexts 规范明确把回环地址算进去），所以**是** secure context。但**"是不是 secure context"与"连接上限/缓存/重连"没有关系** —— 不要把这两件事混起来。**规范保证**只覆盖 secure context 这一半。
- **`webSecurity` / CSP**：与本题无关（实测里 Electron 打了一条 "no Content-Security-Policy" 的安全警告，不影响 `EventSource`）。

---

## 最可能推翻"多路复用 SSE"的那一条

**Q5（单条响应 = 单一串行写链）在"故障隔离"意义上的形态：一个停住不读的消费端会让这条通道上的所有会话一起停，而"每会话一条流"只会停一个。**

为什么是它而不是别的：

- **Q4 的连接上限不是它**：6 连接上限恰恰是多路复用的**动机**。而且"每标签页一条"把上限从"6 个会话"放宽到"6 个标签页"，与最外层用 SSE 还是 WebSocket **无关**（map 自己也这么说）。它不能推翻选型，只能约束选型。
- **Q3 的"关不掉的服务器"不是它**：有明确出口（在 `server.close()` 之前结束每条流，或 `closeAllConnections()`），而且现状就已经在处理这件事。
- **Q5 是唯一一条"换了协议也躲不掉、且与现状相比是净损失"的**：它是单条 TCP 连接 + 应用层串行的性质，WebSocket 同样中招（DSH 自己在 §9 就把它列在 WS 的代价里）。所以它不构成"该改用 WebSocket"的理由，但它**确实**改变了失败半径：从"一个会话静默"变成"整条通道静默"。

**但它不足以推翻选型，理由三条**：

1. **触发条件苛刻**：回环上 `write()→false` 到 `'drain'` 只差约 1 ms（实测），没有丢包、没有带宽竞争。"慢消费者"只能由**对端进程不读**制造，正常路径下不存在。
2. **它换来的东西是验收第 1 条的地基**：没有它就没有"一个标签页同时订阅 N 个会话"。
3. **真正的风险不是"慢"，是"没人处理背压时的无界缓冲"**，而那是**实现责任**，有明确的官方文档警告（Q3a）和明确的检测手段（`write()` 的返回值、`writableLength`、`writableNeedDrain`、`'drain'`）。

**结论：这条不推翻选型，但它把"必须处理背压 + 必须让一条停滞的订阅者不能拖垮整条通道"从'好习惯'提升为'设计约束'。**

---

## 附：与票面引用的现状代码的对照（只描述现状，不作判据）

| 票面引用 | 现状 | 与上面哪条相关 |
|---|---|---|
| `packages/server/src/http/event-stream.ts:63-67` — `response.write(": ping\n\n")`，每 15 s | 注释行心跳 | **Q2：规范保证它零可观察效果。** 它只能防代理超时，不能当 liveness 信号。 |
| `packages/server/src/http/event-stream.ts:100` — `response.write(\`data: ${JSON.stringify(message)}\n\n\`)` | 从不发 `id:`、从不发 `retry:` | **Q1b/Q1c**：客户端永远收不到 `Last-Event-ID`，重连节奏永远是 Chromium 的 3000 ms。 |
| `packages/web/src/client.ts:131` — 只 `addEventListener("message", …)` | 只监听 `message` | **Q2**：命名事件需要自己的监听器；`ping` 这个名字下什么都收不到，因为没有 `data:`。 |
| `packages/web/src/client.ts:158-162` — 靠 `readyState !== CLOSED` 区分"还会重连"与"浏览器放弃了" | 与规范一致 | **Q1a/Q1d**：`readyState` 是唯一可靠的判据，这个用法是对的。 |
| `docs/architecture.md:263` — "一条泄漏的流就是一台关不掉的服务器" | 结论成立、机制描述不准确 | **Q3b** 的核实段。 |
| `docs/architecture.md:248` — claim 比响应多活 2 s，因为浏览器会自己重连 | 与实测吻合 | **Q1b**：Chromium 3 s > 2 s；**Firefox 5 s** —— 如果目标是跨浏览器，2 s 的宽限在 Firefox 下是**不够**的。这是一条可以顺手记下的实数。 |

---

## 附录 A：实验装置与原始数据

### A.1 装置

三份文件，全部**不在** `my-coding-agent` 的源码树里（为了能 `require("electron")`，临时放在了 `packages/desktop/node_modules/.dsh-sse-probe/` 下，**属于依赖目录，不是本仓库源码**，实验结束后应当删除）：

- `serve*.mjs` — `node:http` 测试服务器，把所有请求时刻、`Last-Event-ID` 请求头、`writableHighWaterMark`、背压返回值写进日志。
- `app*.cjs` — Electron 主进程，`new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } })`，`loadURL("http://127.0.0.1:<port>/blank")`。
- `preload*.cjs` — 在渲染器里创建 `EventSource`，把每个事件连同毫秒时间戳经 IPC 送回主进程落盘。
- `close-test*.mjs` — 纯 Node，测 `server.close()` 与一条永不结束的响应的关系。

**关键环境陷阱（会让人以为测试失败）**：本机 `ELECTRON_RUN_AS_NODE=1`。带着它启动 `electron.exe`，Electron 会退化成普通 Node，`require("electron")` 拿到的 `app` 是 `undefined`，报 `TypeError: Cannot read properties of undefined (reading 'commandLine')`。必须先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`（这正是 `packages/desktop/scripts/launch.mjs` 注释里说的那件事）。

### A.2 Q1 原始输出（Electron 44.5.1 / Chromium 152.0.7977.130）

服务端日志（节选，左列是毫秒）：

```
2462 REQ#1 /comment-heartbeat last-event-id=null accept="text/event-stream"
2969 SERVER-END /comment-heartbeat
8880 SERVER-END /normal-eof
11892 REQ#2 /normal-eof last-event-id="42" accept="text/event-stream"
12309 SERVER-END /normal-eof
15493 REQ#1 /normal-eof-noid last-event-id=null accept="text/event-stream"
15721 SERVER-END /normal-eof-noid
18923 REQ#2 /normal-eof-noid last-event-id=null accept="text/event-stream"
22497 REQ#1 /204 last-event-id=null accept="text/event-stream"
30506 REQ#1 /404 ...
38520 REQ#1 /wrong-mime ...
46532 REQ#1 /retry-500 ...
47356 REQ#2 /retry-500 ...      (间隔 ~520 ms，连续 7 次，无退避)
```

渲染器侧：

```
{"name":"comment-heartbeat","events":[{"t":11,"kind":"open"},{"t":11,"kind":"message","data":"{\"real\":true}"},{"t":518,"kind":"error","readyState":0}],"pingCount":0}
{"name":"named-heartbeat","events":[...,{"t":3017,"kind":"ping","data":"{}"},{"t":3017,"kind":"message","data":"plain"},...],"pingCount":1,"msgCount":1}
{"name":"normal-eof","events":[{"t":6026,"open"},{"t":6429,"error","readyState":0},{"t":9440,"open"},...],"errorCount":2,"openCount":3}
{"name":"204","events":[{"t":20045,"kind":"error","readyState":2}],"reconnects":0}
{"name":"404","events":[{"t":28054,"kind":"error","readyState":2}],"reconnects":0}
{"name":"wrong-mime","events":[{"t":36068,"kind":"error","readyState":2}],"reconnects":0}
{"name":"retry-500","events":[... 7 次 open，间隔 510-525 ms ...],"reconnects":6}
CONSOLE: EventSource's response has a MIME type ("text/plain") that is not "text/event-stream". Aborting the connection.
```

### A.3 Q1b 默认间隔与 `retry:` 持久性

```
默认（服务端从不发 retry:）opens = [20, 3219, 6437, 9650]      → 间隔 ≈ 3218 ms
只在第 1 条连接发 retry: 200  opens 间隔 ≈ 410 ms             → 连续 20 次，效果跨重连保持
```

### A.4 Q2 注释行

```
{"kind":"comments-only","seen":[{"t":10008,"kind":"open"},{"t":10918,"kind":"error","state":0}]}
```

三条 `: ping\n\n` 之后 —— 没有 message、没有自定义事件。

### A.5 Q3 写侧

```
HWM {"socketWritableHwm":16384,"resWritableHwm":16384}
BACKPRESSURE falseAt=4 writableLength=16448 writableNeedDrain=true totalFrames=4 bytes=16416
DRAIN#1 at=12006 writableLength=0
WRITE-AFTER-DRAIN returned=true writableLength=25
```

`server.close()` 与永不结束的响应（Node v24.15.0）：

```
40   HOLD-RESPONSE status=200
845  server.close() called
847  CLOSE-REQUEST-DONE
3854 server.closeAllConnections() called
3855 SERVER-CLOSE-CALLBACK
3859 HOLD-SOCKET-CLOSE
```

对照（只有一条 idle keep-alive 连接）：

```
544  CONN total=1
549  server.close() called
552  CLOSE-REQUEST-DONE
3031 TICK openSockets=1        ← close() 之后仍然开着
4556 SERVER-CLOSE-CALLBACK     ← keepAliveTimeout(5000) 到期，socket 自己关掉
4557 CONN-CLOSE total=0
```

### A.6 Q4 连接上限

```
6 条 /hold 全部 OPEN；第 7 条 EventSource：10 秒内一直 CONNECTING，服务端从未收到请求
同时的同源 fetch：同样一直 pending，服务端从未收到请求
释放一条 /hold 之后：fetchSettled = {"at":7124,"txt":"ok"}，第 7 条请求到达服务端
注意：6 条 /hold 里有一条 clientPort 与页面导航那条相同（复用了 keep-alive 连接）
```

### A.7 这次实验**没有**验证的事（不要当成已知）

1. Firefox 的实际行为（只读了源码，没跑）。
2. WebSocket 对照（Chromium 的 kWebSocket 池上限是 255，只来自源码常量）。
3. 多个窗口是否共享同一个 per-origin 连接计数。
4. `backgroundThrottling: true`（默认值）下隐藏窗口里的 `EventSource` 是否照常重连。
5. 真正让对端停止读取，观察"慢消费者拖住其他逻辑流"。
6. 开着 HTTP 代理时，回环请求是否被代理截走。
7. 浏览器对 h2c 的支持状态（见 4b）。
8. 本仓库目标版本 Node `>=22.19` 上的 `server.close()` 记账（实测用的是 v24.15.0）。
9. **Firefox 的默认 5000 ms 只来自源码常量**，没有在本机跑 Firefox 验证；Chromium 侧（3000 ms）有实测。本仓库当前 `RELEASE_GRACE_MS = 2 s` 的宽限在 Firefox 默认节奏下不够 —— 这条推论依赖那个源码常量。
