# Spec：mux 劈成哑的 wire 与会话流的 stream

Status: ready-for-agent

## Problem Statement

维护者面前有三个互相纠缠的事实，读任何一处都要同时理解另外两处：

1. **`mux` 不是一台发帧机器。** 它 880 行里同时装着有界队列、背压、ping/心跳，和"什么是 baseline、哪个事件该带 entry、审批横幅什么时候收、哪个目录被放到一边"。所有这些会话语义都住在一个自称传输层的文件里——按本仓库的分层判据（"这个问题离开 HTTP/WS 是否成立"），它们一个都不该在这儿。
2. **hub 的两张表是同一份订阅信息的两半。** `watchers`（谁在观看）与 `feedMap`（谁要事件、谁要状态）以同一个 sessionId 为键，装的是同一批消费者；"新加一个消费者该挂哪张表"没有判据，只能靠读实现。名字也不说明结构：`feeds` / `SessionFeeds` / `SessionWatcher` / `eventListeners` / `listeners`，六个名字三个概念。
3. **侧栏这条最普通的路径要穿过三个模块。** 行由 projection 算、由 mux 广播、由连接逐个发。于是 mux 认识 projection、认识行、认识隐藏目录规则；而 hub——本该是"某个会话的事分给谁"的唯一答复者——对"这台机器上有哪些窗口"一无所知，那是唯一一件它不需要知道的事，但"把行发给所有窗口"这件事却被放在 mux 里，因为只有 mux 手里有那张连接表。

## Solution

把传输层劈成两半，并把 hub 收敛成一个通道化的 broker：

- **`wire`**：只会发帧。收 `ServerFrame`、写 socket、有界队列、背压与 `1013`、ping 与应用心跳、关停。不认识 sessionId，不知道 baseline 是什么。
- **`session stream`**：懂会话，不认识 socket。订阅 hub、装配 overview、把事件/快照翻译成帧、持有 baseline 前后的扣帧队列、审批横幅的读者计数、baseline 失败的措辞。全部通过 `wire.send` 写出。
- **`hub`**：一张 `Map<sessionId, Set<订阅>>`（一个会话的全体订阅者）+ 一个全局通道 `Set<全局订阅>`（这台机器上的列表）。projection 把行推给 hub，hub 扇出；hub 不看行的内容。
- **`mux`**：接线与存活探测。它拿到一个"从 socket 造出一条 session stream"的工厂函数，因此不需要 import 任何业务类型；它保留的连接集合只用于 ping/心跳定时器与关停。

净效果：`feedMap` 消失，hub 只剩一张按会话的表加一个无键的通道；`mux` 里再没有 `sessionId`、`baseline`、`pendingApprovals`、`branch_changed`、`listed`；侧栏广播从"mux 认识 projection"变成"projection 交给 hub、hub 扇出"。

**协议一个字不改，前端零改动。**

## User Stories

1. As a 窗口用户，I want 打开一个会话时仍然先收到 baseline、再按发生顺序收到其后的每个变更，so that 会话记录永远不会往回跳。
2. As a 窗口用户，I want 冷会话读盘期间到达的事件排在那份 baseline 之后，so that 我不会先看到增量、再看到它被初始状态覆盖。
3. As a 窗口用户，I want 对同一会话重复 open 只刷新状态而不重复订阅，so that 同一条连接上不会出现两份并行的事件流。
4. As a 窗口用户，I want 打开一个不存在的会话时仍然收到带归因的错误帧和干净的流结束，so that 面板给出明确失败提示而不是永远安静。
5. As a 窗口用户，I want 会话被删除时我正在观看的流以 end 干净收尾，so that 没有面板悬挂在等不来的事件上。
6. As a 窗口用户，I want 关掉窗口后后端立刻停止为它造帧，so that 关掉十个标签页不会留下十份无人接收的翻译工作。
7. As a 侧栏用户，I want 一个会话开始运行时它的行立刻变成"运行中"，即使我从未打开过它，so that 列表能当作进度板用。
8. As a 侧栏用户，I want 一个会话被删除时那一行消失，且顺序上先结束它的流、再让行消失，so that 界面不会先丢掉行、再收到一条来自"已不存在会话"的帧。
9. As a 侧栏用户，I want 被放到一边的目录不因为其中某个会话发生变更而自己回来，so that 隐藏是持久的而不是一次性的。
10. As a 侧栏用户，I want 目录进出列表时收到一整份新的列表而不是某种新消息形状，so that 客户端只需要认识一种"这是机器列表"的帧。
11. As a mux 维护者，I want mux 里不再出现任何 sessionId、baseline、事件语义，so that 它的全部代码只剩帧、字节、socket 存活。
12. As a mux 维护者，I want 通过一个工厂函数造连接的业务侧，so that mux 不需要 import hub / projection / 审批里的任何一个类型。
13. As a session stream 维护者，I want 每连接的业务状态（在订哪些会话、baseline 前扣住的帧、正在展示哪些审批）收在一个对象里，so that 断线时的清理是"把这个对象扔掉"而不是遍历若干张边表。
14. As a hub 维护者，I want 一个会话的全体订阅者住在一个 `Set` 里，so that "谁要这个会话的东西"只查一次表就答完，不必记住两个集合谁装谁。
15. As a hub 维护者，I want 订阅元素用"实现了哪几个可选方法"表达自己的兴趣，so that 窗口（要 baseline、要事件、要状态、要告别）与侧栏（只要事件、只要告别）可以同住一个 Set。
16. As a hub 维护者，I want "要不要初始状态"由元素自己声明，so that 侧栏不会为每一行去读一次盘。
17. As a hub 维护者，I want 活半/冷半的那处判定只存在一个地方，so that 快照读法变更只需要改一处；重发与首发共用它。
18. As a hub 维护者，I want 全局通道只转发不透明载荷，so that 它不会在半年后长出"如果是隐藏目录就跳过"这样的业务 if。
19. As a projection 维护者，I want 行变化只推给 hub 一处，so that 它不再需要认识 mux、也不需要知道有几个窗口。
20. As a 审批流程维护者，I want 两个窗口看同一会话时，"已同意"的答案只到达展示过那个审批的那些窗口，so that 一个会话的答案永远不会流到另一个会话，也不会流到从未显示过它的窗口。
21. As a 审批流程维护者，I want 后台记住的答案仍然只在"有订阅正在展示它"时存在，so that 没有读者的问题不会活得比进程还久。
22. As a smoke 维护者，I want 全部断言只看"客户端收到了什么帧、按什么顺序"，so that 我可以先写测试、再拆实现，而测试在拆分前后同样通过。
23. As a smoke 维护者，I want 不再有任何断言依赖内部表（例如"观看表里有没有人"），so that 这次重构不会因为"改写了断言它的测试"而失去安全网。
24. As a 代码审查者，I want 每层"允许知道什么"写成一张表并落在 ADR 里，so that 下一次有人想往 mux 里加一个 `if (sessionId === ...)` 时能被一句话挡住。
25. As a AFK 实施者，I want 一份明确的不变量清单（帧序、恰好一次、删除顺序、无循环依赖），so that 我不必从现有实现反推契约。
26. As a 桌面外壳维护者，I want 关机路径（停止运行 → 每条流收到告别 → 关闭 socket）时序不变，so that Electron 收摊不被本次重构影响。

## Implementation Decisions

### 分层与允许知道什么

| 层 | 知道 | 不知道 |
|---|---|---|
| `wire` | 帧、字节数、队列、stalled、ping、应用心跳、关闭 | 会话、事件、审批、目录、hub |
| `session stream` | 会话、事件语义、baseline 时机、审批读者计数、隐藏目录过滤、帧措辞 | socket、背压、`1013`、字节数 |
| `hub` | 一个会话有哪些订阅者、全局有哪些订阅者 | 帧、连接数、行的内容 |
| `projection` | 有哪些行 | 谁在看、有几个窗口 |
| `mux` | socket、存活定时器、连接集合 | 上面任何一样业务概念 |

### hub

- 一张按会话的表：`Map<sessionId, Set<订阅>>`，取代 `watchers` 与 `feedMap`。
- 一个全局通道：`Set<全局订阅>`。
- `订阅` 用可选方法表达兴趣（来自本次设计讨论，形状即决定）：

```ts
interface 订阅 {
  event?(e: AgentSessionEvent): void;
  state?(s: SessionSnapshot): void;
  baseline?(s: SessionSnapshot): void;   // 没有这个方法就不读盘、不交初始状态
  gone?(): void;                          // 会话被删除 / 进程收摊
}

interface 全局订阅 {
  rows?(row: SessionRow): void;
  gone?(sessionId: string): void;
}
```

- 公开面：`subscribe(sessionId, 订阅): () => void`、`publishRows(row)`、`publishGone(id)`、`publishResync()`（无载荷，通知"整表变了"）、`snapshotFor(id, sink)`（一次性交付：活半同步、冷半读盘、失败交原始 error）。
- `feeds()` / `SessionFeeds` / `SessionWatcher` / `feedMap` / `watchers` 全部删除。
- `subscribe` 的契约沿用现有一份：注册与交付在同一个同步块内完成；`baseline` 恰好一次；`gone` 只在删除或收摊时到达；退订宽容且幂等，且只清理"这一次订阅拿到的那一格"（迟到的退订不得替同 id 上后来的订阅清表）。

### session stream

- 每连接一个，构造依赖：`wire`、`hub`、`projection`、审批答案表。
- 自持 `Map<sessionId, 订阅>`：这既是"我在订什么"，也是断线时唯一的反向索引。
- `start()`：发应用心跳 → 发 overview（`projection.rows()` 过滤隐藏目录）→ 注册全局订阅。顺序即现状，因为客户端把先到的心跳当作"这条连接活着"。
- `open(id)`：已在订则走重发（`hub.snapshotFor`），否则造一个订阅元素（闭包里带 baseline 前的扣帧队列、本连接的待审批集合）挂进 hub，再取 baseline。
- `cancel(id)`：摘订阅、清待审批读者计数。
- `dispose()`：退掉所有订阅、摘全局订阅、让 wire 关闭。
- 目录过滤（隐藏目录规则）从 mux 搬到这里；它仍向 hub 询问规则本身（`listsDirectory`），因为规则只有一份。

### mux

- 保留：socket 升级、`accept`、连接集合、ping 与心跳两个定时器、关停。
- 连接集合的唯一用途是存活探测与关停；**它不再参与任何分发**。
- `accept` 收一个工厂：`(wire) => session stream`。因此 mux 不需要 import 任何业务类型。
- 删除：`open` / `cancel` / `bind` / `push` / `writeBaseline` / `pushBaseline` / `pushStatus` / `pushEntry` / `pushApprovalChanges` / `endStream` / `failBaseline` / `listed` / `overview` / `broadcastSessions` / `sendRow` / `sendGone`。

### 审批答案表

- 整张表**整体搬到业务侧**，由 boot 创建一份、注入每条流（跨连接共享），而不是拆成"记忆进 hub、计数留在流"。
- 理由：`remember` 的前提是"有订阅正在展示它"（没人展示就不记），记忆与可见性是一件事的两面；拆开会让记忆表失去它的存在条件。此前讨论过的"拆两半"方案因此被否。
- mux 对这个对象一无所知——它只是工厂函数里闭包捕获的东西。

### 不变量（必须写进注释）

1. **帧序**：一条连接上的所有帧（流、行、心跳、end）只经同一个 wire 队列写出，所以"先 baseline 后增量"由队列顺序保证，不靠约定。
2. **恰好一次**：`baseline` 与 `error` 互斥、各至多一次；由订阅元素的 `delivered` 与退订的 `cancelled` 两个标志保证。
3. **删除顺序**：流先 `end`、行后 `gone`。实现路径是 `hub.remove` 只调订阅的 `gone()`（流在里面结束），随后 controller 的 `onRemoved` 让 projection `forget` → `hub.publishGone`。
4. **无循环依赖**：`projection → hub`、`session stream → hub`、`session stream → projection`、`hub → 无人`、`mux → wire`。任何一侧新增反向依赖都算破坏。

### 文档

- 新增一条 ADR（编号 0024）："mux 只认帧——wire 与 session stream 的拆分"，附上面那张"允许知道什么"的表。
- 更新 `AGENTS.md` 术语表：`mux` 条目从"只剩帧序与失败的措辞"改为"只剩帧与 socket 存活"；新增 `wire` 与 `session stream` 两条；`hub` 条目补全局通道。
- 更新 `docs/architecture.md` 中传输层与订阅两节。

## Testing Decisions

- **一条判据**：好测试只断言"客户端收到了什么"——帧的类型、顺序、次数——不读任何内部表、不断言任何私有字段。任何需要知道 `watchers` / `feedMap` 是否存在才能写的断言，都是错的断言。
- **唯一 seam**：连接建立时注入的 `FrameSink`（已存在于现有 smoke 的写法里）。测试搭一个假 sink、一份脚本化 transport 的 agent，然后：发 REST 命令 → 断言帧序列。
- **先写测试、后拆实现**：第一步是把 `scripts/smoke-subscribe.ts` 重写为黑盒（现在它几乎每条断言都在测观看表的加减平衡），并让它在**未改动的生产代码**上通过。这一步不改生产代码，因此它证明了"新的黑盒断言与旧行为等价"。
- 需要覆盖的行为：活半 baseline 同步、冷半 baseline 异步恰好一次、重复 open 去重、未知会话的 error+end、删除时的 end、分支移动的重发、审批横幅的读者计数、断线后不再造帧、隐藏目录过滤、整表重发。
- **prior art**：`scripts/smoke-*.ts` 既有的 hermetic home + 脚本化 transport + 假 sink 模式；`scripts/smoke-projection.ts` 的"喂事件、看行"是黑盒写法的样板（其中依赖 `hub.isWatched` 的两条断言需要改写成看帧）。
- 拆分完成后，同一批黑盒测试必须**一字不改**地通过；这是本次重构唯一的正确性证据。

## Out of Scope

- 协议与帧格式的任何变化；前端一行不改。
- 超大 baseline 与 4 MiB 有界队列的冲突（现在就会用 `1013` 掐断整条连接）。要动得单独决定：分片 baseline、提高上限、或让前端分页取历史。
- core 编排层、会话账本、文件闸、持久化格式。
- 性能优化（例如按事件种类分桶订阅）——现在事件只有几种、每个接收者的判断只有一行，做了只会让表更复杂。
- 命名之外的额外重构；这条 spec 的净变化应当是"职责搬家"，不是"顺路美化"。

## Further Notes

- **测试 seam 需要确认**：本 spec 假定唯一 seam 是 `FrameSink`（整个服务器 + 假 socket，断言输出帧）。如果希望把 seam 抬到"直接对 session stream 喂事件"，那会多一条缝，但也更容易定位失败。
- **实施顺序建议**：① 黑盒 smoke 重写并跑绿 → ② 拆 `wire`（纯搬移，行为零变化）→ ③ 拆 `session stream`（把订阅翻译搬出 mux）→ ④ hub 合表（删 `feedMap`）→ ⑤ projection 改推 `publishRows` → ⑥ 文档与 ADR。每一步都保持黑盒 smoke 全绿。
- **风险**：③ 与 ④ 会同时动"删除顺序"与"审批计数"两个隐性契约，而它们今天只靠注释维持。落地时这两条必须各写一条 smoke 断言（删除时先 end 后 gone；两窗口看同一会话时横幅计数）。
- 本 spec 未发布到外部 issue tracker：会话里没有提供 tracker 与 triage 词汇。状态标记沿用仓库既有惯例（`.scratch/<topic>/spec.md` 的 `Status: ready-for-agent`）。若要发到 GitHub Issues 并打 `ready-for-agent` 标签，先运行 `/setup-matt-pocock-skills`。
