# 参考实现的界面规格

> 来源：`deepseek-harness-master/apps/web` 与其 `packages/client/ui-*`（pnpm monorepo）。
> 本文只记录**在源码 / 样式 / locale 文件里实际读到**的内容，每条挂 `文件:行号`。
> 读不到的写「未找到」。凡是推断，集中在文末「推断（非源码事实）」一段。
> 行号为撰写时快照，供定位用。

---

## 0. 全局框架（先建立坐标系）

窗口 = 左栏（`ui-sidebar` 的 `SidebarRoot`）+ 右栏（`ui-conversation` 的 `ConversationRoot`）。
右栏结构：

```
ConversationRoot  (ConversationMainPanel)
├─ header        conversation.header            (ConversationHeader)
└─ content       conversation.content           (ConversationContent)
   ├─ scrollBody
   │  ├─ <Views/> (会话视图)
   │  └─ composerSeat (sticky)
   │     └─ composer.composer 链 → fallback = composerStack
   │        ├─ HeroShell                         (仅 hero 相位)
   │        ├─ heroWorkspaceRow                  (仅 hero 相位) ← 工作目录 + 模式那一行
   │        ├─ conversation.input.dock
   │        └─ conversation.composer.bar → InputBar ← 输入卡片
   └─ WidthControls
```

- `packages/client/ui-conversation/src/client/skeleton/ConversationMainPanel.tsx:45-56`
- `packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx:163-203`
- 相位：`hero`（空会话/未选会话，居中）/ `active`（贴底）——`ConversationMainPanel.tsx:41-43`

---

## 1. 左栏（`ui-sidebar` 的 `SidebarRoot`）

容器：flex 纵向，`padding: 6px 12px`，背景 `--dsw-specific-sidebar-fill`，正文字号 `14px`，文字色 `--dsw-alias-label-primary`。
`SidebarRoot.module.css:9-23`；结构 `SidebarRoot.tsx:199-315`。

**从上到下的块（DOM 顺序，即源码渲染顺序）：**

| # | 块 | 代码位置 | 说明 |
|---|---|---|---|
| 0 | （macOS 专用）`.topStrip` | `SidebarRoot.tsx:215` | 仅 darwin 桌面，装交通灯，含折叠按钮 |
| 1 | `.logoRow` = 品牌 + 折叠按钮 | `SidebarRoot.tsx:216-256` | |
| 2 | `.newSession` 新会话按钮 | `SidebarRoot.tsx:259-277` | |
| 3 | `.panelList` 全局面板（**插件**） | `SidebarRoot.tsx:279-293` | 见 §8 |
| 4 | `.regionArea` 工作区/会话浏览区 | `SidebarRoot.tsx:297-302` | 内容来自 `ui-workspace` 的 `WorkspaceBrowser` |
| 5 | `.footArea` = `.footerActions` + `.settingsArea`（底部账户/设置） | `SidebarRoot.tsx:305-312` | |

### 1.1 品牌行

- 结构：左 = 鱼形 logo（`FishLogo`，24px）+ 品牌名；右 = 折叠按钮 `toggle`（28×28，图标 `IconPanelLeftOutlineRegular` 16px）。
  `SidebarRoot.tsx:178-197, 216-256`
- `.logoRow`：高 `60px`，`padding: 8px 0 8px 4px`，`margin-bottom: 4px`，`gap: 8px`，`justify-content: flex-end`。`SidebarRoot.module.css:220-231`
- 品牌名 `.brandName`：`font-size: 18px; font-weight: 600; line-height: 24px; letter-spacing: 0.04em`。`SidebarRoot.module.css:283-293`
- 展开态：品牌整体是一个「新会话」按钮（点击 = `startSession`，非 macOS）。`SidebarRoot.tsx:243-253`
- 折叠态：`.collapsed .logoRow { height: 36px }`，logo 换为 24px 的鱼形 mark。`SidebarRoot.module.css:233-241`；`SidebarRoot.tsx:187-191`

### 1.2 「新会话」按钮

- `.newSession`：高 `38px`，`padding: 8px 12px`，`margin: 0 2px 12px`，`border: 0.5px solid var(--dsw-alias-border-l3)`，
  `border-radius: var(--dsw-radius-md)`（=12px），背景 `--dsw-alias-button-elevated-fill`，字号 `14px/22px`，字重 `500`。
  内容：图标 `IconNewChatOutlineMedium`(14) + 文案 `t('session.new')` = 「新会话」。
  `SidebarRoot.module.css:395-418`；`SidebarRoot.tsx:259-277`；`ui-sidebar/src/client/locales.ts:5`

### 1.3 工作区/会话区标题栏（`.sectionHeader`）

由 `ui-workspace` 的 `WorkspaceBrowser` 渲染（不是 sidebar 自己）。
`ui-workspace/src/client/rows/WorkspaceBrowser.tsx:1209-1322`；`WorkspaceBrowser.module.css:53-66`。

- 标题：`t('section.workspaces')` = 「工作区」；分组方式为 `flat` 时改用 `t('section.sessions')` = 「会话」。
  `WorkspaceBrowser.tsx:1211-1213`；`ui-workspace/src/client/locales.ts:18-19`
- `.sectionHeader`：高 `36px`，`gap: 4px`，`padding-left: 4px`，`margin-bottom: 4px`，文字色 `--dsw-alias-label-tertiary`，右对齐。

**标题右侧的图标 —— 这里与 ticket 的描述有出入：实际有 3 个控件，不是一个「两个图标的簇」：**

1. **搜索**（放大镜 `IconSearchOutlineRegular`，14px）：`.searchSlot` 里的 `.searchButton`，点开才展开成输入框。`WorkspaceBrowser.tsx:1216-1271`
2. **视图选项**（滑块 `IconSlidersTwoOutlineRegular`）：`ViewOptionsMenu` 的触发按钮，点开一个 `Menu` 下拉，含「分组方式 / 排序方式 / 筛选会话」三段（`groupBy` / `orderBy` / `archivedFilter`）。`WorkspaceBrowser.tsx:106-168, 1274-1282`；文案 `ui-workspace/src/client/locales.ts:20-31`
3. **添加工作区**（文件夹加号 `IconProjectAddRegular`，16px）：点开目录选择流程（同 §3 的目录选择器）。`WorkspaceBrowser.tsx:1287-1302`

> 若读图时把 2、3 认成「两个图标」，那么第 1 个（搜索）是独立的第三个控件。三者都在同一行，展开搜索时 2、3 会折叠隐藏（`.headerActionsHidden`）。`WorkspaceBrowser.module.css:134-141`

### 1.4 底部账户/设置块

- 槽位：`sidebar.footer.action`（list）+ `sidebar.settings`（single），`SidebarRoot.tsx:305-312`。
- `sidebar.settings` 由 `ui-settings-general` 的 `SettingsRoot` 占据；其 `.triggerRow` 内是 `settings.launcher`（账户入口）+ 连接状态指示 + 桌面更新指示。
  `ui-settings-general/src/client/index.ts:198-212`；`ui-settings-general/src/client/SettingsRoot.tsx:216-245`
- `settings.launcher` 由 `ui-settings-account` 的 `AccountMenu` 占据：左 = 头像 / user 图标，右 = 账户名或联系方式（读图里的邮箱即这里的 `label`），点击弹 `Menu`（设置 / 联系我们 / 退出登录）。
  `ui-settings-account/src/client/index.ts:286-287`；`ui-settings-account/src/client/AccountMenu.tsx:57-84`

---

## 2. 会话行（`ui-workspace/.../rows/Rows.tsx`）

会话树 = 工作区分组节（`.groupSection`）> 工作区头行（`.projectRow`）> 会话行（`.sessionRow`）。

### 2.1 行高与排版

- `.sessionRow`：**高 `32px`**，`gap: 0`，`padding: 0 8px`，`border-radius: var(--dsw-radius-md)`（12px），
  `align-items: center`。`Rows.module.css:1-12, 110-113`
- 行内从左到右：`16px` 状态槽（`.slot`，含状态点或前导槽）→ 标题（`.title`）→ 时间（`.time`）→（可选）置顶标 → 动作条（`.rowActions`）。
  `Rows.tsx:586-690`
- 标题 `.sessionRow .title`：`margin: 0 6px 0 4px`，`font-size: 14px / line-height: 20px`，`flex: 1`，超出省略号（hover 时跑马灯）。
  `Rows.module.css:115-117, 165-172, 191-211`
- 时间 `.time`：**`font-size: 10px / line-height: 16px`**，色 `--dsw-alias-label-tertiary`，相对时间文案（「6小时」「2天」…）。
  `Rows.module.css:222-227`；`Rows.tsx:136-140`；文案模板 `ui-workspace/src/client/locales.ts:111-120`
- hover 时时间被动作按钮换掉（`.sessionRow:hover .time { display: none }`）。`Rows.module.css:279-282`
- 工作区头行 `.projectRow`：**高 `34px`**，含文件夹图标（默认）/ 展开三角（hover 换），标题 14/20。
  `Rows.module.css:98-107, 143-155`；`Rows.tsx:242-310`
- 行距：同组内相邻行 `margin-top: 2px`（`.groupSection > * + *`）。`WorkspaceBrowser.module.css:376-380`

### 2.2 「展开其余 N 个会话」

- 位置：**在每个工作区分组内、该组会话列表的末尾**，是一个整行按钮（`.sessionOverflowButton`），不属于某一会话行。
  `WorkspaceBrowser.tsx:581-602`
- 触发条件：一组内**空闲会话默认只显示 5 条**（`COLLAPSED_SESSION_LIMIT = 5`）；运行中/待处理/含运行中子会话的行不计入限额。`WorkspaceBrowser.tsx:55, 57-70`
- 样式：高 `28px`，`font-size: 12px`，文字色 `--dsw-alias-label-tertiary`，左内边距对齐到标题列 `calc(28px + 缩进)`。`WorkspaceBrowser.module.css:499-519`
- 文案：`t('sessions.expand', { n })` = 「展开其余 {n} 个会话」；展开后变 `t('sessions.collapse')` = 「收起」。`WorkspaceBrowser.tsx:598-600`；`ui-workspace/src/client/locales.ts:32-33`

---

## 3. 输入框（`ui-conversation` 的 `InputBar`）——**直接决定 10 号**

### 3.1 它是「两行」吗？——准确说法是「卡片上方一行 + 卡片内底部一行」

**卡片外的上排**（`.heroWorkspaceRow`，仅 hero 相位渲染）：

- 左：工作目录芯片 `WorkspaceChip`（文件夹图标 + 目录名 + 下拉箭头）——组件即 `WorkspaceChip`。
  `ConversationContent.tsx:110-134`；`ui-conversation/.../EmptyHero.tsx:38-62`
- 右：**agent preset 模式芯片**（读图里的「标准模式」），来自槽位 `conversation.hero.agentPreset`。
  `ConversationContent.tsx:132`
- 整行：`display:flex; gap:2px; padding: 0 16px 0 20px; margin-top: 4px`。
  `ConversationRoot.module.css:520-530`

**卡片内的下排**（`.row`，`InputBar` 里）：

```
.tools(左)                                .trailing(右)
 ├─ 附件/命令按钮 +                        ├─ conversation.input.right（槽）
 ├─ 权限槽 conversation.input.permission    ├─ 模型槽 conversation.input.model
 └─ 计划槽 conversation.input.plan          ├─ activity 槽
                                            └─ 发送按钮 .primary
```

`InputBar.tsx:418-497`；`.row` 样式 `InputBar.module.css:251-267`

所以 ticket 里「上排左（工作目录）、上排右（模式）、下排左（`+` 与权限）、下排右（模型 + 发送）」的**分格基本正确**，但要点明：
**工作目录与模式在卡片的上一行（hero 相位专有），不在卡片内部的上排。** 卡片内部的结构是「文本区 + 一条控制行」。

### 3.2 每一格实际是什么控件

| 格 | 控件 | 证据 |
|---|---|---|
| 上排左 工作目录 | `<button>` 自绘芯片（folder 图标 + 省略号文本 + chevron），`aria-haspopup="menu"` | `EmptyHero.tsx:45-61` |
| 上排右 模式 | `<button>` + `Menu`（agent preset，`aria-haspopup="menu"`） | `AgentPresetSeat.tsx:158-209` |
| 下排左 `+` | `<button class="add">`，28×28 圆形，背景 `--dsw-specific-selector`，图标 `IconPlusOutlineMedium`(14)，点击开命令菜单 | `InputBar.tsx:420-433`；`InputBar.module.css:313-335` |
| 下排左 权限 | `<button class="trigger">` + `Menu`（自绘胶囊芯片，非原生 select） | `PermissionSelect.tsx:165-196` |
| 下排右 模型 | `<button class="trigger">` + portal `MenuSurface`（两级：模型 / 强度） | `ModelSelect.tsx:446-473, 478-644` |
| 下排右 发送 | `<button class="primary">`，**34×34 圆形**，背景 `--dsw-alias-button-info-fill`，白箭头（内联 SVG） | `InputBar.tsx:476-495`；`InputBar.module.css:369-391` |

补充：文本区是 contenteditable（Lexical），不是 `<textarea>`；`.input` 最小高 36px（hero 态 52px），卡片 `gap:12px`、`padding-top:8px`、`border-radius: var(--dsw-radius-panel)`(28px)。
`InputBar.tsx:403-417`；`InputBar.module.css:45-77, 169-185, 233-237`

### 3.3 点「工作目录」时弹出的东西是什么形态 —— **关键**

**不是原生 `select`，也不是带搜索框的弹层。** 是**自绘的 `Menu` 下拉**，逻辑在 `WorkspacePicker` / `WorkspacePickFlow`：

- 芯片点击 → 打开 `Menu`（`WorkspacePickFlow` 里的 `<Menu side="bottom" portal>`），列出已有工作区（每项 = 文件夹图标 + 显示名），底部固定一条「添加工作区…」。
  `ui-workspace/src/client/WorkspacePicker.tsx:188-201, 112-119`
- 工作区列表为空、或列表还在加载之外的「只剩添加项」时，芯片点击**直接进入目录选择流程**，不弹一行菜单。
  `WorkspacePicker.tsx:156-162`
- 「添加工作区」进入的**目录选择流程有两种实现，取决于组装**（通过 `conversation.hero.workspace.directoryFlow` 槽位注入）：
  1. **自绘浏览对话框**（`ui-directory-picker-browse` 的 `DirectoryBrowser`）：680×500 的 Miller 列视图，有面包屑 + 可点击进入的**路径编辑框**（`<input>`，点铅笔进入）、“新建文件夹 / 显示隐藏文件 / 取消 / 打开”页脚。**没有独立搜索框**，路径框兼作输入。`ui-directory-picker-browse/src/client/DirectoryBrowser.tsx:273-1051`（头部/交互见 818-925）
  2. **系统原生选目录对话框**（`ui-directory-picker-native` 的 `NativeDirectoryFlow`）：renderless 占位，调起宿主/桌面的原生 chooser。`ui-directory-picker-native/src/client/flow.ts:17-65`
- 结论给 10 号：参考实现里「点工作目录」= **自绘 Menu 弹层**（列表 + “添加工作区…”），**不是原生 select、不是搜索弹层**；“添加”再走目录浏览器或系统对话框。

---

## 4. 空状态（Hero）（`ui-conversation/.../skeleton/`）

组件 `HeroShell`，渲染在 `composerStack` 顶部（hero 相位）。`EmptyHero.tsx:127-165`；`ConversationContent.tsx:163-169`

结构（`.stack`，纵向 gap `12px`，`max-width: var(--dsh-composer-card-max-width)`）：

1. `.headline`：横排 = 鱼形 logo（**34px 宽**，`HeroFish`）+ 标题组。
   - 标题 `t('hero.headline')` = 「探索未至之境」
   - 右上角附一个**上标胶囊徽章** `t('hero.preview')` = 「预览版」
   全部 `.headline`：`font-size: 26px / line-height: 32px / font-weight: 500`，居中；鱼与标题 `column-gap: 10px`。
   `EmptyHero.tsx:137-157`；`HeroShell.module.css:26-76`；文案 `ui-conversation/src/client/locales.ts:77-78`
2. `.body`：**空容器**（composer 在组件外挂载，见注释 `EmptyHero.tsx:158-160`）。

**关于「副标题」：未找到独立的副标题元素。** 读图里的「预览版」是标题的**上标徽章**（`.previewBadge`，`font-size:12px`，胶囊边框，等宽字体），不是另起一行的副标题。
`HeroShell.module.css:62-76`

外边距：hero 整体在列内居中（`justify-content: center`），`.composerHero` 有 `padding-bottom: 32px` 让堆栈略高于正中。
`ConversationRoot.module.css:507-518, 532-538`

---

## 5. 权限审批（`ui-approval` 的 `ApprovalPanel`）

**形态：不是输入框上的一个模式，而是一张「接管」输入卡片的卡片**（composer takeover，占据 composer 座位）。

- 它是 composer 链的一个改写：`ApprovalPanel` 通过 `conversation.approval` 一类接管槽渲染，替换掉 `InputBar`。
  `ui-approval/src/client/ApprovalPanel.tsx:12-18`（`props.matched` 即待处理审批）
- 卡片结构（`.card`）：
  1. `.strip` 顶部状态条：`StateDot` + 「等待审批」(`t('waiting')`)，背景 `--dsw-alias-state-warn-tertiary`，文字 `--dsw-alias-state-warn-primary`。`ApprovalPanel.tsx:66`
  2. `.body`（可滚动，`max-height: var(--dsh-composer-text-max-height)`）：标题 `.headline`（原因，或 `t('escalation',{toolName})` = 「工具 {toolName} 请求越权执行」）+ 命令详情 `.command`（等宽）。`ApprovalPanel.tsx:67-76`
  3. `.actionRow`（右对齐）：`拒绝`(`t('reject')`，outline) + `允许一次`(`t('allowOnce')`，primary)。`ApprovalPanel.tsx:77-84`
- 卡片外观：`border: 1px solid var(--dsw-alias-state-warn-secondary)`，`border-radius: var(--dsw-radius-xl)`(20px)，背景 `--dsw-specific-input-major`，阴影 `--dsw-shadow-lv2`，`max-width: var(--dsh-chat-content-width)`。
  `ApprovalPanel.module.css:8-18`
- 键盘：Enter = 允许一次，Escape = 拒绝（焦点不在输入控件里时）。`ApprovalPanel.tsx:46-58`
- 文案：`ui-approval/src/client/locales.ts:4-10`

**遮挡关系**：它坐在 composer 座位（`.composerSeat`，sticky 贴底），所以**盖住/替换的是输入框本身**，而不遮住整段对话。

---

## 6. 思考块（reasoning）（`ui-chat/.../chat/ReasoningRow.tsx`）

- 组件：`ReasoningRow`，用 `DisclosureRow` 实现「一行可折叠」。**可折叠**，默认收起。
  `ui-chat/src/client/chat/ReasoningRow.tsx:47-102`
- 折叠状态那一行：
  - 左侧图标 `IconThinkOutlineRegular`(14)。`ReasoningRow.tsx:9, 89`
  - **标题文字 = `t('message.think')` = 「思考」**。`ReasoningRow.tsx:90`；`ui-chat/src/client/locale.ts:142`
  - 标题后接一个 `2px` 小圆点分隔符 + 摘要行（`.summary`）：正文的**首行**（流式中取最近完成段落的首行），字号 = 次级正文（默认 `13px / 20px`），单行省略号；流式时有右侧渐隐遮罩。
    `ReasoningRow.tsx:11-32, 60-69`；`ReasoningRow.module.css:32-71`
  - 收起态整行高度固定 `calc(24px + 字体增量)`。`ReasoningRow.module.css:6-9`
- 展开态：渲染完整 Markdown（`variant="compact"`），缩进 `calc(22px + 字体增量)`，标题行 sticky。`ReasoningRow.tsx:70-74`；`ReasoningRow.module.css:15-22, 73-77`
- 运行中：`running` 为真时摘要用 `TextShimmer`，并给出 `t('row.running')` = 「运行中」的无障碍文本。`ReasoningRow.tsx:62-84`；`ui-conversation/src/client/locales.ts:307`

---

## 7. 配色与排版 token（`ui-theme/src/styles/`）

定义文件：`design-platform.css`（语义/静态色，含明暗两套 `body` / `body[data-ds-dark-theme]`）与 `base.css`（圆角、字体、缓动）。
`ui-theme/src/styles/design-platform.css`；`ui-theme/src/styles/base.css`

### 7.1 具体值（明 → 暗）

| 语义 token | 明色 | 暗色 | 两行位置 |
|---|---|---|---|
| `--dsw-alias-bg-base`（主背景/右栏） | `#FFFFFF`（bluish-00） | `#151517`（bluish-950） | 167 / 285 |
| `--dsw-specific-sidebar-fill`（左栏面板） | `#F9FAFB`（bluish-50） | `#1B1B1C`（bluish-900） | 275 / 393 |
| `--dsw-specific-input-major`（输入卡/审批卡面） | `#FFFFFF` | `#2C2C2E`（bluish-850） | 269 / 387 |
| `--dsw-alias-border-l1` | `rgba(0,0,0,.04)` | `rgba(255,255,255,.06)` | 185 / 303 |
| `--dsw-alias-border-l2` | `rgba(0,0,0,.10)` | `rgba(255,255,255,.12)` | 187 / 305 |
| `--dsw-alias-border-l3` | `rgba(0,0,0,.12)` | `rgba(255,255,255,.16)` | 188 / 306 |
| `--dsw-alias-border-l4` | `rgba(0,0,0,.16)` | `rgba(255,255,255,.20)` | 189 / 307 |
| `--dsw-alias-label-primary`（主文本） | `#0F1115`（bluish-1000） | `#F9FAFB`（bluish-50） | 222 / 340 |
| `--dsw-alias-label-secondary`（次文本） | `#61666B`（bluish-700） | `#CFD3D6`（bluish-300） | 223 / 341 |
| `--dsw-alias-label-tertiary` | `#81858C`（bluish-600） | `#ADB2B8`（bluish-400） | 225 / 343 |
| `--dsw-alias-label-caption` | `#ADB2B8`（bluish-400） | `#81858C`（bluish-600） | 214 / 332 |
| `--dsw-alias-state-business-primary`（强调/蓝） | `#4176E6`（deepseek-500） | `#7AAAFF`（deepseek-400） | 240 / 358 |
| `--dsw-alias-button-elevated-fill`（新会话底） | `#FFFFFF` | `#43454A`（bluish-750） | 195 / 313 |
| `--dsw-alias-button-info-fill`（发送圆底） | `#4176E6` | `#7AAAFF` | 201 / 319 |
| `--dsw-alias-interactive-bg-hover`（行 hover） | `rgba(38,49,72,.06)` | `rgba(255,255,255,.08)` | 213 / 331 |

### 7.2 排版 / 圆角 / 间距刻度

- 字体栈：`--dsw-font-family`（系统 + PingFang SC / Microsoft YaHei）；代码字体 `--ds-font-family-code`（SF Mono / JetBrains Mono / Consolas…）。`base.css:7-11`
- 圆角：`xs 4 / sm 8 / md 12 / lg 16 / xl 20 / panel 28`（px）。`base.css:16-21`
- 缓动：`--ds-ease-in-out: cubic-bezier(0.4,0,0.2,1)`；时长 `--ds-transition-duration: .2s / fast .1s / slow .3s`。`base.css:12-15`
- 正文字号（从各处读到）：左栏与会话行正文 `14px/20`；会话时间 `10px/16`；次级（思考摘要/说明）`13px/20`；小注 `12px/18`；hero 标题 `26px/32`。见 §1–§6 各自引用。
- 间距刻度（实测常见值）：`2 / 4 / 6 / 8 / 12 / 16 / 20 / 24 / 32`（px），集中在 `4·8·12·16`。

> 落 `packages/web/src/tokens.css` 时，上表一列明色即可作为对应物；暗色可选。

---

## 8. 明确「有而不该抄」的清单

| 元素 | 读图位置 | 代码位置 | 说明 |
|---|---|---|---|
| **插件栏** | 左栏「插件」行 | `ui-plugin-manager` 注册进 `sidebar.panellist`，标签 `panel:'插件'` | `ui-plugin-manager/src/client/index.ts:139-140`；`ui-plugin-manager/src/client/locales.ts:10`；外壳 `SidebarRoot.tsx:279-293` |
| **标准模式（agent preset 模式切换）** | 上排右 | 槽位 `conversation.hero.agentPreset` → `ui-agent-preset` 的 `AgentPresetSeat`（一个 `Menu` 芯片） | `ConversationContent.tsx:132`；`AgentPresetSeat.tsx:158-209` |
| **输入框左下角 `+`（附件/更多）** | 下排左 | `InputBar` 的 `.add` 按钮，`t('input.commands')`=「添加文件或调用指令」 | `InputBar.tsx:420-433`；`ui-conversation/src/client/locales.ts:26` |
| **「完全权限」这一栏** | 下排左（`+` 右侧） | 槽位 `conversation.input.permission` → `ui-permission-presets` 的 `PermissionSelect`；「完全权限」= `preset.fullAccess` | `PermissionSelect.tsx:76-215`；`ui-permission-presets/src/client/locales.ts:14` |

> 这四项正是 map.md「Out of scope」列的四项，与源码一致。

---

## 9. 推断（非源码事实，供 10 号取舍时注意）

- 「工作区标题右侧那两个图标」：源码里同处是 **3 个**控件（搜索 / 视图选项 / 添加工作区）。ticket 说「两个」可能把搜索排除了，或把视图选项+添加当成一对。**这是读图歧义，不是源码差异。** 依据：`WorkspaceBrowser.tsx:1216-1302`
- 把上排（工作目录+模式）称作「输入框的上排」：源码里这一行是 `heroWorkspaceRow`，在卡片之外；只有 hero（空会话）相位才渲染，`active` 相位不渲染。若本项目要在有会话时也显示工作目录，需自行决定是否照搬这个「仅空态」的限制。依据：`ConversationContent.tsx:163-169`
- 「副标题」：源码未找到独立副标题；读图里的「预览版」是上标徽章。若 10 号想要真正的副标题行，参考实现里没有对应物，属于新增。

---

## 10. 未找到 / 未覆盖

- 未找到 hero 空状态的「副标题」元素（见 §9）。
- 侧栏折叠动画的完整时序、拖拽排序插入线、搜索骨架屏等细节未展开（与改造目标关系不大）。
- 未读 `ui-layout`（`AppFrame` 网格轨道）内部：左栏宽度、列宽变量 `--dsh-*` 的具体定义在本规格外。
