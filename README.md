# my-coding-agent

一个在你本机、自己的桌面窗口里运行的编码 agent。pi 的两个 package 承担了重活，以裁剪副本的形式 vendored 进本仓库：`packages/ai`（`@my-agent/ai`，来自
[`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)）负责模型层，`packages/agent`（`@my-agent/agent`，来自
[`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core)）负责 agent 循环——只取本项目真正调用的部分，不是完整的 package。工具、会话存储、HTTP API、窗口 UI 和 Electron 外壳都是我们自己的。

agent 跑在一个 Node 进程里，而不是渲染进程里：它持有你的 API 密钥，而它的本职就是读写文件。窗口是一个客户端——它用 REST 发送 prompt，并从一条常驻 WebSocket 通道上读取 agent 的输出，这也是为什么每一条命令同样能用 `curl` 或脚本发。[docs/architecture.md](docs/architecture.md) 是设计文档：请求流程、API 表、会话格式，以及每一块为什么在那个位置。

## 快速开始

```bash
node scripts/install-deps.ts         # 安装依赖（为什么不用 npm install 见下方说明）
node scripts/install-deps.ts packages/desktop
node packages/desktop/node_modules/electron/install.js   # 取回 Electron 的二进制
npm run desktop                      # 构建客户端，然后打开窗口
```

首次启动时**没有模型可挑**，因为没有内置的模型清单。打开侧边栏底部的 **Settings**，添加一个端点——表单预填的是 Anthropic 自己的地址——并给它一个密钥。这就是全部设置；见 [模型](#模型)。此后，一段对话跑在哪个模型上由**输入框上的那个座位**决定，就在消息框旁边。

`npm run desktop:dev` 改为通过 Vite 服务客户端，所以 UI 改动无需重新构建就会重载。`npm run build:web && npm run start` 把预构建的客户端当作普通 Web 应用在 `http://127.0.0.1:8080` 上服务，而 `npm run dev` 用 Vite 做同样的事。

想从终端看某个布局，`npm run desktop:screenshot -- ui.png` 会把真实的窗口渲染成一张 PNG 然后退出。加上 `--click <selector>[,<selector>]` 可以截取某个控件背后的东西：`--click ".settings-entry,.settings-tab:nth-child(2)"` 拍的是 Models 面板。

不用任何 UI 检查循环：

```bash
npm run cli -- --cwd . "list the files here"
npm run cli -- --list-models
```

### 从 shell 驱动它

`POST /api/sessions/{id}/messages` 在 prompt 被持久化的那一刻就回答 `202`；答案从一条常驻 WebSocket 通道上到达，而命令全都还是 REST。`node packages/server/src/main.ts --help` 会打印每一个端点，[docs/architecture.md](docs/architecture.md#api) 有那张表。

```bash
curl -X POST localhost:8080/api/sessions/$ID/messages \
  -H 'content-type: application/json' -d '{"text":"list the files here"}'

# 答案不是一次 fetch 能拿到的：在 /mux 上开一条订阅，再按 streamId 读帧。
# Node ≥ 22 自带全局 WebSocket，不需要任何依赖：
node -e 'const ws=new WebSocket("ws://localhost:8080/mux");ws.onmessage=e=>console.log(e.data);ws.onopen=()=>ws.send(JSON.stringify({type:"open",sessionId:process.argv[1]}))' "$ID"
```

### 为什么用 `install-deps.ts` 而不是 `npm install`

这台机器上的 npm 在取几个非常大的 registry packument（`vite`、`@types/node`）时会以 `zlib: incorrect data check` 失败。Node 自己的 HTTP 客户端处理同样的 URL 却没问题，所以 `scripts/install-deps.ts` 自己解析并解包整棵依赖树，并写出 `npm run` 需要的 `node_modules/.bin` 垫片。它会跳过 workspace 链接，所以 `node_modules/@my-agent/core` 是一个指向 `packages/core` 的 junction；如果你哪天删掉了 `node_modules`，就重建它：

```powershell
New-Item -ItemType Directory -Force -Path node_modules\@my-agent
cmd /c mklink /J node_modules\@my-agent\core packages\core
```

等 npm 恢复正常后，`npm install --ignore-scripts` 就能替换这个脚本。

关于 Electron 有两件事。安装器解包 package 但从不跑生命周期脚本，所以 Electron 的预构建二进制必须手工取一次——就是快速开始里的最后一条命令——而那个下载来自 GitHub releases，所以在屏蔽它们的网络上，先把它指向一个镜像：

```bash
ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ node packages/desktop/node_modules/electron/install.js
```

启动窗口要用 `npm run desktop`（它跑的是 `packages/desktop/scripts/launch.mjs`），**绝不要**直接用 `electron` 二进制：环境里任何地方设置了 `ELECTRON_RUN_AS_NODE` 都会把 Electron 变成普通 Node，应用在能打开窗口之前就死了。启动器会为子进程清掉它。

## agent 能做什么

| 工具 | 用途 |
|------|------|
| `read` | 带行号、offset 和 limit 读一个文件 |
| `write` | 创建或覆盖一个文件 |
| `edit` | 替换一个精确字符串，拒绝有歧义的匹配 |
| `glob` | 按模式查找文件 |
| `grep` | 按正则搜索文件内容 |
| `bash` | 在工作区里跑一条 shell 命令 |
| `SubAgent` | 把一个自成一体的小任务委派给一个全新的、只读的助手，并取回它的报告 |
| `SubAgentControl` | 收走或停掉一个后台 `SubAgent` job |

最后两个就是那对委派工具。一个子级是它自己的一个真实会话，只用 `read`、`glob`、`grep`——**永远不用** `write`、`edit`、`bash`——有它自己的 transcript 文件放在 `subagents/` 下，并且它从不请求审批，因为没有窗口去回答一个子级的请求。`subagents: false` 会把这两个工具都排除在外，这就是子级无法启动孙级的方式。

`write`、`edit` 和 `bash` 默认会在 UI 里请求审批。

## 设置

设置来自两个文件，按字段合并、工作区那份赢：

- `~/.my-agent/settings.json` —— 你在本机上的那份。
- `<workspace>/.my-agent/settings.json` —— 工作区自己的那份，仓库可以提交它。

两个文件接受同一套键：

```json
{
  "model": "Opus/claude-opus-5",
  "appearance": { "theme": "dark", "fontSize": 15 },
  "approval": { "write": false, "edit": true, "bash": true },
  "bash": { "defaultTimeoutMs": 120000, "maxTimeoutMs": 3600000 }
}
```

`model` 是一个**新**会话打开时所在的行；一段已经在进行中的对话用哪个模型，是在输入框上选的、就在消息框下面那一行，并且属于那段对话。把 `model` 留空会打开你导入的第一行。

`bash` 是一条 shell 命令可以跑多久：`defaultTimeoutMs` 在该调用自己没有指定 `timeout_ms` 时生效，`maxTimeoutMs` 是任何调用的**上限**——要求更久的命令会被压到它，而这个压顶会在工具结果里说明。构建跑得久的工作区，就把上限调高。

UI 里做出的变更会回到**已经提供那个键**的文件，所以一个钉住了 `approval.bash` 的项目继续拥有它，其他一切则落到你 home 里的那份。`SettingsManager`（`packages/core/src/settings-manager.ts`）读写两者；`session.settingsManager` 是那个活对象。

`appearance` 是一项设置而不是浏览器存储，这是有意的：桌面外壳每次启动都会挑一个新端口，而 `localStorage` 是按 origin 隔离的，所以存在那里的偏好会在窗口重新打开的那一刻被忘掉。`fontSize` 是整窗字号的基准，量程 10–22、默认 15（服务端会把它夹回这个区间）：滑杆改的是基准，标题、侧栏、代码、状态行等各档从它按各自的步差派生，整窗一起动。

## 模型

**没有内置的模型目录**，pi-ai 附带的那一份也是刻意不用的。存在哪些端点、它们的价格、以及它们的上下文有多大，是你比一份编译进依赖里的清单更清楚的事——所以每一个模型都是你亲手输入的。行与请求之间也没有注册表：一行本来就**是**一个端点加一个密钥，所以它直接进入它所命名的那次请求。在 **Settings → Models** 里添加行，或者直接写文件：

`~/.my-agent/models.json`

```json
{
  "models": [
    {
      "name": "Opus",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "sk-ant-...",
      "modelId": "claude-opus-5",
      "contextWindow": 200000,
      "maxTokens": 8192,
      "reasoning": true,
      "defaultThinkingLevel": "medium"
    }
  ]
}
```

- `name` 是你对这一行的称呼，它既是该行的**身份**也是它的**标签**：transcript 记录它、配置补丁命名它、选择器显示它，所以只有一个名字，而不是一个可能与背后身份漂移开的显示名。`modelId` 是向端点请求的东西。一个会话的模型读作 `<name>/<modelId>`。名字在你手上是唯一的——`PUT /api/models` 对重复项报 `400` 而不是悄悄加后缀，因为加了后缀的名字会改变**每一条**命名它的 transcript 的含义——而你还没命名的一行会取它的 `modelId`。
- `baseUrl` 是请求去往的地方，走 Anthropic Messages——本应用唯一会说的传输层，所以一行就是"URL + 密钥背后的一个 Claude 模型"，没有传输层可挑。代理、中转或网关是同一个字段填上它自己的地址；表单预填 Anthropic 自己的端点作为起始值，而 `apiKey` 是请求唯一的认证方式。也没有供应商字段：一行**就是**一个端点，你给它的名字就是配置补丁和 transcript 所携带的东西。
- `reasoning` 说明这个模型有 thinking level。它打开时，每次请求都要求自适应思考、并把 level 当作 effort——**所有行一个形状**，且从不发送 token 预算——而 `modelId` 只决定一个 level 怎么拼写、以及存在哪些 level：一个 DeepSeek 行会把 `medium` 折到 `high` 上，而一个无法停止思考的家族没有 `off`。这些事实是**按模型**的，不是按供应商的，弄错一个是 `400`；见 `packages/core/src/anthropic-models.ts`。
- `defaultThinkingLevel` 是在这一行上新建会话的起始 level。它属于**行**而不属于工作区，因为 level 是模型的：一个五级家族的中间那级，不是一个三档端点拥有的 level。模型没有的 level 在保存清单时会被折到它有的某个上，行回来时显示的是**实际保留**的那个。此后 level 归输入框——按对话改变，并随它所属的那条消息一起发送。
- `contextWindow` 不是装饰：它驱动上下文计量表和压缩何时运行，所以一个错误的值就是一个关于"何时该摘要"的错误决定。
- 密钥以**明文**存在这个文件里、在你机器上，并且永远不会被发回浏览器：`GET /api/models` 把它替换成 `hasApiKey`。一行在**每次请求**时都被重新读取，所以对其中任何字段的编辑——密钥、端点、wire id、窗口——就是下一条消息所用的东西，没有任何东西需要重新打开。

设置面板的模型表单就是同一组字段——名字、模型 id、端点、密钥、上下文窗口、输出上限、模型是否思考、以及在其上新建会话打开的 level。`--model <name>/<modelId>` 在服务器上钉住一个，`npm run cli -- --list-models` 列出存储了什么。

**模型列表为空时，窗口会替你种下一行起点**：`deepseek-flash`，DeepSeek 的 Anthropic 兼容端点，上下文 1,000,000、输出 384,000、思考开、默认强度 `high`，**密钥留空**——应用从不附带凭据，填 key 是只有你能做的事。它走的是普通的 `PUT /api/models`，所以这一行和你手打的一模一样，每个字段都能改；它也不是目录，只是一行。种成功之后 `settings.json` 会记下 `defaultModelSeeded: true`，**此后删掉这一行就是最终决定**：下次启动列表仍然是空的。想让它再出现一次，把这个字段改成 `false`（或删掉它）再启动。

**一行都没有时应用照样能打开**：种不下那行起点（或你把它删了）之后，会话跑在一个占位模型上，它唯一的职责就是以一句提示你去添加一个模型的话失败，而它的名字 `my-agent:unconfigured` 是**保留**的——任何行都不得占用它，因为名字就是一行身份的全部。

一段对话用哪个模型，是在输入框上选的、就在消息框旁边，连同它的 thinking level：两者是**一个座位**，因为 level 属于模型，而移到另一行会落在那一行自己的默认值上。关于这个座位的一切在**带着它发出消息之前**都不会抵达服务器——一个被人指向过、却从未用它发出过消息的模型什么也没回答，所以它不在 transcript 里——而这个选择由使用它的那次请求记录。

旧的 `models.json` 按它写下的样子被读取：一行的 `label` 成为它的 `name`，所以升级保住的是**你选的名字**，而不是你从没见过的 slug。用那些 slug 构建的引用**不能存活**——`settings.json` 里存储的默认值、以及会话记录过的任何模型——所以一个记录过此类模型的会话打开时没有模型，transcript 提示去挑一个，和删除一行产生的句子一样。这正是"一个字符串兼两职"的刻意代价：对于那些用过某一行的会话，**改名和删除它是一件事**；换来的，是模型清单永远不会显示一个没人打过的 slug。

## 验证一次构建

```bash
npm run check                  # 对 core、server 和客户端跑 tsc，加设计 token 审计
npm run smoke:boot             # 进程内服务器启动、落地会话、以及关闭；自带封闭的 agent home，不读机器上的用户配置
node scripts/smoke-desktop-close.ts # 外壳退出顺序：先关服务器再走，含预算与二次退出；不需要密钥
node scripts/smoke-desktop-observability.ts # 外壳的失败面：子进程与渲染进程死亡、未捕获异常、启动超时；不需要密钥
node scripts/smoke-tools.ts    # 工具、会话存储、压缩，不需要供应商密钥
node scripts/smoke-sessions.ts # 会话注册表，不需要供应商密钥
node scripts/smoke-projection.ts # 概况投影与协议信封，不需要供应商密钥
node scripts/smoke-mux-client.ts # 客户端通道：退避、判活、按引用重放、end 与基线；不需要密钥
node scripts/smoke-mux-live.ts  # 真服务器 + 真 WebSocket 跑生产的 MuxClient；不需要密钥
node scripts/smoke-mux.ts       # wire 表面：信封、分道、上行容错、连接级载荷；不需要密钥
node scripts/smoke-liveness.ts  # 客户端判死与重连：生产 MuxClient + 一条可故障中继；不需要密钥
node scripts/smoke-backpressure.ts # 写侧停滞策略：注入假 socket，队列预算与截止时间；不需要密钥
node scripts/smoke-sidebar.ts   # 侧边栏原地改行、按 modified 重排、分页与表头收起；不需要密钥
node scripts/smoke-settings.ts  # 设置真实落盘再重读：收展状态跟着 appearance 序列化恢复；不需要密钥
node scripts/smoke-modes.ts    # 设置面板的模式页、输入框的模式座位与菜单；不需要密钥
node scripts/smoke-transcript.ts # 转录的分批绘制与流式代价：两条路画出同一个、流式一帧只碰尾部、脚注跟着轮与运行走、中途来的帧说了算；不需要密钥
node scripts/smoke-frame.ts    # 一帧只画一次：多次请求合并成一帧、回调里再排的是下一帧、取消的帧不跑；不需要密钥
node scripts/smoke-branch.ts   # 分支图卡片：任意长的消息都是同一固定高度、单行截断、整句在 tooltip 里；不需要密钥
node scripts/smoke-session.ts  # 流式、排队、重试、压缩、委派；不需要密钥
node scripts/smoke-models.ts   # 导入的模型与无模型占位，不需要密钥
node scripts/smoke-default-model.ts # 内置默认模型：常量、服务端收下的形状、先存行后落标记；不需要密钥
node scripts/smoke-model-form.ts # 设置 → 模型表单的八个标签；不需要密钥
node scripts/smoke-approval.ts # 经 API 的审批往返，不需要密钥
npm run start &                # API smoke 测试需要一个正在跑的服务器
MY_AGENT_URL=http://127.0.0.1:8080 node scripts/smoke-api.ts
```

要在没有任何供应商密钥的情况下测试一个会话，用 `scripts/fake-transport.ts` 里的脚本化传输层驱动它：

```ts
import { createFakeTransport, fakeAssistantMessage, fakeToolCall } from "./scripts/fake-transport.ts";
import type { ChatTransport, ModelSource, UserModel } from "@my-agent/core";

const fake = createFakeTransport();
fake.setResponses([fakeAssistantMessage("hello"), fakeToolCall("read", { path: "a.txt" }), fakeAssistantMessage("done")]);

const rows: UserModel[] = [{ name: "test", baseUrl: "http://127.0.0.1:1/v1", apiKey: "unused", modelId: "test-model", contextWindow: 200_000, maxTokens: 8_192, reasoning: false }];
const models: ModelSource = { list: () => rows };
const api: ChatTransport = fake.api;
```

每次供应商调用一个响应、按顺序，所以一次运行可以按需流式、调工具、失败或卡住。在一个临时目录上、用 `openAgent({ workspaceRoot, sessionManager, models, api, settingsManager })` 构建会话，就像 `scripts/smoke-tools.ts` 那样——并抄走它的**两个坑**：`finally` 必须**同时**删除临时工作区和 `workspaceDir(root)`，否则每次运行都会留下一个孤儿目录；以及除非这个测试就是在测持久化，否则传 `settingsManager: SettingsManager.inMemory({...})`。

`npm run desktop:screenshot -- ui.png` 渲染真实的窗口；`node packages/desktop/scripts/inspect.cjs`（经由 Electron 二进制）会 dump 页面实际构建出的东西，并演练一次会话切换。

## 状态

核心循环、六个工具与那对委派工具、会话持久化与恢复、压缩、审批闸门、会话替换、REST API 加一条常驻 WebSocket 通道（`/mux`，同时订阅多个会话、断线判活与重连、写侧背压都有界）、桌面外壳、窗口客户端、以及会话树——会话内部分支和侧边栏里嵌套的 fork——全部可用；类型检查与 smoke 脚本通过（清单见上，均不需要供应商密钥；`smoke:boot` 另自带封闭的 agent home，不读机器上的用户配置）。

**未验证**：第一次真实的模型往返，以及因此只有真实供应商才会走到的部分——token 流式、一次重试退避、压缩的摘要调用。这台机器上没有配置供应商密钥；它们周围的一切由脚本化模型覆盖，而指向一个死端点的一行已经被驱动到一次真实的连接错误。

**未构建**：插件、MCP、skills、图像输入、多用户访问、以及桌面打包（安装包、签名、更新）。细节见 [docs/architecture.md](docs/architecture.md#未构建的东西)。
