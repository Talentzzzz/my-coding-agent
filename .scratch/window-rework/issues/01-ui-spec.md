# 01 参考实现的界面规格

Type: research
Status: resolved
Blocked by: （无）

## Question

参考图（`../reference/harness-window.png`）来自工作区里的 `deepseek-harness-master/apps/web`。要抄它的
**结构**，先得知道它的结构到底是什么。请把下面这些逐条读出来，产出 `../research/ui-spec.md`——它是一份
**可抄的说明**，不是代码，也不是对截图的描述。

1. **左栏**：从上到下有哪些块（品牌 / 新会话 / 插件 / 工作区标题 / 会话行 / 底部账户）？每块的层级、
   间距、字号、图标。工作区标题右侧那两个图标是什么、点了做什么。
2. **会话行**：行高、标题与时间的排布、"展开其余 N 个会话"处在什么位置。
3. **输入框**：它是两行结构吗——上排左（工作目录）、上排右（模式）、下排左（`+` 与权限）、下排右（模型 +
   发送）？每一格实际的控件类型是什么？点"工作目录"时弹出的东西是什么形态（原生 select？自绘弹层？
   搜索框？）——**这一条直接决定我们 10 号怎么实现**。
4. **空状态**：居中图形 + 文案 + 副标题，各自的层级与留白。
5. **权限审批**：它长什么样——是输入框上那一栏的一个模式？还是一张卡片？出现时挡住了什么？
6. **思考块（reasoning）**：怎么显示的、能不能折叠、折叠状态下那一行的标题写什么。
   注意：这一票**只要"它长什么样"**；"思考内容从哪来、在哪一步丢的"是 02 的事。
7. **配色与排版 token**：主背景 / 面板 / 边框 / 主文本 / 次文本 / 强调色的**具体值**；正文字号、行高、
   圆角、间距刻度。给到能让我们在 `packages/web/src/tokens.css` 里落一套对应物。
8. **明说哪些是它"有而我们不该抄"的**（插件栏、模式切换、`+`、权限档位），避免后面误抄。

产出 `.scratch/window-rework/research/ui-spec.md`。

**只写你实际读到的。** 从 `apps/web` 的源码 / 样式 / locale 文件里读到什么就写什么；读不到的写"未找到"，
**不要根据截图猜**。截图只用来定位"这块在代码里叫什么"。凡是推断，单独一段标出来。

## Answer

产出：`.scratch/window-rework/research/ui-spec.md`（每条结论挂 `文件:行号`，推断单列 §9）。

逐条（详见产出文件）：

1. **左栏**：`SidebarRoot` 纵向五块——品牌行(`.logoRow`, 60px，brandName 18/600) → 新会话(`.newSession`, 38px, radius 12) → 插件面板行(`.panelList`/`.panelRow`, min-h 36) → 工作区浏览区(`.regionArea`) → 底部(`.footArea`=账户+设置)。**工作区标题右侧实际有 3 个控件**：搜索、视图选项(滑块 Menu: 分组/排序/筛选)、添加工作区。
2. **会话行**：`.sessionRow` 高 **32px**，标题 14/20 左、时间 10/16 右；「展开其余 N 个会话」是**组内列表末尾**的整行按钮，空闲会话每组默认只显示 **5** 条。
3. **输入框**：卡片**上方一行**放工作目录芯片 + 模式芯片(hero 相位专有)；卡片内部是「文本区 + 底部控制行」(`+`/权限/计划 在左，模型/发送 在右)。点工作目录弹出的是**自绘 `Menu`**（工作区列表 + “添加工作区…”），**不是原生 select、也不是搜索弹层**；“添加”再走目录浏览器(680×500 Miller，含路径编辑框)或系统原生对话框。→ 直接给 10 号用。
4. **空状态**：`.headline`= 34px 鱼形 logo + 「探索未至之境」(26/32, wt500) + 上标徽章「预览版」。**未找到独立副标题**（读图的“预览版”是上标徽章）。
5. **权限审批**：是**替换输入框的接管卡片**（`.card`，警示色边框，顶部状态条 + 正文 + 拒绝/允许一次），坐在 composer 座位，遮住输入框而非整段对话。
6. **思考块**：`ReasoningRow` 用 DisclosureRow，**可折叠**，默认收起；收起态标题 = 「思考」+ 2px 圆点 + 首行摘要(13/20)。
7. **token**：主背景 `--dsw-alias-bg-base` #FFFFFF/#151517；左栏 `--dsw-specific-sidebar-fill` #F9FAFB/#1B1B1C；边框 l1–l4；文本 primary/secondary/tertiary/caption；强调 `--dsw-alias-state-business-primary` #4176E6/#7AAAFF；圆角 xs4/sm8/md12/lg16/xl20/panel28。出处 `design-platform.css` / `base.css`。
8. **不抄**：插件栏(`sidebar.panellist` → ui-plugin-manager)、标准模式(`conversation.hero.agentPreset` → ui-agent-preset)、`+`(`InputBar .add`)、完全权限(`conversation.input.permission` → ui-permission-presets)。
