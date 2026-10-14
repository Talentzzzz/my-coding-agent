# Map：窗口改造

`wayfinder:map`

## Destination

把 my-coding-agent 的窗口改造成参考图那样的**布局与交互**（参考截图见 `reference/harness-window.png`），
同时修掉已实证的运行时缺陷、让"过程"真正实时可见。

走到终点时，这些同时成立：

- 输入框左上角能选工作目录，选中的目录决定"新会话"落在哪里；
- 有一个**会话级**的设置入口（工具与审批），没单独选过就沿用全局；
- 思考与工具过程可以在窗口里合并显示、展开与折叠；
- 发第二条消息仍然收得到流式（不再需要重开窗口）；
- 左栏分组顺序正确、界面没有中英混用。

**明确不做**——参考图里有，本次一律不做：插件栏、标准模式、会话框左下角的 `+`、"完全权限"这一栏。
理由见 Out of scope。

## Notes

**领域。** 本项目是一个带桌面 UI 的编码 agent：agent 跑在 Node 进程里，窗口是一个 Web 客户端，用 REST
发命令、从一条常驻 WebSocket（`/mux`）读事件流。术语表在根 `AGENTS.md` 的「术语」一节，请求流程与每个
选择的理由在 `docs/architecture.md`——动手改哪个子系统之前先读它对应的那一节。

**执行在范围内。** 本次 effort 覆盖 wayfinder 默认的"只产出决定"：`task` 类型的 ticket 就是**执行切片**，
解决它 = 把改动真的落到代码里，并跑 `npm run check` 加上对应的 smoke。`grilling` 类型的 ticket 仍然只
产出决定。

**参考材料。** `reference/harness-window.png` 是用户给的参考截图。它的**实现**在工作区的
`deepseek-harness-master/apps/web`（不在本仓库的构建图里，只作阅读材料，不要往里写东西）。

**既定约定。** 文档中文、源码注释英文；窗口 UI 只读设计 token——`packages/web/src/style.css` 里一个字面
颜色就是一个 bug，值要放进 `tokens.css`，而 `npm run check` 的 token 审计会拒绝一个被引用却从未定义的
`--dsw-*` 名字；改完代码跑 `npm run check` 和对应的 smoke。

**已验证的事实。** `npm run check` 退出码 0（四个 tsc 项目 + token 审计 104/81）；README「验证一次构建」
里列的 smoke 全部通过，另外 `scripts/smoke-approval-endpoint.ts` 与 `scripts/smoke-stream.ts` 也存在且通过
（漏在 README 清单外）。所以本 map 不处理"构建坏了"这一类问题。

**环境坑（会浪费时间的三个）。**

- `HTTP_PROXY`/`HTTPS_PROXY=127.0.0.1:63262` 且 `NO_PROXY` 为空 → README 里那些 `curl localhost:8080`
  示例会被送去代理然后失败。用 node 的 `fetch`/`WebSocket` 探测（它们不读 env 代理）。
- `ELECTRON_RUN_AS_NODE=1` 已经设置在环境里 → 桌面窗口**只能**走 `npm run desktop`
  （`packages/desktop/scripts/launch.mjs`），直接用 electron 二进制会静默退化成普通 Node。
- `npm run desktop:screenshot` 在本机默认参数下**必崩**（GPU 进程 violation），要加 `--disable-gpu`；
  并且它硬编码写 `packages/desktop/ui.png`（一个 tracked 文件），**传路径是无效的**——出图前先想好别覆盖它。

## Decisions so far

<!-- 关掉的 ticket 依次列在这里：一行要点 + 指向该 ticket 的链接 -->

- [01 参考实现的界面规格](issues/01-ui-spec.md)：参考文献在 `research/ui-spec.md`。三条最吃重的：**点"工作目录"弹出的是自绘菜单（已知工作区列表 + "添加工作区…"），不是原生 select**；**输入框是"卡片上方一行（工作目录 + 模式）+ 卡片内（文本区 + 底部控制行）"，而上面那一行只在空态相位渲染**；**权限审批是"用一张接管卡片替换整个输入框"**（警示色边框 + 拒绝 / 允许一次），不是我们现在的 banner。另外纠正了两处读图歧义：工作区标题右侧源码里是**三个**控件（搜索 / 视图选项 / 添加工作区），空状态里那个"预览版"是**上标徽章**、源码没有独立副标题元素。
- [02 思考（thinking）的数据通路](issues/02-thinking-path.md)：思考内容**一路没被丢**——供应商确实 yield（`packages/ai/src/api/anthropic-messages.ts:571-582`）、agent 明确透传（`packages/agent/src/agent-loop.ts:361-379`）、server 整包推（`packages/server/src/mux.ts:411-417`）；断点在 **web 客户端**：`packages/web/src/state.ts:571` 把它压平成 `[思考] …` 前缀拼进正文那一个 `text` 字段，`Item` 压根没有 thinking 字段。**所以 09 是 `packages/web` 包内两三处协同，不必跨供应商 / agent / server。**
- [04 订阅在 run 结束后不再复活](issues/04-subscription-revive.md)：根因在 `client.ts` 的 `retain`——条目被 `end` 打成 `ended` 之后，新一次 `retain` 只往死条目里加引用就 `return`、**不发 `open`**，而服务端在 `end` 时已经 `forget` 了那条订阅，于是后续帧无处可投。现在 `retain` 对 `ended` 条目复位并补发 `open`（"新的一次想要"会复活，"重连后的按引用重放"仍跳过 `ended`），`main.ts` 的 `onStreamEnd` 也与 `onStreamError` 对齐、释放 send 引用。新 smoke 落 `scripts/smoke-mux-live.ts`，**先红后绿**。改动未提交，在工作区里。
- [03 卡顿热点清单](issues/03-jank-profile.md)：**确认是"每帧 O(对话长度)"，而且不止一处**。头号热点 `transcript.render`：0.65 → 3.30 ms/帧（既有历史 50 → 500 条，5.07x），硬证据是每帧 `querySelector` 调用 **161 → 1511**，正好 = `items × 3`（`transcript.ts:170-198` 的 `applyControls` 对**每条消息**无条件跑 3 次）。其次：`renderMarkdown` 每帧重解析**整条**消息（单条 8000 字累计 144 ms，O(T²)）、`renderTools` 输出一变就整组 `replaceChildren`、`sidebar.render`（工作区 4 → 200 时 0.61 → 30.9 ms）而 `main.ts:344` **每帧无条件**调它。**全部落在客户端**，不涉及服务端。
- [05 三条已实证的小缺陷](issues/05-small-defects.md)：① 侧边栏分组标题现在在会话行**之上**（`renderRows` 把 `previous` 初值从 `undefined` 换成 `wrapper.firstElementChild`，也就是标题本身）；② transcript 补了一次按 `items` 顺序的 place（压缩摘要现在落在头部，和 sidebar 同款手法）；③ 默认标题 `New session` → 「新会话」（`session-manager.ts` 两处），`docs/architecture.md` 那处散文引用也一并改了。三条都是**先让断言红、再修到绿**：`smoke-sidebar.ts` 新增子树顺序断言，transcript 那条另有最小 DOM 装置。改动未提交。
- [06 「设置」拆成会话级与应用级](issues/06-settings-split.md)：「没单独选过」的判据定为**字段等值**——branch 上最后一条 `tool_config` 逐字段等于当前全局值、没有 entry 也算沿用全局——而不是"有没有 entry"，因为会话文件只追加、复位必然写成一条等于全局的新 entry，「有 entry」会错报；「沿用全局」复位 = 用现有 `PUT /tools` + `PATCH` 端点组合写一条等于全局值的 entry（会话层**没有撤销**，查证过）；**新增全局默认工具集** `Settings.tools`（缺省 = 全部启用，装配时照 `applyRecordedToolConfig` 先例过滤未知名字），应用级面板因此补上全局默认审批与工具两节；运行中改会话级设置的原子性边界（`setActive` 先验后动、409）查证未变。会话级面板「会话设置」（工具 + 审批 + 沿用全局显示与复位），应用级维持「设置」。快照加 `toolsFollowGlobal` / `approvalsFollowGlobal` 两个显示布尔。代码全归 10 号。
- [07 按选中目录新建会话，及其作用域连坐](issues/07-cwd-scope.md)：**服务端保持无状态**——`POST /api/sessions` 收可选 `cwd`（`hub.newSession(cwd?: string)`），校验"存在且是目录"、不要求是已知工作区（新建到没进过的目录正是第一次进它的正道；workspace root 是工具路径的围栏不是进程的围栏）；**作用域连坐选 (a)**：选择器只影响新建会话，`sessions()`/`settings()`/`current()` 继续 scoped 到启动目录，另一工作区的列表 `GET /api/workspaces` 本来就带回。客户端持有一份"选中目录"状态（默认 = 活跃会话的工作区），hero 芯片、左上角"新会话"、侧栏"当前"标记三处读同一份；芯片照参考实现**只在空态渲染**（语义是将来时，恰好咬合）；~~不做"添加工作区…"~~（由 08 号改判为做，见下）；重启**不记**（localStorage 死于 origin，为瞬时偏好开持久化层不成比例）。
- [08 与仓库既有约定冲突的两处](issues/08-convention-conflicts.md)：状态栏 `total` / `cache` / `context` **保留英文**（刻意的技术读数，不改 `AGENTS.md` 的约定）；空状态**保留现状**（不抄鱼形 logo）；左栏三个控件里**搜索做真**（客户端过滤）、**视图选项只做观感**（排序维持 `modified` 降序）、**添加工作区做真**——推翻 07 号初版的"不做"，走 **OS 原生文件夹选择器**（应用内仍不列目录、不做浏览）。
- [10 照参考图落地布局与观感](issues/10-layout-landing.md)：六条全部落地——工作目录芯片（自绘菜单 + `pickedWorkspace` 三处同源，`POST /api/sessions` 收可选 `cwd`，"添加工作区"走 `desktop.pickFolder()` 的 OS 对话框）；设置拆成会话级（composer 齿轮 →「会话设置」，工具/审批 + followGlobal 显示 + 总复位，复位 = 写一条等值 entry）与应用级（外观/模型/**默认**，新设置字段 `Settings.tools` 全局默认工具集 + 首次有了 UI 的全局默认审批）；审批改成**接管卡片**替换输入框（警示边框 + 状态条 + 拒绝/允许一次 + Enter/Escape）；快照新增 `toolsFollowGlobal`/`approvalsFollowGlobal`（分半判据，core 冷读与活快照共用实现）；搜索真过滤、视图选项观感；token 新增 `--dsw-radius-xl` 与 `--dsw-warn-tint`。截图四张在 `research/`。`desktop:screenshot` 在本机连 `--disable-gpu` 也崩（GPU 进程 0xC0000005），出图改走 `bootServer` + 本机 Chromium（`research/shots.ts`）。

## Not yet specified

- **同一会话被两个窗口打开时的语义**是否需要重新说明——04 修好"订阅复活"之后，"谁在看这个会话"这个
  问题会第一次变成真的，到时候再看要不要一条 ADR。
- **`desktop:screenshot` 的坏形状要不要顺手修**（路径被忽略、默认崩溃）——它是工具而不是产品，等 10 用
  到它的时候再决定。

## Out of scope

- **插件栏**：参考图左栏顶部有，本项目把插件明文排除在范围外（`AGENTS.md`「规则」）。
- **标准模式**（agent preset 那类模式切换）：本项目没有"模式"这个概念，输入框上不引入。
- **会话框左下角的 `+`**（附件/更多）：本次不引入。
- **"完全权限"这一栏**：以会话级「设置」代替，不做成权限档位选择器。
