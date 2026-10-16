# Map：窗口 UI 整改批次

Label: `wayfinder:map`

## Destination

一批窗口 UI 改进与桌面端启动问题全部落地并验证：分支图（单行截断、进入居中、可拖动、两个回对话按钮修复）、工作区（阴影标记当前、右键新建/重命名/删除）、标题栏布局优化、输入框按钮布局、会话栏收起按钮、context 进度条加粗；桌面端在独显直连后能稳定启动（或固化启动参数）。

## Notes

- Issue tracker 是本地 markdown（`docs/agents/issue-tracker.md`），map 与 ticket 都在本目录。
- **本 effort 携带执行**（Notes 覆盖）：多数 ticket 是 `task` 类型，决策已由用户当面钉死，ticket 直接进入实现并在 `## Answer` 里记录做了什么。
- 窗口 UI 规矩见 AGENTS.md：只读设计 token、注释英文/文档中文、加端点 = 控制器方法 + `createRoutes()` 记录。
- 用户已钉死的决策（不要再问）：
  - 工作区「删除」= 仅从列表移除，不碰磁盘。
  - 工作区「重命名」= 直接改本地文件夹名，该工作区下所有会话的 cwd 跟随更新。
  - 工作区当前标记 = 阴影，去掉「当前」文字。
  - 输入框左下角 = 会话设置齿轮（应用级设置仍在侧边栏）。
  - 输入框右下角从左到右 = 模型、思考档位、发送（两个下拉都保留）。
  - 分支图卡片 = 单行，超长用 `…` 截断。
  - 会话栏「收起」= 「展开其余」右侧多一个按钮，撤销上一次展开多出的那一页。
  - 桌面端启动：用户已切独显直连，先重试原样启动；若仍崩再固化 `--disable-gpu --no-sandbox`（方案默认选「默认固定加」）。

## Decisions so far

- [桌面端启动验证与修复](issues/01-desktop-launch.md)：独显直连后仍以同样症状崩溃（GPU 0xC0000005 + 渲染 0x80000003），与显示模式无关；按预案把 `disableHardwareAcceleration` + `no-sandbox` 固化进 `main.cjs`，重启验证通过。
- [标题栏布局原型](issues/07-titlebar-prototype.md)：结构照用户给的参考窗口逐像素量定——**y 0–40 是一条铺满窗口宽的顶带，填充与会话栏同色，页面不在里面画内容**；y ≥ 40 才是两栏，对话面板另一档深度（深色 `27,27,28` / `21,21,23`，浅色 `245,246,247` / `255,255,255`）。用户拍板方案 A，并补两条：**面板左上角圆角 16px**、**会话栏右侧不画分隔线**。原型 `prototype/07-titlebar.html`（`npm run prototype:titlebar`），全部实测数字与截图在 ticket 里。
- [分支图进入时居中](issues/03-branch-center.md)：居中由 `scrollHome()` 的 `max(0, (sizer − viewport) / 2)` 给出；票面提示的 `place-items` 对这棵树是空转的（sizer 从不小于视口，唯一有余额的场合就是图被缩到 40% 下限时），CSS 只留 sizer 的两条 `100%` 下限保护。顺带修了 Ctrl+滚轮锚点读过期 `zoom`、并从 `scrollLeft` 反推图坐标的既有缺陷。全量 smoke 清单绿；真窗口目视未做（本会话 harness 下 Electron 捕获一律被杀）。
- [工作区当前标记改为阴影](issues/05-workspace-shadow.md)：文字标记（`workspace-current` span）删除，换成表头上的 `workspace-head-current` 类 + 新 token `--dsw-shadow-workspace-current`（明暗两套；外圈负责读数、外投负责"浮起来"）；底色保持透明，好让当前工作区照样有 hover。`DrawnNode.mark` 与 `groupFor` 里的增删补丁一并清掉，`main.ts` 里三处还写着"「当前」标记"的注释同时改掉。量具新增第 17 节（标记只有一个、跟着当前走、换组时表头不重建），并修好 `all()` 的类比对（原来恰好等于，DOM 语义是成员）。**目视做了**：`launch.mjs --load <内联真 tokens.css/style.css 的夹具> --screenshot` 浅深两色各一张，另加两张 6 倍放大——放大证明外圈没有被 `.session-list` 的 overflow 裁掉，并把圈的强度从 `border-l1` 档提到 `l3` 档（原值 1 倍下看不见）。**顺带推翻票 03 的一条记录**：这台机器上 `--load --screenshot` 现在是通的，Electron 捕获不一定被杀。
- [工作区右键菜单](issues/06-workspace-context-menu.md)：表头右键三项——新建会话（客户端把右键那个 cwd 传下去）、重命名（`POST /api/workspaces/rename`，一个操作：先搬用户的文件夹、再搬 store 目录、最后只重写 header 那一行的 `cwd`/`parentSession`；有活会话/目标被占/父目录缺失都是 409）、删除（`POST /api/workspaces/hide`，只往 `hiddenWorkspaces` 加一条路径，磁盘不动）。**「哪些工作区在列表里」收成一条规则** `SessionHub.listsWorkspace`：REST 列表与通道概览（连接基线 + 每一行）都问它；搁置/取回不改变任何一行，所以由 `broadcastSessions()` **重发一份概览**通知，而不是发明第二种消息。删除的回头路是「在该目录新建会话即取消隐藏」。code-review 抓到三条真问题并当场修掉：`deleteWorkspace` 在通道 live 时被 `rows.loadFrom` 拒收（验收第 3 条其实是坏的，且概览原先根本没过滤，刷新后分组自己长回来）、`rewriteHeaderPaths` 的字节比较在 Windows 上会漏掉大小写不同的会话、`text-dialog` 的 Escape 只关卡片不 settle（promise 永远悬着）。另修 `style.css` 的字面颜色（提成 `--dsw-scrim`）与 `docs/architecture.md` 缺的两行端点。量具：smoke-sessions 新节（含取消隐藏）、smoke-mux-live 新节（真服务器+真 MuxClient，改动前是红的）、smoke-sidebar 第 20 节，以及 `dom-shim` 补上 `document` 的监听（原先空实现，`menu.ts`/`text-dialog.ts` 的每条 document 路都不可达）。真窗口目视未做。
- [open-claude-ui 参考](issues/11-open-claude-ui-reference.md)：清单 7 条已备好（危险确认对话框、回到底部悬浮按钮、菜单键盘漫游、边缘渐隐、分割条双击归位、档位分段胶囊、状态点微动效），等用户挑中哪些再毕业成 ticket。

## Not yet specified

- [open-claude-ui 参考](issues/11-open-claude-ui-reference.md) 的借鉴清单会毕业出一批新 ticket（数量未知，取决于清单里哪些被用户挑中）。

## Out of scope

- 插件与 MCP 机制（AGENTS.md 规则，与本 effort 无关但再次确认不动）。
