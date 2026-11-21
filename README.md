# my-coding-agent

一个在你本机、自己的桌面窗口里运行的编码 agent。pi 的一段代码作为裁剪副本收进本仓库：`packages/domain/src/agent/llm/`（来自
[`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)）负责模型层——只取本项目真正调用的部分，而且它已经不是一个独立的包，先并进 core、随五模块分层迁入 domain（[ADR-0010](docs/adr/0010-llm-folded-into-core.md)、[ADR-0030](docs/adr/0030-five-module-layering.md)）。运行引擎是我们的代码：它原先是 pi 循环的副本，如今是 `packages/domain/src/agent/agent.ts` 里 `Agent` 的私有方法（先并入 core，[ADR-0007](docs/adr/0007-loop-merged-into-agent.md)；几经往返后由 [ADR-0016](docs/adr/0016-loop-is-orchestration.md) 定为编排层的私有方法），不再跟踪上游。工具、会话存储、HTTP API、窗口 UI 和 Electron 外壳也都是我们自己的。

服务器按模块分层：`app`（组合根）把 agent home 翻译成 `infra`（存储实现）注入给 `domain`（无头 agent 本体）与 `prompt`（system prompt 拼装与项目指示收集，对本仓零依赖的叶子库），`case`（会话应用层：`SessionHub` 与协议信封）与 `trigger`（REST + WebSocket mux 传输面）把它架到线上——见 [ADR-0030](docs/adr/0030-five-module-layering.md)、[ADR-0031](docs/adr/0031-context-folded-into-session.md) 与 [docs/architecture.md](docs/architecture.md)。

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

想从终端看某个布局，得先分清两条路，它们看的不是同一样东西。`npm run desktop:screenshot -- ui.png` **不启动服务器**：它截的是 `--load <page>` 指着的那个页面（`npm run prototype:*` 就是这么拍的，`--click <selector>[,<selector>]` 也只在这条路上有意义）；不带 `--load` 时窗口加载的是 `about:blank`，截出来是一张空白图。要看**真实的窗口**，用 `packages/desktop/scripts/inspect-app`：它进程内启动服务器、加载真客户端，并把页面实际构建出的 DOM 打出来（必须经由 Electron 二进制，且清掉 `ELECTRON_RUN_AS_NODE`——`launch.mjs` 平时替你做的就是这件事）。

### 从 shell 驱动它

`POST /api/sessions/{id}/messages` 在 prompt 被持久化的那一刻就回答 `202`；答案从一条常驻 WebSocket 通道上到达，而命令全都还是 REST。服务器没有 CLI：`packages/app/scripts/serve.ts` 是浏览器 dev 的薄脚本（只收 `--workDir` / `--port` / `--vite` 三个 flag），完整的端点表在 [docs/architecture.md](docs/architecture.md#api)。

```bash
curl -X POST localhost:8080/api/sessions/$ID/messages \
  -H 'content-type: application/json' -d '{"text":"list the files here"}'

# 答案不是一次 fetch 能拿到的：在 /mux 上开一条订阅，再按 streamId 读帧。
# Node ≥ 22 自带全局 WebSocket，不需要任何依赖：
node -e 'const ws=new WebSocket("ws://localhost:8080/mux");ws.onmessage=e=>console.log(e.data);ws.onopen=()=>ws.send(JSON.stringify({type:"open",sessionId:process.argv[1]}))' "$ID"
```

### 为什么用 `install-deps.ts` 而不是 `npm install`

这台机器上的 npm 在取几个非常大的 registry packument（`vite`、`@types/node`）时会以 `zlib: incorrect data check` 失败。Node 自己的 HTTP 客户端处理同样的 URL 却没问题，所以 `scripts/install-deps.ts` 自己解析并解包整棵依赖树，并写出 `npm run` 需要的 `node_modules/.bin` 垫片。它会跳过 workspace 链接，所以 `node_modules/@my-agent/` 下的每个成员都是一个指向对应 `packages/<name>` 的 junction；如果你哪天删掉了 `node_modules`，就重建它们：

```powershell
New-Item -ItemType Directory -Force -Path node_modules\@my-agent
foreach ($p in "app","case","desktop","domain","infra","trigger","web") {
  cmd /c mklink /J "node_modules\@my-agent\$p" "packages\$p"
}
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
| `bash` | 在会话的工作目录里跑一条 shell 命令 |

`write`、`edit` 和 `bash` 默认会在 UI 里请求审批。

## 设置

设置按关注点分属三个文件，每簇一个、且只有一个（[ADR-0028](docs/adr/0028-settings-ownership-per-manager.md)；曾经单一的
`~/.my-agent/settings.json` 只作迁移源：各持有者首次读取时一次性捡走自己的簇，之后旧文件被忽略，不删除不写入）：

- `~/.my-agent/tools.json` —— 工具簇：全局默认的工具集与审批映射、模式（`modes`）、bash 超时。
- `~/.my-agent/models.json` —— 模型簇：导入的模型行、新会话打开时的默认模型（`defaultModel`）、
  种行标记（`defaultModelSeeded`）与重试策略（`retry`）。
- `~/.my-agent/sessions.json` —— 会话簇：steering 与 follow-up 两条队列的全局默认模式。

外观（主题、字号）不在服务端：它随 [ADR-0029](docs/adr/0029-ui-settings-move-to-client.md) 归窗口客户端自己的存储——桌面外壳经 preload 桥写 Electron userData，浏览器回落 `localStorage`——所以它跨端口、跨重开存活。`fontSize` 是整窗字号的基准，量程 10–22、默认 15：滑杆改的是基准，标题、侧栏、代码、状态行等各档从它按各自的步差派生，整窗一起动。

工具簇接受这套键（`tools.json`）：

```json
{
  "approval": { "write": false, "edit": true, "bash": true },
  "bash": { "defaultTimeoutMs": 120000, "maxTimeoutMs": 3600000 }
}
```

`bash` 是一条 shell 命令可以跑多久：`defaultTimeoutMs` 在该调用自己没有指定 `timeout_ms` 时生效，`maxTimeoutMs` 是任何调用的**上限**——要求更久的命令会被压到它，而这个压顶会在工具结果里说明。构建跑得久的项目，就把上限调高。

UI 里做出的变更回到各自簇的文件。每个持有者是**无属性服务**、每次读取都现读自己的文件（构造收注入的存储端口——domain 只认自己声明的端口，`infra` 的 `HomeJsonStore` 一个实现满足三份同形声明，[ADR-0030](docs/adr/0030-five-module-layering.md)）——所以一次变更对每个会话的下一次读取即生效，而会话自己什么都不持有。会话此刻的有效配置（活跃工具集、有效审批、完整模型行）是 `resolveSettings` 把这些文件与该会话快照上的选择**每次现算**出来的组合，从不驻留（[ADR-0019](docs/adr/0019-settings-two-layers.md)）。

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
      "maxTokens": 8192
    }
  ]
}
```

- `name` 是你对这一行的称呼，它既是该行的**身份**也是它的**标签**：会话记录它、配置补丁命名它、选择器显示它，所以只有一个名字，而不是一个可能与背后身份漂移开的显示名。`modelId` 是向端点请求的东西。一个会话的模型读作 `<name>/<modelId>`。名字在你手上是唯一的——`PUT /api/models` 对重复项报 `400` 而不是悄悄加后缀，因为加了后缀的名字会改变**每一条**命名它的会话的含义——而你还没命名的一行会取它的 `modelId`。
- `baseUrl` 是请求去往的地方，走 Anthropic Messages——本应用唯一会说的传输层，所以一行就是"URL + 密钥背后的一个 Claude 模型"，没有传输层可挑。代理、中转或网关是同一个字段填上它自己的地址；表单预填 Anthropic 自己的端点作为起始值，而 `apiKey` 是请求唯一的认证方式。也没有供应商字段：一行**就是**一个端点，你给它的名字就是配置补丁和会话所携带的东西。
- 这一行不再声明自己是否思考。每个模型都能被要求思考，四档——`off`、`low`、`high`、`max`——对每一行都一样，请求里的形状也只有一个：自适应思考，强度作为 effort，**从不发送 token 预算**。`off` 是显式关掉思考，而不是省掉字段。档位由输入框决定并随消息发送，所以它不在这个文件里。
- `contextWindow` 不是装饰：它驱动上下文计量表和压缩何时运行，所以一个错误的值就是一个关于"何时该摘要"的错误决定。
- 密钥以**明文**存在这个文件里、在你机器上，并且永远不会被发回浏览器：`GET /api/models` 把它替换成 `hasApiKey`。一行在**每次请求**时都被重新读取，所以对其中任何字段的编辑——密钥、端点、wire id、窗口——就是下一条消息所用的东西，没有任何东西需要重新打开。

设置面板的模型表单就是同一组字段——名字、模型 id、端点、密钥、上下文窗口、输出上限。设置面板的 Models 页列出存储了什么，新会话打开时的默认模型也来自那里（`models.json` 的 `defaultModel`），服务器不再收 `--model` 一类的启动覆盖。

**模型列表为空时，窗口会替你种下一行起点**：`deepseek-flash`，DeepSeek 的 Anthropic 兼容端点，上下文 1,000,000、输出 384,000、**密钥留空**——应用从不附带凭据，填 key 是只有你能做的事。窗口的默认思考强度是 `high`，那是**客户端**的默认值而不是这一行的字段。它走的是普通的 `PUT /api/models`，所以这一行和你手打的一模一样，每个字段都能改；它也不是目录，只是一行。种成功之后 `models.json` 会记下 `defaultModelSeeded: true`，**此后删掉这一行就是最终决定**：下次启动列表仍然是空的。想让它再出现一次，把这个字段改成 `false`（或删掉它）再启动。

**一行都没有时应用照样能打开**：种不下那行起点（或你把它删了）之后，会话跑在一个占位模型上，它唯一的职责就是以一句提示你去添加一个模型的话失败，而它的名字 `my-agent:unconfigured` 是**保留**的——任何行都不得占用它，因为名字就是一行身份的全部。

一段对话用哪个模型，是在输入框上选的、就在消息框旁边，连同它的 thinking level：两者是**一个座位**，因为 level 属于模型，而移到另一行会落在那一行自己的默认值上。关于这个座位的一切在**带着它发出消息之前**都不会抵达服务器——一个被人指向过、却从未用它发出过消息的模型什么也没回答，所以它不在会话里——而这个选择由使用它的那次请求记录。

旧的 `models.json` 按它写下的样子被读取：一行的 `label` 成为它的 `name`，所以升级保住的是**你选的名字**，而不是你从没见过的 slug。用那些 slug 构建的引用**不能存活**——`models.json` 里存储的默认模型、以及会话记录过的任何模型——所以一个记录过此类模型的会话打开时没有模型，会话里提示去挑一个，和删除一行产生的句子一样。这正是"一个字符串兼两职"的刻意代价：对于那些用过某一行的会话，**改名和删除它是一件事**；换来的，是模型清单永远不会显示一个没人打过的 slug。

## 验证一次构建

仓库声明 Node >= 22.19（类型擦除随版本稳定）；在更早的 22.x 上，任何 `node *.ts`（下面全部 smoke、`serve.ts`）都要先带上 `NODE_OPTIONS=--experimental-strip-types`。

```bash
npm run check                  # 对六模块与 web 客户端跑 tsc，加设计 token 审计与分层守卫
node scripts/smoke-tools.ts    # 工具、会话存储、压缩，不需要供应商密钥
node scripts/smoke-sessions.ts # 会话注册表，不需要供应商密钥
node scripts/smoke-models.ts   # 导入的模型与无模型占位，不需要密钥
node scripts/smoke-model-manager.ts # 模型目录对真实 models.json 的往返：读时迁移、写前重读、未知键保留；不需要密钥
node scripts/smoke-model-settings.ts # 模型簇（行、默认模型、retry）的读写与按键迁移；不需要密钥
node scripts/smoke-default-model.ts # 内置默认模型：常量、服务端收下的形状、先存行后落标记；不需要密钥
node scripts/smoke-settings.ts # resolveSettings 组合视图：模式指针 → 工具集与审批、记录的选择 → 默认行；不需要密钥
node scripts/smoke-tool-settings.ts # 工具簇（tools.json）：读时迁移、写前重读、只动点名字段；不需要密钥
node scripts/smoke-session-settings.ts # 会话簇（sessions.json）：两条队列的全局默认模式与读时迁移；不需要密钥
node scripts/smoke-session.ts  # 流式、排队、重试、压缩、委派；不需要密钥
node scripts/smoke-replay.ts   # 从快照重开的会话仍显示完整的工具过程：调用与结果，不只是消息；不需要密钥
node scripts/smoke-projection.ts # 概况投影与协议信封，不需要供应商密钥
node scripts/smoke-subscribe.ts # 订阅的帧面：baseline 与增量、恰好一次的失败、end 的次序、断线后不再造帧；不需要密钥
node scripts/smoke-stream.ts   # 流的生命周期：观看决定哪些帧流到窗口、谁在改变会话被谁记下；不需要密钥
node scripts/smoke-mux.ts      # wire 表面：信封、分道、上行容错、连接级载荷；不需要密钥
node scripts/smoke-mux-client.ts # 客户端通道：退避、判活、按引用重放、end 与基线；不需要密钥
node scripts/smoke-mux-live.ts  # 真服务器 + 真 WebSocket 跑生产的 MuxClient；不需要密钥
node scripts/smoke-liveness.ts  # 客户端判死与重连：生产 MuxClient + 一条可故障中继；不需要密钥
node scripts/smoke-backpressure.ts # 写侧停滞策略：注入假 socket，队列预算与截止时间；不需要密钥
node scripts/smoke-frame.ts    # 一帧只画一次：多次请求合并成一帧、回调里再排的是下一帧、取消的帧不跑；不需要密钥
node scripts/smoke-sidebar.ts   # 侧边栏原地改行、按 modified 重排、分页与表头收起；不需要密钥
node scripts/smoke-modes.ts    # 设置面板的模式页、输入框的模式座位与菜单；不需要密钥
node scripts/smoke-session-view.ts # 会话视图的分批绘制与流式代价：两条路画出同一个、流式一帧只碰尾部、脚注跟着轮与运行走、中途来的帧说了算；不需要密钥
node scripts/smoke-branch.ts   # 分支页：一条线上一张卡（任意长的消息都是同一固定高度、单行截断、没有悬停提示）、走法挂在下面一行、走法自己的岔照样画、画布能拖能缩、两个出口两种落地；不需要密钥
node scripts/smoke-model-form.ts # 设置 → 模型表单的八个标签；不需要密钥
node scripts/smoke-approval.ts # 经 API 与 wire 的审批往返、宽限与重启继承，不需要密钥
node scripts/smoke-approval-endpoint.ts # 审批端点契约：409、答案表与恢复运行，不需要密钥
node scripts/smoke-approval-queue.ts # 停在审批上的运行横跨的队列：恢复 run 在取走点排干、遗弃清扫丢弃；不需要密钥
node scripts/smoke-approval-recovery.ts # 恢复机器：grant 续跑、deny 合成、孤儿收尾、恢复中 abort，不需要密钥
npm run smoke:boot             # 进程内服务器启动、落地会话、以及关闭；自带封闭的 agent home，不读机器上的用户配置
node scripts/smoke-desktop-close.ts # 外壳退出顺序：先关服务器再走，含预算与二次退出；不需要密钥
node scripts/smoke-desktop-observability.ts # 外壳的失败面：子进程与渲染进程死亡、未捕获异常、启动超时；不需要密钥
```

`smoke-api` 是唯一**不自带服务器**的一条：先在临时 agent home 上起一台活服务器，`MY_AGENT_URL` 指过去，跑完杀掉。`MY_AGENT_HOME` 指向临时目录，所以它会写的 `models.json` 与它出生的会话都落在那里，不碰机器自己的 agent home：

```bash
MY_AGENT_HOME=$(mktemp -d) node packages/app/scripts/serve.ts --workDir . --port 8080 &
MY_AGENT_URL=http://127.0.0.1:8080 node scripts/smoke-api.ts
kill %1
```

要在没有任何供应商密钥的情况下测试一个会话，用 `scripts/fake-transport.ts` 里的脚本化传输层驱动它：

```ts
import { createFakeTransport, fakeAssistantMessage, fakeToolCall } from "./scripts/fake-transport.ts";
import { createSession, openAgent, createToolManager, SessionManager, type ChatTransport, type ModelConfig } from "@my-agent/domain";
import { HomeJsonStore, SessionFileStore, ToolResultsArchive } from "@my-agent/infra";

const fake = createFakeTransport();
fake.setResponses([fakeAssistantMessage("hello"), fakeToolCall("read", { path: "a.txt" }), fakeAssistantMessage("done")]);
const api: ChatTransport = fake.chatTransport;

const rows: ModelConfig[] = [{ name: "test", baseUrl: "http://127.0.0.1:1/v1", apiKey: "unused", id: "test-model", contextWindow: 200_000, maxTokens: 8_192 }];
```

每次供应商调用一个响应、按顺序，所以一次运行可以按需流式、调工具、失败或卡住。在一个临时目录上构建会话——`session` 由 `createSession(workDir, storeDir)` 交出，存储走自造的 infra 实现注入给 `openAgent`：`sessionRepository` 是一只指向临时 store 的 `SessionFileStore`，三份设置端口由同一只 `HomeJsonStore({ home: 临时 home })` 满足（模型行先经 `ModelManager.replaceRows(rows)` 种上）——就像 `scripts/smoke-session.ts` 的 `openSession()` 那样，并抄走它的**坑**：`finally` 里把临时目录和 store 一起删掉，端口永远指向临时 home，否则每次运行都会把会话文件写进本机真正的 agent home。

看一眼真窗口里客户端到底构建了什么（而不是只看一张图），跑 `packages/desktop/scripts/inspect-app`：它进程内启动服务器、加载真客户端，dump 出侧栏、标题、状态行与设置面板的文本，并演练一次会话切换。`--screenshot` 那条路截不到它——见上面的说明。

```bash
env -u ELECTRON_RUN_AS_NODE packages/desktop/node_modules/electron/dist/electron.exe \
  packages/desktop/scripts/inspect-app --theme dark
```

## 状态

运行引擎（`Agent.run`：多轮循环、steering、工具执行与恢复）、六个工具、会话持久化与恢复、压缩、审批闸门、会话替换、REST API 加一条常驻 WebSocket 通道（`/mux`，同时订阅多个会话、断线判活与重连、写侧背压都有界）、桌面外壳、窗口客户端、以及会话树——会话内部分支和侧边栏里嵌套的 fork——全部可用；类型检查与 smoke 脚本通过（清单见上，均不需要供应商密钥；`smoke:boot` 另自带封闭的 agent home，不读机器上的用户配置）。

**未验证**：第一次真实的模型往返，以及因此只有真实供应商才会走到的部分——token 流式、一次重试退避、压缩的摘要调用。这台机器上没有配置供应商密钥；它们周围的一切由脚本化模型覆盖，而指向一个死端点的一行已经被驱动到一次真实的连接错误。

**未构建**：插件、MCP、skills、图像输入、多用户访问、以及桌面打包（安装包、签名、更新）。细节见 [docs/architecture.md](docs/architecture.md#未构建的东西)。
