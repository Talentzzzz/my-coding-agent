# 03 · 侧栏：当前工作区不要底座，只留当前会话那一行

Type: task
Status: resolved

## Question

用户第四轮：**当前工作区不要做阴影了，只有那一行会话做阴影**。

现状：`style.css` 的 `.workspace-head.workspace-head-current` 穿着 `--dsw-bg-active` 的**填充**
（上一轮把描边 + 投影换成了填充，见 `优化/1.png` 与票据 ui-fix-pass-2/06）。用户看到的仍然是一个
「底座」。`--dsw-shadow-workspace-current` 已经删了，所以这一轮要动的是填充本身。

要定的是：去掉底座之后，「新会话写进哪个工作区」这件事靠什么说（标题带上的工作区名？输入框上方
那一行？），以及 `sidebar.ts` 里 `CURRENT_HEAD` 这整个概念还留不留。

## Answer

**底座整个删掉，不是换个颜色。**

- `style.css`：`.workspace-head.workspace-head-current` 那条填充规则删了，原位留一段注释说清为什么
  （描边加投影 → 纯填充 → 用户还是要它走），并说明「新会话落在哪个工作区」现在靠输入框上方那枚工作区
  chip 说，而不是靠给文件夹名画一个框。
- `sidebar.ts`：`CURRENT_HEAD` 常量、`paintCurrent()`、`groupFor()` 的 `currentWorkspace` 参数、
  `SidebarState.currentWorkspace` 字段全部删除；`main.ts` 的 `renderSidebar()` 也不再传它，签名串里那一
  项一并去掉。
- 当前会话那一行**保留** `--dsw-bg-active` 填充 —— 整个侧栏现在只有它一处有「面」。
- `scripts/smoke-sidebar.ts`：删掉整节「当前工作区靠阴影」（它守护的正是被删掉的东西）和 14 节里那条
  「标记与收起态共存」的检查。

验证：`npm run check`、`scripts/smoke-sidebar.ts` 全过；真窗口截图见 `shots/01-line.png` 的侧栏
（`my-coding-agent` 表头已经没有底色，`写一段长回答` 那一行仍是填充）。
