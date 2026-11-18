# 05 - 文档：ADR-0024 + AGENTS.md 术语 + architecture.md 两节

Type: task
Status: ready-for-agent
Blocked-by: 04

## 背景与指针

- Spec：`Implementation Decisions / ### 文档` 全节、User Story 24。
- 落点：
  - `docs/adr/0024-*.md`（新文件）+ `docs/adr/README.md` 的清单表（L14 起那张表，最后一行是 0023）
  - `AGENTS.md`：L110-124 的 `transport` 条目（其中 L116 那句 "mux 只剩帧序（baseline 先于本订阅 backlog 的任何帧）与失败的措辞" 是本票要改的那句）、L189 附近 `SessionFeeds` 的说法、`hub` 条目（补全局通道）、新增 `wire` 与 `session stream` 两条
  - `docs/architecture.md`：`## 谁拥有一个会话`（L264-300 一带，订阅那段）与 `## wire`（L386-440 一带）
  - `docs/notes.md` 第一节**只在确有结论被推翻时**加一条；本次是职责搬家、不是结论推翻，**默认不改**
- ADR 门槛：`docs/adr/README.md` 末尾三条（同时成立才值得一条 ADR）。本 spec 已点名要 0024，按已点名办；写的时候逐条对照那三条，把"为什么它过门槛"一句写进 ADR 开头。

## 改动

### 1. `docs/adr/0024-mux-only-frames.md`

标题（中文，与 0023 同风格）：**mux 只认帧——`wire` 与 `session stream` 的拆分**。

结构照 `docs/adr/0023-*.md` 的既有体例（先读它一遍，别自创格式）。必须含：

- **决定**：传输层劈成 `wire`（只会发帧）与 `session stream`（懂会话、不认识 socket）；`hub` 收敛成"一个会话一张订阅表 + 一个全局通道"；`mux` 只剩接线与存活探测，配合约 `(wire) => SessionStream` 的工厂函数。
- **那张表**（spec `### 分层与允许知道什么`）：五层 × 知道 / 不知道，逐字落进来。这张表是这条 ADR 的**主要产物**——下次有人想往 mux 里加一个 `if (sessionId === ...)`，这张表就是挡住他的那一条。
- **理由**：三条（spec Problem Statement 的三个纠缠事实），一条一段，别展开成散文。
- **协议零变化**：帧格式、`ClientFrame`/`ServerFrame`、前端一行不改。
- **不变量**（spec `不变量` 四条）：帧序（一条连接一个队列）、恰好一次（baseline 与 error 互斥、各至多一次；`delivered`/`cancelled` 两个标志）、删除顺序（流先 `end`、行后 `gone`，路径是 `hub.remove` → 订阅的 `gone()` → controller 的 `onRemoved` → projection → `hub.publishGone`）、依赖方向（`projection → hub`、`session stream → hub`、`session stream → projection`、`hub → 无人`、`mux → wire`）。
- **与 spec 的偏离，逐条记下来**（实施中实际发生的）：
  1. `订阅` 在 spec 的四个可选方法之外，还要 `baselineFailed`（baseline 的失败半——要初始状态的人必然也要它的失败，`SubscriptionSink` 的那两口拆不掉）与 `failure`（一次运行在会话流上说的那句失败，原 `MuxServer.announce`）。
  2. `hub.publishFailure(sessionId, message)`：spec 的 hub 公开面清单漏了这条路，而 `announce` 退场后 `onRunFailure` 没有别的去处；形状与 `publishRows` 同一条原则（只转发载荷、不看内容）。
  3. 全局订阅除 `rows` / `gone` 外还要 `resync`（`publishResync` 无载荷，总得有个收件方法）。
  4. `createMuxServer(factory, options)` 收工厂，而 `accept(sink)` 的签名保持不变（内部造 `Wire` 再交工厂）——这样测试装置与 `muxUpgrade` 都不用动。
  5. 票 04 把"会话流传出"与"行的广播改由 hub 扇出"放进同一张票：只做前者，侧栏会在一张票的时间里坏掉。
- **被取代/修订的既有结论**：`ADR-0001` 里"mux 与 hub 的边界是一份两半保证"的那一段——两半仍成立，但住所换了（hub 半不变，帧序半从 mux 搬到 session stream）；`AGENTS.md` 里 `SessionFeeds` 的说法整体退场。**不**取代 ADR-0001 的传输形态决定。

### 2. `docs/adr/README.md`

清单表加一行（编号 0024，状态列按仓库体例写"已接受（2026-11-18，wire-stream-split 01-05 号票…）"）。

### 3. `AGENTS.md`

- `transport` 条目：把"mux 只剩帧序…与失败的措辞"改成"mux 只剩帧与 socket 存活"，并把两半保证的落点指向 `wire` / `session stream` 两条（一句话 + 链接到 ADR-0024，不复述论证）。
- 新增两条术语（放在 `transport` 之后、`hold` 之前的位置最自然）：
  - **wire** —— 只会发帧的一层：`ServerFrame` 进、socket 出、有界队列、停滞与 `1013`、ping 与应用心跳、关停。不认识会话、baseline、审批、目录。
  - **session stream** —— 每连接一个，懂会话不懂 socket：订阅 hub、装配 overview、把事件/快照翻译成帧、持有 baseline 前的扣帧队列与审批读者计数、隐藏目录过滤、失败措辞；全部经 `wire.send` 写出。
- 删掉 `SessionFeeds` 那句（L189 附近），改成 `订阅` 元素（可选方法表达兴趣）的说法。
- `hub` 相关条目补一句全局通道（`Set<全局订阅>`：这台机器上的列表），并说明 `feedMap` / `watchers` 两张表已合成一张。

### 4. `docs/architecture.md`

- **谁拥有一个会话**：`SessionHub` 那段里"谁在观看（`watchers`）、事件与快照按 id 从哪张表流出（`feedMap`）"改写为一张按会话的订阅表 + 一个全局通道；`subscribe(sessionId, 订阅)` 的契约段按新形状重写（元素的可选方法、`baseline` 声明即读盘、`gone` 的时机、退订宽容且只清自己那一格）；两半保证那段保留结论、把"mux 半"改称"session stream 半"并加一句缝还在同一处（订阅返回拍）。
- **wire** 一节：补三层的分工（`wire` / `session stream` / `mux`），删掉"mux 把 `snapshot.pendingApprovals` 与这条订阅已经告诉过窗口的东西相比较"里对 mux 的指称（那是 session stream 的活），并把审批答案表的住址改成"boot 创建一份、注入每条流、跨连接共享"。
- 两节里任何 `feedMap` / `watchers` / `isWatched` / `SessionFeeds` / `rebaseline` 的名字都必须消失（`rebaseline` → `snapshotFor`）。

## 测试

- 文档票的验收是**事实核对**，不是"写完就行"：每写一段，去代码里核一次名字与位置（`grep` 一遍新名字、旧名字零命中）。
- `npm run check` 绿（`check-tokens` 不碰 md，只是确认没有顺手改坏源码）。
- 提交信息写清"文档跟随已落地的代码"，不写"计划"。

## Comments
