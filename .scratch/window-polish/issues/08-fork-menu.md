# 08 fork 的入口搬进左栏右键菜单

Type: task
Status: open
Blocked by: 01, 02, 14

## Question

把「派生新会话」从**消息上的常驻按钮**（`transcript.ts` 的 `forkButton`）搬到**左栏会话行的右键菜单**。

要做的：

1. **右键菜单**：`packages/web/src/render/menu.ts` 已经有自绘菜单的底座（工作目录菜单用的是它），
   复用它。三项：「派生新会话」「重命名」「删除」——**重命名这一轮就要做**（01 的 ⑨）：它的持久化
   已由 [11 号](11-session-rename.md)拍板（真存储）、由 [14 号](14-session-rename-server.md)落到
   core/server，本票做入口与就地编辑，提交目标是 `POST /api/sessions/{id}/title { title }`。
2. **`（1）` 是左栏渲染出来的，不是 fork 那一刻算出来的**（01 的 ② 被 02 改判）：会话文件里没有标题
   字段，服务端给所有 fork 的标题都等于源标题，所以**任何**客户端算出来的带后缀标题都会被随后的
   `session_row` 帧覆盖、重开就没了。正确做法是**根本不存这个后缀**——渲染行的时候，N 取"它在同一个
   父行下的兄弟序号"（按创建时间排），后缀拼在**父行的显示标题**上，所以派生三次是 `标题（1）（2）（3）`、
   派生的再派生是 `标题（1）（1）`。左栏的 `rowsOf` 已经在建树，兄弟列表就在手边。
3. **fork 出来的行跟普通行长得一模一样**（01 的 ⑧）：**不缩进、槽里不画任何标记**，唯一的区别是
   名字带着 `（1）`。所以 `sidebar.ts` 里的 `drawDepth` / `session-fork-mark` / `data-depth` 那一整套
   视觉缩进这一轮要**一起拿掉**（`rowsOf` 的建树要留下——顺序和"紧跟源会话"还要靠它）。名字本身
   还是权威的：它本来就等于源标题，只剩后缀在说"这是一条派生"。
4. **服务端调用**：`POST /api/sessions/{id}/forks { entryId }`，**`entryId` 传 `null`**。02 号查清
   `null` 的语义是"复制**整份日志**、`leafId` 归位到被选中的那一条"（`session-manager.ts:1584-1618`），
   **不是**"从最后一个已完成的轮次继续"——所以菜单文案要说成"从这条会话接着往下走"，
   不能写成"从最后一条继续"。
5. **不要自己往列表里插行**：02 号证实 `hub.fork` 的 `announceHost` 已经让清单帧带上新行
   （`mux.ts:648-667`），客户端再插一次就会重影。**改名同样不做本地先行**（11 号已拍板真存储）：
   就地编辑提交 REST，行从随后的 `session_row` 帧回来——没有本地改行、没有与服务端对账的逻辑。
6. **触发方式**：右键（`contextmenu`）为主。要不要再来一个键盘等价（`Shift+F10` / 菜单键）由
   01 定，但**会话行上不再常驻任何按钮**。
7. 拆掉 `transcript.ts` 里的 `forkButton` 及其在 `createTurn` / `applyControls` 里的线程，
   `TranscriptOptions.onFork` 一并清理。

`npm run check` + `scripts/smoke-sidebar.ts` / `smoke-sessions.ts` 要绿。**先让断言红再修到绿**——
新会话出现在列表里这条要有断言。
