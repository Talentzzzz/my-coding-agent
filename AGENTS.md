# my-coding-agent

一个带桌面 UI 的编码 agent。`packages/llm` 是 `@earendil-works/pi-ai` 0.99.2 的裁剪副本，
砍到只剩一个传输层：API-key 认证、流式、wire，以及唯一一个 API 实现 Anthropic Messages——
上游对照已放弃（[ADR-0008](docs/adr/0008-loop-merged-into-agent.md)），由本仓库自己维护。
其余都是我们自己的：模型、工具、会话管理器、运行引擎、HTTP API、窗口 UI、
Electron 外壳。插件不在范围内。

`docs/architecture.md` 是设计参考——请求流程、wire、以及每个选择背后的理由；动手改哪个子系统之前，
先读它对应的那一节。`README.md` 覆盖安装、设置和桌面外壳。**下面的术语只是索引**，每条一句话；
定义、理由和取舍在那两份文档里。

## 布局

```
packages/llm       裁剪自 pi-ai 的传输层，只剩 src/api/anthropic-messages.ts；@ts-nocheck
packages/core      无头 agent：agent.ts（编排 + 引擎）、types.ts（引擎与工具的契约）、模型、工具、会话管理器、系统提示词、上下文。没有传输层
packages/server   node:http、REST 命令 + 一条常驻 WebSocket mux、活跃会话；boot.ts 是整个服务器，main.ts 只解析启动参数
packages/desktop  Electron 外壳：进程内启动服务器，让一个窗口指向它
packages/web      Vite + TypeScript 窗口客户端。渲染常驻通道上的逻辑流
```

## 术语

代码把这些词当作术语来用。

- **service（无属性服务）** —— 无属性服务的形态（ADR-0007）：`Agent` 编排、会话账本（`SessionManager`）、
  模型行（`ModelConfigStore`）、工具目录（`ToolRegistry`）；设置没有 Manager——`fillSettings` 函数族 +
  每会话一只袋（ADR-0011）。构造只收服务依赖，公开方法收 `(id, 请求自己的参数)`，每样数据在**用到它的那一行**向属主现取、
  拿到的只是局部变量；不传、不养任何聚合袋。类壳保留（可构造注入），方法体就写在类里、没有一层同名的
  文件级函数可转发，拆掉的只是 per-session 实例字段；
  Manager 内部按 id / 目录键控的缓存随时可从磁盘重建、且藏在自己内部不被传递——这正是它与聚合袋的
  分界。
- **engine（引擎）** —— `Agent.runEngine`：一次运行的入口与出口，编排层自己的方法，**没有对象**。它读的
  每一处接缝都是编排层的私有成员或这次运行的局部变量（`prepareRequest`、`dispatchEvent`、会话自己的
  两条队列、`state.live.activeRun`、这次运行的模型），所以运行期没有一处瞬态被谁持有。原来的
  `packages/loop` 与它的 `Loop` 委派对象已删（ADR-0008）——「循环」从此不是组件的名字，只是那些轮次
  的日常说法。
- **tool（工具）** —— `AgentTool`；`createToolRegistry(toolDefinitions())` 是**进程**的目录（定义 +
  注册进来的工具）。定义是 `(run) => createReadTool(run.workDirAbsPath)` 这样的工厂，所以目录里没有常驻的工作
  目录：`active(state, run)` 拿着随请求来的 `ToolRunContext` 现建可执行集合，活跃集合本身是从账本
  派生的一次读取，不在任何一处持有。没有插件注册表。
- **session（会话）** —— 两个文件（ADR-0009）：`.json` 快照（身份 + title/model/thinkingLevel/工具/审批
  的当前值，变更即整体原子重写）配同 stem 的只追加 JSONL 日志（六种 kind，账本、唯一事实），由
  无状态的 `SessionManager` 拥有——打开时 `fillSession` 合并两份重放出纯数据状态，host 在手时它是
  这两个文件唯一的写者（ADR-0006）；文件随第一条消息**同时**出生（`.json` 是 commit marker），没说过话的
  会话不落盘、不进侧边栏；标题是快照的 `title` 字段，没写过就从分支首条 user 消息派生；配对残缺
  或版本不对的会话直接删、不迁移。
- **settings（设置）** —— `fillSettings` 合并全局与目录两份 `settings.json`（每次打开现读一份快照，
  没有任何缓存），变更写回**已经提供该字段**的那一份。窗口里「设置」这个词**分两级**：**会话级**（工具集合与审批，记在会话 `.json`
  快照的 `activeTools` 与 `approval` 字段里，没单独选过就沿用全局；窗口里没有手动编辑入口，改动它
  只有「选一个模式」这一条路）与**应用级**（外观、模型清单、默认模型、bash 超时，以及全局默认的
  工具集与审批）。
- **model（模型）** —— `models.json` 里的一行**就是**一个 `ModelConfig`：一个端点、一个密钥、以及模型
  自己的事实（`id` 是接口认识的名字，`name` 既是身份也是标签）。`packages/llm` 的 `Model` 类把它变成发
  请求用的对象（`apiKey`、`thinkingLevel` 都骑在这个对象上），`stream(context, options)` 走它携带的
  transport；`Model` 构造时
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
  不是一次配置变更；`recordSelection` 在 `prepareRequest` 顶部才改写快照的 `model` / `thinkingLevel`
  字段，没说过话的会话因此不落盘。
- **transport（传输层）** —— 命令面是 REST：一条常驻 WebSocket mux（`/mux`）承载事件与连接级载荷，
  命令一个字不改地留在 REST。`createRoutes()` 是整张 API 表，`Router` 是唯一解释 URL 的地方，命令
  在被施加时作答——mux 的上行帧**不走 URL**，所以"加一个端点"这条形状管不到 `open` / `cancel`。
  默认端口 8080。abort 是 REST 命令不帧化、不引入 ack/requestId，mux 上行 `cancel` 只用于取消订阅
  （[ADR-0001](docs/adr/0001-transport-websocket-mux.md)、`.scratch/mux-landing/`）。**一条常驻连接
  是一个 `Writable`，所以写侧必须有界**：`write()` 返回 `false` 之后停写，帧进有界队列（4 MiB /
  10 秒），超限用 `1013` 关掉整条连接。
- **claim（认领）** —— 持有者对活跃会话的握持：只有改变会话的请求与在飞的运行各在其长度内一个；读
  transcript 不拿claim，**订阅也不拿**——一张订阅表回答"这条连接订了什么"，与 claim 回答"这个请求
  必须跑在活跃会话上"永不互相换算（ADR-0001）。
- **approval（审批）** —— 结束重启（ADR-0006 §5）：`before_tool` 对要问的调用返回 suspend，结束本轮
  运行且不写结果，tool call 在账本里悬空（有 tool_use 无 tool_result，派生态）；答案经
  `POST /api/sessions/{id}/approvals/{toolCallId}` 到达后启动恢复运行，由引擎的恢复机器按
  toolCallId 配对续跑——grant 重跑该调用、deny 合成结果，无答案的孤儿合成错误结果收尾。
  哪些工具会问是**按会话**的，记在快照的 `approval` 字段里。
- **tool set（工具集合）** —— 活跃工具和审批映射是**一个**决定，一起写在会话 `.json` 快照的
  `activeTools` 与 `approval` 两个字段里；它是状态，绝不是对话。
- **mode（模式）** —— 全局设置里一个命名的预设：工具集合 + 每工具审批映射，整份存进 settings 的
  `modes` 字段。内置「默认」模式不存储——它就是全局默认（`tools` 缺省全量 + `approval`）的活视图，
  在设置 → 模式里可以像普通模式一样点开、保存；选「默认」就是让会话回到全局默认。会话选模式 = 现有的
  `PUT /tools` + 审批 `PATCH` 两个命令的组合，写的是快照的既有字段——没有新模式端点，也没有新
  entry kind；输入框的座位是从快照与模式表**按值匹配**出来的（ADR-0005）。
- **fork（派生子会话）** —— `forkFrom()` 写出**一对**新文件，把源的 `.jsonl` 路径记为 `parentSession`，
  链和 id 原样复制，title/model/level/工具/审批五个当前值随拷。
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
- **retry（重试）** —— 一次瞬时的供应商失败在引擎**之下**重试：`startRun` 给这次运行包一层 transport，
  策略就装在里面，引擎只是对模型 `stream`；失败的尝试从不被记录。
- **queue（队列）** —— 一次运行正在流式时被接受的消息：`steer` 在下一个取走点注入，`followUp` 等这一
  轮结束。
- **assembly（装配）** —— `assembleSession()` 按会话先、设置后的链（`fillSession` → `fillSettings` →
  `createLive`）装配出一份 `AgentState`——装配产物**就是**状态（ADR-0011），只装配、不激活；
  `createSessionAgent()` 是另一半：把服务组起来变成一个**编排层**，进程只需要一份（hub 构造时建它），
  测试与只跑一个会话的调用者用 `openAgent() == assemble + create + adopt` 自组一份。`Agent` 按 id 键控
  持有各会话的状态——公开方法收 id、从状态现取：durable 半是 `state.session`（账本重放出的袋子），
  live 半是 `state.live`。它只决定 transcript
  **命名**哪一行（`modelFor()` 每次请求按选择现查目录，不缓存行的事实）。
- **AgentState（会话状态）** —— 一个会话的全部状态是一件东西（ADR-0011）：`state.session`（账本重放出的
  durable 半）、`state.setting`（本次打开解析出的设置袋）、两个订阅集合，与 `state.live`（`Live`：两条
  队列、在飞运行、partial、重试与挂起位——「进行中且磁盘上没有」的东西）。由 `Agent` 按 id 键控持有，
  `adopt` 是唯一入口、`evict` / `drop` 是唯一出口，进程重启即清空。
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
- **文档用中文，源码注释用英文。** `docs/`、`README.md`、`AGENTS.md` 一律中文；代码标识符、路径、
  命令、API 名、线上协议保持英文。源码注释用英文——这是整棵树的约定，新写的代码照此（既有的两个例外
  是 `scripts/wire/client.ts` 与 `proxy.ts` 的中文注释，见 `.scratch/mux-landing/issues/08-smoke-wire.md`
  的登记）。面向人的字符串按用到它的地方写：窗口文案是简体中文（只有一个 locale），诊断日志（服务端
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
  `SessionHub.claim()` 之外没有东西持有一个会话。**mux 的上行帧不是端点**——`open` / `cancel` 不走
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
