# 12 标题栏：立一条真正的顶带

Type: task
Status: open
Label: feature

## Question

用户已挑定方案 A（`prototype/07-titlebar.html`）。要落地的事：

**现在的形状**：`.header` 背着标题行，第一行是会话标题 + 分支芯片，第二行才是分支页工具行；`titleBarOverlay` 把三个窗口按钮画在页面**上面**，占右上角 138×40。于是按钮压住标题行里的分支芯片、以及分支页工具行里的「100% / 适应 / 回到对话」（图1、图2 的问题）。

**要的形状**（照用户给的参考窗口逐像素量出来的）：窗口最上面是一条 **40px 顶带，铺满整个窗口宽度**，页面不在里面画任何东西，三个窗口按钮住在它的右端；`y ≥ 40` 才是两栏。顶带的填充与会话栏**同色**（深色 `rgb(27,27,28)`，浅色 `rgb(245,246,247)`），对话面板是另一档（深色 `rgb(21,21,23)`，浅色 `rgb(255,255,255)`）。

**用户拍板时补的两条**：

1. **面板左上角要圆角**——参考图里面板左缘从 y=40 的 x=290 收到 y=50 的 x=280（约 10px 半径）。原型用 `--dsw-radius-lg`（16px）：12px 在深色主题里只有几个像素的抗锯齿，截图里读起来是直角。
2. **会话栏右侧不要那条线**——两栏之间只靠填充区分。参考图实测：y=300 一行里会话栏的 `27,27,28` 到 x=279 结束、面板的 `21,21,23` 从 x=280 开始，**中间没有分隔像素**。

## 动手清单

- [ ] 把顶带从 `.header` 里拆出去，做成窗口级的一条：`packages/web/src/style.css:648` 的 `.header` 现在同时是标题行的容器（`padding: 0 24px`、`.header-row` 上的 `height: var(--desktop-titlebar)` / `min-height: 52px`）。
- [ ] 顶带填充用 `--dsw-bg-sidebar`；`.sidebar` 去掉 `border-right`（`style.css:69`）；`.conversation` 保留 `--dsw-bg-base` 并加 `border-top-left-radius: var(--dsw-radius-lg)`。
- [ ] `packages/desktop/main.cjs` 的 `titleBarOverlay.color` 改为跟着 `--dsw-bg-sidebar` 走（`CHROME_LIGHT` / `CHROME_DARK` 现在写的是 `#f9fafb` / `#1b1b1c`，对应不了 `tokens.css` 的 `bluish-60` / `bluish-900`）——浅/深两套都要对。
- [ ] 拖拽区归顶带（`-webkit-app-region: drag`），顶带内没有可交互内容；`.header-row` 不再需要标题栏高度。
- [ ] 顺带修**现成的溢出**：`.branch-tools`（`style.css:755`）是 flex item，自动最小尺寸等于内容宽度，比 header 的 padding box 还宽，右侧会溢进按钮保留区——加 `min-width: 0` 并允许收缩（原生型 `prototype/07-titlebar.html` 里已验证这一条）。**注（票 04 实测，2026-10-17）**：只加 `.branch-tools { min-width: 0 }` **不够**——`.header` 也是 grid item，它的自动最小尺寸（内容）会被 `.conversation` 的单列 `auto` 取成列宽，列可以比容器宽，于是整行照样出界（720px 窗口实测列 701.4px、按钮 x 872–962、`elementFromPoint` 打不中）。票 04 已把 `.header { min-width: 0 }` 一起加上（`style.css:648` 那一块）；本票立顶带时要保证这两条都在，原型之所以「验证过」是因为原型里没有 `.header` 这个 grid item。
- [ ] 会话栏顶行（`sidebar-top`，40px + 6px padding）落在顶带之下；实测第一个可点控件应在 y≈47。

## 验收

- `npm run check` 与 README 的 smoke 清单（`smoke-transcript` / `smoke-branch` / `smoke-sidebar` 与窗口构图最相关）。
- 真窗口截图核对：顶带铺满宽度且与会话栏同色、按钮全落在顶带内、两栏之间无分隔线、面板左上角有圆角；对话页与分支页各一张，浅/深各一张。
- 「被按钮压住的总面积」= 0：顶带里没有页面内容（原型的读数面板已经在量这个）。

## 参考

- 原型与全部实测数字：[07 标题栏布局原型](07-titlebar-prototype.md)
- 真窗口截图：`prototype/shot-A.png`（深·对话）、`shot-A-branch.png`（深·分支）、`shot-A-light.png`、`shot-A-branch-light.png`、`shot-A-branch-zone.png`（按钮保留区描边）
- 复现原型：`npm run prototype:titlebar`，或双击 `prototype/07-titlebar.html`
