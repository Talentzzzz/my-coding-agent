# 把一条 WebSocket 当作多路复用通道时，浏览器与 Node 的既有陷阱

研究票：`.scratch/client-server-refactor/issues/17-ws-multiplex-pitfalls.md`
状态：已解决（结论见票的 `## Answer`）

## 这份文档怎么读

**范围**：只回答"把一条 WebSocket 当多路复用通道"这件事上**平台既有**的行为。不写本仓库的改造建议。

**四条证据等级**，每条结论都标了其中之一：

| 标记 | 含义 |
|---|---|
| **规范保证** | RFC 6455 / WHATWG HTML 的规范性条文（normative，含 MUST/SHOULD）。符合规范的实现**必须**这样做。 |
| **官方文档** | Node.js / Electron 官方 API 文档的明说。是这份实现自己的承诺，不是跨实现的标准。 |
| **实现细节** | 从 Chromium / Firefox / `ws` / undici 源码读出的行为，或本仓库机器上跑出来的实测结果。**可以随版本变**，不构成任何保证。 |
| **未确认** | 没找到一手出处，且没有实测。不要拿它当判据。 |

**取证方式**：一手来源为 [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455.html)、[WHATWG HTML §Web sockets](https://html.spec.whatwg.org/multipage/web-sockets.html)、[IANA WebSocket Close Code Number registry](https://www.iana.org/assignments/websocket/websocket.xml)、Chromium（`github.com/chromium/chromium`，`@main`）、Firefox（mozilla-central tip，经 searchfox）、Node.js v22.19.0 官方源码包、`ws@8.22.0`（npm tarball）、Electron 官方文档。

**实测环境**：Windows、Node **v24.15.0**（undici 7.24.4）与 **v22.19.0**（undici 6.21.2，本仓库的引擎下限）、Electron **44.5.1**（Chromium **152.0.7977.130**，Node 24.21.0）、`ws@8.22.0`。凡依赖 Node 内部记账的结论都标了"测的是哪个版本"。

**一处方法说明**：票 02 的实测装置与脚本没有留在树里；本票的装置**留在**了 `.scratch/client-server-refactor/prototype/ws/`（见[附录 A](#附录-a实验装置与原始数据)），每条实测都能照着复跑。

---

## Q1. 没有自动重连：断开时的可观测信号

### 1a. 规范性确认：WebSocket 规范里根本没有"重连"这个词

**结论：没有。** WHATWG HTML 的 WebSocket 一节里，`reconnect`、`re-connect`、`reestablish`、`re-establish`、`reopen`、`re-open` 六个词的出现次数**全是 0**（对整份 `multipage/web-sockets.html` 做子串计数）。`WebSocket` 接口的成员只有构造器 `new WebSocket(url, protocols)`、`send()`、`close()` 与几个只读属性——**没有任何"重新建立"的入口**。

对照 `EventSource`：同一份规范在那一节里明写了 "reestablish the connection" 的三步算法（票 02 Q1）。**WebSocket 那节一个字都没有**。这就是"浏览器不会自动重连"的规范依据：不是"规范允许但不要求"，而是**规范没有这个机制**。**规范保证**（以"缺席"的形式）。

**Chromium 侧的对应事实**：Blink 的 `DOMWebSocket` 在连接结束后只做状态迁移与事件派发，没有重连分支；唯一的失败路径是 `WebSocketChannelImpl::TearDownFailedConnection()`（`third_party/blink/renderer/modules/websockets/websocket_channel_impl.cc:1001-1010`）：

```cpp
void WebSocketChannelImpl::TearDownFailedConnection() {
  if (GetState() == State::kDisconnected) {
    return;
  }
  client_->DidError();
  if (GetState() == State::kDisconnected) {
    return;
  }
  HandleDidClose(false, kCloseEventCodeAbnormalClosure, String());
}
```

**实测**（[附录 A](#附录-a实验装置与原始数据) 的 `close-codes` 场景）：一整轮 22 条连接、约 45 秒里，服务端的 `upgradeAttempts` **恰好等于我们主动开的连接数**（22），没有任何一次补连。**实现细节**。

### 1b. `close` 事件的 code / reason 取值表（实测，Chromium 152 / Electron 44.5.1）

装置：一个手写 RFC6455 的探针服务器（不依赖 `ws`），页面逐条连接、逐条记录事件。

| 服务端做了什么 | 页面上的事件序列 | `CloseEvent.code` | `reason` | `wasClean` |
|---|---|---|---|---|
| 发 `Close(1000, "bye")` | `open` → `close` | **1000** | `"bye"` | **true** |
| 发 `Close(1013, "try again later")` | `open` → `close` | **1013** | `"try again later"` | **true** |
| 发 `Close(1001, "going away")` | `open` → `close` | **1001** | 原样 | true |
| 发 `Close(4000, "reconnect requested")` | `open` → `close` | **4000** | 原样 | true |
| `socket.destroy()`（不发 Close 帧） | `open` → `close` | **1006** | `""` | **false** |
| 连不上（ECONNREFUSED） | `error` → `close` | 1006 | `""` | false |
| 握手被 HTTP 404 / 200-无-Upgrade 拒 | `error` → `close` | 1006 | `""` | false |
| 协议违规（非法 opcode / RSV1 / 非法 UTF-8 / 非法 close code） | `open` → `error` → `close` | 1006 | `""` | false |

**四条要点**：

1. **服务端发什么码，浏览器就报什么码**，`reason` 原样透传，`wasClean = true`（`1013`、`4000` 都在此列 —— 见 1f）。**实现细节**（且与 RFC 的 Close 帧格式一致：`5.5.1` 规定 body 前两字节是状态码、其后是 UTF-8 reason）。
2. **TCP 掉了、没收到 Close 帧 ⇒ 1006 + 空 reason + `wasClean=false`**，而且**没有 `error` 事件**。RFC 6455 §7.4.1 明说 `1006` "MUST NOT be set as a status code in a Close control frame by an endpoint"，它只用于**上报**异常关闭。
3. **`wasClean` 的判据**（Chromium，`dom_websocket.cc:712-732`）：`state == kClosing && all_data_has_been_consumed && closing_handshake_completion == kCloseHandshakeComplete && code != 1006`。四个条件与上面的表逐条吻合。
4. **服务端 initiate 时，浏览器的回应 Close 帧把 code 与 reason 一起抄回去**（不只是码）：探针服务器日志里，收到的是 `{"code":1000,"reason":"bye"}`、`{"code":1013,"reason":"try again later"}`。RFC §5.5.1 只说 "typically echos the status code"，**reason 也被抄回去是实现行为**。**实现细节**。

### 1c. `error` 事件什么时候 fire

**规范保证**（WHATWG，socket 关闭时的任务）：

> When the WebSocket connection is closed, possibly cleanly, the user agent must queue a task to run the following substeps: Change the ready state to CLOSED (3). **If the user agent was required to fail the WebSocket connection, or if the WebSocket connection was closed after being flagged as full, fire an event named `error`** at the WebSocket object. Fire an event named `close` at the WebSocket object, using `CloseEvent`, with the `wasClean` attribute initialized to true if the connection closed cleanly and false otherwise, …

即 `error` **只**在两个条件下 fire：**UA 必须 fail 这条连接**（握手失败、协议违规、被拒绝），或**写缓冲被标记为满**（`bufferedAmount` 撑爆，票 11 关心的是这一条）。**普通的 TCP 掉线不属于这两类，所以不 fire `error`。**

**实测与规范逐条吻合**（上表）：握手失败与协议违规**有** `error`；干净的 Close 与"TCP 悄悄断掉"**没有** `error`。**一处要收窄的**：第二个条件（"写缓冲被标记为满"）本票**没有造出来**——上面的实测只覆盖了第一个条件与"两者都不成立"的情形，所以那句"逐条吻合"只对**测到的那几类**成立；"缓冲满会不会 fire `error`"在本票里只有规范条文，**未确认清单**照旧收录。

**`error` 与 `close` 的顺序**：Chromium 在 `TearDownFailedConnection()` 里**无条件先 `DidError()` 再 `HandleDidClose(false, 1006, "")`**（上面引的源码），所以失败路径上一定是 `error` 先、`close` 后，且 `close` 的 code 恒为 1006。**实现细节**。

**这件事的实际后果**：`error` **不是**"连接断了"的可靠信号（掉线不 fire 它），`close` **才是**；而 `error` 是"这条连接被判定为坏"的信号。两者的交集才是"坏连接"。

### 1d. `readyState` 的可用判据

| 时刻 | `readyState`（实测） |
|---|---|
| `new WebSocket(...)` 之后 | `0` CONNECTING |
| `open` 事件里 | `1` OPEN |
| **调用 `close()` 的同一 tick** | **`2` CLOSING** |
| `close` 事件里 / 之后 | `3` CLOSED |

`close` 事件一定在 `readyState` 变成 3 之后派发（WHATWG 的算法第一步就是 "Change the ready state to CLOSED (3)"）。**所以"`readyState === CLOSED`"永远是"这条 socket 已经完了"的可靠判据**，而"`readyState !== CLOSED`"**不能**推出"还活着"（CLOSING 也是非 CLOSED）。**规范保证 + 实测**。

### 1e. 客户端自己的 `close(code, reason)`：合法取值与抛错

**规范保证**（WHATWG，`close()` 的步骤）：

> If code is present, but is neither an integer equal to 1000 nor an integer in the range 3000 to 4999, inclusive, throw an "InvalidAccessError" DOMException. If reason is present, then run these substeps: Let reasonBytes be the result of encoding reason. If reasonBytes is longer than 123 bytes, then throw a "SyntaxError" DOMException.

**实测（Chromium 152）逐条吻合**：

| `close(code)` | 结果 |
|---|---|
| `1000` / `3000` / `4000` / `4999` | 成功；`readyState` 立刻变 2；对端收到该 code **与该 reason** |
| `999` / `1001` / `1234` / `2999` / `5000` / `1005` / `1006` / `1015` | 抛 `InvalidAccessError`，消息原文：`Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. N is neither.` |
| `close(1000, "x".repeat(124))` | 抛 `SyntaxError`：`… The close reason must not be greater than 123 UTF-8 bytes.` |
| `close(1000, "中".repeat(41))`（=123 字节） | 成功 |
| `close(1000, "中".repeat(42))`（=126 字节） | 抛 `SyntaxError` |
| 抛错之后再 `close()`（无参） | 发一个**空 payload 的 Close 帧**：本端 `CloseEvent.code = 1005`，对端看到的也是"没有状态码"（`ws` 报 1005，裸解析时 payload 长度 0） |

**三点要注意**：

- **123 是字节数**，不是字符数（`中`=3 字节）。Chromium 的实现用 `StringUtf8Adaptor` 现算（`websocket_common.cc:231-263`，常量 `kMaxReasonSizeInBytes = 123` 在 `:34`）。
- **抛错时 socket 毫发无伤**：`readyState` 仍是 1，连接照旧可用。所以"关不掉"这种 bug 会表现为异常被吞掉、连接继续开着。
- **`close()` 不给 code 时，浏览器发的是空 Close 帧**（对端按 1005 处理），**不是 1000**。这与 `ws` 一致（见 Q4/附录 B），也与 `WebSocket#close()` 的 IDL 默认值"无"一致。

### 1f. 票 07 的 `4000` 与票 11 的 `1013` 两端对齐吗

**结论：都对齐，而且互不混淆——它们是两个方向的同一个码表。**

| 方向 | 谁发 | 码 | 对端实测看到 |
|---|---|---|---|
| 客户端判死自己关（票 07） | 浏览器 | `4000` + `"reconnect requested"` | 服务端（裸解析与 `ws` 两种实现）**都收到 `code 4000` + 那个 reason** |
| 服务端停滞超限关连接（票 11） | 服务端 | `1013` + 一句英文 reason | 浏览器 `CloseEvent` **拿到 `1013` 与原样 reason，`wasClean = true`** |

- **`4000` 在客户端合法**：它在 3000–4999 里（WHATWG 与 Chromium 都放行，见 1e）。
- **`1013` 在服务端合法，在浏览器侧也合法且可见**：RFC 6455 §7.4.1 **没有定义 1013**（它只定义到 1011 与 1015）；`1013 "Try Again Later"` 来自 **IANA 的 WebSocket Close Code Number registry**（`<value>1013</value><description>Try Again Later</description>`，注册日期 2016-10-10）。**它不是保留值**（保留的是 1005/1006/1015），所以两端都不拒。
- **`ws` 也不拒**：`lib/validation.js:30-46` 的 `isValidStatusCode` 接受 `1000..1014` 去掉 1004/1005/1006，外加 3000–4999；`1013` 落在其中（`ws@8.22.0` 源码实证）。
- **两个码不会在日志里混淆**：`4000` 只可能由**客户端**发出（服务端 `ws` 自己在服务端侧发 4000 也合法，但本仓库两侧不是这么用的），`1013` 只由服务端发出；而且浏览器上报的 `CloseEvent.code` 与 `ws` 的 `'close'(code, reason)` **都原样保留发送方的取值**，不重写。

> **一处需要一起写下来的**：`4000`/`4999` 这个区间**规范上属于"库/框架/应用自定义"**（RFC §7.4.2：3000-3999 保留给库与框架、4000-4999 保留给私有使用）。`1013` 则是协议定义码。两者的语义差异是"谁定义的"，不是"能不能用"。

---

## Q2. 心跳与判活

### 2a. 规范义务：收到 Ping **必须**回 Pong；"尽快"只是 SHOULD

**规范保证**，RFC 6455 §5.5.2 原文：

> Upon receipt of a Ping frame, an endpoint **MUST send a Pong frame in response**, unless it already received a Close frame. It **SHOULD** respond with Pong frame **as soon as is practical**.

以及 §5.5.3：

> A Pong frame sent in response to a Ping frame must have **identical "Application data"** as found in the message body of the Ping frame being replied to.
>
> If an endpoint receives a Ping frame and has not yet sent Pong frame(s) in response to previous Ping frame(s), the endpoint **MAY elect to send a Pong frame for only the most recently processed Ping frame**.

**所以"自动回 pong"是规范要求（MUST），不是浏览器的好心**；但**时机只有 SHOULD**，而且**规范明确允许合并多个 ping 只回最后一个 pong**。这两点合起来是票 07 那套 `MAX_MISSED_HEARTBEATS` 参数的天花板：**ping 发得比 pong 回得快时，丢 pong 是规范允许的行为**，容忍次数不能设成 1。

§5.5.1 还钉死了关闭握手的一半：收到 Close 且自己没发过 Close ⇒ **MUST** 回一个 Close 帧（"typically echos the status code"），且"After both sending and receiving a Close message… **The server MUST close the underlying TCP connection immediately**；the client SHOULD wait for the server to close"。

> **这条是本票装置踩到的第一个坑**：探针服务器最初在"自己已经发过 Close"之后又回了一个 Close 帧，浏览器立刻把整条连接报成 `1006/"", wasClean=false`（外加一个 `error`）。改成一端只发一次 Close 帧之后，同一个场景报 `1000/"bye", wasClean=true`。**"多发一个 Close 帧"不是无害的**——它把一次干净关闭变成一次异常关闭，并且**悄悄毁掉了 code/reason 的可观测性**。

### 2b. 浏览器侧：pong 由网络栈自动回，JS 完全不可见

**结论：pong 对 JS 完全不可见，不是"实现行为"，是结构上没有通道。**

- **自动回 Pong 的位置是网络栈**，不是页面 JS、也不是渲染进程。Chromium 在 `net/websockets/websocket_channel.cc:766-780`：

```cpp
    case WebSocketFrameHeader::kOpCodePing:
      DVLOG(1) << "Got Ping of size " << payload.size();
      if (state_ == CONNECTED) {
        auto buffer = base::MakeRefCounted<VectorIOBuffer>(
            std::vector<uint8_t>(payload.begin(), payload.end()));
        return SendFrameInternal(true, WebSocketFrameHeader::kOpCodePong,
                                 std::move(buffer), payload.size());
      }
```

  **同址的下一支是 Pong 的处理**：`// There is no need to do anything with pong messages.`。Firefox 同构（`netwerk/protocol/websocket/WebSocketChannel.cpp:1825-1831` → `GeneratePong(payload, payloadLength)`，`GeneratePong` 在 `:1999-2010` 原样 `memcpy` 回显）。**实现细节**。
- **JS 面没有任何 ping/pong 事件或属性**：Blink 的 `websocket.idl:59-72` 只有 `onopen/onerror/onclose/onmessage` 与 `url/readyState/bufferedAmount/extensions/protocol/binaryType`；Firefox 的 `dom/webidl/WebSocket.webidl` 检索 `ping|pong` **0 命中**。**决定性的负面证据是 Mojo 契约的注释**（`services/network/public/mojom/websocket.mojom:88-124`）：

```mojom
interface WebSocketClient {
  // Receive a non-control frame from the remote server.
  ...
  OnDropChannel(bool was_clean, uint16 code, string reason);
```

  **控制帧根本不上报到渲染进程**——不是"没暴露 API"，是"这条信息没有过河"。**实现细节**。
- **实测**：探针服务器每 200 ms 给页面发一个 Ping（带 payload），**123 个 ping 全部在 0–1 ms 内收到 pong**，payload 原样回抄；同一页面用 `'ping' in ws`、`'pong' in ws`、`'onping' in ws`、`'onpong' in ws`、`'socket' in ws` 全部为 `false`。**实现细节**。

> **对票 07 第 3 条的判定：成立，而且比"未确认"更硬。** "浏览器是否真的对每条 ping 都尽快回 pong"——**实测 123/123，RTT 0–1 ms，包括窗口被节流的那 20 秒（见 2d）**。规范给的是 MUST + SHOULD，实现给的是"立即"。

### 2c. `ws` 的 `ping()` / `'pong'`：Node 22.19 上的行为与语义

源码实证全部来自 `ws@8.22.0`（本地解包副本，见附录 A）。**这一节与"手写 RFC6455 时的规范义务"分开陈述**：前者是 `ws` 的实现细节，后者见 2a。

| 事实 | 结论 | 出处 |
|---|---|---|
| `socket.ping([data], [mask], [cb])` 发什么 | opcode `0x09`、`FIN=1`、`RSV1=0`（**永不压缩**）、payload ≤ **125** 字节，超出抛 `RangeError` | `lib/sender.js:255-268`、`lib/websocket.js:380-402` |
| `readyState` 要求 | `OPEN` 才发；`CONNECTING` **同步抛错**；`CLOSING`/`CLOSED` **静默不发帧**、只把长度记进 `bufferedAmount`、下一 tick 用 `Error` 调 `cb` | `lib/websocket.js:380-402`、`:1152-1173` |
| `'pong'` 事件 | 由 `Receiver` 在 `controlMessage()` 里按 `_opcode === 0x09 ? 'ping' : 'pong'` 分发，监听器**只收到一个 `Buffer` 参数**（payload） | `lib/receiver.js:703-713`、`lib/websocket.js:1269-1277` |
| 收到 Ping 自动回 Pong | `_autoPong` 默认 **true**（客户端与服务端都是），**先发 PONG 再 emit `'ping'`**，payload 原样回显 | `lib/websocket.js:1256-1267`、`lib/websocket.js:683/705`、`lib/websocket-server.js:71/398` |
| `terminate()` | 立即 `socket.destroy()`，不发 Close 帧、不等对端；本端 `_closeCode` 停在 1006 | `lib/websocket.js:500-517` |
| `close()` | 走关闭握手，**等对端的 Close 帧**（或等 `_closeTimeout`，默认 **30000 ms** 才 destroy）；`code` 省略时发**空** Close 帧（不是 1000） | `lib/websocket.js:295-353`、`lib/sender.js:184-211`、`lib/constants.js:10` |
| `close(code)` 的校验 | `isValidStatusCode`：`1000..1014` 去掉 1004/1005/1006，外加 3000–4999；非法码抛 `TypeError`，reason >123 字节抛 `RangeError` | `lib/validation.js:30-46`、`lib/sender.js:184-211` |
| `isAlive` | **`ws` 没有这个属性**；README 的心跳示例里是用户自己挂的 | 全包 grep `isAlive` 0 命中 |

**实测（Node 22.19.0 与 24.15.0，都用 `ws@8.22.0`）**：

- 服务端 `/pings` 命令给页面发 ping → 服务端收到 pong，`rttMs` 0–1。
- 浏览器 `close(4000, "reason-4000")` → `ws` 的 `'close'` 事件收到 `code=4000, reason="reason-4000"`。
- `ws` 服务端 `close(1013, "try again later")` → 浏览器 `CloseEvent` 报 `1013/"try again later"/true`。
- `ws` 服务端 `close(1000, "bye")` → 同上，原样。

**结论：`ws` 的 ping/pong 与浏览器侧的语义完全对齐**（都是协议层、都不进应用层、都自动回、都带 payload 回显），差别只在"`ws` 把 pong 交给了应用（`'pong'` 事件），浏览器不给"。

### 2d. `backgroundThrottling` 与隐藏窗口：WS 投递**不**被节流，定时器**被**节流

这是本票最要紧的一条实测，装置是同一个页面跑两遍（只差 `webPreferences.backgroundThrottling`），服务端每 200 ms 发一帧应用层 text、每 200 ms 发一个 Ping；页面记录每秒的"收到的帧 / `setInterval(100)` 的 tick 数 / `requestAnimationFrame` 的 tick 数"，并订阅 `visibilitychange`。主进程在跑的过程中 `hide()` → `minimize()` → `restore()`。

| 指标（全程 25 秒） | `backgroundThrottling: true`（**默认**） | `backgroundThrottling: false` |
|---|---|---|
| **WS 应用层帧到达数**（服务端发 5 帧/秒） | **123** | **123** |
| **帧到达间隔 min / 中位 / max** | 199 / 202 / **216 ms** | 200 / 203 / 215 ms |
| 每秒帧数（逐秒） | 5,5,5,5,4,5,5,…（恒定） | 5,5,5,5,5,5,5,…（恒定） |
| `setInterval(100)` 的 tick 数 | **46**（≈ **1/秒**，可见的那两秒是 9/秒） | **250**（≈ 10/秒） |
| `requestAnimationFrame` tick 数 | **422** | **5443** |
| **服务端 Ping 的 pong 回收** | **123/123**，RTT 0–1 ms，间隔 199–216 ms | 123/123，RTT 0–1 ms，间隔 200–215 ms |
| `document.visibilityState` | `hidden`（整段） | `visible`（整段，无变化） |

**读法**：

1. **WS 的数据投递完全没有被节流。** 两种配置下到达数、节奏、最大间隔**逐项相同**（差 1 ms 以内）。票 11 最坏情况里那条"隐藏窗口是否会让渲染器停止消费 WebSocket 数据"的答案就是这条：**不会，至少不会因为 `backgroundThrottling` 而停**。
2. **定时器被节流到 1 Hz**（10 倍）。所以这个开关是**真的在工作**的，上面第 1 条不是"整个开关没生效"的假阴性。
3. **pong 的回收不受影响**：123 个 ping 全部在 0–1 ms 内应答。因为 pong 由**网络栈**回（2b），不经过渲染器的定时器与任务队列。
4. **`document.visibilityState` 被这个开关本身改写**：`false` 时它**恒为 `visible`**，即使窗口被 `hide()`/`minimize()`。官方文档明说这一点（见下），所以**它不能当"我是否被节流"的判据**。

**源码侧的机制**（这是上面第 1、2 条差异的出处）：Blink 把任务按 `TaskType` 分到不同的队列 trait（`frame_scheduler_impl.cc:487-558`）：

```cpp
    case TaskType::kJavascriptTimerDelayedLowNesting:
      return ThrottleableTaskQueueTraits();
    ...
    // Throttling following tasks may break existing web pages, so tentatively
    // these are unthrottled.
    // TODO(nhiroki): Throttle them again after we're convinced that it's safe
    // or provide a mechanism that web pages can opt-out it if throttling is not
    // desirable.
    case TaskType::kDOMManipulation:
    ...
    case TaskType::kWebSocket:      // ← 第 539 行
    ...
      return DeferrableTaskQueueTraits();   // ← 第 558 行
```

**WebSocket 的投递任务属于 `Deferrable`（"暂不节流"），JS 定时器属于 `Throttleable`**。**实现细节**，但它解释了实测，而且与"`document.hidden` 在 Blink 的 WebSocket 代码里 0 命中"一致。

**官方文档**（`webPreferences.backgroundThrottling`，逐字）：

> Whether to throttle **animations and timers** when the page becomes background. This also affects the Page Visibility API. When at least one webContents displayed in a single browserWindow has disabled `backgroundThrottling` then frames will be drawn and swapped for the whole window… **Defaults to `true`.**

以及 `browser-window` 的 Page Visibility 一段：

> If `backgroundThrottling` is disabled, the visibility state will remain visible even if the window is minimized, occluded, or hidden.

**文档对网络（乃至 WebSocket）是否被节流：一个字都没有。** 这一句很重要：官方文档的沉默**不等于**"不受影响"——本票的实测才是判据（Chromium 152 上是"不受影响"）。

**两个必须一起说的边界**：

- 这个装置里窗口是**真隐藏**的（`win.hide()` + `win.minimize()`），而且 `visibilityState` 在默认配置下**整段就是 `hidden`**。所以测到的不是"可见但有遮挡"。
- **渲染器进程被完全冻结（Page Lifecycle 的 `freeze`）不在本实验覆盖范围内。** Blink 对 `FrameLifecycleState::kFrozen` 的处理是**主动断连**（`dom_websocket.cc:602-627`：`channel_->Fail("Page entered Back-Forward Cache.")`，且要 `DisconnectWebSocketOnBFCache` 特性开启），**不是延迟投递**。这个分支在本实验里没有触发（没有进 BFCache）。**未确认**：Electron 桌面窗口在什么条件下会让渲染器进入 `kFrozen`。

### 2e. 把票 07 / 票 11 依赖的那几个数字复核一遍

| 票 | 依赖 | 本票给出的事实 | 判定 |
|---|---|---|---|
| 07 | "浏览器没有可观察的协议层信号"（据此新增应用层心跳） | 成立：pong 不可见（IDL/Mojo 无通道，实测 API 面为 0），`WebSocket` 没有 ping 超时，空闲连接上本来没有帧 | **成立** |
| 07 | 服务端 `MAX_MISSED_HEARTBEATS = 2`（容忍 2 次、第三次 `terminate()`）会不会误杀 | 浏览器每 ping 都回 pong（123/123，0–1 ms）；但 RFC 只承诺 MUST + SHOULD，且 §5.5.3 **明确允许合并 pong** | **参数站得住**（容忍 2 次给的是规范允许的合并留了余量）；**但"合并 pong"是规范允许的**，所以容忍次数不能降到 1 |
| 07 | 客户端 watchdog 15000 ms = 3× 心跳间隔 | 隐藏窗口下**应用层帧照样按节奏到**（123/123，最大间隔 216 ms），watchdog 不受 `backgroundThrottling` 影响（它读的是帧，不是定时器精度）；**渲染器自身的定时器会被节流到 1 Hz**，所以 watchdog 的"到点"最多晚约 1 秒 | **成立**；1 s 的抖动相对 15 s 余量可忽略 |
| 11 | `服务端停滞上限 (10 s) < 客户端 watchdog (15 s)` | **不需要改，而且现在两边都更安全了**：隐藏窗口既不会停止消费 WS 数据，也不会延迟 pong；被节流的只有页面自己的定时器（1 Hz），而 watchdog 的输入是帧 | **不等式成立** |
| 11 | "存在一个能表达'这次写没有立刻出去'的信号" | 有两个：`ws.send()` 的**回调被推迟**（实测：400 MiB 缓冲期间 **0/25604** 个回调），以及 `bufferedAmount` / `socket.writableLength` 增长 | **成立**（细节见 Q4c；"持续停滞"那半条本票未证明） |
| 11 | "手写时的规范要求"里 pong 不受应用层背压影响 | RFC §5.5.2 的 MUST 没有例外条款；浏览器把 pong 放在网络栈（2b） | **成立** |
| 15 | 冒烟"支点是服务端一直在说话、客户端仍判它死" | 与 pong 可见性无关（pong 不可见 + 帧确实一直在到） | **支点成立** |

---

## Q3. 连接上限

### 3a. Chromium：255 是**每 group**，但池是**共享的**——而共享的那个才是先撞上的

**源码侧（`net/socket/client_socket_pool_manager.cc`，`@main`）**：

```cpp
// The soft limit for active sockets per pool for this network process. …
std::array<size_t, kSocketPoolTypesSize> g_socket_soft_cap_per_pool =
    std::to_array<size_t>({
        256,  // kNormal
        256   // kWebSocket
    });
...
// WebSocket connections are long-lived, and should be treated differently
// than normal other connections. Use a limit of 255, so the limit for wss will
// be the same as the limit for ws. Also note that Firefox uses a limit of 200.
// See http://crbug.com/486800
std::array<size_t, kSocketPoolTypesSize> g_max_sockets_per_group =
    std::to_array<size_t>({
        6,   // kNormal
        255  // kWebSocket
    });
```

- **每 group 255**（group 的键是 `url::SchemeHostPort`，即 scheme+host+port）；
- **每 pool 软上限 256**（pool 的最小单位是"一个 NetworkContext 里的一条 proxy chain"）；直连时 `client_socket_pool_manager_impl.cc` 把 `sockets_per_proxy_chain = socket_soft_cap_per_pool(pool_type_)`、`sockets_per_group = max_sockets_per_group(pool_type_)`。
- **直连的 WebSocket 走的是一条专用池**（`WebSocketTransportClientSocketPool`，`client_socket_pool_manager_impl.cc:80-94`），而它的容量判据是**池级**的 `Expandability() == SocketPoolExpandability::kCapped`（`websocket_transport_client_socket_pool.cc:90-107`），**不看 group**：

```cpp
  if (Expandability() == SocketPoolExpandability::kCapped &&
      respect_limits == ClientSocketPool::RespectLimits::ENABLED) {
    request_net_log.AddEvent(NetLogEventType::SOCKET_POOL_STALLED_MAX_SOCKETS);
    stalled_request_queue_.emplace_back(...);
    ...
    return ERR_IO_PENDING;
  }
```

- **新池（`HttpStreamPool`）另有一套常量，且没有体现 255**：`http_stream_pool.h:94-100` 的 `kDefaultMaxStreamSocketsPerGroup = 6` / `kDefaultMaxStreamSocketsPerPool = 256`，注释说"与 ClientSocketPoolManager 相同"，但该头文件里 **0 处提到 WebSocket**。
- **还有两条会移动这个数字的机制**：`g_max_sockets_per_proxy_chain = {128, 128}`，以及 2025 年新增的 `SocketPoolAdditionalCapacity`（`net/socket/socket_pool_additional_capacity.cc`）——它由特性 `kTcpSocketPoolLimitRandomization` 控制，**给软上限叠加一份带噪声的额外容量**。**所以"255"这个数字在源码层面本身就不是一个不动的常量。**

**实测（Electron 44.5.1 / Chromium 152，两轮）**：

| 轮次 | 做法 | 结果 |
|---|---|---|
| 1 | 只对一个 origin 连 | 第 **1–255** 条全部 `open`；第 **256**、**257** 条**立刻 `error`**（`onerror` 与 `onclose` 同一毫秒，`readyState` 变 3，`CloseEvent.code = 1006/wasClean=false`），服务端**从来没看到它们的 upgrade** |
| 2 | 先对 origin B 连 1 条（控制组，成功），再把 origin A 打满 | A 停在 **254**（254 + B 的 1 = **255**）；此时**再连一条 B：`error`** |
| 2 续 | 在 A 上 `close()` 掉 5 条，再连 B | B 恰好补上 **5** 条 → **249 + 1 + 5 = 255** |

**结论（实现细节，实测两轮一致）**：

1. **同一个 origin 恰好 255 条**（源码常量 255 得到实测确认）。
2. **不同 origin 共享这份额度**：总量停在 **255**，与新 origin 无关。这一条**推翻了"上限是每 origin、所以不同 origin 可以各自 255"的读法**——它其实是**一个 WebSocket 池的总容量**。**作用域要说准**：本实验的两个 origin 是同一个 `BrowserWindow`（同一个 NetworkContext）里的两个端口，所以这条**只证明"同一窗口内跨 origin 共享"，不涉及窗口之间**——窗口/`session` 是否共享是另一格，见 3d 与未确认清单第 3、4 条。
3. **撞上限是"失败"，不是"排队"**：新连接**立刻** `error` + `close(1006, "", wasClean=false)`，服务端连 upgrade 都收不到。这一点与票 02 查到的 `EventSource` 行为**相反**（`EventSource` 撞 6 连接上限时是**无限 `CONNECTING`**）。
4. **measured 255 vs 源码 256 差 1**：源码的池软上限写的是 256，实测总容量是 255。**未解释**——候选解释是 `SocketPoolAdditionalCapacity` 的随机化、或 `Expandability()` 的判定是"用到 cap-1 就转 `kCapped`"；我没有读到能定案的那一行源码，所以**照实测写 255、照源码写 256，并把这个差记成未解释**。

### 3b. HTTP 池与 WebSocket 池**分开**：255 条 WS 饿不死普通请求

**源码**：`HttpNetworkSession` 持有两个独立的 `ClientSocketPoolManagerImpl`（`SocketPoolType::kNormal` 与 `kWebSocket`，`http_network_session.cc:197-209`），各自持自己的 `socket_soft_cap_`（各 256）与 `max_sockets_per_group`（6 / 255），**名额不共享**。

**实测**（255 条 WS 占满时，对**同一个 origin** 发 3 次 `fetch()`）：

```
attempt 1: status-200, 28 ms
attempt 2: status-200,  3 ms
attempt 3: status-200,  2 ms
```

**结论**：WS 池打满**完全不饿死**普通 HTTP 请求。这与票 02 查到的 SSE 情形（6 条 `EventSource` 把同源 `fetch` 一起饿死）形成鲜明对照：**换成 WebSocket 之后，"一条通道占一个 socket"的压力从 6 挪到 255，而且 HTTP 与 WS 不再抢同一个名额**。**实现细节 + 源码实证**。

### 3c. Firefox：默认 **200**，而且是**进程级全局**，超限同样是失败

**源码实证**（mozilla-central tip，行号取自 searchfox 渲染页）：

- 默认值在 `modules/libpref/init/all.js:1324-1327`（**不在** `StaticPrefList.yaml`）：

```js
// the maximum number of concurrent websocket sessions. By specification there
// is never more than one handshake oustanding to an individual host at
// one time.
pref("network.websocket.max-connections", 200);
```

- 读取并夹取在 `netwerk/protocol/websocket/WebSocketChannel.cpp:3530-3533`：`mMaxConcurrentConnections = std::clamp(intpref, 1, 0xffff);` —— **设成 0 会被夹到 1，不是"禁用"**；构造里的兜底默认值在 `:1202`（`mMaxConcurrentConnections(200)`）。
- 强制点在 `WebSocketChannel::AsyncOpenNative()`（`:3536-3550`），**超限立刻失败、不排队**，注释就是判据：

```cpp
    // WebSocket connections are expected to be long lived, so return
    // an error here instead of queueing
    return NS_ERROR_SOCKET_CREATE_FAILED;
```

- **计数是进程级全局，不是 per origin**：`nsWSAdmissionManager` 是静态单例，里面只有**一个** `Atomic<int32_t> mSessionCount`（`:582-585`、`:598-599`），`IncrementSessionCount/DecrementSessionCount/GetSessionCount` 三个操作**都不带 key**（`:482-504`）。（同一份文件里"同一 host 同一时刻只允许一个握手"那条 RFC §4.1 规则走的是 `mQueue`，**按 address + originSuffix 键**，`:545-563` —— 两套机制，别混。）
- **JS 侧看到的是** `error` + `close{code: 1006, wasClean: false}`：`dom/websocket/WebSocket.cpp:869-890` 把失败的 `aStatusCode` 变成 `mFailed = true`，`:1997-2005` 先派 `error` 再派 `close`，`mCloseEventCode` 初值就是 `CLOSE_ABNORMAL = 1006`（`:141`，`nsIWebSocketChannel.idl:187`）。

**实测：没有。** 本机没有安装 Firefox（`firefox.exe` 不存在），所以这一节**全部是源码实证，没有跑过**。按票 02 的惯例，**Firefox 的 200 与"进程级全局"在实际浏览器里标为未实测**。

### 3d. 与票 16 的关系（只报事实）

- **"每 origin 一条常驻 WS + 普通命令请求在回环上"**：实测成立且宽裕——255 条 WS 之下，同源 HTTP 仍在 30 ms 内答出（3b）。
- **"多个标签页是否共享同一个额度"**：**实测只覆盖了一个窗口/一个 NetworkContext**。源码结构说是"每 NetworkContext 一条池"，但**没有实测两个窗口**。**未确认**。
- **"两个不同的 Electron session/partition"**：源码上是两个 NetworkContext（两条池），**未实测**。**未确认**。
- **HTTP 池的那条 6/256 上限**：本票没有重测（票 02 已测 `EventSource` 那条；WS 与它分池，所以那条不再是 WS 通道的压力来源）。

---

## Q4. 服务端生命周期与写侧

### 4a. `server.close()` 对 upgrade 之后的 socket：**它进不了 `'close'` 回调**

**源码实证（Node v22.19.0 官方源码包，行号为该版本原文）**：

- `net.Server.prototype.close` 最后调 `_emitCloseIfDrained()`，而它**只要还有连接就不发 `'close'`**（`lib/net.js:2401-2408`）：

```js
Server.prototype._emitCloseIfDrained = function() {
  debug('SERVER _emitCloseIfDrained');

  if (this._handle || this._connections) {
    ...
    return;
  }
```

- `_connections` 在**每条被接受的 socket** 上加一（`lib/net.js:2299`），在 `Socket.prototype._destroy` 里减一（`lib/net.js:853-859`）——**这条记账不认识"升级"这件事**，一个 upgrade 之后的 socket 照旧算一条连接。**这就是"关不掉的服务器"换了形态回来的机制本体。**

**实测（Node v22.19.0 与 v24.15.0，两条路线各一遍）**：

| 做法 | `server.close()` 的回调 |
|---|---|
| 纯 `node:http`：`upgrade` 里自己写 101，socket 常驻 | **3 秒内没有发生**；socket 未被 destroy |
| `ws` 的 `WebSocketServer`：同样一条常驻连接 | **3 秒内没有发生**；`ws` 的 `'close'` 事件也没发生，客户端 `readyState` 仍是 `1` |
| 之后把客户端的 socket destroy 掉 | 同一个 tick 内 `SERVER-CLOSE-CALLBACK` 到达、`ws` 的 `'close'` 到达 |

**结论：`server.close()` 覆盖不到 upgrade 之后的 socket —— 它被算作"还活着的连接"，所以回调永远不来。DSH 自建 `upgradedSockets` 的先例是对的，Node 没有替你做。**（两个引擎版本表现一致。）

### 4b. `closeAllConnections()` **也覆盖不到** upgrade 之后的 socket

**源码实证（Node v22.19.0）**：

```js
Server.prototype.closeAllConnections = function closeAllConnections() {
  if (!this[kConnections]) {
    return;
  }

  const connections = this[kConnections].all();

  for (let i = 0, l = connections.length; i < l; i++) {
    connections[i].socket.destroy();
  }
};
```
（`lib/_http_server.js:601-611`）

它遍历的是 **http 解析器自己的连接表**（`kConnections`，一个 `ConnectionsList`，`lib/_http_server.js:184-185`、`:527`）。而**升级的一瞬间，这条 socket 被从那张表里摘掉了**：

- `lib/_http_server.js:952-954`（upgrade 分支）依次调 `unconsume(parser, socket); parser.finish(); freeParser(parser, req, socket);`
- `freeParser`（`lib/_http_common.js`）里有一句 `parser.remove();`
- `Parser::Remove`（`src/node_http_parser.cc:586-594`）→ `connectionsList_->Pop(parser)`

**所以"升级过的 socket 不在 `closeAllConnections()` 的名单里"，而它**在** `net.Server._connections` 里。** 两套记账的不对称就是这么来的。

**实测**：在 4a 两条路线上，`closeAllConnections()` 调用之后的 3 秒里，升级 socket **没有被 destroy**（`socketDestroyed: false`、`ws` 的 `'close'` 事件 0 次、客户端 `readyState` 仍是 1）。**只有在我随后销毁客户端 socket 之后才关**。

> **对本仓库那两处断言的核实（新形态）**：`docs/architecture.md:263` 那句是"**一条泄漏的流就是一台关不掉的服务器**"（前提那半）；"**出口是 `closeAllConnections()`**"那半不是它写的，是研究票 02 Q3b 在核实它时**补出来的**（`issues/02-sse-multiplex-pitfalls.md:27`、`research/sse-multiplex.md:165`），随后被 `docs/adr/0001-transport-websocket-mux.md:101` 原样收录。**换成 WebSocket 之后，出口那一半不成立了**：`closeAllConnections()` **不管升级 socket**，所以上面那句"`server.close()` 的回调不发生"（前提）反而更硬了。新形态的正确表述是"**升级之后的 socket 必须由接手的代码自己记账并销毁；Node 的两条出口都不覆盖它**"——ADR 第 101 行那条"仍未确认"就此结清，见 ADR 的落地清单第 2 条。

### 4c. `ws` 的 socket 高水位与背压语义

**（a）高水位就是裸 `net.Socket` 的默认值。**

- `ws` 全包 grep `highWaterMark` **0 命中**（源码实证）：它不构造、也不包装 socket，客户端路径把 `options` 原样交给 `net.connect`（`lib/websocket.js:1085-1088`），服务端**复用 HTTP server 的 upgrade socket**（`lib/websocket-server.js:125-131`），只额外做 `socket.setTimeout(0)` 与 `socket.setNoDelay()`（`lib/websocket.js:260-261`）。
- **实测（Node 22.19.0 与 24.15.0）**：服务端 `ws` 的底层 socket `writableHighWaterMark = 16384`、`readableHighWaterMark = 16384`，构造器就是 `Socket`。**票 11 那个 16384 的数字在 WS 侧原样成立**（它是 Node 的默认值，不是 `ServerResponse` 特有的）。

**（b）`bufferedAmount` 记什么。**

`ws@8.22.0` 的 getter（`lib/websocket.js:130-137`）：

```js
  get bufferedAmount() {
    if (!this._socket) return this._bufferedAmount;

    return this._socket._writableState.length + this._sender._bufferedBytes;
  }
```

- **有 socket 时 = socket 可写缓冲里"已加帧"的字节 + `ws` Sender 内部"未加帧"的载荷字节**；**单位是混合的**。
- **没有 socket 时**（客户端握手就失败）只有 `_bufferedAmount`。
- **已经 flush 出去的字节不再计入**（那是 `net.Socket` 的语义）。

**（c）`send()` 的回调什么时候来，`write()` 的返回值被怎么处理。**

- **`send()` 没有返回值**（`lib/websocket.js:468-498` 无 `return`），**`ping()` 同样**。所以票 11 "没有用 `ws.send()` 的返回值"这一句是**照实描述**：无返回值可用。
- **回调被交给 `this._socket.write(chunk, cb)`**（`lib/sender.js:563-572`），即 Node `Writable` 的写回调；签名上写的是 "Callback which is executed when data is written out"，**实际是在数据交给内核之后异步触发**。
- **`sendFrame()` 完全忽略 `socket.write()` 的返回值**，Sender 里**没有任何 `'drain'` 监听**（全包 grep 只有 Receiver 的入站 `'drain'`）。

**实测（对端 `pause()`，服务端灌 16 KiB 的帧）**：

```
hwm                       writableHighWaterMark=16384, readableHighWaterMark=16384, constructor=Socket
client-paused             （对端 Node 流 pause()）

密集写一轮（200 帧 × 4096 字节，7 ms 内写完）
  sent                    frames=200, frameBytes=4096, callbacksFired=0     ← 回调一个都没来
  第一次 write() 返回 false  第 2 次 write（0 起算 index 1）
  writesWithFalseReturn   299 / 400
  bufferedAmount          627300 字节（200 帧）—— 之后随内核吸收而排空

灌到上限（25604 帧 × 16384 字节 ≈ 400 MiB，962 ms 内写完）
  sent                    frames=25604, callbacksFired=0, hitCap=true
  marks.last              bufferedAmount == writableLength == 419418084（≈400 MiB）
  writesWithFalseReturn   51198 / 51210        ← 几乎每一次 write() 都返回 false，ws 照写
  firstFalseAtWrite       1
  之后 500 ms 内              callbacksFired 从 0 → 25605，buffer 归 0（RSS 峰值仅 91 MiB）

terminate()               readyState=3，socket.destroyed=true
```

**结论**：

1. **"这次写没有立刻出去"的信号确实存在，而且有两份**：`send()` 的**回调被无限推迟**（400 MiB 缓冲期间 0/25604 个回调），`bufferedAmount` / `writableLength` **增长**。票 11 的判定不依赖具体取值这一点得到确认——它依赖的"信号存在且不会永远不来"成立。
2. **`ws` 不会自己停**：`write()` 返回 `false` 之后它照写（51198/51210 次返回 false，一路灌到 400 MiB）。**"停写 + 有界队列 + 超时结束连接"这条规则必须长在 mux 自己身上，`ws` 不提供。**
3. **手写 RFC6455 时这一层就是自己的**：那时它就是底层 `net.Socket` 的 `write()` 返回值与 `writableLength`（票 02 Q3a 的机制原样成立），额外要自己实现的是帧编解码与 Close/Ping 的应答。
4. **一处必须写下来的装置边界**：本票这个"对端 `pause()`"**没有**造出一条**持续**停滞的连接——400 MiB 在约 500 ms 内被内核/回环吸收干净、2.5 万个回调一次性补齐（RSS 峰值 91 MiB，与票 11 那条"10 秒 20 GB / 961 MiB RSS"的形态不同）。所以"**缓冲会不会永远不排空**"这半条**本票没有证明**；那半条的证据仍然只有票 11 的 `prototype/backpressure-stalled-peer.mjs`（它用的是裸 `net.Socket` + 一个真不读的对端）。本票证明的是另一半：**`ws` 面对 `false` 不停手，而且它把这件事如实反映在 `send()` 回调与 `bufferedAmount` 上**。

---

## Q5. Node ≥22 的全局 `WebSocket`（undici）

票 15 要用它当冒烟客户端，且**不为它引入 `ws` 依赖**。结论分"表面上一样"与"**两个版本真的不一样**"两半。

### 5a. API 表面（两版本逐字相同）

```
prototype: CLOSED, CLOSING, CONNECTING, OPEN, binaryType, bufferedAmount, close,
           constructor, extensions, onclose, onerror, onmessage, onopen, protocol,
           readyState, send, url
statics:   CLOSED, CLOSING, CONNECTING, OPEN, length, name, prototype
常量:      CONNECTING=0 OPEN=1 CLOSING=2 CLOSED=3
```

- **没有 `socket` / `_socket`（不暴露底层 socket）**，**没有 `ping` / `pong` / `onping` / `onpong`**（`'socket' in ws`、`typeof ws.ping` 全是否）。
- 因此票 15 判定"票 11 那条 `socket.pause()` 的对端做不出来"**在 22.19 上也成立**。
- `new WebSocket("not-a-url")` 抛 `SyntaxError`，消息是 `TypeError: Invalid URL`。
- 注：`@types/node` 把 `WebSocket` 声明在 `web-globals/fetch.d.ts` 的全局块里，裸 `WebSocket` 在 `lib: ES2023` + `types: ["node"]` 下通过 `tsc`（票 15 已实测，本票复核 `typeof globalThis.WebSocket === "function"`）。

### 5b. 行为对照：**三处真实差异**（Node 22.19.0 / undici 6.21.2 vs Node 24.15.0 / undici 7.24.4）

| 行为 | Node 24.15.0（undici 7.24.4） | **Node 22.19.0（undici 6.21.2）** |
|---|---|---|
| 服务端每 150 ms 发 Ping | **自动回 pong**（服务端日志 4 条 pong，RTT 0–1 ms） | **自动回 pong**（同样 4 条，RTT 0–1 ms） |
| 客户端 `close(4000, "reconnect requested")` | 服务端收到 `code 4000` + 原样 reason | 同 |
| 服务端发 `Close(1013, "try again later")` | `close:1013/try again later/true` | 同 |
| **服务端 destroy（异常断）** | `error` **然后** `close:1006/""/false` | **只有 `close:1006/""/false`，没有 `error`** |
| **握手失败（连不上 / 非 101 响应）** | `error` + `close:1006/""/false`，`readyState` 变 **3** | **只有 `error`（`"Received network error or non-101 status code."`），`close` 永不 fire；`readyState` 停在 `0`（CONNECTING）超过 15 秒** |
| **协议违规（非法 opcode）** | `error`（message **空**）+ `close:1006`，**并且给对端发一个 `1002 "Invalid opcode received"` 的 Close 帧** | `error`（message = `"Invalid opcode received"`）+ `close:1006`，**但不给对端发 Close 帧**（服务端日志少一条） |
| 非法 `close(code)` | `InvalidAccessError: invalid code` | 同 |

**三条差异对冒烟都致命，逐条说清**：

1. **握手失败时 22.19 不发 `close`，`readyState` 卡在 0。** 等 `close` 事件或等 `readyState === CLOSED` 的写法**在引擎下限上会永久挂住**（实测 15 秒仍是 0）。这条是票 15 那个 wire 客户端必须处理的第一个分叉。
2. **异常断线时 22.19 不发 `error`。** 只按 `error` 判"连接坏了"的写法在 22.19 上什么都不会发生（它会走 `close`）。
3. **协议违规时 22.19 不回 Close 帧。** 若冒烟要断言"服务端看见客户端礼貌地告别"，在 22.19 上是红的——而这与被测代码无关。

> **票 15 第 2 条登记的"需要你确认"的那件事，答案是：不能无条件共用一份 wire 客户端。** 两份 undici 在"连接如何失败"这条路径上分叉；一份同时兼容两者的客户端**至少要**：把"握手失败"的判据同时挂在 `error`、`close`、以及**一个自己的超时**上（因为 22.19 两者只来一个、`close` 根本不来的那一半只能靠超时兜住）。

### 5c. 与浏览器 `WebSocket` 的差异（影响冒烟断言的）

| 面 | 浏览器（Chromium 152） | Node 22.19 | Node 24.15 |
|---|---|---|---|
| ping/pong 可见性 | 不可见 | 不可见 | 不可见 |
| 自动回 pong | 是 | 是 | 是 |
| 异常断线 | **没有** `error`，只有 `close:1006/false` | **没有** `error`，只有 `close:1006/false` | **有** `error` 然后 `close:1006/false` |
| 协议违规 | `error` + `close:1006` | `error` + `close:1006` | `error` + `close:1006` |
| 握手失败 | `error` + `close:1006`，`readyState`→3 | **只有 `error`，`readyState` 停在 0** | `error` + `close:1006`，`readyState`→3 |
| 客户端非法 close code | `InvalidAccessError` + 那段长文案 | `InvalidAccessError: invalid code` | 同左 |
| 底层 socket | 不暴露 | 不暴露 | 不暴露 |
| 自动重连 | 没有 | 没有 | 没有 |

**所以"用 Node 的全局 `WebSocket` 当冒烟客户端、行为照浏览器"这件事，在 22.19 上要打三个折扣**（上表加粗那三行）。**实现细节**。

---

## Q6. 与 SSE 共存的过渡期：**不适用**

票 05 已决定**删除旧 `/events` 端点**，因此不存在"SSE 与 WS 并存"的过渡期，"两种连接池的关系"这个问题**没有承重面**。照票面要求记成**不适用**。

（顺带钉一条相邻的事实，供将来有人重开时用：**HTTP 池与 WS 池在 Chromium 里是两条独立的池**（3b 源码 + 255 条 WS 下同源 `fetch` 仍在 30 ms 内答出）。所以"SSE 的 6 个名额 + WS 的 255 个名额"如果真要并存，是**相加**而不是**共享**。**实测只覆盖一个窗口**。）

---

## 最可能推翻「一条常驻 WS mux」的那一条

**没有一条能推翻选型，但有三条把参数与装置钉住了**——它们分别是"必须自建"、"必须自己记账"、"必须自己踩坑"。

1. **没有自动重连是这个模型最大的一块新增自建件，而且是规范层面的缺席**（1a：WHATWG 的 WebSocket 一节里 `reconnect` 类词 0 命中）。退避、"代"、断代后的收敛全部归客户端；票 07 的判定因此不是"选了个方案"，而是**唯一可行的那条路**。
2. **升级之后的 socket 谁都替你收不了尸**（4a/4b）：`server.close()` 因为它而永不回调，`closeAllConnections()` 因为 `parser.remove()` 而看不到它。这不是"实现得不好"，是**两套记账的不对称**；接手的代码必须自己持有并销毁每一条 upgrade socket。
3. **客户端的失败语义比 SSE 更少而不是更多**：`error` 只在"被判定为坏"时 fire（1c），掉线只有 `close`+1006；而引擎下限那一档（Node 22.19 的 undici）**在握手失败时会连 `close` 都不来**（5b：异常断线仍然给 `close(1006)`，这条限定要紧）。所以"连接已经死了"的判据只能是**自己的读超时**——这正是票 07 那条应用层心跳与 watchdog 的位置。

**反过来，四条"曾被当作新增风险"的东西这次被实测削平了**：

- 隐藏窗口**不会**停止或延迟 WS 消费（2d：两配置下 123 帧逐项相同，pong 123/123）。票 11 最坏情况里那一格从"猜"变成"实测"。
- 流量上限从 6 挪到 **255**，而且 **HTTP 与 WS 分池**，同源 `fetch` 不再被饿死（3b）。
- `ws` 的写侧背压信号**确实存在、也确实不会永远不来**（4c：回调推迟 + `bufferedAmount` 增长，对端一恢复 200 个回调立刻补齐）。
- `1013` 与 `4000` 在两端**都合法、都原样送达、都不互相混淆**（1f）。

---

## 附：票 07 / 11 / 15 / 16 登记的那些事实，逐条结清

| 票 | 登记的问题 | 本票的答案 | 等级 |
|---|---|---|---|
| 07 | `close` 的 code/reason 语义 | 服务端发什么就报什么（含 1013/4000）；TCP 掉线是 1006 + 空 reason + `wasClean=false` | 实测 |
| 07 | `error` 何时 fire | 只在"UA fail 了这条连接"或"缓冲被标记为满"时；**普通掉线不 fire** | 规范 + 实测 |
| 07 | 客户端允许哪些 close code | 1000 与 3000–4999；reason ≤ 123 UTF-8 字节；否则 `InvalidAccessError` / `SyntaxError` | 规范 + 源码 + 实测 |
| 07 | 服务端 `ws` 侧看到的 `code === 4000` 是否与浏览器对齐 | 对齐：`ws` 的 `'close'` 收到 `4000` + 原样 reason | 实测 |
| 07 | `1013` 在浏览器侧合法且原样送达吗 | 是，`wasClean = true`；`ws` 也不拒 | IANA + 源码 + 实测 |
| 07 | 浏览器是否对每条 ping 都尽快回 pong | 是：123/123，RTT 0–1 ms（含被后台节流的 20 秒）；但 RFC 只保证 MUST 回、SHOULD 快，§5.5.3 允许合并 pong | 规范 + 实测 |
| 07/11 | 隐藏窗口 `backgroundThrottling` 的节流幅度 | **WS 投递 0 影响**（两配置下逐项相同）；**JS 定时器 10 倍**（10/s → 1/s）；`rAF` 大幅减少；`document.visibilityState` 被这个开关本身改写，不可当判据 | 实测 + 源码 + 官方文档 |
| 11 | `ws.send()` 有没有"没立刻出去"的信号 | 有：回调被推迟（400 MiB 期间 0/25604）+ `bufferedAmount`/`writableLength` 增长；`send()` 无返回值；`ws` 忽略 `write()` 的 `false`（51198/51210 次）、不监听 `'drain'` | 源码 + 实测 |
| 11 | `ws` 的 socket 高水位 | **16384**（就是 `net.Socket` 的默认值；`ws` 不设） | 源码 + 实测（两版本） |
| 11 | `bufferedAmount` 与 `writableLength` 各记什么 | `bufferedAmount = _socket._writableState.length + _sender._bufferedBytes`（混合单位） | 源码 + 实测 |
| 11 | `1013` 与 `4000` 会不会在日志里混淆 | 不会：两端都原样保留发送方的码与 reason | 实测 |
| 11 | 停滞上限 (10 s) < watchdog (15 s) 站得住吗 | 站得住，而且隐藏窗口这一格现在有实测 | 实测 |
| 15 | 全局 `WebSocket` 在 22.19 上能不能当共用 wire 客户端 | **不能无条件共用**：握手失败时 22.19 不发 `close`、`readyState` 卡在 0；异常断线不发 `error`；协议违规不回 Close 帧 | 实测 |
| 15 | `socket.pause()` 的对端做不出来 | 结论不变（22.19 也不暴露底层 socket） | 实测 |
| 15 | `server.close()` / `closeAllConnections()` 对 upgrade socket 的记账 | `close()` 的回调**永不发生**；`closeAllConnections()` **也覆盖不到**（`parser.remove()` 把它摘出了名单）。跟踪**不是冗余** | 源码 + 实测（两版本） |
| 16 | Chromium 的 255 实测成立吗 | 成立（同一 origin 恰好 255），**但它是池级共享的**：换个 origin 也开不出来，总量停在 255 | 实测 |
| 16 | 撞上限是排队还是失败 | **失败**：立刻 `error` + `close(1006/false)`，服务端看不到 upgrade（与 `EventSource` 的无限 CONNECTING 相反） | 实测 |
| 16 | HTTP 池与 WS 池共享名额吗（问 6） | 不共享：255 条 WS 下同源 `fetch` 28/3/2 ms | 源码 + 实测 |
| 16 | Firefox 的对应值 | 默认 **200**，**进程级全局**（不是 per origin），超限立刻失败、JS 见 `error` + `close(1006/false)` | 源码（**未实测**） |

---

## 附录 A：实验装置与原始数据

### A.1 装置

全部在 `.scratch/client-server-refactor/prototype/ws/`（**与票 15 要新建的 `scripts/wire/` 无关**，这里是研究用的一次性装置）：

| 文件 | 作用 |
|---|---|
| `server.mjs` | **手写 RFC6455** 的探针服务器（握手、帧编解码、Close/Ping/Pong）。不依赖任何包，所以能在 Node 22.19 上直接跑。支持上行命令（`close` / `destroy` / `ping` / `stats` / `echo` / `badopcode` / `rsv1` / `badutf8` / `badclose`），并把每个事件写成一行 JSON |
| `ws-server.mjs` | 同一个命令协议的 **`ws` 包**版本，用来回答"服务端用 `ws` 时看到什么" |
| `electron-main.cjs` / `electron-preload.cjs` / `renderer.html` | Electron 装置：主进程建窗口、按场景 hide/minimize/restore；渲染器跑 6 个场景（`close-codes` / `errors` / `pool-limit` / `pool-limit2` / `pool-limit3` / `throttle`）并把结果经 IPC 送回主进程落盘 |
| `run.mjs` | 驱动：挑空闲端口、起探针服务器（可选两个）、起 `electron.exe`、收日志 |
| `node-close-upgrade.mjs` | Q4a/4b：`server.close()` / `closeAllConnections()` 与 upgrade socket（纯 `node:http` 与 `ws` 两条路线） |
| `ws-backpressure.mjs` | Q4c：`ws` 的写侧表面（对端 `pause()`，逐次记录 `write()` 返回值、`writableLength`、`bufferedAmount`、回调） |
| `global-ws.mjs` / `global-ws-handshake-fail.mjs` | Q5：Node 全局 `WebSocket` 的 API 面与失败语义（两版本各跑一遍） |

**关键环境陷阱（票 02 已经踩过一次，这次同样）**：本机 `ELECTRON_RUN_AS_NODE=1`。带着它启动 `electron.exe`，Electron 退化成普通 Node。`run.mjs` 在 `spawn` 的 env 里显式 `delete` 掉它。

**第二处陷阱（本次新增，值得记下来）**：`BrowserWindow` 构造参数里的 `show: true` **在本机不足以让页面进入 `visible`**。第一轮 `close-codes` / `pool-limit` 的 `document.visibilityState` 整段是 `hidden`，而 `win.isVisible()` 是 `true`。要显式再调一次 `win.show(); win.focus(); win.moveTop()` 才会变成 `visible`。这件事本身是**未确认**的（可能与本机的桌面会话有关），但它决定了"隐藏窗口"实验必须有 `visibilitychange` 与 `win.isVisible()` 双份证据，不能只看其中一个。

**第三处（自查）**：本文档的几份探针脚本里，`ws` 是从 `$env:TEMP` 里解包的 `ws@8.22.0` 通过 `--ws-path` 传绝对路径加载的——**本仓库没有、也不需要装 `ws`**。两个 Node 二进制同理（`nodejs.org` 下载的 v22.19.0 zip 解到临时目录）。

### A.2 Q1 的原始输出（Electron 44.5.1 / Chromium 152.0.7977.130）

```
server-close-1000          | open | close:1000/"bye"/true
server-close-1013          | open | close:1013/"try again later"/true
server-close-1001          | open | close:1001/"going away"/true
server-close-4000          | open | close:4000/"reconnect requested"/true
server-destroy-tcp         | open | close:1006/""/false
client-close-1000          | threw=-                   | open | close:1000/""/true
client-close-4000          | threw=-                   | open | close:4000/""/true
client-close-4999          | threw=-                   | open | close:4999/""/true
client-close-3000          | threw=-                   | open | close:3000/""/true
client-close-1001          | threw=InvalidAccessError | open | close:1005/""/true
client-close-2999          | threw=InvalidAccessError | open | close:1005/""/true
client-close-5000          | threw=InvalidAccessError | open | close:1005/""/true
client-close-1234          | threw=InvalidAccessError | open | close:1005/""/true
client-close-999           | threw=InvalidAccessError | open | close:1005/""/true
client-close-1005          | threw=InvalidAccessError | open | close:1005/""/true
client-close-1006          | threw=InvalidAccessError | open | close:1005/""/true
client-close-1015          | threw=InvalidAccessError | open | close:1005/""/true
reason-124-ascii           | threw=SyntaxError         | open | close:1005/""/true
reason-123-ascii           | threw=-                   | open | close:1000/""/true
reason-123-bytes-cjk       | threw=-                   | open | close:1000/""/true
reason-126-bytes-cjk       | threw=SyntaxError         | open | close:1005/""/true
报错原文: Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or
          between 3000 and 4999. 1001 is neither.
          Failed to execute 'close' on 'WebSocket': The close reason must not be greater
          than 123 UTF-8 bytes.
服务端统计: {"connections":1,"peak":1,"upgradeAttempts":22,"upgradeRejected":0}   ← 22 次连接、0 次补连
```

`errors` 场景（失败语义）：

```
refused-tcp                  | error | close:1006/""/false
handshake-404                | error | close:1006/""/false
handshake-200-no-upgrade     | error | close:1006/""/false
protocol-bad-opcode          | open | error | close:1006/""/false
protocol-rsv1                | open | error | close:1006/""/false
protocol-bad-utf8            | open | error | close:1006/""/false
protocol-bad-close-code      | open | error | close:1006/""/false
clean-close-1013             | open | close:1013/"try again later"/true
abnormal-destroy             | open | close:1006/""/false            ← 注意：没有 error
```

服务端侧看到的客户端 Close 帧（`ws` 包做服务端时，`ws-close-event`）：

```
{"id":1,"code":1000,"reason":"bye"}                      ← 服务端发 1000，浏览器抄回 code+reason
{"id":1,"code":1013,"reason":"try again later"}          ← 同上，1013
{"id":1,"code":1001,"reason":"going away"}
{"id":1,"code":4000,"reason":"reconnect requested"}
{"id":1,"code":1006,"reason":""}                         ← 服务端 terminate()
{"id":1,"code":4000,"reason":"reason-4000"}              ← 浏览器自己 close(4000, "...")，原样到达
{"id":1,"code":4999,"reason":"reason-4999"}
{"id":1,"code":1005,"reason":""}                         ← 浏览器 close() 无参 = 空 payload
{"id":1,"code":3000,"reason":"reason-3000"}
```

### A.3 Q2 的原始输出（throttle 两轮）

```
throttling=true   frames=123  timerTicks=46   rafTicks=422   gaps 199/202/216 ms
                  pongs=123   rtt 0/1/1 ms    inter-pong gap 199/202/216 ms
                  ticksPerSec  9,3,1,1,1,1,1,1,1,1,1,1,1,1,1,2,1,1,1,1,1,1,1,9,3,0
                  framesPerSec 5,5,5,5,4,5,5,5,5,5,5,5,4,5,5,5,5,5,5,5,5,5,5,5,4,1
                  visibilityLog: hidden@1.1s → visible@15.02s → hidden@15.04s
                                 → visible@23.1s → hidden@24.1s
throttling=false  frames=123  timerTicks=250  rafTicks=5443  gaps 200/203/215 ms
                  pongs=123   rtt 0/0/1 ms    inter-pong gap 200/203/215 ms
                  visibilityLog: （空）
```

### A.4 Q3 的原始输出（Electron / Chromium 152）

```
轮次 1（只打一个 origin）
  index 1..255 → open         （openedCount=255，openedLast=[253,254,255]）
  index 256    → error        readyState=3, 事件: [error@3998, close@3998 code=1006 wasClean=false]
  index 257    → error        同上
  同时的同源 fetch: 28 ms / 3 ms / 2 ms（全部 200）
  服务端统计: server1 upgrades=255, server2 upgrades=0

轮次 2（先给 origin B 一条，再打满 A）
  controlB            = open
  打满 A              = 254 条
  池满时再连 B         = error
  在 A 上关 5 条之后    A=249, B 再补 5 条 → 249 + 1 + 5 = 255
  推论                = 池级共享容量 255（源码常量写的是 256，差 1 未解释）
```

### A.5 Q4 的原始输出

`server.close()` / `closeAllConnections()`（Node v24.15.0；v22.19.0 逐项相同）：

```
raw: listening port=49681
raw: handshake-done upgraded=1 socketDestroyed=false
raw: server.close()-called
raw: after-close-wait(3s)  closeCallbackAt=null  upgradedClosed=0  socketDestroyed=false
raw: closeAllConnections()-called
raw: upgraded-socket-close-after-closeAllConnections-TIMEOUT(3000ms)
raw: after-closeAllConnections  closeCallbackAt=null  upgradedClosed=0  socketDestroyed=false
（随后 client.destroy() → SERVER-CLOSE-CALLBACK 立刻到达）

ws:  handshake-done upgradedSockets=1 socketWritableHwm=16384 socketReadableHwm=16384 ctor=Socket
ws:  server.close()-called
ws:  after-close-wait(3s)  closeCallbackAt=null  closeEvents=0  clientReadyState=1
ws:  closeAllConnections()-called
ws:  socket-close-after-closeAllConnections-TIMEOUT(3000ms)
（随后 client.terminate() → SERVER-CLOSE-CALLBACK @6349，socket-close @6350）
```

`ws` 写侧（对端 `pause()`）：

```
轮 A：200 帧 × 4096 字节
hwm {"writableHighWaterMark":16384,"readableHighWaterMark":16384,"constructor":"Socket"}
sent {frames:200, frameBytes:4096, callbacksFired:0}
marks: i=10  bufferedAmount=0      writableLength=0      lastWriteReturned=true
       i=30  bufferedAmount=0      writableLength=0
       i=122 bufferedAmount=307500 writableLength=307500 lastWriteReturned=false
       i=200 bufferedAmount=627300 writableLength=627300 wsBufferedBytes=0
after-stall(3s)   bufferedAmount=0  writableLength=0  callbacksFired=200
                  writesWithFalseReturn=299/400  firstFalseAtWrite=101  readyState=1

轮 B：灌到上限（25604 帧 × 16384 字节 ≈ 400 MiB）
sent {frames:25604, frameBytes:16384, callbacksFired:0, hitCap:true, floodMs:6000}
marks.last {i:25604, bufferedAmount:419418084, writableLength:419418084,
            wsBufferedBytes:0, callbacksFired:0, lastWriteReturned:false, rssMb:84}
firstFalseAtWrite=1   writesWithFalseReturn=51198/51210
timeline: +1474ms buffered=0 callbacks=25605 rssMb=89
          +1986ms …（此后每 500 ms 都是 buffered=0 callbacks=25605 rssMb=89）
after-stall  bufferedAmount=0 callbacksFired=25605 readyState=1 rssMb=91
after-resume bufferedAmount=0 callbacksFired=25605 readyState=1
after-terminate readyState=3 destroyed=true
```

### A.6 Q5 的原始输出（两版本）

```
Node v24.15.0 (undici 7.24.4)
  prototype: [... 19 个名字 ...]，statics: [CLOSED,CLOSING,CONNECTING,OPEN,length,name,prototype]
  liveness-hooks: onping/onpong/ping/pong/socket/_socket 全部 false
  echo ok；server-pings → pongs=4 rtt=[1,1,1,0]
  client-close-4000 → close:4000/""/true；服务端收到 code=4000 reason="reconnect requested"
  server-close-1013 → close:1013/"try again later"/true
  server-destroy    → ["error", "close:1006//false"]
  protocol-badopcode→ ["error:", "close:1006//false"]，并给对端发了 1002 "Invalid opcode received"
  refused / handshake-404 → ["error:", "close:1006//false"]  readyState=3
  client-close-invalid: 1001/1234/5000/1005 全部 InvalidAccessError: "invalid code"

Node v22.19.0 (undici 6.21.2)
  同上的 API 面与 liveness-hooks（全部 false）；pongs=4 rtt=[1,1,0,1]
  client-close-4000 → close:4000/""/true
  server-close-1013 → close:1013/"try again later"/true
  server-destroy    → ["close:1006//false"]              ← 没有 error
  protocol-badopcode→ ["error:Invalid opcode received", "close:1006//false"]
                      服务端只收到 3 条 Close 帧（少一条 1002）  ← 没回 Close 帧
  refused / handshake-404 → ["error:Received network error or non-101 status code."]
                      readyState=0，15 秒采样点全是 0，close 从未 fire
```

### A.7 这次实验**没有**验证的事

见下面的未确认清单；此外还有四处**方法上的**边界：

1. Q3 的"多个窗口是否共享同一个额度"**没测**（只开了一个 `BrowserWindow`）。
2. Q2 的"渲染器被 `kFrozen`（BFCache/冻结）时 WS 怎么办"**没测**（只测了 `backgroundThrottling`，没有触发冻结路径）。
3. Q1 的"服务端用 `ws` 发 `Close` 之后**不**关 TCP，客户端会不会等"**没测**（本票的探针服务端一直遵守 §5.5.1 立刻关 TCP；见未确认清单第 14 条）。
4. Q4c 的"对端 `pause()`"**造不出持续停滞**（400 MiB 在约 500 ms 内被回环/内核吸收），所以"缓冲会不会永远不排空"这半条在本票里没有证据（见未确认清单第 12 条）。

---

## 未确认清单（不许当已知用）

1. **Chromium 实测总容量 255 与源码池软上限 256 差的那 1 条**：没读到能定案的那一行源码（`SocketPoolAdditionalCapacity` 的随机化与 `Expandability()` 的转换阈值都只是候选）。**照实测用 255，别把 256 当上界用。**
2. **Firefox 的一切运行时行为**：`200`、进程级全局、超限失败、`error` + `close(1006)` **全部只有源码实证**，本机没有 Firefox。票 02 的惯例照旧。
3. **多个窗口 / 多个 Electron session 是否共享 WebSocket 池的 255 名额**：源码结构说是"每 NetworkContext 一条池"，**没有实测**。
4. **Chromium 的 `HttpStreamPool`（新池）在 WebSocket 上到底用哪套常量**：新池头文件里 0 处提到 WebSocket，而实测行为与"255 池级共享"一致。**哪一套在生效未确认。**
5. **Electron 隐藏窗口在什么条件下会让渲染器进入 Page Lifecycle 的 `kFrozen`**（那时代码是**断连**，不是延迟投递）：本实验没有触发该路径，Electron 文档对此沉默。
6. **`document.visibilityState` 为什么在本机的默认配置下整段是 `hidden`**（而 `win.isVisible()` 是 `true`）：可能与桌面会话有关，**与 `backgroundThrottling` 的关系已由实测钉死，但它自身为什么这样未确认**。
7. **`backgroundThrottling` 对**其他** Electron/OS 组合的行为**：实测只覆盖 Windows + Electron 44.5.1 + Chromium 152，一个窗口。
8. **控制帧（Ping/Pong）载荷超限/分片时的处理器行为**：Chromium 侧没有找到强制的 payload ≤ 125 检查（只有 debug 断言），`ws` 侧是明确拒绝（`WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH`）。**Chromium 这一格未确认。**
9. **`ws.close()` 在 `CONNECTING` 时的完整事件序**：源码上走 `abortHandshake`（`error` + `close`），**本票没有跑**。
10. **浏览器 `close()` 之后"服务端不回 Close 帧"的等待上限**：Chromium 有一条提示性的超时（`net::WebSocketChannel` 的 closing handshake 超时），**本票没有测它的取值**。
11. **Node 22.19 的 undici 在握手失败后那条连接到底有没有被彻底回收**（它 `readyState` 停在 0、不发 `close`，资源是否泄漏）：**没有测**。它对冒烟的直接影响（等不到 `close`）已经实测，但"泄漏与否"是另一件事。
12. **`ws` 上"缓冲永远不排空"的持续停滞**：本票装置（对端 `pause()`）在 400 MiB 之后仍然排空了，所以这半条**只有票 11 的裸 `net.Socket` 装置**作证。`ws` 侧的"持续停滞"形态**未确认**。
13. **"写缓冲被标记为满"时 `error` 到底 fire 不 fire**：WHATWG 把这一条写成 `error` 的第二个触发条件（1c 引的规范条文），但本票**没有造出缓冲满**——实测覆盖的是握手失败、协议违规、干净 Close 与 TCP 掉线，**没有一条落在这个条件上**。规范条文之外的任何断言（包括"`bufferedAmount` 撑到多少算满"）都**不许当已知用**。
14. **服务端发了 Close 帧却不关 TCP 时，客户端等多久**：Chromium 有一条 closing handshake 超时，**本票没有测它的取值**；探针服务端全程遵守 RFC 6455 §5.5.1 立刻关 TCP（见附录 A.7 第 3 条），所以这一格完全没有数据。
