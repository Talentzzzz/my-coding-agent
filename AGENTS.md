# my-coding-agent

一个带桌面 UI 的编码 agent。`packages/core/src/llm/` 里有一份 `@earendil-works/pi-ai` 0.99.2 的裁剪副本，
砍到只剩一个传输层：API-key 认证、流式、wire，以及唯一一个 API 实现 Anthropic Messages——上游对照已
放弃（[ADR-0008](docs/adr/0008-loop-merged-into-agent.md)），由本仓库自己维护，并且已经并进 core
（[ADR-0015](docs/adr/0015-llm-folded-into-core.md)）。其余都是我们自己的：模型、工具、会话管理器、
运行引擎、HTTP API、窗口 UI、Electron 外壳。插件不在范围内。

`docs/architecture.md` 是设计参考——请求流程、wire、以及每个选择背后的理由；动手改哪个子系统之前，
先读它对应的那一节。`README.md` 覆盖安装、设置和桌面外壳。**下面的术语只是索引**，每条一句话；
定义、理由和取舍在那两份文档里。

## 布局

```
packages/core      无头 agent：agent.ts（编排：会话表、命令、审批、投影与事件契约，以及一次运行的引擎 + 填充链 + 压缩 + 重试 + 闸门）、session/（账本、状态、fanout、事件）、types.ts（引擎契约，转发合并后的 Context/Tool 名字）、llm/（裁剪自 pi-ai 的传输层：api/、model.ts、models.ts、types.ts（Context 与 Tool 住这里）、utils/；@ts-nocheck）、模型、工具、系统提示词、上下文。没有 HTTP 传输层
packages/server   node:http、REST 命令 + 一条常驻 WebSocket mux、活跃会话；boot.ts 是整个服务器，main.ts 只解析启动参数
packages/desktop  Electron 外壳：进程内启动服务器，让一个窗口指向它
packages/web      Vite + TypeScript 窗口客户端。渲染常驻通道上的逻辑流
```

## 术语

代码把这些词当作术语来用。

- **service（无属性服务）** —— 无属性服务的形态（ADR-0007）：`Agent` 编排、会话账本（`SessionManager`）、
  配置（`SettingManager`——设置与模型行共用的无状态门面，ADR-0011 修订节）、工具表（`ToolManager`）。构造只收服务依赖，公开方法收 `(id, 请求自己的参数)`，每样数据在**用到它的那一行**向属主现取、
  拿到的只是局部变量；不传、不养任何聚合袋。类壳保留（可构造注入），方法体就写在类里、没有一层同名的
  文件级函数可转发，拆掉的只是 per-session 实例字段；
  Manager 内部按 id / 目录键控的缓存随时可从磁盘重建、且藏在自己内部不被传递——这正是它与聚合袋的
  分界。**工具域有一个例外**：`ToolManager` 持一张常驻实例表
  （[ADR-0016](docs/adr/0016-tool-manager-instance-table.md)），是这条形态里唯一持有实例的服务；
  `SessionManager` / `SettingManager` 与 `Agent` 编排仍是原来的形态：每样数据在用到它的那一行现取、
  不养聚合袋，这条不变。理由与边界只在那条 ADR，这里不复述。**消费边界是另一条**：三只 Manager 的
  构造由 `createSessionAgent()` 吸收、在本进程的唯一消费者是 `Agent` 编排，server 包只认编排层的公开
  面——这条归 [ADR-0017](docs/adr/0017-agent-facade.md)，由 `npm run check` 的 `check-server-facade`
  守卫。
- **engine（引擎）** —— `Agent.run`：一次运行的入口与出口，与 `runEngine`、`prepareRequest`、压缩
  阶梯、重试泵、两个闸门一起是 `Agent` 的私有方法（ADR-0024：loop 就是编排，没有回调面、没有
  白名单、没有守卫）。它读的每一处接缝要么是这次运行的局部变量（模型、abort controller、事件 sink，
  以及**这次运行自己重放出的那只袋**），要么是 `this`——三只 Manager、hooks、transport、prompt
  builder 都在编排层自己身上。`RunInput` 只有三件值（`state` / `bag` / `start`）；那只袋是
  ADR-0019 的「一次运行读一次盘」，开跑时 `bag(id)` 一次装进、运行全程写它。工具调用经
  `executeTool` 执行（转发 `ToolManager.execute`，
  [ADR-0016](docs/adr/0016-tool-manager-instance-table.md)），解析只对着本请求声明过的数组按名查
  ——「模型被告知什么与它可以运行什么」从同一个对象作答；发给模型的是带 `tools` 的 `Context`
  ——同一个 `Tool` 的两半都经它手，而传输层只读另一半（ADR-0015）。「循环」只是那些轮次的日常说法。
- **fanout（扇出）** —— `session/fanout.ts`：`emitEvent`、`publishState`、`appendMessageEntry`、
  `dropQueued`、`emitQueueUpdate`、`nextStamp`、`snapshotOf`、`approvalsOf`，参数是
  `(state, session, SessionServices)`——那只袋是**调用方自己开的**，函数不持有、不缓存（ADR-0019）。
  编排层与运行对象都发事件、都写账本，所以这些无状态件谁的成员都不是；
  写边界 `finalizeToolResult` 也住这里。
- **tool（工具）** —— `Tool`（`llm/types.ts`）：声明（`name` / `description` / `parameters` /
  `constrainedSampling`）与执行（`label` / `prepareArguments` / `outputSchema` / `execute` / `replay` /
  `executionMode`）在**一个**类型里，传输层只读前一半、引擎只用后一半（ADR-0015）。`Tool` 与目录无关：
  `execute` 的第三个实参是本轮栈上的 `ToolRunContext`（`workDirAbsPath` + bash 超时），所以六个内置都由
  零参工厂造出、一个实例服务所有会话。`ToolManager`（`tools/manager.ts`，
  [ADR-0016](docs/adr/0016-tool-manager-instance-table.md)）是**进程**的那只服务：一张 `Map<name, Tool>`
  装全部实例（首次访问一次填满六个，懒），公开面四法 `names` / `get` / `execute` / `register`——
  `execute` 是生产代码唯一调 `Tool.execute` 的地方，`register()` 是测试接缝（只加新名字，同名连内置也
  抛错）。「这一轮能调哪些、哪些要问」仍是**一次选择**，纯数据 `ToolState` 从账本派生、每次读取现算：
  **Map 持全部实例、活跃名单不进 Map**，判活的是引擎手里那个 `ReadonlySet<string>`。没有插件注册表。
- **session（会话）** —— 两个文件（ADR-0009）：`.json` 快照（身份 + title/model/thinkingLevel/工具/审批
  的当前值，变更即整体原子重写；另有一个 `suspended` 标记——停在审批闸门的**纯显示缓存**，仅 true
  落盘、缺省即 false，账本为准、控制流不读，[ADR-0021](docs/adr/0021-snapshot-suspended-marker.md)）
  配同 stem 的只追加 JSONL 日志（六种 kind，账本、唯一事实），由
  无状态的 `SessionManager` 拥有——打开时 `fillSession` 合并两份重放出纯数据状态，host 在手时它是
  这两个文件唯一的写者（ADR-0006）；文件随第一条消息**同时**出生（`.json` 是 commit marker），没说过话的
  会话不落盘、不进侧边栏；标题是快照的 `title` 字段，没写过就从分支首条 user 消息派生；配对残缺
  或版本不对的会话直接删、不迁移。**这两个文件就是 transcript 本身**：进程里没有一份副本，每次操作
  现开一只袋、用完就丢（`Agent.bag(id)`，ADR-0019）——唯一的例外是文件还没出生的那只袋，它在
  `live.unwritten` 上，因为那时它是唯一的一份。
- **settings（设置）** —— `SettingManager` 是设置与模型行**唯一**的门（ADR-0011 修订节）：无状态门面、
  不做任何缓存，每个方法现读全局与目录两份 `settings.json`，变更写回**已经提供该字段**的那一份；一次写入
  对一切会话的下一次读取即生效，没有需要失效的副本。会话的模型行走同一只门（`modelCatalog()` /
  `replaceModels()`）。窗口里「设置」这个词**分两级**：**会话级**（工具集合与审批，记在会话 `.json`
  快照的 `activeTools` 与 `approval` 字段里，没单独选过就沿用全局；窗口里没有手动编辑入口，改动它
  只有「选一个模式」这一条路）与**应用级**（外观、模型清单、默认模型、bash 超时，以及全局默认的
  工具集与审批）。
- **model（模型）** —— `models.json` 里的一行**就是**一个 `ModelConfig`：一个端点、一个密钥、以及模型
  自己的事实（`id` 是接口认识的名字，`name` 既是身份也是标签）。`llm/model.ts` 的 `Model` 类把它变成发
  请求用的对象（`apiKey`、`thinkingLevel` 都骑在这个对象上），`stream(context, options)` 收一个
  `Context`（messages + system + **必填**的 `tools`）并走它携带的 transport；`Model` 构造时
  才补上的 `api`、`input`、`cost` 是本构建的**常量**而不是配置项，所以磁盘上的行里没有它们。core 的
  `coerceModelConfig` 是"什么才允许被存下来"的唯一守门人；`createModel(config, level, transport?)` 是
  "一行 → 一个模型"，`modelFor(choice, catalog, transport?)` 是"一个**选择** → 一个模型"——按 `name` 现查
  目录，查不到就用占位行的事实、保留用户选的名字。所以会话只存**选择**（`ModelChoice` 的 `name` 与
  `thinkingLevel` 两个字段），行的事实从不复制进任何袋子：每次构造都重新读文件，改密钥/挪端点下一次
  请求就生效，没有需要失效的副本。
- **thinking level（思考等级）** —— `off`、`low`、`high`、`max`：一次请求被要求的强度，骑在
  `Model.thinkingLevel` 上，从不发 token 预算，所以 level **就是**强度；`off` 是**显式关掉思考**，
  不是省略一个字段。四档对每个模型都一样，所以档位是**客户端**的事：输入框随消息带来它，行上没有
  默认档，服务端只负责把收到的档位放上模型。
- **model selection（模型选择）** —— 输入框的 `{ model, thinkingLevel }`，随消息发送（`ModelSelection`），
  不是一次配置变更；`applyModelSelection` 在收到的当下就把它写到快照的 `model` / `thinkingLevel`
  字段（含行当前的 wire id——磁盘格式两半都在才落一行），没说过话的会话因此不落盘。
  「这个会话在哪个模型上」是**派生**的：`modelChoiceOf`（`session/model-choice.ts`）按
  「文件记录的选择 → 打开时指定的行 → 设置里的默认行」现算，不再有谁把它种在袋上（ADR-0019）。
- **transport（传输层）** —— 命令面是 REST：一条常驻 WebSocket mux（`/mux`）承载事件与连接级载荷，
  命令一个字不改地留在 REST。`createRoutes()` 是整张 API 表，`Router` 是唯一解释 URL 的地方，命令
  在被施加时作答——mux 的上行帧**不走 URL**，所以"加一个端点"这条形状管不到 `open` / `cancel`。
  默认端口 8080。abort 是 REST 命令不帧化、不引入 ack/requestId，mux 上行 `cancel` 只用于取消订阅
  （[ADR-0001](docs/adr/0001-transport-websocket-mux.md)、`.scratch/mux-landing/`）。**一条常驻连接
  是一个 `Writable`，所以写侧必须有界**：`write()` 返回 `false` 之后停写，帧进有界队列（4 MiB /
  10 秒），超限用 `1013` 关掉整条连接。模型那一侧另有一个同名的 `ChatTransport`（`llm/types.ts`），
  只管一次请求的流式，与这里说的命令面不是一回事（ADR-0015）。
- **hold（持有）** —— 持有者对活跃会话的握持：只有改变会话的请求与在飞的运行各在其长度内一个；读
  transcript 不拿 hold，**订阅也不拿**——一张订阅表回答"这条连接订了什么"，与 hold 回答"这个请求
  必须跑在活跃会话上"永不互相换算（ADR-0001）。名字在 ADR-0018 之前叫 `claim`，语义一字未动。
  计数在编排层（`Agent.hold(id)` / `Agent.release(id)`，读法是 `holdsOf(id)`）：hold 现在只是"谁在用
  这个会话"，不再是"表里那份 transcript 靠谁活着"——transcript 不在表里（ADR-0019），驻留只关乎队列、
  订阅与在飞的运行。hub 的 `hold` / `release(host)` 只是每次连接进出各转手一次。
  它是公开面上唯一的"我要用它"动词——`ensure` 已降为类私有（`ensureState`）：它只保证这个 id 有一份
  live 半，因为"这个 id 在不在内存里"不是调用方的问题。
- **approval（审批）** —— 结束重启（ADR-0006 §5）：`before_tool` 对要问的调用返回 suspend，结束本轮
  运行且不写结果，tool call 在账本里悬空（有 tool_use 无 tool_result，派生态）；答案经
  `POST /api/sessions/{id}/approvals/{toolCallId}` 到达后启动恢复运行，由引擎的恢复机器按
  toolCallId 配对续跑——grant 重跑该调用、deny 合成结果，无答案的孤儿合成错误结果收尾。
  哪些工具会问是**按会话**的，记在快照的 `approval` 字段里。**问题比进程活得久**：重启后悬空 call
  仍可回答，侧边栏的琥珀点由快照的 `suspended` 显示标记点亮（ADR-0021）；标记不参与批/拒/恢复的判断。
- **tool set（工具集合）** —— 活跃工具和审批映射是**一个**决定，一起写在会话 `.json` 快照的
  `activeTools` 与 `approval` 两个字段里；它是状态，绝不是对话。
- **mode（模式）** —— 全局设置里一个命名的预设：工具集合 + 每工具审批映射，整份存进 settings 的
  `modes` 字段。内置「默认」模式不存储——它就是全局默认（`tools` 缺省全量 + `approval`）的活视图，
  在设置 → 模式里可以像普通模式一样点开、保存；选「默认」就是让会话回到全局默认。会话选模式 = 现有的
  `PUT /tools` + 审批 `PATCH` 两个命令的组合，写的是快照的既有字段——没有新模式端点，也没有新
  entry kind；输入框的座位是从快照与模式表**按值匹配**出来的（ADR-0005）。
- **fork（派生子会话）** —— `forkFrom()` 写出**一对**新文件，把源的 `.jsonl` 路径记为 `parentSession`，
  链和 id 原样复制，title/model/level/工具/审批五个当前值与 `suspended` 标记随拷（ADR-0021）。
- **branch（分支）** —— 同一个会话里的另一条路径，而 fork 是另一对文件；`branch(entryId)` 移动 leaf，
  `getBranchPoints()` 报告分支点——**整份日志**的，不是活跃链的，所以树不随 leaf 的位置变形（每个点
  带一个 `anchor`，指窗口该把它的卡片挂在谁下面）。
- **compaction（压缩）** —— transcript 收缩而不是被替换，最便宜的步骤先走：**trim_tool_call_arg**（截短
  工具调用参数）、**clear_tool_result**（清空可重取工具的结果），再到模型写的摘要；每一步是一条
  entry，日志永远保留全文。
- **hook（接缝）** —— 三个进程级接缝：`context`、`before_tool`（审批闸门）、`after_tool`（改写即定稿：
  账本存的就是返回的那个版本；要截断先用 `archiveToolResult()` 归档全文，没约束的超大结果由写边界
  兜底归档到 `.my-agent/tool-results/`）。一个 `Hooks` 服务本进程跑的所有会话，所以每个事件
  都带 `sessionId`，处理器拿它现取目录与被闸的工具映射；默认值由 `createSessionAgent()` 构造时装。
- **retry（重试）** —— 一次瞬时的供应商失败在引擎**之下**重试：`Agent.run` 给这次运行包一层 transport，
  策略就装在里面，引擎只是对模型 `stream`；失败的尝试从不被记录。
- **queue（队列）** —— 一次运行正在流式时被接受的消息：`steer` 在下一个取走点注入，`followUp` 等这一
  轮结束。
- **assembly（装配）** —— `assembleSession(services, options)` 收**必填**的三服务 + 窄的
  `AssembleAgentStateOptions`（原名 `OpenSessionOptions`；只有 transcript 袋子与模型档位，
  工作目录是袋子自己的 `sessionSetting.workDirAbsPath`，没有覆盖参数），按会话先、设置后的链
  （`fillSession` → 设置现读 → `createLive`）装配出一份
  `AgentState`——装配产物**就是**状态（ADR-0011），只装配、不激活。**装配的产物是 live 半，不是
  transcript**（ADR-0019）：袋只是入参，它要么被丢掉（有文件，重放随时能再造），要么存进
  `live.unwritten`（还没文件，谁也再造不出来）；唯一调用者是 `Agent.assembleAgentStateBySession`
  （原名 `open`，`adopt` 已删，装配并进门里，服务由此只能是编排层自己的，不再是包的公开面），而
  这扇门本身已收成类私有：公开面上剩 `create`（造）、`hold` / `release`（用它）与
  `snapshotOf` / `readSessionSnapshot`（读），何时装配、递哪只袋子进表不再是外界的动词。
  `createSessionAgent()` 是另一半：
  收 `{ settingsHome?, modelsHome?, api? }`（外加 test-only 的 `settings` / `tools` 两缝）并**自己造三只
  Manager**——Manager 不再是调用者的决定（[ADR-0017](docs/adr/0017-agent-facade.md)）——组成一个
  **编排层**，进程只需要一份（hub 构造时建它，递的只是 homes 与 api；打开的模型默认不进公开面——
  它是设置里的事实，装配每次从磁盘现读），测试与
  只跑一个会话的调用者用 `openAgent() == create + open` 自组一份。`Agent` 按 id 键控
  持有各会话的 **live 半**——公开方法收 id，transcript 现开一只袋（`bag(id)`），live 半从表里现取：
  `state.live` 是两条队列、在飞运行、partial、重试位、挂起位与 `unwritten`；状态对象不出 core，server
  侧读的是窄读一族（`titleOf` / `fileAbsPathOf` / `isSubmitting` 一类，纯数据）。它只决定 transcript
  **命名**哪一行（`modelFor()` 每次请求按选择现查目录，不缓存行的事实）。
- **AgentState（会话状态）** —— 一个会话的 **live 半**是一件东西（ADR-0019，形状承自 ADR-0011）：
  `{ sessionId, listeners, eventListeners, live }`。没有 `session`：transcript 是两个文件，每次操作
  重放一次（一次运行读一次、带着走；一条命令读一次、用完就丢）。`live` 里除两条队列、在飞运行、
  partial、重试与挂起位之外还有两样：`unwritten`（唯一的内存 transcript——文件还没出生的那只袋）与
  `openedOn`（打开时调用方指定的那一行模型，唯一无处可派生的值）。由 `Agent` 按 id 键控持有，
  装配经 `Agent.assembleAgentStateBySession` 进表、`evict` / `remove` 是唯一出口，进程重启即清空；
  类型不出 core，server 侧只见纯数据窄读（ADR-0017）。
- **workDirAbsPath（当前工作目录）** —— 一个会话的相对路径基准与命令起点，**按会话**，从会话自己快照的
  setting 字段取（`session.sessionSetting.workDirAbsPath`，绝对）。它**不是围栏**：绝对路径原样接受，`..` 也能走出去，工具
  可以碰这台机器上的任何文件——目录只决定一个裸路径是什么意思。
- **directory（目录）** —— 侧边栏的分组：在同一目录里开过的会话归在一组。它只是列表的组织方式，
  没有边界含义；组名可改、可「删除」（只从列表移除，磁盘不动），都是存在设置里的视图决定。
- **event（事件）** —— 一个 `AgentSessionEvent`：`AgentEvent` 与会话自己的成员（`queue_update`、
  `compaction`、`config_changed`、`retry_*` 等）扁平地合在一起。

## 约定

- Node >= 22.19，仅 ESM，TypeScript 由 Node 的类型擦除直接运行；`core`/`server` 没有构建步骤，只有 web
  客户端被打包。
- 相对 import 带 `.ts` 扩展名；只用可擦除语法（没有 `enum`、`namespace`、参数属性），tsconfig 强制。
- 缩进用 tab，双引号，分号；除非第三方类型所迫，不用 `any`。
- **文档与源码注释用中文，可保留必要的英文。** `docs/`、`README.md`、`AGENTS.md` 一律中文；代码
  标识符、路径、命令、API 名、线上协议保持英文。源码注释也用中文（标识符、术语该是英文的地方照写
  英文）——2026-11-12 由「注释用英文」改判，原规则连同它的两个既有例外（`scripts/wire/client.ts`
  与 `proxy.ts` 的中文注释，见 `.scratch/mux-landing/issues/08-smoke-wire.md` 的登记）一并作废，
  全树统一。面向人的字符串按用到它的地方写：窗口文案是简体中文（只有一个 locale），诊断日志（服务端
  与客户端，多为 `mux: ` 前缀）也是简体中文，状态行的 `total`、`cache`、`context` 保持英文。
- 工具失败即抛出：一个抛出的工具会被作为错误结果报告给模型。
- 每个工具路径都经过 `resolveToolPath(workDirAbsPath, …)`：绝对路径原样、相对路径按 `workDirAbsPath` 解析，没有围栏。

## 命令

```bash
node scripts/install-deps.ts .   # 解析并解包依赖（为什么不用 npm install 见 README）
npm run check                    # 对 core、server、web 跑 tsc，加 token 审计
npm run dev                      # http://127.0.0.1:8080，Vite 服务客户端
npm run build:web && npm run start   # 改为服务预构建的客户端
npm run desktop                  # 构建客户端，然后打开桌面窗口
npm run desktop:dev              # 同样，但由 Vite 服务客户端
```

三个坑：外壳只能通过 `npm run desktop`（`packages/desktop/scripts/launch.mjs`）启动，有
`ELECTRON_RUN_AS_NODE` 时会悄悄把 Electron 变成普通 Node；它服务的是 `packages/web/dist` 而不是源码，
所以客户端改动要 `npm run build:web`，或者用 `npm run desktop:dev` 迭代；**编辑源码要用编辑器工具，
绝不要走 shell 的文本往返**——`Get-Content -Raw` / `Set-Content` 按机器的 ANSI 代码页读写，会把一个
UTF-8 文件的行连起来、把每一个非 ASCII 字符换成 `?`。

## 规则

- 绝不提交或打印供应商凭据：密钥只在 `<agent home>/models.json` 里，只骑在一次请求所用的模型上
  （`Model.apiKey`），从不发给客户端——`GET /api/models` 只报 `hasApiKey`，不要加回显密钥的字段。
- 客户端对供应商 SDK 一无所知，只看得到协议消息。
- 不先删掉一个运行时依赖、或不在提交里解释为什么，就不加新的运行时依赖。
- 第一版不做委派（子代理）、插件和 MCP：不要以「先加一对工具」的方式把它们塞回来。要加，先改这条规则
  和对应的架构文档，再动代码。
- 加一个端点 = 控制器上一个方法 + `createRoutes()` 里一条记录：`Router` 之外没有东西解释 URL，
  `SessionHub.hold()` 之外没有东西持有一个会话。**mux 的上行帧不是端点**——`open` / `cancel` 不走
  URL，所以这条形状管不到它们，加一个帧类型也不违反它。
- 改完代码跑 `npm run check` 和对应的 smoke（都不需要供应商密钥）：core 用 `scripts/smoke-tools.ts`，
  模型用 `smoke-models.ts`，会话注册表用 `smoke-sessions.ts`，HTTP 表面用 `smoke-api.ts`，wire 表面用
  `smoke-mux.ts`；清单见 README 的*验证一次构建*。
- 窗口 UI 只读设计 token。`packages/web/src/style.css` 里一个字面颜色就是一个 bug；把值放进
  `tokens.css`，而 `npm run check` 会拒绝一个被引用却从未定义的 `--dsw-*` 名字。
- 跟随**会话**的控件属于输入框，活得更久的控件属于设置面板（模型及其 thinking level、以及一行打开时的
  默认 level 就是这么分的）。transcript 那一列是窗口存在的唯一理由；输入框下面的状态行只携带 token
  总数、**这一轮**从缓存里读回的 token 数（会话均值在 tooltip 里）和上下文占用。

## Agent skills

### Issue tracker

Issue 与 spec 以本地 markdown 文件形式存放在 `.scratch/<feature>/` 下。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个规范的分诊角色，每个标签字符串与它的角色名相同。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：仓库根目录的 `CONTEXT.md` 与 `docs/adr/`。见 `docs/agents/domain.md`。
