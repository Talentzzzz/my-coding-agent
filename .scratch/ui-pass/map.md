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
- [open-claude-ui 参考](issues/11-open-claude-ui-reference.md)：清单 7 条已备好（危险确认对话框、回到底部悬浮按钮、菜单键盘漫游、边缘渐隐、分割条双击归位、档位分段胶囊、状态点微动效），等用户挑中哪些再毕业成 ticket。

## Not yet specified

- 标题栏原型（[标题栏布局原型](issues/07-titlebar-prototype.md)）：**第二轮原型已就绪**（`prototype/07-titlebar.html`，双击即可）。第一轮的"在标题行内部让位"四个方案已被用户否掉——照参考窗口逐像素量出来的结构是：**y 0–40 是一条铺满窗口宽的顶带，页面不在里面画任何东西，填充与会话栏同色；y ≥ 40 才是两栏，对话面板比会话栏深/浅一档**。我们现在的 bug 是顶带被画成了面板的色（`rgb(21,21,23)`），所以按钮站在"内容"上。`A 参考形态` 与 `B 统一填充` 两方案实测都是 0 冲突，等用户拍板后从"标题栏原型"毕业出实现 ticket；实现 ticket 要带上：拆顶带、顶带填充/`titleBarOverlay` 跟主题、`.header-row` 去掉标题栏高度、`.branch-tools` 的 `min-width: 0`。
- [open-claude-ui 参考](issues/11-open-claude-ui-reference.md) 的借鉴清单会毕业出一批新 ticket（数量未知，取决于清单里哪些被用户挑中）。

## Out of scope

- 插件与 MCP 机制（AGENTS.md 规则，与本 effort 无关但再次确认不动）。
