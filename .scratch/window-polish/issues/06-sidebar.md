# 06 左栏：去 logo、行规格、拖拽调宽

Type: task
Status: resolved
Blocked by: 01, 04

## Question

照 01 的原型与 04 的尺寸决定改 `packages/web/src/render/sidebar.ts` + `style.css`。

要做的：

1. **去掉左上角的 logo**：`sidebar.ts` 里 `brand` 那个 `M` + `my-agent` 整块拿掉。
   `channel-indicator`（连接状态）与 `toggle`（收起侧栏）要重新落位——它们原本和 brand 挤在一行，
   现在那一行空了，别留一个 40px 的空条。`#app[data-sidebar="rail"]` 那一堆 rail 规则里凡是只服务于
   brand 的（`.brand-name`）要一并清理。
2. **会话行照参考实现的规格，并且只有一行**：行高 32px、圆角 `--dsw-radius-md`、内边距左右 8px、
   标题一档、时间一档（01 的 ⑤，已由原型定下）。现状那第二行状态（"● 运行中" / "▍ 已打开 · 空闲"）
   整个拿掉：**运行中 / 待审批收进左边那个 16px 的槽**（一个琥珀色圆点），"已打开"就是
   `aria-current` 那条底色本身。`rowStatus()` 与 `.session-item-status` 及其 `min-height` 一并清理。
3. **fork 出来的行跟普通行长得一模一样**（01 的 ⑧）：`drawDepth` / `.session-item[data-depth]` /
   `.session-item[data-depth]::before` / `.session-fork-mark` 这一整套视觉缩进**这一轮删掉**，
   行与行之间不再有竖线、不再有 ▸。**`rowsOf()` 的建树要留着**——顺序和"紧跟源会话"还靠它。
   名字上的「（1）」由渲染层拼（08 号），本票只要保证行本身没有第二种长相。
4. **工作区分组**：前一个 effort 的 05 号修过"标题在会话行之上"的顺序问题，别改回去。
   参考实现的 project row 是 34px、hover 时文件夹图标被展开箭头替换——**要不要做 hover 换图标**
   由 01 的原型定。
5. **左栏宽度可拖**：在左栏右边缘加一条把手，拖拽改变 `#app` 的 `grid-template-columns` 第一列。
   收起的 rail 态（52px）不能被拖坏；拖到的宽度按 04 的结论决定记不记。把手必须可见（hover 时出现
   一条竖线即可），键盘也能调（左/右方向键）。**原型已验：抓右缘往右拖 = 加宽。**
6. **右键菜单本身属于 08 号**（派生新会话 / 重命名 / 删除），本票只负责把行画对 + 拖宽，
   以及 08 号要用的就地改名输入框（`.rename-input` 的尺寸要跟行里的标题对齐，换进去时不跳）。

`npm run check` + `scripts/smoke-sidebar.ts` 要绿。smoke 里如果断言了 brand 的存在，**改断言**并说明
为什么那个断言本来就该消失。

## Answer

六条全做，与 05 号同一批落地（两票在 `style.css` / `state.ts` / `tokens.css` 上逐行交缠，拆不开，
一个提交走）。`npm run check`、`scripts/smoke-sidebar.ts` 绿——smoke 原本就没断言 brand 的存在，
无需改断言。

1. **logo 整块删掉**：`sidebar.ts` 的 `brand`（`M` + `my-agent`）与 `style.css` 的 `.brand-*` 一并
   清理。顶行只剩新建会话与收起按钮，40px 高度由这两个控件撑着，不留空条；连接指示挪进**栏脚**、
   与设置入口同行——它是窗口级的事实，栏脚是窗口级东西住的地方。静默时只有一个点没有字
   （参考实现的读法），connecting 脉动、down 才有声。
2. **会话行一行化**：32px 高、`--dsw-radius-md`、左右 8px；原第二行状态整个删除
   （`rowStatus()` / `.session-item-status` / `min-height` 一并清理），运行中/待审批收进左边
   16px 槽的一颗琥珀圆点（`busyOf()`：pending > 0 或 running，两者同色——同一事实的两面），
   「已打开」就是 `aria-current` 底色本身，不占槽。
3. **fork 缩进删除**：`drawDepth` / `data-depth` / 竖线 / ▸ 整套从渲染里拿掉；`rowsOf()` 的建树
   留着（顺序与"紧跟源会话"还靠它）。行与行只有一种长相，fork 的差异就是名字上的「（1）」。
4. **工作区分组**：标题在会话行之上的顺序未动；分组头 34px、meta 档，hover 时文件夹图标换
   chevron——两者共用一个槽位，hover 而非 DOM 决定谁显示。
5. **拖宽**：左栏右缘一条 6px 把手（`role="separator"` + 方向键），拖的是 `--dsw-sidebar-width`。
   量程从 `tokens.css` 的 `--dsw-sidebar-min/max`（208/360）读回——config 模块跑在 Node 上，
   客户端不把它拉进 bundle，字面值只是样式表加载失败时的兜底。宽度记进
   `appearance.sidebarWidth`（04 拍的 settings 层，非 localStorage——桌面外壳每次启动换端口）；
   服务端 `clampSidebarWidth` 与客户端 clamp 同一对数；**按下未动不覆写**偏好；收起的 rail 态
   把手隐藏、拖拽与键盘都早退。
6. **就地改名**：`.rename-input` 就是行内标题换上输入框的衣服——同一 flex、同一 margins、title 档
   同一套字号行高，换进去不跳。

## Comments

- code-review（两轴并行，2026-10-15）：无硬性违反。判断题级遗留三条——① 拖宽量程 208/360 现存三处
  （tokens.css、config.ts 的 `SIDEBAR_WIDTH_RANGE`、main.ts `sidebarRange()` 的兜底字面量），注释
  已给理由，但 tokens.css 那句"stated twice on purpose"宜改成把客户端兜底也点名；② **键盘调宽
  每按一次方向键就写一次 settings.json**（keydown 内逐次 `saveSettings`），指针路径是松手才提交
  ——建议移到 keyup 且只在宽度真的动过之后提交，与"空按不覆写"同一克制；③ main() 里 resizer 约
  80 行内联块，注释密、内聚，可留可抽。
