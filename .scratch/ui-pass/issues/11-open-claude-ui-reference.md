# 11 open-claude-ui 参考

Type: research
Status: resolved
Label: feature

## Question

通读 `open-claude-ui-main/`（用户找来的 Claude UI 参考项目），对照本仓库 `packages/web`，提炼一份**可借鉴的 UI/交互改进清单**：它做得好而我们还差的（布局、交互、细节均可），逐条注明参考文件位置与本仓库落点。清单交用户挑选，挑中的从 map 的 Not yet specified 毕业成新 ticket；不做的留在清单里存档。

注意：只提炼、不照搬——本仓库有自己的 token 体系与「无新运行时依赖」规则，React 实现不直接可用，看的是交互与版式。

## Answer

通读了参考项目的 35 个 code-examples 与本仓库 `packages/web/src` 的现状，去掉已有 ticket 覆盖的部分（分支图、右键菜单、标题栏、输入框布局、收起按钮、context 进度条）后，剩 7 条值得做的，按值得做的程度排序。全部只借交互与版式，不引依赖；涉及颜色的条目已注明走 token。

1. **删除会话前加危险确认对话框**（最高优先，属正确性缺口）
   - 参考：`code-examples/ConfirmationDialog.tsx` — danger 变体模态确认，Escape 与点击遮罩均可退出，确认键与普通键视觉分离。
   - 落点：`packages/web/src/main.ts` 的 `deleteSession`，入口在 `render/sidebar.ts` 的行菜单「删除」项。
   - 为什么：现在右键菜单一次误点就永久删除整份记录（transcript and all），无任何回旋；这是清单里唯一一条数据丢失风险的交互。

2. **「回到底部」悬浮按钮 + 滚动钉住守卫**
   - 参考：`code-examples/useClaudeScrollPinning.ts` — 离开底部超过 120px 时浮现「跳至最新」按钮；用户滚动后 150ms 内不夺回视口。
   - 落点：`render/transcript.ts` 已有 `trackScroll` 的 80px sticky 判定与 `scrollToBottom` 公开方法，只差按钮本体（挂在 transcript 容器上）与冷却窗口；样式落 `style.css`。
   - 为什么：读历史时新 token 到来只能手动滚回去，一个明确的归位控件比「自己滚到底」符合直觉；150ms 冷却还能顺带解决贴底临界处 sticky 抖动。

3. **菜单键盘漫游导航（roving focus）**
   - 参考：`code-examples/useClaudeRovingFocus.ts` — ArrowUp/Down 循环、Home/End 首尾、Tab 立即跳出、动态 tabindex 只留当前项可聚焦。
   - 落点：`render/menu.ts` — 现在只有 Escape 关闭，菜单项完全不可用键盘到达。
   - 为什么：菜单已是全平台统一弹层（fork/重命名/删除都走它），键盘不可达是 a11y 与手感双缺口；纯事件逻辑，与现有实现贴合。

4. **滚动容器边缘渐隐遮罩**
   - 参考：`code-examples/ScrollFadeContainer.tsx` — 7 档非线性 alpha 渐变 `mask-image`，触顶/触底时该边归零，28px 羽化。
   - 落点：`style.css` 给 `.transcript` 与 `.session-list` 加 mask；触顶/触底信号复用 transcript 已有的 scroll 监听，sidebar 自己加一个。注意：alpha 蒙版梯度本身不承载色相，但若规则要求严格，可用 `--dsw-surface` 透明化或为 mask 单列一个 token。
   - 为什么：内容从滚动容器边缘硬切出去是「截图感」的主要来源，mask 是纯 CSS、零 JS 成本，观感提升明显。

5. **分割条双击归位 + Escape 撤销拖拽**
   - 参考：`code-examples/ArtifactsSplitPaneResizer.tsx` — 双击手柄弹簧归位 50/50（此处可归位到 token 默认宽），拖拽中按 Escape 回滚到起始值。
   - 落点：`main.ts` 的 `sidebarResizer` / `contentResizer` 两个 pointer 处理器（`sidebarDrag` / `contentDrag` 里已存起始值，回滚是现成的）。
   - 为什么：现在拖坏宽度只能用手柄逐级按键微调回去；「双击回默认、Escape 反悔」是低成本高确定性的手感补全。

6. **思考档位改分段胶囊控件**
   - 参考：`code-examples/SegmentedControl.tsx` — 999px 胶囊轨道 + 纯几何等分滑动指示器，档位类有限选项少一次点击且状态外显。
   - 落点：`composer.ts` 的 `levelSelect`（档位通常是 2–4 个枚举值）；模型选择仍留 select（列表长、动态）。
   - 为什么：档位是会话内高频切换且值离散，胶囊让当前档不点自明。与已有「输入框按钮布局」ticket 不冲突——那条管座位排布，这条管控件形态。

7. **状态点微动效：呼吸与脉冲**
   - 参考：`code-examples/StatusIndicators.tsx` — 空闲指示灯 2.4s 明度呼吸、运行态 1.2s 脉冲扩散，纯 CSS keyframes。
   - 落点：`style.css` 的 `.channel-dot`（连接中呼吸）与 `.tool-spin`（已有旋转，可加脉冲底色）；颜色全部引用现有 token。
   - 为什么：侧栏连接点的三态现在只靠静止圆点区分，微动效让「还在连」和「断了」在余光里也能分辨，是几行 keyframes 的 polish。

筛掉未列的：会话置顶/拖拽排序（与本仓库「顺序是 modified 的函数」的排序设计冲突，且需服务端持久化）、失败消息重试横幅（现有 setDraft 回填已覆盖主路径）、代码块复制衰减态（已有等价实现）、Token 环形仪表（context 进度条已有 ticket）。
