# 06 左栏：去 logo、行规格、拖拽调宽

Type: task
Status: open
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
