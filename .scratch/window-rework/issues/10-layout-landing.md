# 10 照参考图落地布局与观感

Type: task
Status: resolved
Blocked by: 01, 06, 07, 08, 09

## Question

最后一块拼图：把 01 读出来的规格、加上 06 / 07 / 08 定下来的决定，**落到窗口上**。

**要做的：**

1. **输入框顶行**：左侧「工作目录」选择器，只列已知工作区，选中即决定"新会话"落在哪个目录
   （接法看 07 的决定）。
2. **设置入口易位**：输入框上的「设置」= **会话级**（工具 / 审批 + "沿用全局"，接法看 06 的决定）；
   左下角「设置」= **应用级**。现在那个三标签弹窗按 06 拆开。
3. **权限审批变好看**（用户原话"权限审批做的丑"）：照 `../research/ui-spec.md` 第 5 条重做
   `packages/web/src/main.ts:406-428` 的 `approvalCard`。参考实现的做法是**用一张接管卡片替换整个输入
   框**（警示色边框 + 拒绝 / 允许一次），而不是我们现在这样在输入框上面挂一条 banner——这个差别大概
   就是"丑"的来源。
4. **空状态、左栏分组、那两个图标**：照 01 的规格 + 08 的决定做。
5. **不做**：插件栏、标准模式、会话框左下角的 `+`、权限档位（见 map.md 的 Out of scope）。
6. **UI 只读设计 token**：新的颜色 / 间距 / 圆角进 `packages/web/src/tokens.css`；`style.css` 里**不许**
   出现字面颜色——`npm run check` 的 token 审计会拒绝一个被引用却从未定义的 `--dsw-*` 名字。

**跑**：`npm run check` + `smoke-sidebar.ts` + `smoke-projection.ts`。

**出图**：用 `npm run desktop:screenshot` 出一张改后截图。三个坑别踩——要加 `--disable-gpu`（否则 GPU 进程
崩溃、出不了图）；它硬编码写 `packages/desktop/ui.png`，而那是**一个 tracked 文件**，传路径无效，所以先
想好怎么不覆盖它；`ELECTRON_RUN_AS_NODE=1` 在这个环境里是设了的，只能走 `launch.mjs`。

**答案里带**：改后截图路径 + 哪些"不做"被确认没有误做进来。

## Answer

六条全部落地；`npm run check` 全绿（tsc ×4 + `tokens ok: 106 defined, 86 referenced`），票面要求的
`smoke-sidebar.ts` / `smoke-projection.ts` 加上 `smoke-sessions.ts`（本轮扩了两个接缝的断言）、
`smoke-stream` / `smoke-tools` / `smoke-mux` / `smoke-mux-live` / `smoke-approval` / `smoke-models` 全部通过。
**截图在 `../research/`：`landing-after.png`（空态 + 芯片 + 三控件）、`workspace-menu.png`（自绘菜单）、
`session-settings.png`（会话级）、`app-settings.png`（应用级「默认」页）**。

### 1. 输入框顶行：工作目录芯片（07 的接法）

- 芯片在输入卡片上方一行（`.hero-row`），**只在 transcript 为空时渲染**（07 第 6 条：将来时）。菜单是
  自绘弹层（`render/menu.ts`，本窗口唯一的自绘菜单）：已知工作区列表（复用侧栏的 `rows.groups()`，
  当前选中项打勾）+ 分隔线 + 「添加工作区…」。
- **选中目录是客户端持有的一份状态**（`pickedWorkspace`），三处读同一份：芯片显示、`newSession()` 的
  `cwd`、侧栏「当前」标记。默认 = 活跃会话的工作区，无会话 = 启动目录；打开会话即清空显式选择，
  所以「当前」永远不会和正在看的对话矛盾。不落任何持久化（07 第 5 条）。
- 服务端：`hub.newSession(cwd?)` + `POST /api/sessions` 收可选 `cwd`（空体照旧），校验只做
  「存在且是目录」（400），响应的 `sessions` 列**该目录**的会话。新目录进列表走
  「选中 → 创建第一个会话 → `GET /api/workspaces` 自扩展」。
- 「添加工作区…」走 **OS 原生文件夹选择器**（08 改判）：`desktop.pickFolder()` 经 preload IPC 调
  `dialog.showOpenDialog({ properties: ["openDirectory"] })`，浏览器模式（无外壳）明确报错而不是装死。

### 2. 设置入口易位（06 的拆分）

- **输入框上的「设置」**（composer 控制行左端的齿轮）→ **会话级面板**（`render/session-settings.ts`，
  标题「会话设置」）：工具开关（`PUT /tools`）+ 审批开关（`PATCH`），每节一行「当前沿用全局设置 /
  当前已单独设置」，由快照的 `toolsFollowGlobal` / `approvalsFollowGlobal` 驱动；底部一个总复位
  「沿用全局」（两半都跟随全局时禁用）——发全局默认工具集 + 全局审批表，写成一条**等于全局值的**
  `tool_config` entry。
- **左下角「设置」**→ **应用级面板**，三标签：外观 / 模型 / **默认**。「默认」页装默认模型、bash 超时、
  **全局默认审批**（固定六键，UI 里第一次有了这个面）与**全局默认工具集**（新设置字段
  `Settings.tools`，缺省 = 全部启用，老文件零迁移；工具名列表来自当前会话的 `allTools`，没挂会话时
  如实说列不出）。
- core：`applyRecordedToolConfig` 增加全局默认参数——装配与分支重放（`applyBranchToolConfig`）在
  branch 无 entry 时落到全局默认（`architecture.md` 那句"设置文件什么都没说"已随实现改写）；
  `toolConfigFollowsGlobal` 做分半判据（工具按集合、审批按字段），live 快照与冷读共用同一实现。

### 3. 权限审批：接管卡片

`approvalCard` 重做成参考实现的形状：**替换整个输入框**而不是 banner——警示色边框 + 顶部状态条
（呼吸圆点 + 「等待审批」，`--dsw-warn-tint` 底）+ 标题「允许运行 {tool}？」+ 等宽命令体 + 右对齐
「拒绝 / 允许一次」。键盘照参考：Enter 允许、Escape 拒绝（焦点在控件上时不抢）。composer 在接管期间
**隐藏**而非禁用——一张可见但灰着的输入框会邀请往问题后面排队打字。

### 4. 空状态、左栏、图标（08 的三条决定）

- **空状态照旧不动**（sparkle + 「想做点什么？」），没抄参考的鱼形 logo。
- **搜索：真功能**——标题行的搜索按钮展开输入框，客户端过滤会话行（标题或工作区路径匹配；过滤时
  全量显示匹配行、无「展开其余」、无匹配分组整组隐藏而非删除，清空后原位恢复）。`smoke-sidebar.ts`
  新增第 7 节断言（shim 补了事件记录 / `contains` / `lastElementChild`）。
- **视图选项：只做观感**，tooltip 写明「暂未启用」，排序维持 `modified` 降序，`rows.ts` 未动。
- **添加工作区：真功能**，走 OS 对话框（见 1）。

### 5. 「不做」核对（确认无误做进来）

- **插件栏**：没有。左栏从上到下 = 品牌 / 新会话 / 工作区列表 / 设置，无面板行。
- **标准模式（agent preset）**：没有。hero 行只有工作目录一枚芯片，右侧没有模式位。
- **会话框左下角的 `+`**：没有。composer 控制行左端是齿轮 + 模型 + 思考档位。
- **权限档位（完全权限）**：没有做成选择器；该位置由会话级「设置」顶替（06）。

### 6. token

新增 `--dsw-radius-xl: 20px`（审批卡圆角，照 01 §5 的 xl）与 `--dsw-warn-tint`（状态条底色，明
amber-100 / 暗 amber-900）。`style.css` 无字面颜色，token 审计通过。菜单、芯片、接管卡全部只读既有
alias。

### 出图的诚实说明

`npm run desktop:screenshot` 在这台机器上**连 `--disable-gpu` 也救不回来**：GPU 进程
`exit_code=-1073741819`（0xC0000005）三次后 `GPU process isn't usable. Goodbye.`——map.md「Not yet
specified」里那笔"desktop:screenshot 的坏形状要不要顺手修"就此有了实测答案。改走 09 号验证过的同一条
路：`bootServer`（生产 bundle）+ 本机 Chromium（`research/shots.ts`），真服务器、真 DOM、四张截图。
Electron 外壳本身没有动到渲染路径（只加了 pickFolder 的 IPC），窗口里的页面与截图所见是同一份 bundle。

### 验证

- `npm run check`：绿（tsc ×4 + token 106/86）。
- `smoke-sessions.ts` 扩了两节：**装配接缝**（无 entry 开在 `settings.tools` 上、followGlobal 分半判定、
  复位写等值 entry 后读回"沿用全局"、分支移到未记录链恢复全局默认、冷读与活快照一致）与 **HTTP 面**
  （`POST /api/sessions` 带 cwd 201 / 不存在 400 / 非目录 400 / 非字符串 400 / 空体照旧；
  `PATCH /api/settings` 的 `tools` 类型校验 400——接受路径不在此写真实 settings 文件）。
- `smoke-sidebar.ts` 扩了搜索过滤一节；`smoke-mux-client.ts` 的快照 fixture 补了两个新字段。
- 其余 smoke 全绿（清单见开头）。

### 代码复核结论（两轴）

- **规范轴**：无硬违反。采纳的：`optionalObjectBody` 与 `readObjectBody` 收成共享的 `readBodyText` +
  `parseObject`；全局默认工具集的三处重复收成 `defaultToolNames()`；菜单项补上参考实现的文件夹图标
  （`MenuItem.icon` 从预留变成在用）。未采纳：`withFollowed` 守卫收拢（两处、语义各异）；审批卡
  `max-height` 对齐参考的 composer 变量（8rem 是同一意图的本地面额）。
- **规格轴**：采纳的：芯片在**无已知工作区**时直接进选择流程（ui-spec §3.3，不再弹只剩"添加"的菜单）；
  followGlobal 判据改用**过滤后**的全局默认（否则手改 settings 带未知名字时，复位会被判成"已单独
  设置"）；`applyRecordedToolConfig` 的 `globalTools` 改为必填（默认 `[]` 是给未来调用方的陷阱）；
  `tools: []` 拍成**显式全关**（缺省字段 = 全量），UI 往返不再自相矛盾。**复查还抓到一个回归**：
  装配把"无 entry 落全局默认"无差别应用后，子代理自备的只读注册表被冲成全量（`smoke-session.ts` 红），
  修法是调用方自备注册表时回退到其**当前集合**（那是刻意装配的 loadout，不是没选过）。
  未采纳：键盘应答 `approvals[0]`（它就是第一张卡，多卡时按列表序作答有注释可循）。
