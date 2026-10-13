# 冒烟与验证策略

Type: grilling
Status: resolved
Blocked by: 05

## Question

`AGENTS.md` 的规则是："改完代码跑 `npm run check` 和对应的 smoke（都不需要供应商密钥）"。本次改动会同时推翻**四个**冒烟脚本对传输层的假设——它们在五个地方各自复制了一份"按 `\n\n` 切块、取 `data:` 行"的 SSE 解析器：

- `scripts/smoke-stream.ts:86-93`（`feed()`）
- `scripts/smoke-api.ts:62-75`（`readStream()`）与 `:140-147`（`collectFrames()`）
- `scripts/smoke-boot.ts:33`
- `scripts/smoke-approval.ts:123-135` 与 `:392-404`（两处 `pump()`）

它们**都不用 `EventSource`**（Node 没有这个 API）。传输换成 WebSocket 后（2026-10-12，见 `map.md`），问题从"改五份 SSE 解析器"变成"给冒烟一个 WS 客户端"：Node ≥22 自带全局 `WebSocket`（undici），本仓库引擎下限 22.19 正好够用，**不需要**为此引入 `ws` 依赖——但它在 22.19 上的确切行为归票 17 核实。

要钉死的是：

1. **要不要抽一个共享的测试工具**。五份重复实现是既有技术债。抽的话放在哪（`scripts/` 下一个模块？`packages/server` 里导出？）——注意 `docs/notes.md:31-33` 的规则"测试一次运行不需要供应商密钥"，以及 `scripts/fake-transport.ts` 是**模型**传输替身、不是 wire 替身，别混。
2. **每个脚本的断言怎么改**。逐条判定哪些断言在新模型下**语义变了**而不是"字段名变了"：
   - `smoke-stream.ts:155-170`（空闲流自我 `stream_end` + 会话被回收）——常驻连接里没有"空闲流"这回事；
   - `smoke-stream.ts:210-217`（断言 `stream_end` 的下标**严格大于** `agent_end`）——D2 已失效（票 05）；
   - `smoke-stream.ts:238-248`（第二条流在 `idle grace × 6` 后仍活着）；
   - `smoke-boot.ts:28-36`（打开 `/events`、解析第一帧、断言落到的是 `sessionId`）；
   - `smoke-api.ts:354-359` 与 `:375-384`（移动/新分支点必须作为新 `session` 帧到达流）——这两条断言的是"一棵变了的树是所有人的事"，在新模型下应该**保留**，只是运载方式变了；
   - `smoke-api.ts:305-307` 的注释说"未知会话在流 URL 上也必须是 404"，但**代码只请求了读取端点**——注释与代码不一致，`/events` 的 404 实际由 `smoke-stream.ts:192-197` 覆盖。这处漂移要不要顺手修。
3. **验收边怎么被证明**。`map.md` 的四条验收边目前没有一条有对应的测试：
   - "一个标签页同时订阅 N 个会话"——需要新的冒烟（现有脚本全部单会话）；
   - "逻辑流重开后收敛"——需要断连再连的冒烟；
   - "发送不依赖先 attach"——需要"无人观看时运行失败"的冒烟（今天的 D3 路径）；
   - "客户端能发现连接已死"——需要一个假死连接的冒烟。
   这些都是**新**脚本还是既有脚本的新段落？
4. **桌面外壳的退出路径**。`packages/desktop/main.cjs:254-261` 的 `before-quit` 注释写着"服务器持有着打开的事件流和活会话；关闭它们才能让进程真正退出，而不是等一个永不结束的响应"——这条关停顺序假设会随常驻连接而变（一条**没人会主动结束**的常驻响应正是最坏情况）。`docs/architecture.md:263` 把"泄漏的流 = 关不掉的服务器"当成承重事实。本票要决定用哪个冒烟证明关停仍然能完成——`scripts/smoke-boot.ts:38-47` 今天已经断言了"关闭后拒绝连接"，够不够。

   **研究票 02 把这条事实修正了**（`../research/sse-multiplex.md` Q3，实测挂起 3 s）：结论**成立**，但**机制描述不准确**——不是"资源泄漏 / 占着 socket 到进程结束"，而是"**只要有一条响应没结束，`server.close()` 的 `'close'` 事件与回调就不发生**"。而且**有明确出口**：`server.closeAllConnections()`（Node v18.2.0+）本仓库从未提及。**传输切换后的新事实**：WebSocket 连接要经过 HTTP `upgrade`，升级后的 socket 在 `server.close()` 记账里是什么地位**未确认**——DSH 的 WebServer 在 `upgrade` 时把 socket 自己记入 `upgradedSockets`、服务关闭时统一 `destroy()`（`../research/dsh-portability.md` §4 末尾），这正是"close 覆盖不到它们"的先例证据。本票要决定：本仓库照做，还是先让票 17 核实 Node 是否已经替你做；冒烟是断言"常驻连接下进程仍然能退出"，还是顺手改用 `closeAllConnections()` 让退出不依赖"每条流都被礼貌地结束"。

## Answer

### 结论（一句话）

**抽两个共享装置、放 `scripts/wire/`（一个 wire 客户端 `client.ts`、一个可故障的中继 `proxy.ts`），
五处六份手写帧解析器收成一份；四条验收边各有明确归属——第 1 条与第 2 条的"主动丢弃"那半归新脚本
`smoke-mux.ts`（wire 表面的家），第 2 条的"断连再连"那半与第 4 条归新脚本
`smoke-liveness.ts`（而它**不重写 watchdog，直接驱动生产连接层**——重写一个 watchdog 去断言 watchdog
是同义反复——装置是一条"黑屏但不关连接"的中继），第 3 条落在 `smoke-stream.ts` 的新段落与
`smoke-mux.ts` 的第 7 条；票 11 的停滞规则改由注入假 socket 的新脚本
`smoke-backpressure.ts` 驱动，**不做**票 11 决定 8 里那条"真客户端 + `socket.pause()` 的对端"；
关停的判据是"常驻连接 + 一个没人会回答的审批在场时 `close()` 在预算内返回，且**不调用
`process.exit`** 的进程自行退出"，实现侧由 mux 自己持有 upgrade 后的 socket 并在 `close()` 里
`destroy()`，**不**依赖 `closeAllConnections()` 当机制。**

下面第 0 节先更正五条会改变答案形状的事实，第 1–4 节按票面四问回答，末尾是决定记录、落点与
"本票没有回答的"。

---

### 0. 事实校正：五条，每一条都改变一个答案的形状

1. **票面那两处 `smoke-approval.ts` 行号是票 13 落地之前的快照。** `pump()` 今天在 `:121-147`（票面
   写的 `:123-135` 正落在它的循环体里，仍对得上），另一处 `attach()` 里的 `pump()` 在 `:480-500`；
   票面的 `:392-404` 指的是**旧文件**里那个同名函数——我 `git show b857b9b^:scripts/smoke-approval.ts`
   核过，旧文件 `:390-404` 就是它，票 13 往文件里插了 90 行，于是它漂了。**结论不变：是两个函数。**
2. **复制的份数是五处、六个函数，不是五份。** `feed()`（`scripts/smoke-stream.ts:70-118`）、
   `readStream()`（`scripts/smoke-api.ts:52-78`）、`collectFrames()`（`smoke-api.ts:126-156`）、
   `smoke-boot.ts:30-34`（内联，连函数都不是）、`pump()` ×2（`smoke-approval.ts:121-147`、
   `:480-500`）。生产侧那份在 `packages/web/src/client.ts`，但它交给 `EventSource` 解析（`:116`），
   所以**手写的**解析器确实只有这六个。
3. **`npm run check` 一行都不看 `scripts/`。** 根 `tsconfig.json` 的 `include` 只有
   `packages/core/src/**/*.ts` 与 `packages/server/src/**/*.ts`。实测：把 `scripts/**/*.ts` 加进
   `include` 立刻报出 **35 个既有错误、分布在 6 个文件**（`fake-transport.ts` 19 个、
   `install-deps.ts` 6 个、`smoke-session.ts` 5 个、`smoke-approval.ts` 3 个（含那条**明令保持原样**的
   `new SessionHub({ workspaceRoot: root })`）、`smoke-tools.ts` 1 个、`smoke-models.ts` 1 个）。这一条
   决定第 1 节(d)里"装置进不进 check"。
4. **Node 的全局 `WebSocket` 不暴露底层 socket。** 本机 Node v24.15.0（引擎下限 22.19）：原型上只有
   `close / send / readyState / bufferedAmount / binaryType / url / extensions / protocol / on*` 与四个
   常量，没有 `socket`、没有 `pause()`。所以票 11 决定 8 里那句"冒烟用票 15 的 WS 客户端 + 一个
   `socket.pause()` 的对端"**做不出来**（`pause()` 是 `net.Socket` 的方法）：要么为冒烟手写一份
   RFC6455 客户端去拿 socket，要么把这条断言改到 mux 写侧的注入 seam 上。本票选后者（第 3 节第 5
   条），并把那条端到端证据留在 `prototype/backpressure-stalled-peer.mjs`。同一处事实还说明：pong 也
   不可见，所以冒烟同样不许对 pong 断言。
5. **票面引的 `docs/notes.md:31-33` 是另一条规则的位置。** 那三行是"`packages/ai` 与 `packages/agent`
   一行都不改"那一节；"**测试一次运行不需要供应商密钥**"在 `:35-37`（标题在 35、正文在 37）。规则本身
   不变，被改的只是引用——本票的装置与它一致（见第 1 节(b)末尾那条"两条不许破的规矩"）。

一条**可行性证据**（它是第 1 节(c)能成立的前提）：`packages/web/src/client.ts` 今天在 Node 下
import 得动（实测 `node -e "import('./packages/web/src/client.ts')"` 成功）——它只在**运行时**碰
`EventSource`，模块作用域是干净的。"客户端连接层可以在 Node 下被驱动"因此不是新架一层，而是**保住
一个已经成立的性质**。

---

### 1. 共享装置：**两个，放 `scripts/wire/`**；客户端那半**不抽**，直接驱动生产连接层

#### (a) 抽什么

```ts
// scripts/wire/client.ts —— 冒烟用的 wire 客户端（Node ≥22 的全局 WebSocket，不引入 ws）
export interface WireClient {
	/** 发一个上行帧：故意发畸形帧也要能发，容错规则本身是被测对象。 */
	send(frame: ClientFrame | Record<string, unknown>): void;
	/** 订阅一个会话，并断言这条逻辑流的第一帧是 baseline；返回那份快照。 */
	open(sessionId: string): Promise<SessionSnapshot>;
	cancel(sessionId: string): void;
	/** 这条逻辑流上收到的 item（`streamId` 就是它），按到达顺序。 */
	items(sessionId: string): readonly ServerMessage[];
	/** 连接级载荷（`streamId === null`）：heartbeat / sessions / session_row，一栏都不属于它们。 */
	connection(): readonly unknown[];
	/** 等到这条流上第一个满足 `match` 的帧；超时回 undefined——"什么没到"要用它断言。 */
	waitFor(sessionId: string, match: (message: ServerMessage) => boolean, ms?: number): Promise<ServerMessage | undefined>;
	/** 这条流的终帧与错帧：`{ ended, errors }`。 */
	endOf(sessionId: string): { ended: boolean; errors: readonly string[] };
	/** 原始信封，供断言信封本身。 */
	readonly frames: readonly ServerFrame[];
	/** 连接被关闭时的 code / reason（**不断言取值**，见第 3 节）。 */
	closed(): Promise<{ code: number; reason: string }>;
	close(): Promise<void>;
}
export function connect(url: string): Promise<WireClient>;
```

**它叫 `WireClient` 而不是 `Channel`**：`channel` 在本仓库已经**是票 07 的连接状态字段名**
（`connecting | live | down`，见第 3 节第 4 条），两个东西共用一个名字会让人读不动
"`channel === "live"`"到底说的是哪一面。文件叫 `client.ts`、类型叫 `WireClient`、用它的脚本里那个
实例叫 `wire`。

```ts
// scripts/wire/proxy.ts —— 一条可以出故障的 TCP 中继（装置，不含任何断言）
export interface FaultyProxy {
	readonly url: string;                 // 客户端连这里
	/** 停止把服务端方向的字节转给客户端，但**继续读、继续丢**——socket 不关。 */
	blackout(on: boolean): void;
	/** 黑屏期间被丢掉的东西：服务端一直在说话的证据。 */
	readonly dropped: { bytes: number };
	/** 客户端连了几次：重连的证据。 */
	readonly connections: number;
	close(): Promise<void>;
}
export async function faultyProxy(target: URL): Promise<FaultyProxy>;
```

两条形状上的规矩，各有一个理由：

- **`WireClient` 的读侧遇到畸形信封要响亮地失败**，与浏览器那份 `parseServerFrame`（票 05 第 6 条：只
  校验信封、其余容错）**故意相反**。所以它**不是**"第三份复制的解析器"：被复制的那六份是同一个
  **沉默**的东西，而冒烟的读者是**断言工具**——它宁可当场炸，也不肯把"服务端发了个坏帧"读成"这帧
  我认识但不处理"。这也正是它不 import 浏览器那份解析器的理由：容错器会把冒烟要找的 bug 吞掉。
- **`streamId: null` 的帧只进 `connection()`，永不进 `waitFor(sessionId, …)`，也不进 `open()` 的
  "第一帧"判据**（票 07 在本票 `## Comments` 里登记的那条要求）：常驻通道上一帧心跳就能让"第一帧是
  基线"随机失败。同理，`open()` 之前到达的连接级帧不改变任何东西。

#### (b) 为什么放 `scripts/`，不放三个 package 里的任何一个

- **不放 `packages/server`**：服务端是**被测物**，让它导出自己的测试客户端是把断言建立在被测物的
  善意上；而且 `AGENTS.md` 的布局里 server 只有"整个服务器"这一个出口。
- **不放 `packages/core`**：core 没有传输层（"没有传输层"是它的定义），wire 客户端放进去等于给它加
  一个传输。
- **不放进 `packages/web`**：那份是容错器（见上），职责不同。
- **不叫 `fake-*`，也不进 `scripts/fake-transport.ts` 那个位置**：`scripts/fake-transport.ts` 是
  **模型**传输替身，地图与 `AGENTS.md` 都明令别混。新目录 `scripts/wire/` 的语义是"**wire 侧的
  装置**"，与"模型传输替身"各占一个名字、各占一个位置，谁也不冒充谁。`fake-transport.ts` 原地不动。

**两条不许破的规矩**（票面点名的那条在第一条）：① **测试一次运行不需要供应商密钥**——两个装置只碰
wire，模型一律仍由 `fake-transport.ts` 提供，而 `smoke-liveness.ts` 的核心断言（判死）**不需要任何
会话**——它测的是连接本身，只有"重连之后逐条重放 `open`"那一半才要一个会话；② **`fake-transport.ts`
的职责不变**，它只替模型传输，不因为冒烟换了传输而改一行。

#### (c) 客户端那半**不抽**：`smoke-liveness.ts` 直接驱动生产连接层

验收第 4 条（"客户端能在不发请求的情况下发现连接已死"）的判据在**客户端**。在冒烟里重写一个
watchdog、再断言"我的 watchdog 会响"，是同义反复——它证明的是脚本自己。所以：

> **`scripts/smoke-liveness.ts` import 生产连接层（票 07 的 `MuxClient` 与订阅集合）本身。**

这条给落地压一个**硬约束**（也是一条好设计）：票 07 的连接层必须

1. **DOM-free**——不碰 `document`，`window` 只碰必需面（`online` / `offline` 要么注入，要么用
   `typeof window !== "undefined"` 兜住），渲染层它一行都不 import；
2. **可注入 socket 与计时器**——冒烟要把心跳间隔与客户端容差一起降到毫秒级（票 07 已经定了客户端
   容差按服务端报的 `everyMs` 的 3 倍推，所以**只要服务端那个 option 可注入，客户端就跟着快**），
   并且在"服务端不再发应用层帧"时能在容差内判死。

今天 `packages/web/src/client.ts` 已经满足第 1 条（第 0 节的实测）。这不是"新架一层"，是**不让它退化**：
哪一天有人往连接层里塞一句 `document.hidden`，`smoke-liveness.ts` 会立刻红。

#### (d) 进不进 `npm run check`：**进，但只进新的**

`include` 加四项：`scripts/wire/**/*.ts`、`scripts/smoke-mux.ts`、`scripts/smoke-liveness.ts`、
`scripts/smoke-backpressure.ts`。理由三条：

1. 共享装置是**所有**冒烟的地基，而它今天不在任何类型检查里（第 0 节第 3 条）——一份没人检查的
   地基不能承重；
2. 这条同时让 (c) 的第 1 条**由 tsc 执行**而不是靠自觉：根项目只有 `ES2023` + `types: ["node"]`，
   所以 `scripts/smoke-liveness.ts` 一 import 连接层，那个文件就被拉进这个程序，一旦它碰 `DOM`
   类型，`npm run check` 当场红。（顺带核实过：`@types/node` 在 `web-globals/fetch.d.ts` 里把
   `WebSocket` 声明成**全局**，所以裸 `WebSocket` 在 `lib: ES2023` + `types: ["node"]` 下就能通过
   `tsc`——冒烟不需要 import `node:http` 的同名导出。）
3. 旧文件那 35 个错误**不在本票范围**（其中一个是明令保留的怪异）。一次还清是另一件事，而且它会
   把"冒烟策略"这一票变成"顺手修 6 个文件的类型"——本票只保证**新写的东西一开始就干净**。

#### (e) 端口与装配：新脚本一律 `port: 0`，共享的是**装置**不是**装配**

- 新脚本用 `bootServer({ …, port: 0 })`（它今天就支持），共享装置只吃 URL，**不写死端口**。今天的
  `8086-8091` 是"并行跑两个冒烟就撞车"的既有债；重写到的 rig 顺手改成 0。
- **共享的 rig 不抽**：三个 rig 建的图不一样（单会话 / 多会话 / 手搭宿主 + 脚本化模型传输），共享的
  是**装置**（连一条通道、故障一条中继），不是**装配**。抽一个"万能 rig"会把三处各自的意图压成参数。
- **不引入 runner**（`npm run smoke:all` 之类）：好几个冒烟所需的装置根本不同（有的要一个外部服务器、
  有的要子进程、有的要注入的 socket），而 `AGENTS.md` 那条"跑**对应的** smoke"的价值正在"对应"。
  命令清单继续住在 `README.md` 的*验证一次构建*，本票只改那张清单的内容。

---

### 2. 逐条判定：**哪些断言语义变了、哪些只是字段名变了**

先把判据摆出来，逐条应用：

> **一问："这条断言的主语在新模型里还存在吗？"** 不存在 ⇒ 删除或换主语；存在但换了运载 ⇒ 改写；
> 存在且语义未变 ⇒ 只改字段名。

| 位置 | 今天断言的是 | 判定 |
|---|---|---|
| `smoke-stream.ts:148` | 会话起初空闲 | 保留 |
| `smoke-stream.ts:155-170` | 空闲流自我 `stream_end`、会话随即被回收 | **主语消失**（没有"空闲流"，`IDLE_GRACE_MS` 整条不存在）⇒ 换主语成"订阅不让会话活着、也不被回收" |
| `smoke-stream.ts:210-217` | `stream_end` 排在 `agent_end` 之后 | **反转**（D2 失效）⇒ 断言 `agent_end` 之后**没有**终帧，且流还能用 |
| `smoke-stream.ts:219-223` | 运行结束后会话被回收 | 保留，**理由换成 claim**（票 09 第 2 条） |
| `smoke-stream.ts:238-248` | 运行中附着；宽限不结束它 | **换主语**（"宽限不结束它"→"没有任何东西结束它"）＋新增"基线交代运行" |
| `smoke-stream.ts:192-197` | 未知 id 的流是 HTTP 404 | **换运载**：帧上 `error` 然后 `end`，且连接不断 |
| `smoke-boot.ts:28-36` | `/events` 的第一帧是落地会话 | 保留事实，换运载（`open` 后的 `baseline`）＋**必须走连接级过滤器** |
| `smoke-api.ts:305-307` | 注释说流 URL 也 404，代码只测读取端点 | **漂移**：随重写自然消失（见下） |
| `smoke-api.ts:354-359`、`:375-384` | 移动与新分支点作为新快照到达流 | **保留**（"一棵变了的树是所有人的事"），只改运载 |
| `smoke-approval.ts:121-147`、`:480-500` | 两处 `pump()` | 换装置（共享的 wire 客户端）；`EventController` 自建随票 05 §7 删除 |
| `smoke-sessions.ts:89,90,123` | `hub.claim()` 不带 id | **改写**（票 09 决定 6）：`currentSessionId()` → `claim(id)` |
| `smoke-tools.ts` / `smoke-models.ts` / `smoke-session.ts` | 不碰 wire | **不动**（`packages/server` 只被 `smoke-stream` / `smoke-approval` / `smoke-boot` / `smoke-sessions` 四个 import；`smoke-api` 不 import 它，只对着一个外部进程发 HTTP） |

逐个脚本说清楚。

#### `smoke-stream.ts`：主题收窄成"**claim 决定会话活多久，订阅不决定**"

文件不改名（它讲的就是会话的内容流，改名买不到东西、却要动两处文档清单），但头注释与
`:346-353` 那段"被侧的是 registry 的 idle grace"要重写：新模型里被侧的是**订阅不拿 claim**与
**运行自己拿一条 claim**。

- **`:155-170` 换成三条更硬的**：
  1. `open` 一个空闲会话 ⇒ 第一帧是 `baseline` 且 `submitting === false`；
  2. 这条逻辑流在**若干倍 idle grace** 之后仍然活着（没有 `end`、连接没关）——常驻通道里"服务端主动
     结束一条流"只有两种情况，而都不是它（票 05 第 3 条）；
  3. **同一时刻 `hub.live` 里没有它**，而且**订阅路径上一次 `hub.claim` 都没发生**——后者照
     `docs/notes.md` §二 bug 4 办：**数 `hub.claim` 的调用次数**，不数 `hub.live`（释放发生在
     `finally` 里，一个 tick 就回收完，`live` 看不见任何东西）。
  "流报告了自己的结束""响应随后结束"这两句**删除**：`stream_end` 的继任者 `end` 说的是"这条订阅到此
  为止"，而它在"看着空闲会话"这一幕里不该出现。
- **`:210-217` 反转**成两条：运行结束后**没有** `end` 到达；且同一条逻辑流**还能用**（同一会话再
  POST 一次，`event` 帧照常到）。这是"运行结束不再结束流"唯一的可判定形式。
- **`:219-223` 保留**："运行结束之后会话被回收"依然为真，但**不是因为流结束了**，而是因为运行那条
  claim 随启动它的 `prompt` 调用 settle 而释放、且没有别的 claim（票 09 第 2 条）。注释必须跟着改，
  否则下一个人会照旧读成"流结束触发的回收"。
- **`:238-248` 换主语**：① `open` 一个正在跑的会话 ⇒ 基线里 `submitting === true`（票 06：基线
  交代运行）；② 这条逻辑流在 `idle grace × 6` 之后仍活着——但断言的理由换成"**没有任何东西**会结束
  它"。"两条流都被那次运行结束"整段删除。
- **新增两段**（票 08 与票 09 各给了一条可断言的形式）：
  1. **形状 C**：把 `sessionManager.appendMessage`（或某个 `agent_end` 监听者）打成抛一次，跑一轮，
     **同一个装置跑两次**——**挂一条逻辑流**的那次断言 ① 这条流收到 `item: { type: "error" }`；
     ② **随后**收到 `status` 且 `submitting: false`（票 08 决定 3：`finally` 必须发这一帧）；
     ③ 会话被回收（claim 没泄漏）；④ `console.error` 里有一条服务端日志（进程内冒烟直接 monkeypatch
     `console.error` 收一行——这是"日志存在"唯一确定性的断言办法）。**一条流都不挂**的那次只断言
     ④ 与会话被回收：这正是票面点名的"**无人观看时运行失败**"（D3 在失败那一侧的替代物，票 08 的
     形状 C——"收件人是空集合时，日志是唯一还听得见的落点"）。**别把 ④ 写成"帧上说了一次"**。
  2. **无人观看的运行照样守着会话**（票 09 Comment 1 给的形式）：不 `open` 任何逻辑流，直接 POST ⇒
     运行期间 `hub.live` 含它、运行结束后不含。这是验收第 3 条在服务端的半边。

#### `smoke-mux.ts`（**新**）：wire 表面的唯一家

**它为什么是新文件**：今天没有一条冒烟碰过信封、分道、连接级帧或上行容错；把它们塞进
`smoke-stream.ts` 会让那一份同时讲"claim 的生命周期"和"wire 的形状"两件事，而两者的 rig 也不同
（单会话 vs 多会话）。`AGENTS.md` 的规则里"HTTP 表面用 `smoke-api.ts`"这一句落地时要加一条对偶：
"**wire 表面用 `smoke-mux.ts`**"。

断言清单（每条都只依赖真 socket，不断言任何未核实事实）：

1. **连接级**：连上后收到 `sessions` 基线（`SessionRow[]`，票 10）与 `heartbeat`；**两者都到**即可，
   **不断言谁先**（票 07 在本票 `## Comments` 里登记：基线可能先于心跳）。
2. **分道与替换**：`open(id)` 的第一帧是 `baseline` 且 `streamId === id`；**重复 `open` 同一个会话
   是替换**（第二份基线，不是第二条流——票 05 第 1 条）；`cancel(id)` 之后该 `streamId` 再没有帧。
3. **`open` 失败**：未知 id ⇒ 该流上先 `error`、再 `end`（票 05 决定 5 + 票 14 的窄缝），而且
   **连接不断**、别的流照常。这条接替了旧 `smoke-stream.ts:192-197` 的 HTTP 404。
4. **上行容错**：发一个看不懂的 `type`、再发一段非 JSON ⇒ **连接不断**（票 05 第 2 条），别的流
   照常。（这是 `WireClient.send` 必须能发任意对象的原因。）
5. **验收第 1 条**：**一条连接上两个会话**（一个在跑、一个空闲），每一帧只出现在它自己的
   `streamId` 上，各自的 transcript 逐条更新；空档期照收心跳。
6. **验收第 2 条**：`cancel` 之后**从别处**改这个会话（REST POST 一条消息，或第二条连接发一次
   prompt），再 `open` ⇒ 新基线是"现在长什么样"，且**是替换不是追加**（拿 `items` 比基线的
   `messages.length`，不是旧数 + 新数）。
7. **验收第 3 条的概况半边**（票 10 Comment 3 给的可判定形式）：**一个逻辑流都不开**，POST 一次 ⇒
   连接级仍收到那一行的 `session_row`：`running: true`，随后 `running: false` 且 `modified` 前进。
   这是"后台会话那一行照常更新"唯一的可判定形式。
8. **不在这里断言的**：`end` 之后"不重开"（那是客户端订阅集合的事，归 `smoke-liveness.ts`）；
   服务端侧只说一条——**发出 `end` 即删掉那条条目**（`cancel` 的语义"之后没有帧"必须保住，票 05
   第 3 条）。

#### `smoke-boot.ts`：只换"落地会话"那一段

前四件事（客户端被服务、`/api/health`、`/api/models`、`GET /api/sessions/current` 与
`hub.currentSessionId()` 一致）**原样保留**。第五件（`:28-36`）换成：用共享的 wire 客户端连上、`open`
落地会话、断言那条流的**第一帧是 `baseline` 且 `session.id === sessionId`**——**必须走连接级过滤器**，
否则连接上的第一帧可能是一帧 `sessions` 或 `heartbeat`。第六件（关闭后拒绝连接）保留，并按第 4 节
补两条更强的。

#### `smoke-api.ts`：REST 全保留，三处动

REST 那一半（health / models 往返与重名 400 / settings 409 / 列表 / 404 / 树 / fork / 分支的错误码）
**一条都不改**——它测的东西与传输无关，而且 `MY_AGENT_URL` 这个"外部服务器"约定要保留：它测的是
"客户端对供应商一无所知"的另一半，一个真的独立进程。

1. **树那两条断言（`:354-359`、`:375-384`）：保留事实、换运载**。`frame.type === "session"` →
   `item.type === "baseline"`，走 `wire.waitFor`。断言的内容（"一棵变了的树是所有人的事"）在
   新模型里一字不变——票 06 把 `branch_changed` 触发的全量快照定成一次**基线替换**，所以它到的地方
   仍然是那条逻辑流。
2. **"脚本必须另持一条 claim"这个前提删掉，并把它的消失变成一条新断言**：票 09 给 `hub.reap()` 装了
   守卫（`SessionManager.hasUnrecordedLeaf()`），于是"移动之后**不 attach 任何东西**也让移动生效"
   从"做不到"变成"可断言的正确行为"——移动 → `GET` 确认 `leafId` 是那个 entry → **不 attach**
   直接 POST 下一条消息 → 运行结束 → `GET` 到 `branchPoints` 里有它。`docs/notes.md` §五 bug 3 那段
   注释改成"这一段曾需要一条流的 claim 来保住内存里的 leaf；票 09 之后由 `reap()` 的守卫保住"。
   **登记给票 18**：leaf 可持久化之后守卫删掉，这条断言要重新表述成"因为 leaf 落盘了"，**不是删掉它**。
3. **那处漂移（`:305-307`）：修，但不单独修。** 旧注释说"未知会话在**流 URL** 上也必须是 404"，
   而代码只请求了读取端点——新模型里"未知会话的流"没有 HTTP 状态码可断言了（它成了帧上的 `error` +
   `end`，归 `smoke-mux.ts` 第 3 条）。所以重写时这句话**自然消失**：注释改成"未知 id 的**读取**是
   404"，并在旁边指一句"这条断言的对偶（流）在 `smoke-mux.ts`"。先单独改一行注释、落地时再改第二遍，
   是把同一句话搬两次。
4. 顺带：`readStream()` / `collectFrames()` / `watch()` 三段换成共享的 wire 客户端；`handleFrame` 里
   `session` → `baseline`、`session_event` → `event`（其余五个成员名字不动）。
5. **票 10 在本票 Comments 里登记的那条（列表应答从 `SessionRef` 变成 `SessionRow`，"凡手工构造过
   `SessionRef` 期望值的地方都要跟着改"）在这两个脚本上**没有落点**：我核过 `scripts/` 里没有一处
   提到 `SessionRef`，脚本读的是 `id` / `parentId` / `sessions` / `submitting` / `messages` /
   `branchPoints` 这些字段。所以"REST 那一半一条都不改"与那条登记不冲突——多出来的
   `modified` / `running` / `pending` 的消费者在别处（票 10 §7 那张落点表）。

#### `smoke-approval.ts`：三件事

1. **装置**：两个 `pump()` 换成共享的 wire 客户端；`:98` 与 `:555` 两处 `new EventController(streams, hub)`
   随票 05 §7（删除 `/events` 与 SSE 传输层）一起删，改为从 `bootServer()` 拿图（或拿它导出的 mux
   工厂）。**禁令要读准**：`docs/notes.md` §一与地图的 Out of scope 管的是前半段那个
   `new SessionHub({ workspaceRoot: root })`（`:45`）与它手挂宿主那几行（`:86-88`），**不管**路由与
   传输那半——所以那个怪异**原样保留**，被删的只有 `EventController`。
2. **票 13 那段"三条流都听到同一个答案"**：**三条流 → 三条连接**（票 05 第 1 条：一条连接上一个会话
   至多一条逻辑流），其余逐字不变（每条连接的 `approval_settled` 都必须是那个真答案）。这里顺手把
   票 19 的舞台摆好：**同一个 `toolCallId` 出现在两个会话时不得串号**——那一条归票 19 落地时写，
   本票只指出舞台在哪（同一份 rig，两个会话，一个共享 id）。
3. **票 14 的两条**（都不依赖 WS 侧任何未核实事实）：
   - **重启之后基线里没有那次审批**：第一段（真服务器 + 脚本化模型传输）把一次运行停在审批上 →
     关掉 → **起第二个进程**：`spawn(process.execPath, ["packages/server/src/main.ts", "--cwd", root,
     "--port", String(port)], { stdio: "ignore", env: { ...process.env, MY_AGENT_HOME: home } })`，
     其中 `home = process.env.MY_AGENT_HOME ?? join(homedir(), ".my-agent")`（显式算出来，不靠继承），
     `port` 先用 bind-to-0 探一个空闲的（`main.ts` 拒绝 `port <= 0`）；**就绪判据是轮询
     `/api/health`**，不要去解析子进程的 stdout（`main.ts:144-147` 的 SIGTERM 处理器里有
     `process.exit(0)`，而 stdio 解析是另一个坑）。然后在**新进程**上用共享的 wire 客户端连上、`open`
     那个会话：断言那条流的**第一帧（基线）里 `pendingApprovals` 为空**，且 transcript 里那次工具调用
     **还在**。
     **别写成"重启后有一条 entry 记着它"**——那正是本票否掉的方向。这条断言真正杀死的是"有人顺手
     把待审批落盘"：新进程根本没有那次运行，所以它对"落了盘但没恢复运行"这种半吊子实现是红的。
   - **未知 `toolCallId` 答 409**：对不在 `pendingApprovals` 里的 id 调端点 ⇒ **409** 且响应体说明
     这个 id 不是待回答的审批；**顺手再断言真答案仍然是 200**（免得把闸门装到了正确路径上）；再挂上
     一条流跑一遍，确认**差量帧没有被这次失败请求污染**（票 13 的 `[true, false, false]` 那类断言的
     反面）。**别断言 404**——票 14 第 3 节明确否掉了它。

#### `smoke-sessions.ts`：三处机械改写

`:89`、`:90`、`:123` 三处 `hub.claim()` → 先 `currentSessionId()` 再 `claim(id)`（票 09 决定 6）。
另外两件**要说清但不写断言**：

- "生产代码里没有一处不带 id 的 `claim`"由签名本身保证（`claim(sessionId: string)`），不需要断言；
- "**每页加载只调一次 `/api/sessions/current`**"（票 09 决定 7）是**客户端**约束，它的可断言版本需要
  客户端被驱动——装置与第 1 节(c)是同一个 seam。今天没有它，所以本票把它**登记为未覆盖**（见末尾），
  不假装某条冒烟管着它。

---

### 3. 四条验收边与票 11 的那条规则：各归哪个装置、断言什么、**不许**断言什么

| 验收边 | 装置 | 断言的可观察形式 | 明确**不**断言 |
|---|---|---|---|
| 1 一条连接订阅 N 个会话 | `smoke-mux.ts`（共享的 wire 客户端） | 第 2 节 `smoke-mux.ts` 第 2、5 条：一条连接上两条逻辑流各自分道、各自的 transcript 逐条更新，重开同一个会话是替换 | 客户端**画**出两栏（只有 `npm run desktop:screenshot` 那类装置看得见，见末尾） |
| 2 丢弃后重挂、收敛到"现在" | **两个运载**：主动丢弃 → `smoke-mux.ts` 第 6 条；载体失败（断连再连）→ `smoke-liveness.ts` 第 5 步 | `cancel` → 从别处改动 → 再 `open` ⇒ 新基线是现在，且是**替换不是追加**；断连重连之后**同样**由新基线替换（视图等于新基线，不是旧状态 + 补发） | 缺口修复/重放（票 06 拒了游标） |
| 3 发送不依赖先 attach | `smoke-stream.ts` 新增段 + `smoke-mux.ts` 第 7 条 | 无人观看时：运行照样跑、会话照样守着、transcript 有结果（票 08 形状 A/B/C 各自的落点）；概况行照样 `running: true → false` | "客户端一定收到了"（没有订阅者时本来就没有收件人） |
| 4 客户端不发请求就发现连接已死 | **`smoke-liveness.ts`（新）**：生产连接层 + `proxy.ts` | 见下 | pong 可见性、close code、`reason` 文案 |

**第 4 条的步骤（逐条都要是可观察的）**：

1. 起一个 `bootServer({ port: 0, heartbeatMs: 50, … })`（**心跳间隔是可注入的 option**，照
   `StreamRegistryOptions.idleGraceMs` 的惯例；客户端的容差按它报的 `everyMs` 的 3 倍推，所以两个
   数字一起降到毫秒级，整段跑在亚秒级）；
2. 客户端（生产连接层）连**中继**的 URL：`channel === "live"`，至少一帧心跳到达；
3. `proxy.blackout(true)`：**中继继续读服务端、继续丢**（这一条是装置的关键——它不读的话测到的是
   服务端的停滞策略，而不是客户端的 watchdog），socket 不关；
4. 断言在容差（3 × `everyMs` + 余量）内 `channel === "down"`；
   **支点：`proxy.dropped.bytes > 0`**——**服务端一直在说话，客户端仍然判它死**。这正是"客户端判活的
   输入是应用层帧"的可观察形式，也是它对"pong 是否可见"（票 17）完全免疫的原因；
5. `proxy.blackout(false)`：断言 `proxy.connections` 变成 2（重连发生），`channel` 回到 `live`，
   且订阅集合为那个会话**重放了 `open`**（服务端第二次收到基线请求），并把那一栏的视图**替换成新
   基线**——这是验收第 2 条"断连再连"那一半的收敛断言（"主动丢弃"那一半在 `smoke-mux.ts` 第 6 条）。

**第 5 条（票 11 的停滞规则）：`scripts/smoke-backpressure.ts`（新），注入一个假 socket。**
**为什么不照票 11 决定 8 那条形状**：第 0 节第 4 条——全局 `WebSocket` 不暴露底层 socket，`pause()`
无从谈起；为它手写一份 RFC6455 客户端是拿一大块新代码换一条**已经有端到端证据**的断言
（`prototype/backpressure-stalled-peer.mjs`）。冒烟要的是确定性与速度，所以把这条规则钉在它的
**输入 seam** 上：mux 写侧接受一个"像 socket 的东西"（`write()` / 缓冲计数 / `close()`），冒烟注入
一个"写满之后一律返回 `false`、永不 drain"的替身，参数（字节预算 / 毫秒上限）全部注入。断言：

1. `write()` 返回 `false` 之后**不再直接 `write()`**（数调用次数，不看字节阈值——票 11 第 1 节那张
   表说的就是"`false` 出现的时刻不可预测、但它一到就必须停"）；
2. 应用层队列的字节数**从不越过**注入的预算；
3. 连接在停滞上限**之后**、且在容差内被关闭，服务端记下了那条日志；
4. **慢但在读**的对端：假 socket 开始排空之后，队列按序补发、**没有洞**（比对帧序列）——"宁可不丢"
   这条规则的可判定形式；
5. 内存只读 mux 自己的计数，**不读 RSS**（RSS 断言在冒烟里是噪声，票 11 的实测已经给过量级）。

**哪些断言属于 wire、哪些属于"直接调"**（票 11 Comment 2 点名要的那条清单）——判据是"这个事实**只有
经过真 socket 才存在**吗"：

| 类别 | 谁 | 为什么 |
|---|---|---|
| **wire**（真 `WebSocket` 或真 `net` 连接） | `smoke-mux.ts` 全部；`smoke-boot.ts` 的落地会话段；`smoke-api.ts` 的树两段；`smoke-approval.ts` 的审批往返与"三条连接"；`smoke-stream.ts` 里所有**帧**断言；`smoke-liveness.ts` 全部 | 信封、分道、连接级帧、心跳、`close`、背压的**对端**——这些事实的存在方式就是"线上来过一帧"，白盒复现不了 |
| **直接调**（不经网络） | `smoke-backpressure.ts` 的写侧（注入假 socket）；`smoke-stream.ts` 里对 hub 的白盒断言（`hub.live`、数 `hub.claim` 次数）；`smoke-sessions.ts` 全部；各 rig 的装配（手挂宿主、注入脚本化模型） | 要断的是**状态与计数**（队列字节、claim 次数、注册表内容），把它们经 socket 走一圈只会引入时序噪声；而"一个真不读的对端"那件事的证据已经在 `prototype/backpressure-stalled-peer.mjs` |
| **都不属于** | `smoke-tools.ts` / `smoke-models.ts` / `smoke-session.ts` | 它们连服务器都不 import（第 2 节末行） |

---

### 4. 桌面外壳的退出路径：**mux 自己持有 upgrade 后的 socket**，判据是"没有 `process.exit` 也能退出"

今天的顺序是 `streams.close() → hub.close() → server.close()`（`boot.ts:112-118`），三条进入口
分别是 `boot.close()`、`main.ts:144-147`（SIGTERM/SIGINT）与 `desktop/main.cjs:254-261`
（`before-quit` 里 `void closing.close()`，**不 await**）。

**承重事实**（研究票 02 Q3，实测挂起 3 s；`docs/architecture.md:263` 就是把这句当承重事实用的那一处）：
只要有一条响应没结束，`server.close()` 的 `'close'`
回调就不发生。换成常驻 WS 之后**新增的未知**是"upgrade 之后的 socket 在 `server.close()` 记账里是
什么地位"（票 17 第 4 问），而 DSH 的先例是"自己记 `upgradedSockets`、关闭时统一 `destroy()`"。

**决定：不依赖 Node 的记账，也不拿 `closeAllConnections()` 当机制。** mux 连接层自己持有它接下的每
一个 upgrade socket，`close()` 里 `destroy()` 它们（那时一条连接级终帧都不必发——整台服务器要走了）。
三条理由：

1. 这是唯一**不依赖未核实事实**的写法；
2. `closeAllConnections()` 会一并掐掉正在飞的 REST 请求，而关停时该被结束的东西已经有主人
   （`hub.close()` 先 `abort()` 再 `close()`），拿一把大锤替代顺序是丢信息；
3. 若票 17 实测出 Node 已经覆盖升级 socket，这段跟踪**冗余但无害**——删掉它的理由届时由一次实测
   给出，而不是由猜测给出。

**冒烟怎么证明（票面的问题）**：`smoke-boot.ts:41-48` 那条"关闭后拒绝连接"是**必要但不充分**的
（票面写的 `:38-47` 把前一行 `await server.close()` 也算了进来）——listener 不再接受新连接，与"进程
能退出"是两件事。加两条：

1. **进程自行退出**（**照抄 `smoke-boot.ts` 今天的形状**：它已经是唯一一个**完全不调用 `process.exit`** 的冒烟，只设 `process.exitCode`——今天六个脚本以 `process.exit(...)` 结尾（`smoke-tools` / `smoke-models` / `smoke-session` / `smoke-sessions` / `smoke-stream` / `smoke-api`），`smoke-approval.ts` 以 `process.exitCode` 结尾但它的三个看门狗仍 `process.exit(1)`，而**显式 `process.exit` 会同时掩盖任何泄漏的句柄**）。装置：`bootServer`，一条常驻连接**订阅着**、并且有一次运行**停在
   审批上**（最坏情况：一个没人会主动结束的响应 + 一条 claim + 一条常驻 socket）→ `await close()`
   → 断言它在预算内返回 → 然后**让脚本自然结束**，并挂一个 **`unref()` 的看门狗**
   （`setTimeout(..., 5000).unref()`）：循环若排空了，进程在看门狗之前退出（`unref()` 的定时器不阻止
   退出）；若还有 socket 或运行挂着，看门狗到期、报 FAIL、`process.exit(1)`。这是"关得掉"唯一的
   **直接**证据，而且不依赖任何未核实事实。
2. **子进程那条路**：第 2 节票 14 的第二个进程在**开着常驻连接**时收 `SIGTERM`，断言 `exit` 事件
   在预算内到达。**限度必须写下来**：`main.ts:144-147` 的 shutdown 里有 `process.exit(0)`，所以它
   证明的是"外壳能把服务器放下去"，**不是**"事件循环自己排空"——后者只有第 1 条能证。本票**不改**
   `main.ts` 那句（CLI 的行为不是本票的题目），只登记这条不对称。

`desktop/main.cjs:254-261` 那段注释在新模型下**字面上已经不对**（没有"响应"这个对象了），落地时改成
"服务器持有着常驻连接与活会话；`close()` 自己接管它接下的 socket，所以进程不必等一条永不结束的响应"。
**`void closing.close()` 不 await 这一条不动**：Electron 的 quit 不等它，进程退出本身会关掉 socket；
本票要保的是 `close()` 自己能返回。

---

### 决定记录（下游可以直接依赖的）

| # | 决定 | 直接约束谁 |
|---|---|---|
| 1 | 共享装置**两个**，放 `scripts/wire/`：`client.ts`（wire 客户端 `WireClient`，读侧遇到畸形信封**响亮失败**、`send` 能发任意对象）与 `proxy.ts`（可故障中继，黑屏时**继续读继续丢**）；五处六份手写解析器收成一份；与 `scripts/fake-transport.ts`（**模型**传输替身）各占一个位置 | 落地、12 |
| 2 | 冒烟**不重写** watchdog：`smoke-liveness.ts` 直接驱动生产连接层；因此票 07 的连接层必须 **DOM-free**、可注入 socket 与计时器 | 07、落地 |
| 3 | `npm run check` 的 `include` 加 `scripts/wire/**/*.ts` 与三个新脚本；旧文件那 35 个既有错误**不在本票范围** | 12、落地 |
| 4 | `smoke-mux.ts`（新）= wire 表面的家（信封、分道、替换、`end`、连接级三类载荷、畸形容错）+ 验收第 1 条 + 第 2 条的"主动丢弃"那半 + 票 10 第 7 条那条概况断言；第 2 条的"断连再连"那半在 `smoke-liveness.ts` 的重连步骤里 | 落地 |
| 5 | `smoke-stream.ts` 主题收窄成"claim 决定会话活多久，订阅不决定"，新增票 08 形状 C 与"无人观看的运行"两段；`smoke-api.ts` 树断言换运载并新增"无持有者的移动仍生效"；`smoke-boot.ts` 只换落地会话那一段 | 落地、18 |
| 6 | 票 14 的两条落在 `smoke-approval.ts`：第二个进程用**真子进程**（`main.ts` + bind-to-0 探端口 + 轮询 `/api/health` + 显式 `MY_AGENT_HOME` + `stdio: "ignore"`） | 14、落地 |
| 7 | 票 11 的停滞冒烟改成**注入假 socket**的装置，不做"真客户端 + `socket.pause()` 的对端"（全局 `WebSocket` 不暴露底层 socket）；端到端证据留在原型脚本 | 11、17、落地 |
| 8 | 关停：mux 自持 upgrade 后的 socket、`close()` 里 `destroy()`；**不**拿 `closeAllConnections()` 当机制；判据是"常驻连接 + 无人能答的审批在场时 `close()` 在预算内返回，且无 `process.exit` 的进程自行退出"（照抄 `smoke-boot.ts` 今天的形状：显式 `process.exit` 会掩盖泄漏的句柄） | 12、17、落地、desktop |
| 9 | 新脚本一律 `port: 0`，共享装置只吃 URL；不抽共享 rig（共享的是**装置**不是**装配**）；不引入 runner | 落地、README |
| 10 | **明确不断言**的清单：pong 可见性、`1013` / `4000` 的送达、`backgroundThrottling` 幅度、upgrade socket 在 `server.close()` 里的记账、浏览器连接池上限 | 16、17 |

### 落点（本票只产出决定，代码一行未动）

| 落点 | 内容 | 归谁 |
|---|---|---|
| `scripts/wire/client.ts`（新） / `scripts/wire/proxy.ts`（新） | 第 1 节的两个装置 | 落地 |
| `scripts/smoke-mux.ts`（新） | 第 2 节的 8 条 | 落地 |
| `scripts/smoke-liveness.ts`（新） | 第 3 节第 4 条 | 落地（依赖票 07 的连接层 seam） |
| `scripts/smoke-backpressure.ts`（新） | 第 3 节第 5 条 | 落地（依赖 mux 写侧的注入 seam） |
| `scripts/smoke-stream.ts` / `smoke-api.ts` / `smoke-boot.ts` / `smoke-approval.ts` / `smoke-sessions.ts` | 第 2 节逐脚本的判定 | 落地 |
| `tsconfig.json` | `include` 加 `scripts/wire/**/*.ts` 与三个新脚本 | 落地 |
| `README.md`（*验证一次构建*）与 `AGENTS.md`（命令/规则里"HTTP 表面用 `smoke-api.ts`"那一行） | 命令清单加三个新脚本；补一条对偶"**wire 表面用 `smoke-mux.ts`**" | 落地 |
| `packages/web/src/`（票 07 的落地） | 连接层 DOM-free、可注入 socket 与计时器 | 票 07 的落地 |
| mux 连接层 | 自持 upgrade socket 并在 `close()` 里 `destroy()`；写侧接受可注入的 socket 式替身；`heartbeatMs` / 停滞预算与上限是**可注入的 options** | 落地 |
| `packages/desktop/main.cjs:254-261` | 注释按第 4 节改写（`void closing.close()` 不动） | 落地 |
| `docs/notes.md` §三 与 `docs/architecture.md` 的*会话树*那段（`:434`） | 那两段讲的"`scripts/smoke-api.ts` 的绕法：为移动之后的那次运行 attach 一条流"随票 09 的守卫**不再需要**，句子要跟着改（今天它们仍然为真——守卫还没落地） | 落地、18 |
| `docs/architecture.md:263` | "一条泄漏的流 = 一台关不掉的服务器"那句按研究票 02 的准确说法重写（ADR 的*顺手要修的两处已知漂移*第 2 条已登记），并补上新模型下写侧的那半句——本票第 4 节就是它的新读法 | 落地 |
| `docs/adr/0001-transport-websocket-mux.md` | **不提前改**（票 12/14 的惯例）。落地时把落地清单那一行"四个冒烟脚本｜五处各自的 SSE 解析器换成 WS 客户端"改成本票第 1 节的形状（两个装置 + 三个新脚本 + `include`），而第 147 行那个"关停判据归票 15"的问题由第 4 节回答 | 落地 |

### 本票没有回答的（别当成已定）

- **客户端"两栏画出来"没有自动判据**：验收第 1 条能自动断言的是服务端那一半（一条连接上 N 条逻辑
  流各自分道），两栏渲染只有 `npm run desktop:screenshot` 那类人工/半人工装置看得见——本票不假装
  它有自动判据。
- **"每页加载只调一次 `/api/sessions/current`"**（票 09 决定 7）今天**未覆盖**：它的装置与第 1 节(c)
  是同一个 seam，落地时若要断言，就加在 `smoke-liveness.ts` 的 rig 上（同一个被驱动的客户端）。
- `smoke-liveness.ts` 的容差余量、`smoke-backpressure.ts` 的注入参数取多少：落地时按实测选，只要
  远小于各自的判定上限。
- **服务端判死（票 07 的 2000 ms ping / 第三次 `terminate()`）没有冒烟**：客户端一侧看不见 pong，
  而服务端一侧要断言的"真死连接被终止"要一个真不回 pong 的对端——那是一个手写 RFC6455 的客户端，
  本票不建它（第 0 节第 4 条同源）。
- **票 17 若推翻第 2 条的可注入性**（例如浏览器 `WebSocket` 与 undici 分叉到无法共用一份连接层），
  那要改的是**装置**（多一份适配器或退回白盒驱动），不是"客户端判死"这条判定。

## Comments

**2026-10-12，票 07 解决时追加（本票仍 open，这里只登记两条影响本票的既有决定）**：

1. **验收第 4 条现在有明确的实现者，冒烟要照它写**：票 07 判定客户端判活靠**连接级应用层心跳** `{ streamId: null, item: { type: "heartbeat", everyMs } }`（服务端每 5000 ms 一帧）+ 客户端**读超时 watchdog**（15000 ms）。本票第 3 问里那条"需要一个假死连接的冒烟"应写成**只断言可观察行为**：连上之后服务端不再发心跳、也不关 socket，看客户端是否在容差内判死并重连。**不要**把断言写成"因为没有 pong 所以判死"——**pong 在 JS 侧是否可见是票 17 的未核实事实**，把它写进冒烟等于把一条猜测钉成判据。冒烟据以成立的前提只有一条、而且它本身可断言：**客户端判活的输入是应用层帧**（心跳），所以停掉应用层帧就必须触发重连。
2. **冒烟的帧过滤器要认识两类"不属于任何会话"的帧**：`streamId: null` 的心跳（票 07）与 `streamId: null` 的 `error`（票 05 第 2 条先定义、不实现）。所以第 2 问逐条判定断言时，凡"取第一帧""断言某一帧是 `session`"的地方，都要按"**先丢掉 `streamId: null` 的帧**"改写——否则常驻通道上一帧心跳就会让"第一帧是基线"这类断言随机失败。

**2026-10-12，票 09 解决时追加（本票仍 open，这里登记四条影响本票的后果）**：

1. **"一条流一条 claim"消失，"在飞的运行持有一条 claim"取代它**：claim 在运行的第一次写之前拿到、随启动它的那次 `prompt` 调用 settle 释放（票 09 决定 2；**不是**"观察 `submitting`"）。于是本票第 2 问里那几条围绕流的断言要按"没有流这个对象"重写：`smoke-stream.ts:155-170`（空闲流自我 `stream_end` + 会话被回收）与 `:238-248`（断言「宽限不结束它，结束它的是运行」，`scripts/smoke-stream.ts:245-248` 的注释就是这么说的）在新模型里**没有主语**；而"没人看的时候运行照样守着会话"可以直接断言成"运行期间会话仍在 `hub.live` 里、运行结束后才被回收"。
2. **`hub.claim()` 收紧成 `claim(sessionId)`**（无 id 的回落删掉，票 09 决定 6），所以 `scripts/smoke-sessions.ts:89,90,123` 三处要先 `currentSessionId()` 再 `claim(id)`——它同时让"每页加载只调一次 `/api/sessions/current`"这条客户端约束有一个可断言的版本（票 09 决定 7）。
3. **"订阅不拿 claim"有了可断言的形式**：订阅路径上**不得出现 `hub.claim` 调用**，照 `docs/notes.md:59` 那条"要验证就数 `hub.claim` 的调用次数"办；`smoke-stream.ts:391` 那种"直接 `hub.claim` 给测试台自己用"的用法不受影响。
4. **`smoke-api.ts` 那个顺序假设不再需要脚本自己撑**：notes §五 bug 3 是"脚本必须在移动期间另持一条流的 claim"，因为 leaf 只在内存；票 09 给 `hub.reap()` 加了守卫（不关闭有未落盘 leaf 的会话，决定 8），所以"移动之后不 attach 任何东西也能让移动生效"变成了**可断言的正确行为**——这一点在 leaf 可持久化（票 18）落地后要重新表述。

**2026-10-12，票 10 解决时追加（本票仍 open，这里登记新帧种类与一条类型变化）**：

1. **连接级（`streamId: null`）上共有三类载荷，外加一个已定义未实现的信封级形状**（票 05 / 07 / 10 定下之后；今天树上还没有）：票 07 的 `heartbeat`，票 10 的 `sessions`（每连接一次的基线，`SessionRow[]`）与 `session_row`（一行变了），以及票 05 第 2 条那个"先定义、不实现"的 `{ streamId: null, error: { message } }`（与 `item` 平级）。所以票 07 那条"先丢掉 `streamId: null` 的帧"的过滤器要一并认识它们——尤其**基线可能先于心跳到达**，把"第一帧是心跳"写进断言同样会随机失败。
2. **REST 列表的应答类型从 `SessionRef` 变成 `SessionRow`**（多了 `modified` / `running` / `pending`），而且它从此由服务端的投影 store 答：冷会话的 `running` / `pending` 是 `false` / `0`（构造上如此），`modified` 是最后一条带时间戳的 user/assistant 消息。冒烟里凡手工构造过 `SessionRef` 期望值的地方都要跟着改。
3. **一条可以断言的验收**（票 10 第 4 节的机制）：**没有任何会话订阅时，一条会话仍会产出概况帧**——`POST /api/sessions/:id/messages` 之后不 `open` 任何逻辑流，通道上仍应收到那一行的 `session_row`（`running: true`，随后 `modified` 与 `running: false`）。这是"后台会话那一行照常更新"唯一的可判定形式，本票值得给它一条。

**2026-10-12，票 11 解决时追加（本票仍 open，这里登记一条要写的冒烟与两处别写进断言的东西）**：

1. **票 11 的写侧策略需要一条冒烟，而装置已经有了**：判据是"**一个真的不读的对端会让服务端在预算内关掉这条连接，而不是无界增长**"。可直接搬的实验脚本是 `.scratch/client-server-refactor/prototype/backpressure-stalled-peer.mjs`（`node:http` 服务器 + 一个真不读的对端；跑 10 秒能看到"继续写"涨到 961 MiB RSS、"遵守背压"停在 24 KB）。冒烟版要改成：**用新的 mux 层**（`send()` 写若干帧 → 对端 `pause()` → 断言连接在停滞上限**之后**的容差内被关闭，且服务端内存有界）。**不要把 4 MiB / 10 秒写成被测常量**——它们是可注入的 `options`（照 `StreamRegistryOptions.idleGraceMs` 与 `HubOptions.approvalGraceMs` 的惯例），冒烟用毫秒级的值驱动，否则一条冒烟要跑 10 秒。
2. **`scripts/smoke-stream.ts:15` / `smoke-approval.ts:15` 自建 `EventController`**（票 05 §7 已登记）在新模型里连"这个类不存在"都算不上了：票 11 的队列与停滞策略落在**新 mux 的写侧**，而这些脚本要断言的是**传输表面**，所以它们要么改用真 mux 客户端，要么改测"帧是怎么产出的"。本票的清单因此多一条：**哪些断言属于 wire（走真客户端）、哪些属于注册表（直接调）**。
3. **一处别写进断言的东西**：票 11 在停滞超限时用 close code `1013` 关连接。这个取值的对齐（浏览器与 `ws` 是否都认）是**票 17 的待核实事实**（票 17 的 `## Comments` 里 2026-10-12 票 11 那一条的第 3 点），所以在票 17 给答案之前，冒烟只断言"**连接被关闭**（`close` 事件到达、且不早于停滞上限）"，**不要**断言 `code === 1013`。

**2026-10-12，票 14 解决时追加（本票仍 open，这里登记两条可断言的审批行为）**：票 14 判**待审批不跨重启存活**，并把"重启后横幅怎么撤"归给基线 + `end`，两件事都能在**不依赖 WS 侧任何未核实事实**的前提下断言，所以它们都属于本票清单里"用最小装置就能钉住的行为"：

1. **换一个进程之后，基线里 `pendingApprovals` 为空**——不需要任何新帧、也不需要等一帧通知：起一个真服务器，让一个会话停在待审批上（`scripts/smoke-approval.ts` 的第二阶段已经有这种装置），**把它关掉、用同一个 `MY_AGENT_HOME` 与 `--cwd` 起第二个进程**，然后断言新进程答出的基线（`GET /api/sessions/:id` 的 `session.pendingApprovals`，新模型下等价于那条逻辑流的第一帧）里**没有**那次审批，而 transcript 里那次工具调用**还在**。这条同时是"不落盘"这条决定唯一可判定的形式——**别把它写成"重启后有一个 entry 记着它"**，那正好是本票否掉的那个方向。
2. **对一个不在 `pendingApprovals` 里的 `toolCallId`，审批端点答 409**——今天答 200（`controllers/sessions.ts:445-461` 无条件返回）。断言写成"**状态码是 409**，且响应体里说明这个 id 不是待回答的审批"，**顺手再断言一次真答案仍然是 200**（免得把闸门装到了正确路径上）；挂上一条流再跑一遍，确认**差量帧没有被这次失败的请求污染**（票 13 的 `[true,false,false]` 那类断言的反面）。**别断言 404**——本票明确否掉了它（理由见票 14 第 3 节）。

**2026-10-13，票 17 解决时追加（本票的 Answer 一字未改；第 0 节第 4 条与决定 2/7/8/10 依赖的平台事实已到位，其中一条**改变装置**）**：

1. **"五处六份解析器收成一份 wire 客户端"可以照做，但"三份冒烟共用一份"要打折扣**：Node **22.19.0（undici 6.21.2）** 与 24.15.0（undici 7.24.4）在**失败语义**上分叉——① **握手失败时 22.19 只 fire `error`、`close` 永不 fire、`readyState` 停在 `0`（CONNECTING）超过 15 秒**（24.15 是 `error` + `close(1006)` + `readyState → 3`）；② **异常断线时 22.19 不发 `error`**（只有 `close(1006)`）；③ **协议违规时 22.19 不给对端回 Close 帧**。所以一份同时兼容两者的客户端**至少要把握手失败的判据同时挂在 `error`、`close` 与一个自己的超时上**（22.19 那一半只能靠超时兜住）——这正是本票末尾"票 17 若推翻第 2 条的可注入性，那要改的是**装置**"那句的兑现。
2. **第 0 节第 4 条结论不变**：22.19 的全局 `WebSocket` 同样不暴露底层 socket、也没有 `ping`/`pong`，所以决定 7 那条"注入假 socket"的改法原样成立。
3. **决定 10 的"明确不断言"清单可以照旧**（pong 可见性、`1013`/`4000` 的送达、节流幅度、upgrade socket 记账、连接池上限都已核实，但冒烟**仍然不必**断言它们）：`1013` 与 `4000` 实测两端都合法且原样送达、**不会混淆**；`backgroundThrottling` 只节流页面自己的定时器（10/s → 1/s）、**WS 投递零影响**——所以第 4 条那个"两个时间尺度降到毫秒级"的装置不受它影响。
4. **决定 8 那句"若票 17 实测出 Node 已经覆盖升级 socket，跟踪可删"有答案了：没有覆盖。** `server.close()` 的回调因为 `net.Server._connections` 照算这条 socket 而**永不发生**；`closeAllConnections()` 因为 http 解析器在升级那一刻 `parser.remove()` 把它摘出了自己的连接表而**看不到它**（Node v22.19 与 v24.15 实测一致）。所以"mux 自持 upgrade socket 并 `destroy()`"**不是冗余，是必须**。完整出处见 `../research/ws-multiplex.md`（装置 `../prototype/ws/`）。

**2026-10-13，票 18 解决时追加（本票的 Answer 一字未改；记那条登记给本票的冒烟断言的最终形式）**：

票 09 Comments 第 4 条登记的那条断言（"移动之后不 attach 任何东西，下一条 prompt 仍从移动后的 leaf
继续"）有了可落地的最终形状，在票 18 的落地清单第 3 条：**移动之后不 attach 任何东西 → 等会话被回
收 → 一条冷读（`GET /api/sessions/{id}`）报出移动后的 `leafId` → 下一条 prompt 仍从它继续**。回收斩
断了驻留的 `Agent`，冷读只能从文件回答——这正是"因为 leaf 落盘了"的可观察形式，也顺手断言了"关掉
窗口之后移动还在"（本票第 1 问第 2 半）。配对的 `smoke-session.ts` 断言（close → reopen 移动仍在；
没有 `leaf` entry 的旧文件按最后一条 entry 读）同在票 18 的清单里。落地时守卫**不写**：票 18 判定票
09 决定 8 的判据在新世界里不可定义，从落地清单上划掉了。

**2026-10-13，票 09 的文档改写收尾时追加**：ADR-0001 的*文档落点*登记在本票名下的那一问——"关停仍
能完成的判据是'断言常驻连接下进程仍然能退出'，还是改用 `closeAllConnections()`"——**已由本票 Answer
的决定 8 回答**（mux 自持 upgrade 后的 socket 并在 `close()` 里 `destroy()`，**不**拿
`closeAllConnections()` 当机制；判据是"常驻连接 + 一个没人会回答的审批在场时 `close()` 在预算内返回，
且不调用 `process.exit` 的进程自行退出"），并已被票 17 Comments 第 4 条实测坐实（`server.close()` 的
回调与 `closeAllConnections()` **都**覆盖不到 upgrade 之后的 socket）。落地形式就在
`scripts/smoke-boot.ts` 末尾：那条 `unref()` 的自然退出看门狗，加上子进程收 `SIGTERM` 在预算内
`exit`。`docs/architecture.md` 的 `## 谁拥有一个会话` 已按研究票 02 的准确说法重写（不再是"一条泄漏的
流就是一台关不掉的服务器"）。本票无剩余改动。
