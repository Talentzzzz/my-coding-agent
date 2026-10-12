# my-coding-agent

一个带桌面 UI 的编码 agent。两个 vendored package 承担了重活：`packages/ai`（`@earendil-works/pi-ai`
0.99.2 的裁剪副本，砍到只剩一个传输层：API-key 认证、流式、wire，以及唯一一个 API 实现
Anthropic Messages）和 `packages/agent`（pi 的 agent 循环、工具执行、事件、steering）。其余都是我们
自己的：模型、工具、会话管理器、HTTP API、窗口 UI、Electron 外壳。插件不在范围内。

`docs/architecture.md` 是设计参考——请求流程、wire、以及每个选择背后的理由；动手改哪个子系统之前，
先读它对应的那一节。`README.md` 覆盖安装、设置和桌面外壳。**下面的术语只是索引**，每条一句话；
定义、理由和取舍在那两份文档里。

## 布局

```
packages/ai       vendored 传输层，只剩 src/api/anthropic-messages.ts；@ts-nocheck
packages/agent    vendored 循环：四个文件，Loop / LoopState（上游叫 Agent / AgentState）
packages/core     无头 agent：模型、工具、会话管理器、系统提示词、上下文。没有传输层
packages/server   node:http、REST + SSE、活跃会话；boot.ts 是整个服务器，main.ts 是 CLI
packages/desktop  Electron 外壳：进程内启动服务器，让一个窗口指向它
packages/web      Vite + TypeScript 窗口客户端。渲染事件流
```

## 术语

代码把这些词当作术语来用。

- **tool（工具）** —— `AgentTool`；`createToolRegistry(workspace)` 持有定义和每会话的活跃集合，没有
  插件注册表。
- **session（会话）** —— 一个只追加的 JSONL 文件，由 `SessionManager` 拥有；entry 的 kind 有
  `message`、`tool_config`、`compaction` 等，未知 kind 原样带过。
- **settings（设置）** —— `SettingsManager` 合并全局与工作区两份 `settings.json`，变更写回**已经提供
  该字段**的那一份。
- **model（模型）** —— `models.json` 里用户导入的一行**就是**一个端点加一个密钥，它的 `name` 既是
  身份也是标签；`modelFor(row, level)` 把一行变成发请求用的模型（`apiKey`、`thinkingLevelMap`、
  `thinkingLevel` 都骑在这个对象上）。
- **thinking level（思考等级）** —— `off` 到 `max`：一次请求被要求的强度，骑在 `Model.thinkingLevel`
  上，从不发 token 预算，所以 level **就是**强度；模型可以没有 `off`（`thinkingLevelMap` 里的
  `off: null`）。
- **model selection（模型选择）** —— 输入框的 `{ model, thinkingLevel }`，随消息发送（`ModelSelection`），
  不是一次配置变更；`recordSelection` 在 `prepareRequest` 顶部才写 entry，没说过话的会话因此不增长
  entry。
- **transport（传输层）** —— REST 加 server-sent events，从不用 socket；`createRoutes()` 是整张 API 表，
  `Router` 是唯一解释 URL 的地方，命令在被施加时作答。默认端口 8080。
- **claim（认领）** —— 持有者对活跃会话的握持：每条事件流一个，外加运行或改变会话的请求在其长度内的
  一个；读 transcript 不拿 claim。
- **approval（审批）** —— `before_tool` 把一次调用停住，直到有人回答
  `POST /api/sessions/{id}/approvals/{toolCallId}`。哪些工具会问是**按会话**的，记录在一条
  `tool_config` entry 里。
- **tool set（工具集合）** —— 活跃工具和审批映射是**一个**决定，一起写在一条 `tool_config` entry 里；
  它是状态，绝不是对话。
- **fork（派生子会话）** —— `forkFrom()` 写出一个**新**文件，把源的**文件路径**记为 `parentSession`，
  链和 id 原样复制。
- **branch（分支）** —— 同一个会话里的另一条路径，而 fork 是另一个文件；`branch(entryId)` 移动 leaf，
  `getBranchPoints()` 报告分支点。
- **compaction（压缩）** —— transcript 收缩而不是被替换，最便宜的步骤先走：**argtrim**、**prune**，
  再到模型写的摘要；每一步是一条 entry，文件永远保留全文。
- **hook（接缝）** —— 会话三个接缝：`context`、`before_tool`（审批闸门）、`after_tool`（超过 80,000
  字符的结果归档到 `.my-agent/tool-results/`）。
- **retry（重试）** —— 一次瞬时的供应商失败在循环**之下**、在 `streamFn` 接缝上重试，失败的尝试从不
  被记录。
- **subagent（子代理）** —— `SubAgent` / `SubAgentControl` 这一对工具；每次委派是一个真实的子
  `Agent`，永不嵌套，跑在收窄到 `read`、`glob`、`grep` 且审批关闭的注册表上。
- **queue（队列）** —— 一次运行正在流式时被接受的消息：`steer` 在下一个取走点注入，`followUp` 等这一
  轮结束。
- **assembly（装配）** —— `openAgent()` 从设置、AGENTS.md、导入的模型构建一个会话；它只决定 transcript
  **命名**哪一行（`adoptCurrentRow()` 每次请求都从活行重建）。
- **workspace（工作区）** —— agent 可以触碰的目录；它是**按会话**的，从会话自己 header 里的 `cwd`
  取根。
- **event（事件）** —— 一个 `AgentSessionEvent`：`AgentEvent` 与会话自己的成员（`queue_update`、
  `compaction`、`config_changed`、`retry_*` 等）扁平地合在一起。

## 约定

- Node >= 22.19，仅 ESM，TypeScript 由 Node 的类型擦除直接运行；`core`/`server` 没有构建步骤，只有 web
  客户端被打包。
- 相对 import 带 `.ts` 扩展名；只用可擦除语法（没有 `enum`、`namespace`、参数属性），tsconfig 强制。
- 缩进用 tab，双引号，分号；除非第三方类型所迫，不用 `any`。
- **文档与注释用中文。** `docs/`、`README.md`、`AGENTS.md` 与源码注释一律中文；代码标识符、路径、
  命令、API 名、线上协议保持英文。窗口文案直接写简体中文（只有一个 locale），状态行的 `total`、
  `cache`、`context` 保持英文。
- 工具失败即抛出：一个抛出的工具会被作为错误结果报告给模型。
- 每个工具路径都经过 `Workspace.resolve()`，好让它留在工作区内部。

## 命令

```bash
node scripts/install-deps.ts .   # 解析并解包依赖（为什么不用 npm install 见 README）
npm run check                    # 对 core、server、web 跑 tsc，加 token 审计
npm run dev                      # http://127.0.0.1:8080，Vite 服务客户端
npm run build:web && npm run start   # 改为服务预构建的客户端
npm run desktop                  # 构建客户端，然后打开桌面窗口
npm run desktop:dev              # 同样，但由 Vite 服务客户端
npm run cli -- --cwd . "list the files here"   # 不用任何 UI 调试循环
```

三个坑：外壳只能通过 `npm run desktop`（`packages/desktop/scripts/launch.mjs`）启动，有
`ELECTRON_RUN_AS_NODE` 时会悄悄把 Electron 变成普通 Node；它服务的是 `packages/web/dist` 而不是源码，
所以客户端改动要 `npm run build:web`，或者用 `npm run desktop:dev` 迭代；**编辑源码要用编辑器工具，
绝不要走 shell 的文本往返**——`Get-Content -Raw` / `Set-Content` 按机器的 ANSI 代码页读写，会把一个
UTF-8 文件的行连起来、把每一个非 ASCII 字符换成 `?`。

## 规则

- 绝不提交或打印供应商凭据：密钥只在 `<agent home>/models.json` 里，只骑在一次请求所用的模型上
  （`BaseModel.apiKey`），从不发给客户端——`GET /api/models` 只报 `hasApiKey`，不要加回显密钥的字段。
- 客户端对供应商 SDK 一无所知，只看得到协议消息。
- 不先删掉一个运行时依赖、或不在提交里解释为什么，就不加新的运行时依赖。
- 子代理是**一对工具**，不是机制：没有供应商注册表、没有嵌套生成、没有新协议。发现自己想加其中
  任何一样时，停下来、去长现有的那一对。插件和 MCP 机制仍然不在范围内。
- 加一个端点 = 控制器上一个方法 + `createRoutes()` 里一条记录：`Router` 之外没有东西解释 URL，
  `SessionHub.claim()` 之外没有东西持有一个会话。
- 改完代码跑 `npm run check` 和对应的 smoke（都不需要供应商密钥）：core 用 `scripts/smoke-tools.ts`，
  模型用 `smoke-models.ts`，会话注册表用 `smoke-sessions.ts`，HTTP 表面用 `smoke-api.ts`；清单见
  README 的*验证一次构建*。
- 窗口 UI 只读设计 token。`packages/web/src/style.css` 里一个字面颜色就是一个 bug；把值放进
  `tokens.css`，而 `npm run check` 会拒绝一个被引用却从未定义的 `--dsw-*` 名字。
- 跟随**会话**的控件属于输入框，活得更久的控件属于设置面板（模型及其 thinking level、以及一行打开时的
  默认 level 就是这么分的）。transcript 那一列是窗口存在的唯一理由；输入框下面的状态行只携带 token
  总数、缓存命中率和上下文占用。

## Agent skills

### Issue tracker

Issue 与 spec 以本地 markdown 文件形式存放在 `.scratch/<feature>/` 下。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个规范的分诊角色，每个标签字符串与它的角色名相同。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：仓库根目录的 `CONTEXT.md` 与 `docs/adr/`。见 `docs/agents/domain.md`。
