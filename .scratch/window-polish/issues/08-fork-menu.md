# 08 fork 的入口搬进左栏右键菜单

Type: task
Status: resolved
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

## Comments

- **claimed，做到一半暂停（等并行的 07/09/13 会话收尾）。** 已落地（红先绿后，`smoke-sidebar.ts` 全绿）：`menu.ts` 加 `openMenuAt`（指针定位 + 视口收拢）与 `MenuItem.danger`；`sidebar.ts` 拆掉 `drawDepth`/`session-fork-mark`/`data-depth`，`rowsOf` 留树、兄弟按 `createdAt` 排，`（N）` 由渲染拼在父行显示标题上（`标题（1）（2）（3）`、`标题（1）（1）` 有断言）；行上 `contextmenu` 开三项菜单；就地改名编辑净名、后缀自动拼回。**改名暂为本地覆盖**（`Sidebar.renames`），14 号落地后换 `POST /api/sessions/{id}/title`。第 7 条（拆 `forkButton`）已由并行会话的未提交改动完成。`SidebarHandlers.onForkSession/onDeleteSession` 暂为可选，main.ts 接线是剩余工作：fork（`entryId: null`）、删除、改名提交、`session_gone` 帧的消费。

## Answer

七条全部落地（14 号先解，见它的 Answer）。`npm run check` + `smoke-sidebar.ts` / `smoke-sessions.ts`
及清单内其余 smoke 全绿；断言红先绿后，"新会话出现在列表里"有断言（第 10 段：先只有源行、带 fork 行
重渲染后新行出现、其他行不重建）。

1. **右键菜单**：`menu.ts` 加 `openMenuAt(x, y, items)`（指针定位、视口内收拢，测量在 append 之后）
   与 `MenuItem.danger`；`sidebar.ts` 的 `openSessionMenu` 开三项——「派生新会话」（fork 图标，tooltip
   「复制整份记录，从这条会话接着往下走」）/ 分隔线 / 「重命名」 / 「删除」（trash、danger 色）。
2. **`（1）` 由渲染拼**：`rowsOf` 建树留下，兄弟按 `createdAt` 排，N 是同父行下的兄弟序号。**一条
   修订**：改名真存储后 fork 的服务端标题不再恒等于源标题，所以 base 规则是「行自己的名字与父行
   相同才继承父行显示标题（后缀堆叠：`标题（1）（1）`），不同了（被改过名）就以自己的名字为准」——
   不然一个改过名的 fork 行会被显示回父行的名字。`标题（1）（2）（3）`、`标题（1）（1）`、改名后
   `新名字（1）` 三种都有断言。
3. **fork 行与普通行同长相**：`drawDepth` / `session-fork-mark` / `data-depth` 及其 CSS（含 rail 规则）
   全部拆掉，`rowsOf` 建树保留。
4. **服务端调用**：`forkSession(sessionId)` → `POST /api/sessions/{id}/forks { entryId: null }`，派生后
   `openSession` 跟过去（main.ts 由票 09 的会话接好线，本票核对并保留）。
5. **不自己插行**：行来自 `session_row` 帧。**改名同样不做本地先行**（修订后的第 5 条）：就地编辑
   提交 `POST /api/sessions/{id}/title`（`api.renameSession`），行从随后的帧回来；smoke 断言"本行
   没有自己改名字"。
6. **触发**：行上 `contextmenu`，无常驻按钮、hover 也不出现。
7. **拆 `forkButton`**：已随票 09 的会话落地（`TranscriptOptions` 现在只有 `onUserContext`）。

**超出原票范围、经用户拍板加进来的：真删除。** 服务端一条龙——`SessionManager.remove(id)`（找到
即删那一个文件）、`hub.remove`（忙会话拒绝：有 claim/在开/在跑/待审批 → 控制器 409；空闲则照 reap
的次序 settle → observers → listeners → close，`closing` 槽跨整个删除过程防重开竞态；落地后重置
`current`）、`projection.forget/onGone`、`DELETE /api/sessions/:id`、协议新成员
`session_gone { sessionId }`（连接级帧，`mux.sendGone`）。客户端 `rows.remove` + `session_gone`
消费；删的是正在读的会话时，本窗口释放 pane、回到空态（models/settings/reachable 保留）。
**就地改名**：入口与编辑框在本票，提交到 14 号的端点，`onRenameSession` 接线；改的是正在读的会话时，
服务端确认后把新名折进 snapshot，让头部标题立刻跟上。
