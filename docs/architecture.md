# 架构

一个 Node 进程，一个窗口。agent、会话文件、以及供应商密钥都活在进程里；窗口只是它所服务的服务器的一个客户端。

```
窗口 (packages/web)  --REST 命令-->  server (packages/server)  -->  core (packages/core)  -->  @my-agent/llm  -->  供应商
                     <--一条常驻 WebSocket--  四个域服务 + 一个编排层    core：引擎、工具、hook
                        （其上是 N 条逻辑流）
```

agent 不在浏览器里，原因有两个：凭据绝不能进入渲染进程；而读写文件是它的本职，浏览器做不到。它工作的地方是这台机器上**真实的目录**，不是虚拟文件系统。

命令用 `POST`，事件走一条**常驻的 WebSocket**（`/mux`），因为两个方向的性子不同：命令是每个用户动作一条，要的是状态码；事件是每秒多条、跨会话、要的是有序且无缺口。一条连接的生命周期是**连接**而不是某一次运行：它随标签页存活、跨多次运行、跨会话切换，其上的逻辑流身份是 `streamId`（就是会话 id）。值得点名的后果是 `abort` —— 它继续留在 REST 上（`POST /api/sessions/{id}/abort`），不是 mux 上的一帧，所以卡住的标签页、一个脚本、另一个标签页，都能停掉同一次运行；而"取消订阅"与"中止运行"是两回事，mux 上行的 `cancel` 帧只用来关掉一条逻辑流，从不中止运行（[ADR-0001](adr/0001-transport-websocket-mux.md)）。

另一个后果是"命令的承诺在哪里结束"。`Agent.prompt()` 在**运行**结束时才 resolve，所以一个 await 它的控制器会把请求和它的 claim 一起攥上几分钟，然后在 `202` 所宣告的那件事结束时报 `202`。控制器的做法是启动运行然后立即返回；由订阅的流报告它——**包括启动前就失败的运行**，因为到那时已经没有响应可供失败了。

## 各 package 的职责

**core** 是无头的：工作目录、导入的模型、工具、会话管理器、系统提示词、审批闸门，对 HTTP 和 DOM 一无所知。它是 **ADR-0007 的五个无属性服务**——账本、设置、模型行、工具定义这四个域平级互不依赖，`Agent` 是第五个、只做跨域编排；编排层自己不持有会话状态：durable 的一半是账本，live 的一半（两条队列与在飞运行）居 hub 持有的活登记处 `OpenSessions`——条目 `OpenSession` 装着 `SessionRuntime`（[ADR-0006](adr/0006-stateless-session-architecture.md) §1、§4，[ADR-0007](adr/0007-services-drop-instance-state.md) §4）。它发出 `AgentSessionEvent` 值 —— `types.ts` 的 `AgentEvent`，加上它自己的成员：队列深度、压缩、entry 落地、配置变更、重试。运行引擎也住在这里：`Agent.runEngine` 是编排层的一个方法，而不是它旁边的一个对象——读代码不需要在两层之间来回换算，一次运行只走一条链 `startRun → runEngine → prepareRequest → dispatchEvent`（[ADR-0008](adr/0008-loop-merged-into-agent.md)）。

**server** 拥有传输层和活跃会话：`SessionHub` 持有那五个无属性服务——模型行、设置、账本、工具目录四个域，加**一个**编排层 `Agent`——以及一个按 id 键控的活登记处 `OpenSessions`（每 id 一份条目 `OpenSession`——两条队列与在飞运行、订阅集合与跨栈 run 槽、一次打开解析出的装配，进程里唯一的跨栈内存会话态，宿主收摊时随之删除）；除此之外它只按 id 记 claim（谁能用这个会话），那本是传输层的事（[ADR-0001](adr/0001-transport-websocket-mux.md)）；`Router` 把请求变成对某个控制器的一次调用，每个控制器在它做事期间持有 claim；`mux.ts` 的连接层持有一张订阅表（连接 × 会话），**订阅不拿 claim**；`projection.ts` 把"每个会话在做什么"聚成侧边栏的行。模型是**每次请求**都从 `models.json` 读，而不是缓存成一份目录；会话在每次请求前从它命名的那一行重新推导自己的模型，所以设置面板的一次编辑——密钥、端点、窗口、wire id——能抵达**每一个已经打开的会话**。

**web** 拥有呈现：协议消息进，视图模型，DOM 出。它持有一条常驻连接（`client.ts` 的 `MuxClient`），把每条逻辑流的帧喂给对应的一栏，把连接级载荷喂给侧边栏的行表。它永远看不到供应商 SDK、transcript 文件、或服务器没发过来的任何路径。

| 层 | 归属 | 细节 |
|---|---|---|
| 认证、流式、wire | `@my-agent/llm` | `api/anthropic-messages.ts` —— 该 package 里留下的唯一一个 API 实现，导出为 `anthropicMessages` 传输层 |
| 导入的模型 | 我们 | `core/src/models.ts`：用户手打的那些行，每行由**手写的一个名字**命名——这个名字既是该行的身份也是它的标签，因为 transcript、配置补丁、选择器三处必须指同一行——每一行都直接变成发请求时用的模型；旧行的 `label` 被读作它的 `name`，这保住了用户选定的名字，代价是一次性的：用旧 slug 构建的引用会失效。上游的 `builtinModels()`、它的每供应商工厂、以及在其中路由的 `Models`/`Provider` 注册表，是被**刻意删除**的 |
| 每模型能力 | 我们 | `core/src/anthropic-models.ts`：某个 Claude 模型接受什么，从它的 wire id 推导——因为手打的一行没有别的东西可以作键 |
| 运行引擎、steering、事件 | 我们 | `agent.ts` 的 `Agent.runEngine`、工具调用、流事件——引擎是编排层的方法，不是委派对象（[ADR-0008](adr/0008-loop-merged-into-agent.md)） |
| 工具 | 我们 | 基于 `node:fs` / `node:child_process` 的六个文件工具 |
| 会话持久化 | 我们 | `SessionManager`：`.json` 快照（会话是什么）+ 同 stem 的只追加 JSONL 日志（说过什么），配对残缺即删（[ADR-0009](adr/0009-session-two-file-format.md)） |
| 提示词、压缩、视图收缩 | 我们 | `context/system-prompt.ts`、`trim-tool-call-args.ts`、`spill.ts`、`clear-tool-results.ts`、`compaction.ts` |
| HTTP + WebSocket | 我们 | `node:http`：命令走 REST，事件走一条常驻 WebSocket mux（`/mux`）；RFC6455 手写，不引入 `ws` 依赖 |
| 桌面外壳 | 我们 + Electron | `packages/desktop`：窗口、标题栏、主题，以及进程内的服务器 |
| 窗口 UI | 我们 | Vite + TypeScript，无框架，一个 DOM 渲染器架在常驻通道上 |

运行时依赖是两个包：`@my-agent/llm`、`typebox`。前者是 `@earendil-works/pi-ai` 0.99.2 的裁剪子集（`packages/llm`），只追踪到本项目真正触达的文件，并保留在 pi 自己的编译设置下（逐文件 `@ts-nocheck`；仓库根更严格的 tsconfig 仍然检查每一个进入 core 的 import）；上游对照已放弃（ADR-0008），它由本仓库自己维护。它旁边那个同源的循环（`packages/loop`，来自 `@earendil-works/pi-agent-core`）已经不存在：引擎并入 `agent.ts`，它那份 `@ts-nocheck` 随文件一起退场，也不再跟踪上游（[ADR-0008](adr/0008-loop-merged-into-agent.md)）。`pi-tui`、`pi-mcp`、`pi-codemode`、`pi-durable` 和 pico3 harness 都没有取用。

ai 子集比"应用触达的那些文件"还要窄：它是**一个传输层**触达的文件。上游 pi-ai 实现了五种 chat API，把每个实现的 import 都推迟到 `api/*.lazy.ts` 之后，好让宿主只为它实际发送的那一种付费；它还通过一个带 OAuth 和环境变量兜底的凭据存储来解析凭据，并让每个请求都经过一个供应商注册表。本应用这些一个都不做：它**永远**说 Anthropic Messages，用的是用户敲进 `models.json` 的密钥。于是 `api/anthropic-messages.ts` 是静态 import 的，另外四个实现和那些懒包装是**被删除**而不是"仅仅不可达"，注册表也跟着它们一起没了：wire 上再没有任何东西提及供应商——`Model` 和 `AssistantMessage` 都不带这个字段——所以被重放的 thinking level 不再与产生它的那一行做匹配。它也不需要匹配，因为 level 表是**单独从 wire id 推导**的（`anthropic-models.ts`）：两行命名同一个 wire id，只可能产出同一套 level，而按行匹配只会在这一个时候丢掉 level——用户把他一直在对话的那一行改了名或重新导入了。`packages/llm/src/models.ts` 里留下的是"一次请求所依赖的、关于某个模型的事实"，而不是曾经拥有这些事实的那次查找。如此只剩下 `@anthropic-ai/sdk` 和 `typebox` 两个依赖。

## 目录布局

```
my-coding-agent/
├── package.json, tsconfig*.json, AGENTS.md, README.md, docs/architecture.md
├── scripts/          # install-deps.ts（此处 npm 的替代品）、check-tokens.ts，以及各个 smoke 脚本
└── packages/
    ├── core/src/     # @my-agent/core - 无头 agent：agent.ts（编排层 + 引擎）、session-factory.ts
    │                 #   （装配）、types.ts（引擎与工具的契约）、hooks.ts（三个接缝）、models.ts、
    │                 #   settings-manager.ts、workdir.ts、protocol.ts、session/（会话管理器）、
    │                 #   context/（提示词、trim-tool-call-args、spill、clear-tool-results、
    │                 #   compaction）、tools/（每工具一个文件 + 委派对）
    ├── server/src/   # @my-agent/server - 传输层：boot.ts、main.ts、http.ts、http/（routing.ts 是
    │                 #   唯一读 URL 的地方，websocket.ts 是手写的 RFC6455，client-frame.ts 解析上行帧）、
    │                 #   mux.ts（常驻连接、订阅表、写侧有界队列）、projection.ts（侧边栏行）、
    │                 #   controllers/（routes.ts 是 API 表）、hub.ts（五个单例 + 一个编排层、一张 claim 表）
    ├── desktop/      # @my-agent/desktop - Electron 外壳：main.cjs、preload.cjs、scripts/launch.mjs、
    │                 #   scripts/inspect.cjs
    └── web/src/      # @my-agent/web - 窗口客户端：main.ts、api.ts、client.ts（MuxClient）、
                      #   rows.ts（连接级行表）、state.ts、composer.ts、dom.ts、tokens.css、
                      #   style.css、render/
```

## 装配与设置

`Agent` 只用被交给它的东西，别的什么也不用：构造只收**服务**——会话管理器、导入的模型、工具注册表、活登记处（`OpenSessions`）、传输层、hook 表面与提示词构建器——它的每个公开方法都以会话 id 打头，每样数据在用到它的那一行向属主现取：durable 的一半经 `sessions.stateOf(id)` 从账本重放，live 的一半经 id 从登记处条目读（条目 `OpenSession` 装着两条队列与在飞运行的 `SessionRuntime`，外加订阅集合、跨栈 run 槽，以及一次打开解析出的装配——`workDirAbsPath`、设置袋、模型选择；由打开链路在首次触碰时建造、宿主收摊时删除）。它不读设置文件、不构建工具、也不挑模型（项目指令 `AGENTS.md` 是每次请求现读的提示词输入，本身不进条目），更**不持有任何会话状态**，所以打开一个会话和恢复一个会话是同一条链（种子→补齐，[ADR-0006](adr/0006-stateless-session-architecture.md) §2；重放出的账本状态是可从磁盘重建的缓存，见*SessionManager 是真相之源*）。

构造只收服务这件事有一条直接的后果：**一个进程只需要一个编排层**。hub 在构造时建它一次，此后每个会话都经它、以 id 调用（[ADR-0007](adr/0007-services-drop-instance-state.md) §6：hooks、transport、提示词构建函数是进程级不可变配置，不是会话状态）；而"想独占一个会话"的调用者——一个 smoke、或只跑一个会话的调用方——自己组一个，两条路走的是同一对函数：

```
ensureSession({ workDirAbsPath, sessionState, sessionManager?, openSessions?, … })  # 装配 + ensure 条目 + adopt 袋
createSessionAgent({ sessionManager, models, openSessions, api?, tools? })            # 一个编排层，默认 hooks 已装
        -> agent.prompt(sessionId, …)                        # 公开方法一律以 id 打头

openAgent(options) == ensureSession(options) + createSessionAgent(…)   # 一次性的那对，给测试与子会话
```

`openAgent()` / `ensureSession()`（`core/src/session-factory.ts`）负责向外伸手。会话管理器是唯一一个**由调用者决定而非发现**的协作者，因为"要打开**哪一个**会话"是宿主的问题：hub 用 `create` / `open` 回答它，测试用 `inMemory` 回答它。模型及其 level 在任何地方都遵循同一套优先级：调用者指定的 → transcript 记录的 → `off`（没人要求过，就不要求）。因此测试可以在一份临时管理器和 `SettingsManager.inMemory` 上打开会话，完全不碰 `~/.my-agent/settings.json`。

设置是**一个对象** `SettingsManager`（`core/src/settings-manager.ts`），没有别的地方保留副本：目录的设置袋在装配时解析一次、作为装配字段记在登记处条目上，`applyConfig` 搬运**会话**缓存的东西——两条队列的模式（队列住在条目里，循环只在取走点拉取）——而把值经袋写回文件。模型和 thinking level 根本不在补丁里：两者都属于某一次对话，也都随使用它们的消息一起到达（见*输入框的模型座位*）。

| 作用域 | 文件 | 变更写到哪 |
|---|---|---|
| 全局 | `<agent home>/settings.json`（`~/.my-agent/settings.json`） | 还没有任何一层命名过该字段 |
| 项目 | `<workDirAbsPath>/.my-agent/settings.json` | 项目文件已经命名过该字段 |

这条规则叫**写到值所在之处**：一个仓库把 `"approval": { "bash": false }` 钉在项目文件里，它就继续拥有那套审批设置，于是 UI 里的一次切换被写在它旁边。嵌套对象做合并，所以一个只命名某个工具审批的补丁不会动到文件里的其他条目。每一层都按它文件里写的样子保留，未知键也在内，而合并视图是单独归一化的；写之前会重读文件，所以进程运行期间的手工编辑能存活。写入是同步的，而一个无法解析的设置文件会**抛出并点名该文件**，而不是悄悄按默认值跑下去。

这些文件为 `approval` 与 `tools`（全局默认活跃工具集，缺省即全量）提供的是**一个新会话打开时的默认值**。会话自己的选择记录在它 `.json` 快照的 `activeTools` 与 `approval` 字段里，并在它存活期间覆盖那些文件——所以 `PATCH /api/settings` 移动的是默认值，`PATCH /api/sessions/{id}` 移动的是该会话。窗口里没有单独编辑会话那半边的入口：它的工具与审批由输入框左下角的模式座位施加，那正是这两个命令的组合。

**模式是这两半的命名预设，不是第三个状态层**（[ADR-0005](adr/0005-modes-are-a-tool-config-choice.md)）。`modes` 字段整表存在 settings 文件里（`ModeSettings[] = { name, tools, approval }`，`PATCH /api/settings` 一次替换整份）；内置「默认」模式不被存储——它就是全局默认的活视图，所以选「默认」就是会话回到全局默认。设置 → 模式里「默认」与普通模式读起来一样：一行摘要，点开是同一套行内表单；它的名字只读，保存写的是全局 `tools`/`approval`，不写 `modes` 列表。会话选模式不写新端点、也不写新 entry kind：施加一个模式就是 `PUT /api/sessions/{id}/tools` 与审批 `PATCH` 两个现有命令的组合，写的是 `.json` 快照的既有字段。因此一个被施加了模式的会话与一个记录着同样配置的旧会话在任何读取方眼里不可区分；输入框的座位显示哪个模式，是从快照与模式表**按值匹配**出来的——模式被改名后旧会话会失配，这与模型行用名字作身份是同一条规则、同一个代价。

## 输入框的模型座位

哪个模型来回答、以及被要求思考得多用力，是输入框上的**一个**控件——也是**一个**随消息同行的值：`POST /api/sessions/{id}/messages` 携带 `{ text, behavior?, model?, thinkingLevel? }`，`Agent.prompt` 在运行开始前施加这一对（`applyModelSelection`）。

它之所以不是一次独立的配置变更，是因为这两半在"用它们发出一次请求"之前都**不是真的**。会话的 `.json` 快照只存**当前值**——`model` 与 `thinkingLevel` 两个字段——所以 `recordSelection` 写的就是这份快照：`prepareRequest` 先跑 `adoptCurrentRow()`（重新读取的活行），再把模型的行名与 wire id、以及 level 和快照里记录的比较，只重写**移动了的**那个字段（`setModel` / `setThinkingLevel`）。四种「最后一条赢」的配置 entry（`rename`、`model_change`、`thinking_level_change`、`tool_config`）随两文件格式一起消失了（[ADR-0009](adr/0009-session-two-file-format.md)）——它们的历史从来无人读，快照只留当前值。一个打开了却从未被说过话的会话因此完全不落盘：变更先留在内存 meta 里，随出生一起写出。在此期间输入框持有自己的选择，并在快照一旦同意时立刻丢掉对应的那一半，所以服务器一跟上，这个控件就不再是覆盖值。

level 本身骑在模型上（`Model.thinkingLevel`，由 `createModel(config, level)` 在构造之后设定、由 `reconfigure` 在原地重算），而不是在传输层选项里待在它旁边。这就是"哪个端点"和"多用力"成为**一个**发请求时用的对象的原因，也是发请求只有一个入口（`Model.stream`，转给它携带的 transport）的原因：effort 在 `buildParams` 里从模型上读取，而一个不带 level 的模型与 `off` 是同一次请求——都是显式把开关关掉。四档（`off`、`low`、`high`、`max`）对每一行都一样，所以档位是客户端的：输入框随消息带来它，行上没有默认档，`GET /api/models` 发出的 `thinkingLevels` 只是让输入框有一个能读的形状。

## 循环（`runEngine`），端到端

这一段里的「循环」就是 `Agent.runEngine`——引擎不再是对象，而是编排层自己的方法（[ADR-0008](adr/0008-loop-merged-into-agent.md)），所以下面每一步里「循环做的事」都是同一个文件里的代码。

1. 输入框发送 `POST /api/sessions/{id}/messages`，带 `{ text, behavior?, model?, thinkingLevel? }`。
2. `SessionController.prompt` 认领会话，在它上面调用 `prompt`，并回答 `202`。
3. 会话施加这个选择，追加用户消息，并调用 `Agent.prompt(sessionId, message)` —— 当一次运行正在流式时，同一个入口按 `behavior` 把消息排进会话自己的 steer / followUp 队列，等循环在取走点取走。
4. `prepareRequest` 重读活行、记录移动了什么、从 `buildSessionContext()` 取得 transcript —— 压缩和分支就住在那里 —— 会话在它前面放一条新的打头 system 消息，`context` hook 施加在这一对之上，然后从 @my-agent/llm 开始流式。
5. 工具调用到达：`beforeToolCall` 跑 `before_tool` hook，后者在设置要求时默认请求审批；`afterToolCall` 跑 `after_tool`，后者的改写即定稿；写边界（`appendMessage`）兜底归档没人约束过的超大结果。
6. 每个会话事件都作为 `{ type: "event", event }` 发给每一条订阅了该会话的逻辑流；连接级的心跳与行表走 `streamId: null` 那条道。
7. `message_end` 把消息持久化到 JSONL 文件；浏览器从事件增量修补它的 DOM。

## 工具契约

一个工具就是一个 `AgentTool`：名字、描述、一个 TypeBox schema、以及 `execute`。**没有插件注册表。** 工具那一侧分三样东西，各有各的家：`toolDefinitions()` 是六个内置的**定义**，只读、进程级，每条是 `(run) => createReadTool(run.workDirAbsPath)` 这样的工厂——因为一个 `AgentTool` 闭包着自己的工作目录，而一个持着它们的目录就等于持着每会话的目录；`createToolRegistry(toolDefinitions())` 是进程的**目录**（定义 + `register` 进来的工具，只有测试走这条路）；而"这一轮能调哪些、哪些要问"是**一次选择**，是纯数据 `ToolState`，从快照的 `activeTools` / `approval` 字段派生、随每次读取到达，不在注册表里、也不在任何一处被持有。注册表因此只有 `names` / `build` / `activeNames` / `active` / `register` 五个方法：`active(state, run)` 拿着随请求来的 `ToolRunContext`（`workDirAbsPath` + bash 超时）现建可执行集合，每一次路径解析都经过同一个 `resolveToolPath`：绝对路径原样接受、相对路径按 `workDirAbsPath` 解析，**没有围栏**——工具可以碰目录之外的任何东西。工具失败即抛出；引擎（`agent.ts`）把一次抛出变成给模型的错误结果。

执行模式是**每个工具上的字段**，不是注册表状态：`read`、`glob`、`grep` 是 `parallel`；`write` 和 `edit` 是 `sequential`，因为对同一个文件的两次并发编辑会竞争；`bash` 是 `sequential`，因为并发命令交错在一起的输出无法阅读。

`write` 和 `edit` 的回答不只是文本。除了模型读到的那份内容，它们结果的 `details` 还携带一个 `FileDiff` —— 形状在 `protocol.ts` 里 —— 包含这次变更的每一行、它在旧文件和新文件里的行号、哪些行是新增、以及一条被重写且**确实不同**的行的字符范围。`tools/diff.ts` 只计算一次：剥掉公共的头和尾，然后对剩下的部分做 LCS，并做了预算控制，使得整段都是变更的中间部分被报告为**一次重写**而不是一张二次方的表，最后按三行上下文切成 hunk。`diffText` 把同一份报告的"模型那一半"投影出来，所以模型据以自查的文本和读者看到的卡片不可能描述不同的变更。这份报告骑在循环自己的 `tool_execution_end` 事件上，所以 wire 不需要为它加成员；而循环记录整个结果——因此 transcript 把报告保留在工具文本旁边。**它永远不会被发给任何供应商**：一次请求只携带工具结果的 content，且只有 content，而 `estimateTokens` 量的是同一个字段，所以一份报告既不花 token，也不会导致更早的压缩。

`setActiveTools(names)` 记录这个决定（改写快照的字段，不是写进注册表），而活跃集合就是循环执行的东西——它随每次请求经 `prepareRequest` 递给循环，也是循环对一次脚本化调用说"不"的依据——对未激活工具的调用会返回 `Tool <name> not found`，一个错误结果，而不是静默成功。transcript 的**打头 system 消息**只装提示词，每次请求**重建**而非追加——第二份提示词描述的是一个已经不存在的状态。**工具是请求的参数，不是消息内容**：`prepareRequest` 把活跃集合放进上下文的 `tools`，循环用 `toToolDeclaration` 削成声明，传输层直接拼成请求体的 `tools`，所以改工具集只需要下一次请求。构建器拿到的是注册表当前的名字和会话的**有效审批映射**——设置在下面、本会话自己的选择在上面，**包括那些未激活的工具**，所以一个被收窄掉的受闸工具仍然被声明为受闸，而不是被静默丢掉。重建发生在下一次请求；一次已经在飞的运行保持它启动时的那套。

两张映射都是**会话自己的**，由 `setActiveTools` 和 `applyConfig` 写进 `.json` 快照的 `activeTools` 与 `approval` 字段——两者一份快照，因为在 UI 里"启用一个工具"和"选择它的审批"是同一个决定。设置文件保持它们的角色：新会话打开时的默认值；一个会话里的切换不再抵达该目录上的其他每个会话。`applyConfig` 从到达 `settingsManager.applySettings` 的东西里剥掉 `approval`，所以文件不被写入，而队列模式仍然照写。这两个字段是**状态，绝不是对话**：`prepareRequest` 每一轮都从当下的选择重建请求，所以它们对提示词毫无贡献。

## Hook

三个接缝从前接在 `Agent` 内部；现在它们是一个注册表，`core/src/hooks.ts` 里的 `createHooks()`。处理器按注册顺序运行，`apply` 逐字段合并它们返回的东西，所以后一个处理器细化前一个的答案；`on` 返回一个可以再次移除它的调用。`createSessionAgent` 在任何宿主能注册之前先装好默认值（内部就是 `installDefaultHooks`）。

这个表面是**进程级**配置（[ADR-0007](adr/0007-services-drop-instance-state.md) §6），一个实例服务本进程跑的所有会话，所以每个事件都点名它属于哪个会话——处理器用这个 id 现取它要的其余东西（目录、账本、审批映射），而不是靠闭包记住一个会话。

| Hook | 事件 | 默认处理器 | 从哪调用 |
|---|---|---|---|
| `context` | `{ sessionId, messages, systemPrompt }` | 无 —— 会话已经有 transcript 了 | `prepareRequest`，在每次供应商请求之前 |
| `before_tool` | `{ sessionId, toolCallId, toolName, args }` | 审批闸门，`Agent.authorize` | 引擎的 `beforeToolCall`（`toolCallHooks()`） |
| `after_tool` | `{ sessionId, toolCallId, toolName, content, isError }` | 无 —— 改写即定稿；兜底住在写边界 | 引擎的 `afterToolCall`（`toolCallHooks()`） |

- **`context`** 是一个纯覆盖接缝：没有注册任何处理器时，供应商拿到的正是会话自己本来会发的那些。
- **`before_tool`** 是审批闸门。审批集合决定哪些工具要问，UI 通过审批端点 / `denyAllApprovals` / `snapshot.pendingApprovals` 回答，而这个 hook 把一次未答的审批变成 `{ suspend: true }`——运行在这里结束而不是等在内存里，tool call 不写结果、在账本里悬空，答案经审批端点到达后启动恢复运行，由引擎的恢复机器按 `toolCallId` 配对续跑：grant 重跑该调用、deny 合成结果，无答案的孤儿合成错误结果收尾（ADR-0006 §5）。后一个处理器可以**细化**这道闸门，但不能**撤掉**它。
- **`after_tool`** 没有默认处理器，因为在这里改写就是**定稿**：消息落盘那一刻，content 就是最终版本，账本不再存第二份。要截断一个结果，先自己把全文归档——`archiveToolResult()`（`hooks.ts`，一行调用，内部复用 `spill.ts` 的路径推导）把全文写进工作目录的 `.my-agent/tool-results/<session id>/` 并返回带路径的头尾视图——再把返回的内容放进 `{ content }`。不强制：强制不了，也不该强制。没人约束的超大结果由**写边界**兜底（`finalizeToolResult`，`agent.ts` 的 `appendMessage`）：超过 80,000 字符（`SPILL_RESULT_CHARS`）的整份归档、模型拿头尾各 2,000 字符加归档路径；归档写不出去时 `boundToolContent` 仍把文本限制在 `MAX_TOOL_RESULT_BYTES`（200 KB）。

由此得出一条规则：**改写即定稿，账本存的就是你返回的那个版本。** 过去这里是「两半」——transcript 存工具的原话、一条 `tool_result_view` entry 记 hook 留给模型的 `shown`，每次请求现配——现在那一机制已删，连老文件里的重放层也随 v≤4 文件的删除一起消失：hook 的返回就是消息的内容，落盘即冻结，请求、快照、重启后的进程读到的都是同一份。代价是两条约束：截断的决定必须在 `after_tool` 即时做出且不可反悔；归档的完整性从此依赖工作目录（路径由 session id + call id 推导），不依赖账本——fork 只复制 entry 流，原目录在就能读全文，原目录没了就只剩截短版。

## 会话事件

`Agent.onEvent` 发布**一个**扁平的联合类型 `AgentSessionEvent`：

```ts
type AgentSessionEvent =
  | Exclude<AgentEvent, { type: "message_update" }>                                       // 循环的词汇，未改动
  | { type: "message_update"; delta: { timestamp: number; kind: "text" | "thinking"; contentIndex: number; text: string } }
  | { type: "queue_update"; queued: QueuedPrompt[] }              // 已接受、尚未被取走的消息本身（text + timestamp）
  | { type: "compaction"; summary: string; firstKeptEntryId: string; summarized: number; tokensBefore: number; contextTokens: number }
  | { type: "compaction_failed"; message: string }
  | { type: "tool_results_cleared"; cleared: number; tokensBefore: number; contextTokens: number }
  | { type: "tool_call_args_trimmed"; trimmed: number; tokensBefore: number; contextTokens: number }
  | { type: "entry_appended"; entryId: string; kind: SessionEntry["type"] }
  | { type: "config_changed"; model?: string; thinkingLevel?: string; approvals?: Record<string, boolean>; tools?: string[] }
  | { type: "retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "retry_start"; attempt: number; maxAttempts: number }
  | { type: "retry_end"; success: boolean; attempt: number; finalError?: string };
```

循环的事件是这个联合的**成员**，而不是一个嵌套字段，所以消费方只需对 `event.type` 保持**一个** `switch`；这之所以安全，只是因为没有任何 `AgentEvent` 名字与这里新增的名字相撞，而**新的会话事件绝不能复用循环的某个名字**。

`message_update` 是唯一一个**被替换**而不是照搬的成员。循环的版本同时带着整条 partial 消息和供应商的 delta；会话只把 delta 发出去——两个 delta 之间真正移动的只有一个增量，而每 token 重传整条回答会让帧长随答案线性增长，客户端还得重读全文才知道变了什么。整条消息仍走三处：`message_start`、`message_end`，以及中途接入时基线里的 `snapshot.partial`（没有它，一个在回答写到一半时打开的窗口只能从下一个 delta 开始画）。toolcall 的 delta 不占帧：工具卡由工具事件建。

| 成员 | 何时发出 |
|---|---|
| `queue_update` | 队列**真正变化**的三个地方：一条消息被接受进 follow-up 队列时、取走点取走消息时、以及随运行丢弃未取走消息时。事件带的是队列的**内容**（`QueuedPrompt[]`），不是计数；没有去重基线——调用了就是变了，steer 入队、无害的清空都不发 |
| `compaction` | `maybeCompact` 的末尾，在会话管理器记录该 entry 之后 |
| `compaction_failed` | 同一位置，当摘要请求抛出时：transcript 未被改动 |
| `tool_results_cleared` | 同一位置，在 `appendClearToolResults` 命名了被清掉的结果之后——它们没有自己的 entry，所以这是唯一说明它发生过的东西 |
| `tool_call_args_trimmed` | 同一位置，在 `appendTrimToolCallArgs` 命名了被缩短的参数之后 |
| `entry_appended` | 每一条 message entry 落地之后，来自 `prompt` 和来自 `handleEvent` |
| `config_changed` | `applyModelSelection`、`applyConfig`、`setActiveTools` —— 只带变化了的字段 |
| `retry_scheduled`、`retry_start`、`retry_end` | 重试策略的三个回调，各一个事件 |

成员在**事实发生处**发出，而不是在方便处发出；`config_changed` 只携带移动了的东西，所以重发当前设置是静默的，而不是在声称有什么变了。`onEvent` 发布事件，而 `onChange` 发布快照：队列在两者中都出现（都是 `QueuedPrompt[]`），因为事件是活的，而快照是晚到的订阅者据以重建的状态。

## 流式期间的输入

在一次运行正在流式时发出的 prompt 是**被接受**而非被拒绝的。`prompt(text, { behavior })` 把它交给循环，**不写盘**：

| `behavior` | 队列 | 循环何时看到它 |
|---|---|---|
| `steer` | steering | 在正在跑的那一轮的下一个取走点，所以它能改变这一轮做什么 |
| `followUp`（默认） | follow-up | 当 agent 本来要停下来时，这会开启另一轮 |

`Settings.steeringMode` 和 `Settings.followUpMode`（`"all"` 或 `"one-at-a-time"`，默认 `one-at-a-time`）决定每个取走点注入多少条排队消息。`snapshot.queued` 报告已接受、循环还没取走的消息**本身**（`QueuedPrompt[]`：文本与时间戳）——**只算 follow-up**，steer 进的是正在跑的那一轮；`applyConfig` 重新施加这两个模式；`settle()` 等的是**队列被取空**，而不只是当前这一轮结束——唯一的例外是闸门结束的那次运行，见下。

**排队消息的落盘点在取走点上，不在接受点上**（[ADR-0003](adr/0003-queued-writes-at-drain.md)，见其文末修订）。循环在取走点直读会话自己的两条队列（`drainTranscribed`），并在**取走的那一刻**把消息写进 store——文件里的位置就是模型遇到它的位置。于是 store 同时是请求的来源（`prepareRequest` 从它建）和基线的来源（重连、重载、宿主复活都按它重建 items），而两者读到的是同一个顺序：循环回放的那个。两类消息「先于循环的回显」落盘：启动一次运行的那条 prompt（在循环之前写，窗口不必等第一个事件），和取走的插话（在取走点写）；循环的回显因此**从不落盘 user 消息**——凡走到回显的 user 消息都已被喂入方写好，`message_end` 只落 assistant 与 toolResult（ADR-0003 文末修订）。计数从**被接受**算到**被取走**，而不是从队列深度的一比一换算算——`one-at-a-time` 下一次取走只消费一条，排着的不止一条。

一次运行结束时**还没被取走**的消息随运行一起丢弃（发送契约即发即弃：取走即落盘，没被取走就没人会回答它），只清空会话自己的两条队列，让深度归零——`settle()` 等的就是这个（[队列住在会话里](adr/0003-queued-writes-at-drain.md)）。中止、失败、以及恰好在循环决定不再找消息之后到达的那条 prompt，都走这一步。

**闸门结束的那次运行是唯一的例外。** 它把队列留下（`RunScope.suspended`），因为**恢复运行就是来取走它们的**：批准或拒绝之后开的那次运行，在它的取走点上把消息取走、落盘，位置在恢复出来的工具结果之后——那也是 provider 唯一接受它的位置（`tool_result` 必须紧跟 `tool_use`，所以它不能提前写）。等它的人因此看到的是「排队中 1」一直亮着，而不是那句话悄悄消失。相应地，`settle()` 把「有悬空调用在等人答」读作**一个问题而不是活**，所以挂起的会话照样能落定——否则 hub 的回收会卡在第一次 `settle()` 上。真正没人来接的时候（回收宽限走完、`abort` 结束会话）由 `denyAllApprovals` 一并清空队列：那是「不会再有运行来取」的通知，不是又一处随意丢弃。

## 重试

一次瞬时失败的供应商调用——过载、被限流、连接掉线——过去会结束这一轮，让用户重新发一次 prompt。现在它**在引擎之下**重试，用的是 @my-agent/llm 自己的工具箱：`RetryPolicy`、`retryDelayMs`、`isRetryableAssistantError`、以及 `retryAssistantCall`，后者拥有尝试次数、延迟和取消。

`Settings.retry` 就是这个策略逐字段的翻版：`enabled`（默认 `true`）、`maxRetries`（`3`）、`baseDelayMs`（`2000`）、`maxAgentDelayMs`（`60000`）。第 `k` 次尝试等待 `min(baseDelayMs * 2^(k-1), maxAgentDelayMs)`；`maxRetries` 数的是**重试**而不是调用，而 `0` 是一个设置值，不是一个缺失值。

**接缝在模型的 transport 上，在引擎之下。** 另一个候选是引擎在两轮之间留的钩子 `prepareNextTurn`，它行不通：错误响应是一次硬退出，引擎发出 `turn_end` 和 `agent_end` 就返回了，**根本走不到下一轮**。该钩子在 vendored 循环里从未被装配过，随合并一起删除；引擎现在是 `agent.ts` 的 `Agent.runEngine`，而它不再收到一个 `streamFn`：`startRun` 给这次运行包一层 transport，策略装在那一层里，所以它既拦得住引擎的每一次请求，也拦得住压缩摘要那次不经过引擎的请求。`pumpAttempts` 包裹每一次尝试，把它的 `AssistantMessageEventStream` 排进会话自己的流，并让 `retryAssistantCall` 来分类：

- 成功尝试的事件原样通过；
- 将被重试的尝试，除了它的**终态事件**之外全部通过——所以循环从不记录它，而被重试的尝试的增量会**原地覆盖**同一个 assistant 槽位。循环必须看到每次请求**恰好一个** `start`，否则它会追加第二条 assistant 消息，而不是替换那条被放弃的；
- 策略放弃的失败，让它的终态事件通过，运行就像重试存在之前那样结束。

于是 transcript 只增长**一条** assistant 消息，它之后的请求没有残余的错误需要解释，而用户的 prompt 从不被写两次。

**上下文溢出是唯一的例外。** 它是压缩的问题，且从不瞬时：一次溢出的尝试在分类器看到它之前就离开了重试循环，运行以那个错误结束。`snapshot.isRetrying` 和 `snapshot.retryAttempt` 报告晚到的订阅者无法从事件里看到的状态；`abort()` 取消一次只在等待退避的重试——运行的中止信号正是 `retryAssistantCall` 所睡于其上的那个——而 `settle()` 等待一次挂起的重试，而不是在它下面 resolve。浏览器把这三个事件渲染成一行 `retrying in Ns (attempt k/m)`。

## SessionManager 是真相之源

`Agent` 自己不保留 transcript。`SessionManager`（`core/src/session/session-manager.ts`）保留，而且它是会话 config 里的**一个对象**，不是会话记得去写的一个文件：会话通过 `session.sessionManager` 追加，并从它那里读回每一次请求，所以"发给供应商的"、"恢复的进程看到的"、"磁盘上的"是同一件东西，而不是三件需要保持同步的东西。账本的形状也是 ADR-0006 的：`SessionState` 是纯数据，`fillSession` 是磁盘到状态的**唯一**入口——hub 打开一个会话、冷读一份 transcript、进程重启后重开，走的都是它；host 在手时它就是这两个文件**唯一的写者**（claim 保证），追加与快照重写都即时落盘，所以内存里重放出的状态从不与文件分叉——它是 ADR 允许的那种**可从磁盘重建的缓存**，不是第二份事实。

在磁盘上，一个会话是**两个**文件，位于 `<agent home>/sessions/--<把分隔符换成短横的 workDirAbsPath>--/<ISO 时间戳>_<id>.{json,jsonl}`，按 stem 配对（[ADR-0009](adr/0009-session-two-file-format.md)）。每个工作目录一个 store 目录，以**绝对路径**命名而不是哈希，所以一个文件不必打开就能追溯到它的项目。**`.json` 是快照**：`SessionMeta` 的五个身份字段（`version`、`id`、`timestamp`、`workDir`、`parentSession`）加五个当前值（`title`、`model`、`thinkingLevel`、`activeTools`、`approval`——缺席意味着「从未选择」，这是区分「选了 off」和「没选过」的东西），每次变更整体原子重写（temp + rename），`CURRENT_SESSION_VERSION = 5` 的判定落在这份文件上。**`.jsonl` 是日志**：不可变的 entry 流，每一行是一条 entry，携带 `id`、`parentId`、`timestamp` 和一种 kind。父链接是让这个文件成为一棵树的东西；`leafId` 是对话当前所在之处，而移动它就是窗口在这棵树上行走的方式——见*会话树*。存在六种 kind：

- `message`，持有循环产生的或用户发出的 `Message`；
- `compaction`，一个检查点（见下）；
- `clear_tool_result`，它命名那些其文本被从视图中清掉的工作结果（见下）；
- `trim_tool_call_arg`，它命名那些其记录的 tool-call 参数被缩短的 assistant 消息（见下）；
- `leaf`，对话**去了哪里**的记录——`branch()` / `resetLeaf()` 在位置真的移动时写出的一条状态 entry，`buildIndex()` 重放它，让一次移动活过回收与进程退出（见*会话树*）；
- `usage`，一笔**不挂在任何消息上**的模型花销：`operation`、`model` 与整份 `usage`。这个构建已经不再写它（委派不在第一版范围内），但读取照旧——老文件里的记录照样按文件序计入总额，未知的 `operation` 按普通花销读，不拒绝。

别的任何东西都整份保留并原样交回：**这个构建不认识的 kind 必须能活过一次读取**，因为是更新的构建写了它，而日志从不被重写。读取是逐行独立解析的，所以一行读不了不会让会话的其余部分也读不了。`prune` 和 `argtrim` 这两个更早构建的名字则不复存在——它们只出现在 v≤4 文件里，而那样的文件整对删除（见下），归一化这一层随之消失。

配对残缺或版本不对的会话**直接删，不迁移**：扫描（`settleSessionFiles`）按 stem 配对两文件，只有一半、`.json` 版本不是本构建的、`.jsonl` 空而 `.json` 在——一律删两边；`fillSession` 打不开时同样先删再抛（[ADR-0009](adr/0009-session-two-file-format.md)）。

`buildContextEntries` 把分支变成仍在上下文里的 entry，施加那三个被记录成 entry 的决定：沿父链接从根走到 `leafId`，在那条分支上找到最新的 `compaction`，从它的 `firstKeptEntryId` 起全部取用、并丢掉之前的（换成这个检查点），然后清掉任何 `clear_tool_result` 记录命名的结果、缩短任何 `trim_tool_call_arg` 记录命名的参数。`buildSessionContext` 把这份清单投影成发给模型的东西，并报告快照里记录的 thinking level 和模型。

写入是同步的，两类各走各的格式：六个 append 方法（`appendMessage`、`appendUsage`、`appendCompaction`、`appendTrimToolCallArgs`、`appendClearToolResults`、`appendLeafRecord`）把新 entry 链接到 leaf、移动 leaf，并往日志追加一行；四个快照方法（`setTitle`、`setModel`、`setThinkingLevel`、`setToolConfig`）改内存 meta，文件在手则当场整体重写，值没变不重写。`SessionManager.create()` **不写任何东西**：两份文件随第一条 user/assistant 消息**同时**出现（`persistEntry` 里 `hasConversation` 那道闸）——先 `.jsonl` 全量、后 `.json` 快照，所以 `.json` 的存在就是「会话存在」的 commit marker，出生半途而废留下的单边文件由扫描清掉。没人说过话的会话在盘上没有痕迹、在侧边栏没有一行；出生之前 meta 的变更只留内存，随出生写出。pi 的延迟创建因此被保留下来，代价是 id 在那之前不可寻址，而这段窗口由 `SessionHub` 手里那份 manager 承担（`pending` 表），因为唯一会把这个 id 发出去的就是它自己；进程重启，这份窗口一并消失，那条会话本来也没有内容可丢。标题在快照里有 `title` 时用它，没有才从第一条**有文本的**用户消息推导——活会话和列表一视同仁，读的都是同一份快照。

**用量是按文件记的账，不是按分支。** 状态行的 token 总数由 `sessionUsage` 从**整个文件**的 entry 折出——assistant 消息身上的 `usage`、`compaction` entry 存的摘要调用花销、`usage` entry 记的委派花销，三处来源、一个总数——而不是从活跃分支的消息折：被切走的分支上烧掉的 token 也烧掉了，压缩之前的消息不再出现在上下文里、可它们的请求曾经发出，这两个事实都不随 leaf 在哪而改变。总和里唯一的例外是 `contextTokens`（当前上下文占用）：它不是累计值，而是活跃分支最后一条带 usage 的 assistant 消息报出的占用量，属于 leaf 所在的那条分支。窗口客户端在 `turn_end` 上增量折 assistant 消息、由 `status` 帧与服务端的总额对齐，所以一笔 `usage` entry 落账后，客户端在下一个状态帧到来时收回这笔账。

这就是 `prepareRequest` 要紧的原因：它让供应商请求和文件一致，无论会话是一秒前创建的还是重启后恢复的。hook 改写过的工具结果不是例外，也不需要任何按请求的现算：落盘的 content 就是最终版（写边界兜底归档超大结果），请求、快照与 wire 读到的是同一份；result 被清掉时 clear 后到后赢，被压缩折掉时消息连同它的版本一起离开视图。

### 压缩

一段长对话是**被折叠**的，不是被截断的。触发条件是模型的上下文窗口减去固定的 33,000 token 保留量（`compactionThresholdFor`），所以同一份 transcript 在小窗口模型下会压缩，在大窗口下不会；这份保留量覆盖估计看不到的东西——打头的系统提示词、工具声明、以及即将生成的那条回复——而一个拿不出 33k 的窗口改为拿出自己的一半，因为非正的触发条件会被读成"永不压缩"。

**先截参数，再清结果，只有还不够时才摘要。** `maybeCompact` 走三步：

1. `write` 和 `edit` 记录下来的参数——`ARG_TRIM_TOOLS`（`context/trim-tool-call-args.ts`）里仅有的两个——携带的正文就活在它们改过的那些文件里，所以一旦某次调用的结果上了分支，视图就只保留它们的前 200 个字符加一个 `... [truncated] ...` 标记。这一步不花钱、也不需要时钟，所以即使 transcript 是热的它也照跑。
2. 一小时没有请求，意味着供应商已经丢掉了这个提示词的缓存，所以此后每个没人看过一眼的结果都在被全额计费；`context/clear-tool-results.ts` 命名那些**可重新取得**的——`REFETCHABLE_TOOLS`，一次运行通过重新跑一遍就能产出的所有东西——**除了最新的五个**。这份清单说的是"哪些可以走"，不是"哪些必须留"：一份只写过一次的报告、或对话本身产出的任何其他答案，无论多旧都保留，因为再问一次也复现不出来。
3. 只有到这时才为一份摘要付费。

缓存是否已经没了，是从最新的 **assistant** 消息——最后一次供应商调用——量的，而不是从最新的 entry 量：用户刚敲的消息只有几秒大，关于被缓存了什么它什么也没说。如果截短后或清空后的视图已经在触发条件之下，那就到此为止、不发请求——这正是排序的意义所在，因为重写一段供应商已经读过的提示词的中间部分，比它省下的 token 更贵。

前两步是决定，并且被**记录成决定**：`appendTrimToolCallArgs` 和 `appendClearToolResults` 写出命名了它们所覆盖内容的 `trim_tool_call_arg` 和 `clear_tool_result` entry，而 `buildContextEntries` 施加它们，所以下一次请求、窗口、以及明天读这个文件的进程，看到的都是同一份 transcript，不必重新决策。它们命名的东西在文件里原封未动——这种格式从不重写一行——这正是让文件保持为完整记录、而 transcript 只是它的一个视图的原因。

摘要**不逐字保留任何东西**。每一个已完成的轮次都被折叠，只有**正在飞的那一轮**——最新的 turn start 及其之后的一切——作为消息存活；尾部没有 token 预算，所以一个不断压缩的会话会不断扩展**同一份**摘要。切口就是那个最新的 turn start，在 `prepareCompaction` / `findCutPoint`（`context/compaction.ts`）里，而遍历从最新的检查点之后开始。只有 turn start 能作为候选，因为供应商会拒绝一个其调用缺失的工具结果。

这次请求是**一次**供应商调用：`summarizationPrompt()` 把对话写出来——transcript 里的消息本就是模型可读的形状，压缩检查点是包着标签的 user 消息——，并加上 pi 的结构化检查点指令——在扩展上一份摘要时用 update 变体，再加 `SUMMARIZATION_SYSTEM_PROMPT` 作为 system 消息——而 `Agent.summarize` 用**会话自己的模型**来发它，那个模型携带的 key、端点和窗口与对话发送时所用的一致，并带 `cacheRetention: "none"`，因为一次性的摘要永远不会再被发送。它不经过循环，所以它自己归一化上下文，而不是继承循环为某一轮准备的东西。响应的 `stopReason` 必须是干净的：`error` 和 `length` 都抛出，因为一份残缺的摘要会静默丢掉它声称代表的那段历史。它是唯一一次不经过循环的认证调用，所以 key 被点名在它上面，而调用方不点名时传输层回落到模型自己的 key——一个点名了端点却没点名凭据的请求会在 setup 阶段被拒绝，而这正是从前"某个会话的行一直都有 key，摘要却失败"的原因。写下来的是一条 `compaction` entry：`summary`、`firstKeptEntryId`、`tokensBefore`、摘要调用的 usage。提示词不在其中——它每次请求都重建，恢复时拿到的就是当下的那份。产不出摘要的压缩把 transcript 原样留下，并被报告为 `compaction_failed` 而不是抛出：为它让这一轮失败，会用请求路径内部的一次崩溃去替换一个清楚的上下文溢出错误。

## 谁拥有一个会话

`SessionHub`（`server/src/hub.ts`）持有五个无属性服务与一个活登记处：编排层是本进程唯一的一份，方法一律以会话 id 调用；模型、设置、账本、工具目录各自是它们自己的服务（四个域加编排层，就是 ADR-0007 的五个）；活登记处 `OpenSessions` 按 id 装着两条队列、在飞运行、订阅集合、跨栈 run 槽与那次打开的装配，进程重启即从零重建（[ADR-0006](adr/0006-stateless-session-architecture.md) §4、[ADR-0007](adr/0007-services-drop-instance-state.md) §4）。除此之外 hub 只有一张按 id 的 claim 表——那是传输层的事实，所以计数器住在传输层。**订阅不拥有会话**：一条逻辑流是 mux 订阅表里的一行（连接 × 会话），它不拿 claim、也不让会话保持打开。持有一个 claim 的是**会改变会话的请求**，在它自己的长度内一个；审批的恢复运行也走同一条 `claim()`。所以一个会话可以在没人在看的情况下运行，而一个开着却闲置的窗口也不会替谁留住一个条目。

读 transcript 不算在内。`SessionController.read()` 既不拿 claim 也不打开会话：`SessionHub.snapshotOf()` 在本进程运行该会话时从活对象回答，否则从它的两个文件回答，走的是装配路径用的同一个 `readSessionSnapshot()`——所以一次读取的代价是一次文件读取而不是一个会话，它既不能保活一个会话、也不能驱逐一个、更不会在 hub 里留下痕迹。**窗口打开一个会话也不走这条路**：打开与切换都是一次订阅，`open` 帧以一份基线作答（[ADR-0010](adr/0010-open-session-over-mux.md)），导航路径上没有一次读取；`read()` 是命令面的读一半，脚本与诊断用它。页面加载是唯一的例外，而且是"开哪一个"的例外：先问一次 `GET /api/sessions/current`，再由同一帧 `open` 把它打开（见*API*一节）。订阅也一样：`SessionHub.observe(sessionId, observer)` 只往观察表里挂一个观察者，观察者既不保活它看的会话，也不花钱跑它。

```
一条常驻连接 ─┐ 订阅表（连接 × 会话，不拿 claim）
一次请求      ─┼─ claim ─> HostedSession { id, workDirAbsPath, claims, reaping }   id -> claim (SessionHub)
在飞的运行    ─┘                └ id -> OpenSession（队列、在飞运行、订阅、装配）(OpenSessions)
                                 └ 一个 Agent 服务全部 id        (core)
```

每个 id 一份所有权就是全部要点：**把所有权按连接而不是按会话来决策**，就意味着同一个会话上的两个标签页各自往同一对文件上跑、各自独立地追加，而没有一处能回答"这个会话现在是谁在跑"。（编排层本身已经是全进程一份，所以这条代价今天不再表现为两个 `Agent` 对象，而是表现为两条运行争一份 transcript——结论没变，形状变轻了。）`SessionHub.claim()` 是唯一数 claim 的东西——改变会话的请求与在飞的运行都经过它——而订阅故意绕开它："这个请求必须跑在活跃会话上"（claim 回答的）与"这条连接要不要这个会话的内容"（订阅回答的）是两个永不互相换算的问题（[ADR-0001](adr/0001-transport-websocket-mux.md)）。一个标签页落在哪个会话上由它记住的 id 决定，所以重载恢复的是它当时在看的那段对话，而不是 hub 会默认到的那个。

一条逻辑流结束（客户端 `cancel`、或它看着的宿主被回收）只是停止转发：它**刻意不**中止——正在飞的运行继续跑、继续持久化，所以刷新页面、关掉标签页、或切换会话都不可能截断一份 transcript。看着的宿主被回收时那条车道会收到一帧 `end`；"从来没在跑"与"看着的会话停了"是两件事，只有后者发 `end`。

释放是即时的：最后一个 claim 消失就触发一次**回收（reap）**。这里没有"比浏览器重连多活两秒"那一段——那条等待属于旧的 `EventSource` 传输，随传输切换一并退场。反过来，"一个人回来回答一个问题要多久"是另一个问题，claim 答不了它：claim 只说明有人**曾经**在看，所以一次停在审批上的运行不该在最后一个查看者切换会话的那一刻被拒绝，那是**替那个人**做出的推断，而他其实只差一次点击。因此一个有待回答审批的会话会停驻 `approvalGraceMs`（十分钟，`HubOptions`），只有到那时才把沉默读成**遗弃**、拒绝那个审批，好让一台合上的笔记本不能把一次运行永远停驻在那：

```
最后一个 claim 释放 -> settle()（运行结束在闸门上时，悬空的调用此刻才出现）
                    -> 无待回答审批：正常往下
                    -> 有待回答审批：
                        宽限（approvalGraceMs）内被回答 -> 正常往下
                        宽限走完仍无回答、且无 claim    -> 拒绝它
                        宽限内到达 claim               -> 让开；答案仍然是他们的（reaping 释放）
回收 -> settle()
     -> 此期间有 claim 到达：保留该会话
     -> 否则：从 map 里移除、通知观察者、close()
```

顺序也要紧——会话只在它 settle 之后才被遗忘，而它是**在 `close()` 完成之前**从 map 里移除的，所以一次与回收竞争的请求会等这次 close，而不是把同一个文件打开两次；而在此期间到达的 claim 会取消回收。遗忘是安全的，因为磁盘上的两个文件才是持久副本。由此有三个后果：持久化不依赖传输层监听者，所以没人看的一轮也照样落盘；一个无视自己中止信号的工具会让它的会话常驻，所以 `bash` 遵守它，未来任何长跑工具也必须遵守；关闭会先结束每条连接（`MuxServer.close()` 让它们放弃订阅），正是这一点让 `SessionHub.close()` 得以完成。

**谁限制写？** 一条常驻连接就是一个 `Writable`，而对端不读时"继续写"的官方后果是无界缓冲，直到进程被自己的内存压垮。所以写侧**必须有界**：`write()` 返回 `false` 之后停写，后续帧进一个有界队列（4 MiB / 10 秒），超限用 `1013`（"try again later"）关掉**整条连接**。这是隔离性付的账——一条连接卡住不会拖住 agent 循环，代价是恢复要靠客户端重连 + 逐条重放订阅 + 一份新基线。这个上限（10 秒）刻意低于客户端的读超时（15 秒），好让"通道卡住"以服务端的 close 收场，而不是等客户端把 watchdog 耗完。

**关停那件事也要说准。** 不是"一条泄漏的流就是一台关不掉的服务器"，而是：**只要有一条响应没结束，`server.close()` 的 `'close'` 回调就不发生**（`server.closeAllConnections()`——Node v18.2.0+——能收掉空闲的 keep-alive 连接，但收不掉已经 upgrade、不再是一条响应的那些 socket）。所以服务端自持 upgrade 后的每条 socket，关停时直接 `destroy()` 它们，这是让进程能干净退出的出口。

## 会话树

entry 自格式变更起就携带 `id` / `parentId`，所以一个会话的文件一直都是**一棵树**，而 `leafId` 是对话当前所在之处。有两样东西挂在这上面，窗口把两者都画出来：一个**分支**，是同一个文件里的另一条路径；一个**派生子会话（fork）**，是另一个文件。

### 分支

`SessionManager.branch(entryId)` 把 leaf 移到更早的一条 entry，于是下一次追加成为它的子节点，而原来在那里的 entry 就不再处于活跃链上。什么都不被重写、删除或复制。`Agent.branchTo(entryId, descend)` 是窗口移动的**唯一**方式：当它选择对话**已经有的**另一条走法时，它落在 `entryId` 最新的 tip 上——这正是切换分支的含义；当它回退去写一条新的时，它落在这条 entry 本身。它在一次运行正在飞时拒绝执行，因为循环会往 leaf 上追加：在它下面做一次移动，会把那一轮剩下的部分归到该轮并未在回答的一条分支下。

让这棵树可导航的是 `getBranchPoints()`：一条对话从它**以多于一种方式继续过**的消息，每种继续方式一个选项。一个子节点只在**有一条消息能通过它抵达**时才算数。`compaction`、`clear_tool_result`、`trim_tool_call_arg`、`leaf`、`usage` entry 是状态，而不是对话可以被恢复到的位置，所以一条位于消息之前的状态 entry 会被**穿过去**，而不是被当作一个空选项提供出来——回退、切换模型、再问一次是**一条**继续，不是两条。每个选项用它下方最早的那条消息来打标签，这正是让窗口能说出"它**没有**展示的那个选项通向哪里"的东西。

**报告的是整份日志，不是活跃链。** 一次走遍文件里的每一条 entry，把每一处分叉都报出来，只有 `options[].active` 是与链相关的（哪一条选项是 leaf 现在走的那条）。这是树的**归属**问题：树是这段对话的形状，不是 leaf 当前位置的形状。只报链上的分叉时，回退到第一条之后，它下面的岔就从图上消失了——同一个会话，同一个文件，位置一动就少一半树，而"我能回到哪里去"正是这张图唯一要回答的问题。每个分支点因此还带一个 `anchor`：窗口按 entry 摆卡片（线上的一句 user 消息，或更早某个分叉点已经画出来的那条走法），`anchor` 就是这个点上方最近的那张卡。点本身不一定在线上，`anchor` 一定是它的祖先——所以按文件序折进来的窗口，永远在摆一个点之前就摆好了它要挂上去的那张卡。

**选择是会话的，不是分支的。** 两文件格式之前，工具与审批配置随分支走——`branchTo` 移动 leaf 后重放目标分支的 `tool_config` entry。快照化之后这套重放不存在了：`activeTools` 与 `approval` 是会话 `.json` 里的当前值，与模型、标题同属「会话是什么」的那一半，移 leaf 改不了它们，`branchTo` 因此不再发 `config_changed`（[ADR-0009](adr/0009-session-two-file-format.md)）。要改选择，走的仍是与分支无关的那两个命令。

**只有 entry id 在传。** `BranchOption` 携带子节点的 id 和一个标签——**从不**携带那个选择所通向的 tip。一条分支在它的 tip 上生长，所以一个被记住的 tip 在那条分支被继续的那一刻就成了过期指针，而一个持有它的窗口会回退到对话早已离开的地方；服务器在做选择时从 id 往下走。`SessionSnapshot.branchPoints` 就是这条 wire 的全部，所以一个无视它的客户端画的仍然只是它一直在画的那一条链。

在 HTTP 上，一次移动是 `POST /api/sessions/{id}/branch`，带 `{ entryId, descend? }`，用会话的新状态作答。一棵变了的树不只是发问客户端的私事，所以 `Agent` 发出 `branch_changed`，而每条订阅用一帧新的 `baseline` 来回应它。有两样东西发出它，而它们是同一件事从两侧看：一个移动了的 leaf（一个窗口选了另一条走法——否则显示旧链的第二个标签页会把它的下一条 prompt 发往一条它并未在展示的分支），以及在一条**已有继续**的消息**之后**追加（回退再问一次就是这样把那条消息变成一个分支点的）。没有第二种情况，窗口会一直留着它从旧快照读到的分支点，而它刚写下的那条走法的切换器要等到重载才出现。

leaf 自己也在文件里。一次**真的移动了位置**的移动——`branch()` / `resetLeaf()`，也就是 `Agent.branchTo` 落到存储层的那个动作——写出一条 `leaf` 状态 entry：`leafId` 字段记对话**去了哪里**（一个 entry id，或 null 意为"第一条 entry 之前"），而 entry 自己以移动前那个 leaf 为父节点追加、且这次追加**不推进** leafId——树的位置记"这次追加发生在哪"，`leafId` 字段记"对话去了哪"，两个事实各占一个字段。移动到当前所在之处不写（`recordSelection` 同款守卫），所以连续的空移动不增长文件；普通的追加推着 leaf 走，不需要记录——文件最后一条 entry 就是位置。`buildIndex()` 按文件序重放：`leaf` entry 把 leafId 设成它记录的位置，其余每种 entry 把 leafId 设成自己——后写的是最后的话，一条旧记录像一条旧的 `compaction` 一样自然过期；记录的目标不在文件里时（只有手改的文件能造出来）回落到 entry 自己的树位置。`leaf` 记录的加入不需要换版本号——kind 集合本来就是开放的，这个构建不认识的 kind 原样带过；换版本号的是文件的**代**，上一次换它的是两文件格式（[ADR-0009](adr/0009-session-two-file-format.md)）。

没有 `leaf` 记录的文件**不补写**：读路径不得为补一条记录而开始写（"Reading a transcript must not be an event in it"），第一条 `leaf` entry 由第一次真的移动写出；在那之前，文件按最后一条 entry 读，行为与从来逐字节相同。而这份记录让一次移动第一次活过了回收与进程退出：一个关闭的会话不再忘掉它，下一个读取方——冷读的快照、重开的进程——从文件记录的位置恢复，而不是从最后被写下的那条分支。

### 派生子会话（fork）

一个 **fork** 是同一条链变成第二个文件：

```
SessionManager.forkFrom(sourcePathInput, targetCwdInput, entryId, sessionDirInput)   # 写出一个持有该分支的新文件
```

`forkFrom` 是唯一的静态方法：它从**源的两个文件**开始，而不是一个活的管理器，这正是让 hub 能 fork 一个它并未在运行的会话的原因。它把**包含** `entryId` 的那条分支复制进新 `.jsonl`（`entryId` 为 null 时是整份日志），被复制的那段前缀保持它**原本的** entry id，因为那些就是父级已经写下的 id：这正是让一个 fork 能追溯回它所来自的那些 entry 的东西。然后写出新 `.json`：新 id、目标 workDir、`parentSession` 设为源的 **`.jsonl` 路径**，title、model、thinkingLevel、activeTools、approval 五个当前值随拷。是路径而不是 id，因为一个手里拿着某个文件的读取者，手里拿着的就是它。什么都不被重写，源只被读取，而它自己的 leaf 不会因为一次 fork 而移动。

`SessionHub.fork(sessionId, entryId)` 拥有这个操作，因为一条分支必须比请求它的那个请求活得更久。在 HTTP 上它是 `POST /api/sessions/{id}/forks`，用新 id 作答；调用方随后订阅那个 id，走的是其他每个会话都走的同一条 `open` 帧。`SessionSnapshot` 携带 `parentSession`、`leafId`、以及每条消息一个 entry id，所以一份 transcript 可以就一条它并未看着被写下的消息提供"从这里 fork"。

快照记录父级的**路径**，因为那是一个手里拿着某个文件的读取者所持有的东西。列表是两端同时已知的**第一个**地方，所以 `linkForkParents` 把那个路径解析成父级的 **id**——是 id 而不是路径，因为侧边栏其他每一行都是用 id 命名的——而 `SessionRef.parentId` 携带它。父级在该目录之外的 fork 保持未解析、显示为根，这是诚实的读法：那里也没有东西能打开它。用它的是侧边栏，它把一个目录的会话按深度优先铺开，一个 fork 放在它所来自的那个会话下面。

## 委派（第一版不做）

`SubAgent` / `SubAgentControl` 曾经是一对**装配出来的**工具：不进进程目录，而是作为 `entry.localTools` 记在登记处条目上，解析工具时与目录合成一个视图（`registryView`）——因为一个子级需要父级的模型、thinking level 与 transcript 文件，而这些东西只有那次打开刚刚解析出来。

第一版把整条链删掉了：工具本身、`localTools` 字段、`registryView`、`subagents: false` 选项，以及它的冒烟用例。现在每个会话跑的就是进程目录那一份定义，"会话自有的工具"这个概念不存在。`usage` 这种「没有消息可搭的花销」仍然可读（见*会话文件*），只是不再有人写它。

## API

命令面全是 JSON 请求与响应；**会话事件不是其中任何一个**——它们是一条常驻 WebSocket 上的帧。`createRoutes()` 就是整张 REST 表，而 `Router` 是唯一读 URL 的东西。mux 的上行帧（`open` / `cancel`）**不走 URL**，所以这张表与它们互不覆盖：表里每一条都是任何人能用 `curl` 发的请求，而帧是窗口说它要订阅什么的方式。

| 方法 | 路径 | 请求体 | 回答 |
|---|---|---|---|
| `GET` | `/api/health` | — | `{ ok, absWorkDir, live }`——`live` 是本进程正在运行的会话 id |
| `GET` | `/api/models` | — | `{ models: ModelOption[] }` |
| `PUT` | `/api/models` | `{ models: ModelInput[] }` | `{ models: ModelOption[] }` |
| `GET` | `/api/settings` | — | `{ settings: SettingsSnapshot }` |
| `PATCH` | `/api/settings` | `{ patch: { appearance?, approval?, tools?, modes?, bash? } }` | `{ settings }` —— 目录**默认值**，在任何会话存在之前读取；按会话的审批变更发往 `PATCH /api/sessions/{id}`；`modes` 整表替换（ADR-0005） |
| `GET` | `/api/directories` | — | `{ directories: DirectoryGroup[] }`——每组的 `sessions` 是 `SessionRow[]`（含 `modified` / `running` / `pending`）；被搁置的目录不在其中 |
| `POST` | `/api/directories/rename` | `{ workDirAbsPath, name }` | `{ workDirAbsPath, name, settings }`——只改这个列表里显示的名字，写进 `directoryNames`；磁盘上的文件夹与每份会话快照的 `workDir` 都不动 |
| `POST` | `/api/directories/hide` | `{ workDirAbsPath }` | `{ settings, directories }`——只从列表移除，磁盘原样；把该路径从 `hiddenDirectories` 里去掉（`PATCH /api/settings`）即可放回，在该目录里新建会话也同样 |
| `GET` | `/api/sessions` | — | `{ sessions: SessionRef[] }` |
| `GET` | `/api/sessions/current` | — | `{ sessionId, sessions }` |
| `POST` | `/api/sessions` | `{ absWorkDir?: string }`（可为空体） | `201 { sessionId, sessions }`——带 `absWorkDir` 时会话落在那个目录，`sessions` 列**该目录**的会话 |
| `GET` | `/api/sessions/{id}` | — | `{ session: SessionSnapshot }` |
| `POST` | `/api/sessions/{id}/messages` | `{ text, behavior? }` | `202 { accepted }` |
| `POST` | `/api/sessions/{id}/abort` | — | `{ stopped }` |
| `PATCH` | `/api/sessions/{id}` | `{ patch: ConfigPatch }` | `{ session }` |
| `PUT` | `/api/sessions/{id}/tools` | `{ names: string[] }` | `{ session }` |
| `POST` | `/api/sessions/{id}/approvals/{toolCallId}` | `{ approved }` | `{ toolCallId, approved }` |
| `POST` | `/api/sessions/{id}/forks` | `{ entryId: string \| null }` | `201 { sessionId, sessions }` |
| `POST` | `/api/sessions/{id}/branch` | `{ entryId: string, descend?: boolean }` | `{ session }` |

这里没有一行是会话事件的端点——唯一的流式通道是 `/mux`（不在 `/api` 之下，因为它不是一个 REST 资源）；`abort` 也留在 REST 上，不帧化。`/api/directories` 的行是这个进程知道的每一行，而**无人在看时一个会话的行也照样更新**（它由 `projection.ts` 喂，不由某条恰好开着的流喂）；通道不可用时，客户端把 `GET /api/directories` 当作侧边栏行表的 REST 兜底。**被搁置的目录是这里唯一的例外，而它只有一条规则**（`SessionHub.listsDirectory`）：REST 列表与通道概览都按它过滤，所以两条路永远说同一件事——只过滤概览会让一个被删掉的分组在它某个会话下次变动时自己长回来。搁置或取回不改变任何一行，所以它由**重发一份概览**（`broadcastSessions()`）通知，而不是靠 `session_row`。

`ModelOption` 是用户导入的一行、**去掉密钥**——`hasApiKey` 说明是否存了一个，而密钥从不离开服务器。`PUT /api/models` 替换整份清单，因为设置面板编辑的是一份清单，而一份被半途施加的清单是没人能推理的状态；一行不带 `apiKey` 送来时，保留存在它名下的那个，这正是让面板能够往返一行"它从未被展示过密钥"的数据的原因。名字是一行的**身份**——transcript 记录它、配置补丁命名它——所以重复会被 `400` 拒绝（`The name "X" is already in use`），而不是在用户背后把它改成唯一的：一个加了后缀的名字会改变**每一条**命名它的 transcript 的含义，而显示这次冲突的那个面板才是修复该发生的地方。变更能抵达活会话而不必重新打开它们，因为会话持有一个 `ModelSource`、每次请求都通过它读存储而不是复制一行、并每次都从活行重新推导自己的模型——所以端点、窗口和 wire id 都随密钥一起移动。

`GET /api/directories` 扫描 agent home 的会话目录，所以侧边栏可以按目录分组，尽管本进程是**恰好**在其中一个之上启动的；从另一个分组打开会话要使用该会话自己快照里的 `workDir`。`PATCH /api/settings` 刻意比 `PATCH /api/sessions/{id}` 更窄：主题、字号、审批集合、全局默认工具集在任何会话存在之前就要读，所以它们不能住在某一个会话上。

表里两行与会话的打开有关，而**打开**都不是它们做的。`GET /api/sessions/{id}` 是一次**读取**——脚本、诊断、以及任何不是窗口的客户端用得上它，窗口从不发它（打开会话就是一次 `open` 帧，基线是那个问题的全部答案，[ADR-0010](adr/0010-open-session-over-mux.md)）。`GET /api/sessions/current` 回答的是"这台机器上一次在看哪个会话"——`--session` 钉住一个，否则新建一个（开窗落在欢迎态，历史归侧边栏）——窗口在页面加载时问它一次，只拿它当**起点**：该开哪一个。打开仍是那一帧 `open`，它自己什么都不画；一个照着它去猜并且照着画的客户端才会静默显示与服务器正在服务的**不同**的对话。所以它不违背"导航不读"这条：读的是"开哪个"，画的从来只有基线。

路径参数在控制器看到它们之前按段做百分号解码，所以一个不透明的 id——工具调用 id 可能含冒号——能安然走完这段路而不会被二次编码。失败是 JSON——`{ error }`——配上说明发生了什么的 status：`404` 表示 id 不是会话，`400` 表示请求体不是 JSON 或字段类型不对，`409` 表示会话拒绝的一次变更（未知工具名、没有任何行提供的模型），或一个不是待回答审批的 `toolCallId`——会话存在、请求合法，但此刻收不下这个答案，`405` 带 `Allow` 表示该路径在另一个动词下存在。审批端点只在答案真的被收下时才记入答案表（只读检查在 `onApproval` 之前），所以一次被 409 拒掉的请求不会污染任何一条订阅还在展示的审批的差值。

## wire

服务器推给客户端的一切都在 `core/src/protocol.ts` 里，分三层：一份 `ServerMessage`（一条逻辑流的内容）、一层 `StreamFrame` / `ConnectionFrame`（一条逻辑流或整条连接的帧），以及最外面的信封 `ServerFrame`。一条 WebSocket 消息就是一个信封，套着一帧；用哪个键载 id，就把两种帧分开了：

```ts
type ServerFrame =
  | ({ streamId: string } & StreamFrame)      // 一条逻辑流，streamId 就是会话 id
  | ({ streamId: null }   & ConnectionFrame)  // 连接自己的载荷
```

于是"把连接级载荷塞进某条会话的流"和反过来都成了**不可表示**的状态，而不只是"不推荐"。信封刻意在 `ServerMessage` 之外、而不是塞进它每个成员的字段里：好几个调用方构造协议消息时背后根本没有流（一次 REST 读取、一次 fork），内联 id 会逼它们去发明一个。

一条逻辑流有三种形状（`StreamFrame`），用字段名而不是判别式区分：`item` 装一条 `ServerMessage`，`end: true` 说这条流结束了，`error` 说这条流上出了事。`end` **不带原因**：该分的是"这条逻辑流上有没有过 `baseline`"，不是"服务端为什么结束它"。`error` 也**不是**终帧——流还开着，客户端接下来怎么做取决于它有没有见过 `baseline`。

```ts
type ServerMessage =
  | { type: "baseline"; session: SessionSnapshot }   // 这条逻辑流的起点：每次 open 一份，重复 open 再送一份
  | { type: "event"; event: AgentSessionEvent }
  | { type: "entry"; entryId: string; messageTimestamp?: number }   // entry_appended 背后的那条消息，供 "fork from here" 使用
  | { type: "approval_request"; request: PendingApproval }
  | { type: "approval_settled"; toolCallId: string; approved: boolean }
  | { type: "status"; usage: UsageTotals; submitting: boolean; queued: QueuedPrompt[]; isRetrying: boolean; retryAttempt: number }
  | { type: "error"; message: string };
```

`baseline` 是一次订阅的**全部起点**：`open` 之后的第一帧就是它，而订阅与基线是同一个原子动作——建条目、取快照、挂监听、发基线，中间没有 `await` 点，所以"基线与增量之间没有缺口"是构造出来的、不是论证出来的。重开一条逻辑流拿到的是一份**新的** `baseline`（替换，不是追加），恢复因此收敛到"现在长什么样"，而不是"我错过了哪几帧"。**`open` 是幂等的**（[ADR-0010](adr/0010-open-session-over-mux.md) 决定 1）：重复订阅不被拒绝，而是再送一份基线，所以"send 还持有引用时切走又切回"这种不产生新订阅的落点，拿到的也是当下的快照——正在跑的会话那份带 `partial`。因此一条逻辑流上的 `baseline` **不止一份**（分支移动的 `pushBaseline` 同样如此），"第一帧"是事实，"只有一份"不是；窗口按基线到达时自己的点击序号（`openSeries`）决定画不画，迟到的整帧丢弃。

连接级的那条道（`ConnectionFrame`）也是 `item` / `error` 两种形状，但 `item` 装的是 `ConnectionItem`——**不属于任何会话**的载荷：

```ts
type ConnectionItem =
  | { type: "heartbeat"; everyMs: number }         // 服务端每隔多久发一次，客户端据此校准自己的读超时
  | { type: "sessions"; sessions: SessionRow[] }   // 这个进程知道的每一行，每连接一次，替换而非追加
  | { type: "session_row"; session: SessionRow };  // 一行变了，整行替换（行小，幂等胜过差量）
```

`heartbeat` 是**应用层**的判活：浏览器一侧根本看不到协议层的 Pong，所以它必须有一个有人读的信号，那正是它能喂给读超时 watchdog 的东西。协议层的 Ping/Pong 另有一份职责，它判的是**客户端**死没死（2 秒一次、容忍两次未回应，第三次 `terminate()`）——两个计时器回答两个不同的问题，刻意不让一个成为另一个的函数。

上行帧 `ClientFrame` 只有两个成员，且**没有信封**——帧本身就是协议：

```ts
type ClientFrame =
  | { type: "open"; sessionId: string; window?: unknown }
  | { type: "cancel"; sessionId: string };
```

`open` 订阅一条会话，**重复也照发**（见上：答案是再一份基线）——`cancel` 取消订阅（关一条逻辑流，同 DSH 的 `cancel`；**中止运行只叫 `abort`、只在 REST 上**，两个词不混用）。两条都是**连接上的状态**，不是会话上的：同一会话在一条连接上至多一条逻辑流，所以会话 id 就是全部地址，没有单独的订阅句柄要同步。抵达一条未知 `type` 的上行帧会被丢弃并记一行日志，而不是关掉连接。

一个会话 id 可以被多于一条连接订阅，并被任意多个请求读取。hub 为它运行**一个** agent 循环，并把它的事件转发给每一条订阅它的逻辑流，所以 `event` 和 `status` 是**按订阅者**的，尽管它们背后的 transcript 是共享的。这条流是单向的：命令从不是它上面的一帧。扩展任一侧的规则：如果浏览器需要知道某件事，它进一条消息或一个端点；如果只有服务器端需要，它就留在 core。`snapshot.allTools` 是 header 据以给每个工具画一个开关的东西，`snapshot.activeTools` 是那些开关显示为开的东西，而 `PUT /api/sessions/{id}/tools` 带 `{ names }` 替换活跃集合。

`models`、`sessions`、`directories`、`settings` 从前是这条流上的帧；它们现在是端点，因为一个无法订阅任何会话的页面仍然需要填充它的侧边栏、设置面板和窗口 chrome。连接级载荷里唯一替代了旧行为的是 `sessions` / `session_row`：一个窗口的行表由投影喂，不再由它恰好在看的那条流喂——**没人在看时一个会话的行也照样更新**。

`approval_request` 和 `approval_settled` 是**订阅自己的**活儿，不是会话的：会话把一次待回答的审批作为一次普通变更发布，所以 mux 把 `snapshot.pendingApprovals` 与这条订阅已经告诉过窗口的东西相比较，只发差值——没有这一步，横幅只会出现在"prompt 上去之后才重载"的页面上。答案表按**会话**键控（`Map<sessionId, Map<toolCallId, ShownApproval>>`），因为几个 Anthropic 兼容端点会把不同会话的 `toolCallId` 编成同一个；一条准予绝不能因此抵达另一个会话的窗口。

## 请求流程

```
窗口输入框
  -> POST /api/sessions/{id}/messages          一次 fetch，回答 202
  -> server/http/routing.ts                    路由表匹配 method + path
  -> server/controllers/sessions.ts            控制器：claim、调用、释放
  -> server/hub.ts                             claim 表 + 活登记处条目（编排层是本进程唯一的一份）
  -> core/agent.ts                             Agent.prompt()
  -> core/agent.ts                             runEngine：流、工具调用、before_tool 与 after_tool hook
  -> core/hooks.ts                             context、审批闸门、工具输出兜底
  -> core/tools/*                              针对服务器文件系统执行
  -> core/session/*                            追加每条消息和每个工具结果
  -> server/mux.ts                             observe 这条会话的订阅，把每条 ServerMessage 装进信封
  -> web/client.ts, web/state.ts               按 streamId 分道，解析、折叠，交给渲染器
  -> web/render/*                              增量更新 DOM
```

## 桌面外壳

`packages/desktop` 是字面意义上的外壳。`main.cjs` 启动 `npm run start` 所启动的同一个服务器——`server/src/boot.ts` 的 `bootServer()`，端口用 `0` 好让操作系统分配一个空闲的——并让一个 `BrowserWindow` 指向它返回的 URL。API、会话模型、客户端都不会因为身处窗口而不是标签页而有任何改变。

| 关注点 | 决定 | 理由 |
|---|---|---|
| 后端 | 进程内导入，不 spawn | 只有一条生命周期要管，而 `close()` 就是 `main.ts` 的信号处理器所调用的同一个调用 |
| 端口 | `0`，由系统分配 | 第二次启动永远不会和第一次撞上，也不必预留任何号码 |
| 传输 | 朴素的 `http://127.0.0.1:<port>` | 服务器本来就既服务客户端、又在 shell 兜底之前校验 API 路由 |
| 标题栏 | Windows 上 `titleBarStyle: "hidden"` + `titleBarOverlay`，macOS 上 `hiddenInset` | 页面自己画 header，所以它能把自己的调色板带进标题栏；Linux 保留自己的边框 |
| 主题 | 页面跟随 `nativeTheme`，通过 `preload.cjs` 同步读取 | 只有一个主题来源，所以标题栏和页面不可能不一致 |
| 桥 | `contextBridge` 暴露原生主题和四条窗口命令 | 渲染进程不需要文件系统、不需要 shell、也不需要 IPC 透传 |
| 失败面 | `observability.cjs` 监听 `child-process-gone` / `render-process-gone` / `uncaughtException` / `unhandledRejection`，启动带一个 20 s 的看门狗；报告先写一行日志，再画一张 `data:` 说明页，原生对话框只在页面画不出来时兜底 | 子进程成批死亡（GPU、network）过去是靠人肉翻日志才看清的，而"什么都没发生"正是 10/13 那次的样子；`data:` 页由外壳自己画、不经过那个没起来的服务器，而**渲染进程死后换上的新渲染进程照样能画它**（本机 `forcefullyCrashRenderer()` 实测），所以它排在原生对话框前面——`showErrorBox` 会阻塞到有人点掉它 |
| 外壳诊断的语言 | **英文**（`desktop: …`），与 `shutdown.cjs` 及 `main.cjs` 既有的行一致；说明页与原生对话框里的文案是中文 | AGENTS.md 把诊断日志划给中文，而外壳从第一行起就是这条规则的例外；新模块跟着邻居比一半中文一半英文更小。用户看得到的字符串仍按窗口文案走中文 |
| 看门狗 | 启动有预算（挂起也会被报告），重试/换端口的**策略**没有 | 失败必须可见是这张表的事；等多久、重试几次是另一个决定，没有它就只是永远没有窗口 |
| 沙箱与 GPU 开关 | **一条都不加**——Chromium 默认的沙箱与进程模型原样使用，`webPreferences.sandbox: true` 因此是生效的配置 | 曾经加过四条（`no-sandbox` 等）来自一段**从未提交**的本机规避；为什么删、什么条件下按什么顺序加回来，全在 [ADR-0004](adr/0004-shell-sandbox-switches-removed.md) |
| 打包 | 未构建 | 安装包、签名、更新、ASAR 布局，在决定要发布之前都太早 |

外壳必须通过 `scripts/launch.mjs` 启动，而不是直接调 `electron` 二进制：环境里**任何地方**设置了 `ELECTRON_RUN_AS_NODE` 都会把 Electron 变成普通 Node，而应用会死在 `require("electron")` 返回一个路径而不是 API 上。客户端从不 import `@my-agent/llm`，也不 import core 的引擎与其他内部模块——它只看得到 `protocol.ts` 的类型，这正是让第二个界面（终端、RPC）成为一个**新客户端**而不是一次 core 改动的原因。

## 与原计划的偏离

| 原计划 | 实际构建 | 原因 |
|---|---|---|
| 一条 WebSocket 同时承载命令和事件 | 命令走 REST，事件走一条常驻 WebSocket mux；`channel.ts` 长成 `mux.ts` | 浏览器发的一切都是带状态码的请求，服务器发的一切都是单向的；命令面留在 REST 不动，而事件合流到一条常驻连接上（[ADR-0001](adr/0001-transport-websocket-mux.md)） |
| `channel.ts` 拥有会话 | `hub.ts`，claim 由改变会话的请求与在飞的运行持有（**订阅不拿**） | 同一个会话 id 上的两条连接会构建两个 agent 循环、跑在同一对文件上并各自独立追加 |
| 每个会话读一次 `settings.json`，用一个 `SettingsStore` 去写 | 每个目录一个管理器，两层 | 一个目录上的两个会话持有同一个文件的两个版本，最后写的人赢 |
| @my-agent/llm 内置的模型目录 | `<agent home>/models.json`，前面没有注册表 | 存在哪些端点、它们的上下文多大，是**用户的事实**；一行本来就**是**一个端点加一个密钥，所以"每行一个 provider"持有的只是行自己已经有的一个字符串——而那个字符串现在就是该行的 `name`，它既是选择器显示的标签，也是 transcript 记录的身份 |
| 每行一个传输层 | 每一行都走 Anthropic Messages，每模型能力从 wire id 推导 | 本应用只说一种 API，所以传输层选择会是一个没人能采取行动的选择；某个 Claude 模型接受什么仍然必须按模型来，而 wire id 是手打的一行所携带的唯一事实 |
| pi-ai 的懒加载 API，以及它推迟的那四个 API | `api/anthropic-messages.ts` 静态导入，其他实现删除 | 本应用能发的唯一请求就是它一直在发的那一个，所以推迟一个它总要加载的模块买不到什么，却会在树里留下四个任何行都够不到的实现 |
| pi-ai 的服务端拒绝回退：`compat.allowedFallbackModels`、`fallbacks` 请求字段、它的 beta header、标记流中途模型切换的 `fallback` content block、以及为答案计价的目标成本 | 删除 | 被允许的目标是 pi 生成目录的一个事实，而本应用没有那份目录：手打的一行无法说明它的端点接受哪些模型作为回退，所以 `allowedFallbackModels` 从未被设置、没有任何请求携带过 `fallbacks`、每个读它的分支都不可达。这样的响应会把什么价钱算错，不是一个能从 wire id 推导出来的能力，所以它不是本应用声称拥有的能力 |
| pi-ai 的 `Models`/`Provider` 注册表、凭据存储、OAuth 登录、环境变量密钥查找 | 该行自己的密钥，骑在发请求所用的模型上（`Model.apiKey`），并由 `Agent.adoptCurrentRow()` 在每次请求前按活行原地重算整个模型 | 这里的模型**就是**端点加上到达它的密钥，两者都存于 `models.json`；用户没有输入的密钥是本应用看不到的密钥，而浏览器配对和令牌刷新没有可以发生的表面。重新推导而不是在旁边解析密钥，是更强的陈述：对端点、窗口或 wire id 的一次手工编辑，能抵达一个**一直开着**的会话，而不只是它的密钥 |
| 会话属于进程启动时所在的那个目录 | 会话属于它自己快照里的 `workDir` | 从另一个目录分组打开一行，必须按它自己的 `workDirAbsPath` 解析相对路径 |
| 工具被限制在会话的工作区里（`Workspace.resolve` 拒绝根之外的路径） | 目录只是相对路径的基准：`resolveToolPath(workDirAbsPath, …)` 原样接受绝对路径、允许 `..` 走出去，`Workspace` 类整个删除 | 「agent 只能碰这个文件夹」把一个本地对话当成了沙箱：要求它改 `/tmp` 里的一份配置、或看 `~/notes` 里的一条日志，用户都得先搬文件。目录仍然决定一个裸路径是什么意思、命令从哪里开始，这就够了；真正的边界不是路径 |
| 模型切换在顶栏、工具集合在弹层、计量表在侧边栏 | 侧边栏角落一个按钮后的统一设置面板，加上输入框上的一个模型座位 | 那些是很少碰的控件，却坐在"对话被读取"的那片 chrome 里；状态行只保留会话的 token 总数、缓存命中率和上下文占用，别无其他。模型及其 thinking level 是证明这条规则的那个例外：它们跟随**对话**，所以属于书写区下方那一行，而新会话打开时的默认值是模型行的字段 |
| 模型和 thinking level 作为 `PATCH /api/sessions/{id}` 的补丁字段 | 消息体上的一个 `ModelSelection`，由 `prepareRequest` 记录 | 配置变更在发出的那一刻就被施加——为的是一个两者都没用它发过请求的会话。transcript 只交代"什么回答了某一轮"，所以记录发生在 `prepareRequest` 改写快照的那一刻，而不是用户指向某个东西的那一刻 |
| thinking level 作为流上的一个选项（`SimpleStreamOptions.reasoning`） | 模型上的一个字段（`Model.thinkingLevel`） | 这里的模型就是一次请求的配置，而 level 是它的一部分：level 待在模型旁边时，wire 就有了同一个强度的两个来源，而 `streamSimple` 原本就是为了把一个翻译成另一个而存在。放在模型上，effort 就在端点所在之处被读取，翻译失去了对象，两个入口也随之合并成一个 `stream` |
| 压缩建立在 vendored 循环的辅助函数上 | 我们的切口规则加 pi 的提示词对，作用在我们的 entry 上（提示词对随引擎一起并入 `agent.ts`） | pi 的压缩期望它自己的 entry 格式；切口是我们的——每个已完成的轮次折叠、正在飞的轮次保留——而提示词对是 pi 的 |
| `server/protocol.ts` | `core/src/protocol.ts` | 客户端 import 同一套 wire 类型，所以它们属于双方都能触达的地方 |
| 审批作为 `Agent` 内部的逻辑 | `settings.approval` 加默认的 `before_tool` hook | transcript、闸门和工具输出兜底是同一个 hook 表面上的默认值，而不是会话内部的逻辑 |
| `scripts/` 按原计划的样子 | 加了 `install-deps.ts`、各个 smoke 脚本、`fake-transport.ts` | 这台机器上 npm 取不到最大的那些 packument；而这些脚本在没有供应商密钥的情况下验证循环、会话注册表、导入的模型、审批往返、以及 HTTP 表面；脚本化传输层住在这里而不是 `@my-agent/llm` 里，因为它是本应用的测试替身，而 pi-ai 附带的那个是建立在那个已经消失的注册表之上的 |

## 未构建的东西

插件、扩展、MCP、skills、图像输入、多用户访问、部署、桌面打包。每一样都会在循环配得上之前先给循环加一个概念。

**第一次真实的模型往返也仍未验证**，因为这台机器上没有配置供应商密钥：token 流式、一次重试退避、压缩的摘要调用，都从未被真实供应商回答过。它们周围的一切由 `scripts/fake-transport.ts` 覆盖；见 `README.md` 里的 *验证一次构建*。

