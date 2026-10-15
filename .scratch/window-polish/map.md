# Map：窗口打磨

`wayfinder:map`

## Destination

把窗口从"能用"打磨到**细腻**：排版、间距、字号照参考实现重做；两个可以左右拖拽的把手；两个入口
（左栏 fork、会话内分支）从"常驻按钮"改成"右键菜单"；工具过程收敛成一行可点开的东西。

走到终点时，这些同时成立：

- 左栏**没有 logo**，会话行的字号与行高照参考实现的规格（32px 行、14/20 标题、12px 次要行），
  全树不再有 10/11/11.5/12.5px 这类散值；
- 左栏宽度可**左右拖拽**调整，阅读列的宽度同样可调，而**会话顶部不跟着正文宽度动**（12 号：
  页签与「当前分支」钉在会话列两端的那条固定头里）；
- 对左栏一个会话行**右键**，菜单里有「派生新会话」，选中后左栏出现一个新会话，标题是
  **`原标题（1）`**，挂在该行下方；
- 对会话里的**用户消息右键**，菜单里有「分支」，选中后**左栏一个字节都不变**，会话进入分支页
  —— **入口只有一个：固定头右上角那一块「当前分支」**（13 号把 01 的 ③ 那两个页签拆掉了）；
  分支页里画的是一棵**从左到右、根在最左**的树（12 号把 01 的几何转了九十度），
  **Ctrl+滚轮缩放、按住左键拖画面**（13 号定的手势），**点一个节点只是选中它、要按那个按钮才切过去
  并回到对话**（那儿也是唯一的出口），而固定头最上面一行是**会话标题**、右边那一块一直写着当前读的是哪一条；
- 正文里不再有「智能体」这个标签（每轮一个圆点标识 + 用户消息下的一条分隔线），也不再出现
  `[调用 read]` 这类占位文本；一次工具调用读作**一行 `Read` + 简短路径**，点开才展开内容；
- **重新打开一个会话，工具调用的结果仍然在**（现在是丢的）。

## Notes

**领域。** 本项目是一个带桌面 UI 的编码 agent：agent 跑在 Node 进程里，窗口是一个 Web 客户端，用
REST 发命令、从一条常驻 WebSocket（`/mux`）读事件流。术语表在根 `AGENTS.md` 的「术语」一节，
请求流程与每个选择的理由在 `docs/architecture.md`——动手改哪个子系统之前先读它对应的那一节。

**执行在范围内。** 本 effort 覆盖 wayfinder 默认的"只产出决定"：`task` 类型的 ticket 就是**执行切片**，
解决它 = 把改动真的落到代码里，并跑 `npm run check` 加上对应的 smoke。`grilling` / `prototype` 类型的
ticket 仍然只产出决定或产物。

**参考材料。**

- 用户给的三张截图已归入 `reference/`：`01-dsh-window.png`（参考实现的整窗，圈出了阅读列宽度的
  拖拽把手）、`02-hero-and-composer.png`（圈出了"不要智能体标签"、"选模型的放在输入框右边"、
  "这两行字去掉"）、`03-tool-and-rounds.png`（圈出了"每一轮有一个圆点标识"、"调用 read 太丑"、
  "重开会话看不到工具结果"）。
- 参考实现的**源码**在工作区的 `deepseek-harness-master/`（不在本仓库的构建图里，只作阅读材料，
  不要往里写东西）。这一轮最吃重的四处：会话行规格 `packages/client/ui-workspace/src/client/rows/Rows.module.css`、
  过程行规格 `packages/client/ui-chat/src/client/chat/TurnProcessNodeView.module.css`、
  字号与字体的基底 `packages/client/ui-theme/src/styles/base.css`、
  会话行菜单项 `packages/client/ui-workspace/src/client/session-actions/`（`ForkSession.tsx` 就是一个菜单行）。

**既定约定（照搬前一个 effort）。** 文档中文、源码注释英文；窗口 UI 只读设计 token——
`packages/web/src/style.css` 里一个字面颜色就是一个 bug，值要放进 `tokens.css`，而 `npm run check` 的
token 审计会拒绝一个被引用却从未定义的 `--dsw-*` 名字；改完代码跑 `npm run check` 和对应的 smoke。
既有 token 表 `packages/web/src/tokens.css` 已经从参考实现移植过来，**新增名字沿用 `--dsw-*` 前缀**。

**已验证的事实（动手前不必再证）。**

- `npm run check` 退出码 0；`scripts/smoke-*.ts` 里 README 清单所列全部通过。
- 服务端**已经有** `POST /api/sessions/{id}/forks { entryId }`（`packages/server/src/main.ts:113` 的命令表、
  `packages/server/src/hub.ts:419` 的 `fork()`），`entryId` 为 `null` 时从源会话的叶子分叉。
- 左栏**已经**拿得到 `parentId`，并且已经按树缩进画（`packages/web/src/render/sidebar.ts` 的 `rowsOf` /
  `drawDepth`）——所以"fork 出来的会话挂在源会话下面"这件事不需要新的服务端事实。
- 分支切换器**已经**存在：`BranchOption` / `item.branch.options`（`packages/web/src/render/transcript.ts`
  的 `branchNav`）——要搬的是它的**位置**，不是它的数据。
- 工具卡片**已经**是一行 summary + `<details>`（`transcript.ts` 的 `renderTool`），要改的是它的**读法**
  （名字 + 路径、不要 `[调用 read]`）与**位置**，不是从零做。

**环境坑（沿用前一个 effort）。** `HTTP_PROXY`/`HTTPS_PROXY=127.0.0.1:63262` 且 `NO_PROXY` 为空 →
`curl localhost:8080` 会被送去代理，用 node 的 `fetch`/`WebSocket` 探测；`ELECTRON_RUN_AS_NODE=1` 已在环境里 →
桌面窗口只能走 `npm run desktop`；`npm run desktop:screenshot` 在本机必崩，出图走
`.scratch/window-rework/research/shots.ts` 那套（bootServer + 本机 Chromium）。
`smoke-api.ts` 与其他 smoke 不同：**它要一台已在跑的服务器**（默认 `127.0.0.1:8080`），空跑会在
WebSocket 连接处报 "the mux connection failed"——那是没起服务器，不是回归。

**2026-10-15 用户反馈后的核实结论（动手前不必再证）。**

- 分支、fork、改名、删除**已落地**（08/09/14 号，提交 077a7f4、ce1a589），check 与 smoke 全绿。
  用户报"没实现"最可能是入口发现或旧构建：fork 只在会话行**右键菜单**里、没有常驻按钮；分支入口
  单走法时整块隐藏，要分过一次岔才出现；桌面外壳服务 `packages/web/dist`，改完要
  `npm run build:web` 且已开的窗口要重开。真窗口逐个入口的核验归 [19 号](issues/19-entry-verification.md)。
- 「对话页左右调整」（04 号 ① 的阅读列把手）**确实从未落地**——代码里 `contentWidth` 一处不存在，
  只有左栏把手（06 号）落了。归 [15 号](issues/15-content-handle.md)。
- 用户消息发送后的渲染异常（气泡悬在上一轮回答下方、偏小、下带孤立光标块）截图存
  `research/shot-user-bubble-bug.png`，复现与修复归 [16 号](issues/16-user-bubble-render.md)。

## Decisions so far

<!-- 关掉的 ticket 依次列在这里：一行要点 + 指向该 ticket 的链接 -->

- [19 真窗口核验：分支、fork、改名三个入口可达且可用](issues/19-entry-verification.md)：**三个
  入口在最新构建里全部可达且可用**（`research/verify-19.ts`，真 UI 24 条断言全绿，出图 10 张
  在 `research/v19-*.png`）。用户报的「没实现」核实为**旧构建 + 入口藏得深**（fork/改名/删除
  只在会话行右键菜单、无常驻按钮；「当前分支」块单走法时整块隐藏，要先分过岔）。核验跑出两条
  真 bug，按票面规矩另开、不在 19 里修：[21 删除刚派生的会话后会订阅已删会话（红横幅
  「未知的会话」）](issues/21-fork-then-delete-stale-open.md)、
  [22 空态的模型位读作「（已丢失）」](issues/22-empty-state-model-seat.md)。
- [17 整体字号抬高：原型拍板维持现状](issues/17-type-scale-up.md)：三方案原型
  （`prototype/type-scale.html`，真窗口构图、`?variant=` 切换、悬停读实际字号）让用户对照后
  收回原始诉求——五档一字不动，"小一号"的感觉来自别处；后续某个具体面再读着小，按面开新票。
- [18 工作区按最近活跃排序](issues/18-workspace-recency.md)：客户端 `rows.ts` 的 `groups()`
  把方向排反了（升序，活跃工作区沉底），服务端本来就是降序——一比较器反转落地，smoke-sidebar
  新增一节直接驱动 `SessionRows` 钉住"刚发过消息的工作区排第一"。链路（projection 推 `modified`
  → `session_row` 帧 → 重画重排）核实过不用动。
- [07 会话：圆点、分隔线、工具一行](issues/07-transcript.md)：五条全落（`packages/web`）。
  角色行连 `labelFor`/`initialFor` 整个拆掉、不留替代物，用户气泡下的细分隔线挂在回合自己的
  `::after` 上（reconcile 一行没改）；10 号留给 07 的 `contentToText` 缝如约收掉——正文路径加
  `withoutToolCalls`，call-only 消息从此没有正文 item，`contentToText` 本体与三处工具输出消费
  不动；工具组照原型读作一行 `Name path`（无边框盒、hover 提亮、chev hover 才出现、running
  脉冲点在行尾、diffstat 钉行尾、展开内容缩进 22px，认不得的参数只显名字）；工作目录芯片常驻
  composer 卡上方最左（hero 行的隐藏逻辑删除），模型选择器整座推右下，两行提示字删掉，
  textarea 字号尊重 05 已拍的 body 档；状态行核对后零改动。smoke-replay 的位置断言改判为
  「组夹在问题与回答之间」并钉住 call-only 不留正文。出图 `research/shots-transcript.ts` 前后
  各两张（整窗 + 输入框特写）。出图顺带撞出 item 身份 `role:timestamp` 同毫秒碰撞的边角，未修。
- [14 改名的持久化：rename entry 与标题端点](issues/14-session-rename-server.md)：**改名是一条
  `{type:"rename"}` entry**（header 不动、version 维持 3，未知 kind 原样带过免费兼容），
  **文件序最后一条赢、与分支无关**（左栏一行是一个会话，不是一条走法）；活会话与文件扫描两条读取
  路径同改；`hub.rename` 活走自己的 manager、冷照 `forkFrom` 按路径追加、不拿 claim；
  `POST /api/sessions/:id/title`（空白 400、`shortenTitle` 72 字符兜底、201）经
  `onRenamed → projection.refresh → 既有 session_row 帧` 送达，**改名这条路 protocol.ts 一字未动**；
  ADR-0002 落 `docs/adr/`。执行期发现：真存储改了 08 ② 的前提——左栏拼后缀的 base 规则随之修订
  （行名与父行相同才继承父行显示标题，不同了用自己的名字），落在 08 号。
- [08 fork 的入口搬进左栏右键菜单](issues/08-fork-menu.md)：行上 `contextmenu` 开自绘三项菜单
  （`menu.ts` 新增 `openMenuAt` 指针定位 + `MenuItem.danger`）：**派生新会话**（`entryId: null`，文案
  「复制整份记录，从这条会话接着往下走」）、**重命名**（就地编辑净名、提交 `POST /title`、行从
  `session_row` 帧回来——**不做本地先行**）、**删除**（用户拍板加的真删除：`SessionManager.remove`
  + `hub.remove` 忙会话 409 + `projection.forget/onGone` + `DELETE /api/sessions/:id` + 协议新成员
  `session_gone` 连接级帧；删掉正在读的会话时窗口释放 pane 回空态）。**`（1）` 由渲染拼**（兄弟按
  `createdAt` 排、同父行下序号；base 规则见 14 号的修订）；`drawDepth`/`session-fork-mark`/
  `data-depth` 整套视觉缩进连同 CSS 拆掉，`rowsOf` 建树保留；`forkButton`/`onFork` 拆掉（随票 09 落地）。
- [04 两个把手与字号阶](issues/04-handles-and-type.md)：三问全拍。① **只有一个把手**，管正文最大
  宽度（量程照 13 号第 6 条），**不给"整列宽度"的第二个把手**——留白只剩 35/20px，第二个把手
  无可调之物；"左栏挤没阅读列"由 600 下限兜住。布局常量落 token：`--dsw-content-min/cap`（600/
  1280）、`--dsw-content-gutter/gutter-tight`（35/20）、`--dsw-sidebar-min/max`（208/360，
  01 的取向顺手拍死），公式（列宽−70/列宽−40）留在消费端 TS。② **宽度记在
  `appearance.sidebarWidth` / `appearance.contentWidth`**（px、可缺省）：localStorage 出局
  （README 明文——桌面外壳每次启动挑新端口、origin 一变就死；参考实现用 localStorage 是
  **与参考的刻意分歧**）、会话 header 出局（宽度是窗口偏好不是会话属性）；语义照参考抄两条——
  存拖出来的偏好值、读回 clamp 到当次量程，按下未拖动不覆写。③ **字号收成五档 token**
  （title 14/20、meta 13/18、caption 12/16、body 15/25、code 13/20），现状 8 个散值全部收编；
  **设置里的"字号"只驱动 body 一档、默认从 14 抬到 15**，其余四档固定——并**纠正了题干的误认**：
  参考实现不是"整棵树缩放"，实测只有会话区骑轴（次要行公式派生），左栏行是固定 14/12/10；
  状态行三字段保留、钉 caption 12 等宽（跟 index.html 走，typography 表的 13/20 改判）。
  **顺带拍掉**"固定头钉两端 vs 正文左对齐"：维持固定头现状。一处自定可推翻：滑杆量程沿用
  12–20，body 拖到 12 时与固定档倒挂是用户自己的极端选择。
- [11 会话改名：标题从"派生"变成"可写"](issues/11-session-rename.md)：**选真存储——新增一种
  `rename` entry**，header 不动（append-only，第 1 行写了就不碰）、`version` 维持 3（未知 kind 原样
  带过）；读取是**会话级**的——文件序最后一条赢（照 `tool_config` 的读法），有它派生让位，
  与 leaf 在哪条走法上无关；**`（1）` 后缀照 01 的 ② 不存、仍由左栏拼**，存储里只有净名
  （fork 整份复制时 `rename` entry 随行，fork 落地时名字 = 源名字）；**编辑范围只改这一条，
  不连坐派生**（亲属关系由位置与后缀表达，不由同名表达）；线路是 `POST /api/sessions/{id}/title
  { title }`，追加后走既有 `session_row` 发布路——**客户端不再"本地先行"**，08 第 5 条作废；
  服务端那半边开在 [14 号](issues/14-session-rename-server.md)（含 ADR-0002）。
  顺带关掉「Not yet specified」里"改名之后的连坐"那条雾：不连坐。
- [01 交互原型：两个右键入口与观感](issues/01-prototype.md)：原型落 `prototype/`（`index.html` 是一页
  可切换三视图的整窗，`typography.html` 是"现状 vs 提案"的字号对照，都自包含、浅深两套，
  `prototype/shoot.mjs` 出图到 `research/shot-*.png` 并把五条交互跑一遍）。**经两轮**，共 11 条决定：
  ① 左栏右键菜单用**自绘菜单**（不是原生 `contextmenu`），会话行**不再常驻任何按钮**，hover 也不出现；
  ② `（1）` **不存**，由左栏在渲染行时按"同一个父行下的兄弟序号"拼（**被 02 号改判**，见下）；
  ③ **分支是会话顶部的两个页签「对话 / 分支」，选「分支」整个会话区换成一张 git 泳道图**
  （**被用户推翻过两次**：初版 `‹2/3›` 窄条 → 二版"窄条 + 弹层里的缩进树" → 三版现在这样）：
  一条泳道走一条路、分支点上拐一个肘、节点是圆点、主干永远占最左那条泳道所以当前路径是一条直线，
  点任意一行切过去；④ 工具过程读作**一行 `Read  path`**，`[调用 read]` 这类占位文本
  从正文里消失；⑤ **会话行收成一行 32px**（"运行中/待审批"收进左边那个 16px 的槽，"已打开"就是
  `aria-current` 那条底色）；⑥ **没有"每一轮一个圆点"**——轮与轮之间没有任何标记，用户消息下一条
  细分隔线之后就是内容；⑦ 工作目录属于**输入框顶部的最左边**，不属于会话左上角；
  ⑧ fork 出来的行与普通行**长得一模一样**（不缩进、槽里不画标记），只有名字带 `（1）`；
  ⑨ **改名就地可编辑**（右键菜单 → 输入框 → Enter/Escape），编辑的是净名，后缀自己拼回来；
  ⑩ 阅读列把手**往右推是变窄**（初版方向反了）；⑪ 状态行只有 `total` / `cache` / `context` 三个字段；
  ⑫ 「分支」是**页签**不是常驻条也不是弹层，选中时记录**整块**被替换（输入框留着，这条可推翻）。
  六条（⑥–⑪）来自第二轮反馈，⑫ 来自第三轮 —— 三轮反馈就是原型这一票想要的那种反应。
- [13 原型第五轮：顶部只留标题与入口、分支页专心当"总览"](issues/13-branch-focus.md)（**拆掉 01 ③
  的两个页签，落地 01 ⑫ 里"输入框可推翻"那条**）：固定头只留两样 —— **最上面一行是会话标题**、
  右边是**唯一的分支入口**（分叉图标 + `当前分支` + 短 id + 这条走法开头那句，可点、有 hover；
  只有一条走法时整块收掉），**「对话 / 分支」两个页签整块拆掉**，所以进出分支页各只有一个门
  （进：那一块；出：分支页里那个按钮）；**分支页的手势写死成 Ctrl+滚轮缩放（指针锚定、40%–300%）
  + 按住左键拖画面**（哪儿都行、压在节点卡上也拖得动）—— 用 4px 位移把"点选中"和"拖画面"分家，
  不再借 `click`，实测 Ctrl+滚轮 `88%→124%`、从卡片上拖 220px `scrollLeft 121→321` 且选中项不变，
  手势提示就写在摘要行里；**一个节点默认只念前 14 个字，悬停才展开整句**（实测 27 字的走法
  `41px → 58px`，展开长在卡片自己身上、会盖住下一行，故意的）；**分支页里没有输入框了** ——
  底部对话框（连同工作目录与状态行）整块收掉，这一页只有树。**正文列的尺度同时被重定**（第 6 条）：
  从"居中 + 固定 700"改成**按会话列宽算** —— 默认两侧各留 **35px**（原来 70px 的一半）、
  拖到最宽两侧各留 **20px**、上限 `列宽 − 40` 与 **1280px**、下限 600，窗口或左栏一变就重算，
  实测会话列 840 → 默认 770 / 推到底 600 / 拖到底 800（参考实现是 `clamp(680, 列宽*0.64, 920)`
  + 两侧 88px 预算，这一步是故意放宽）。留缺口：切分支仍只换第 2 轮正文（09）、根节点不可选、
  缩放比例与正文宽度都不持久化（后者是 04 的事）；`−/＋/适应` 三个按钮留着当兜底（可推翻）。
- [12 原型第四轮：顶部固定、树横过来、缩放、选中再回去](issues/12-branch-horizontal.md)（**推翻了
  01 ③ 的几何与交互两半**）：**会话顶部是整列的一条固定头** —— 页签、「当前分支」抬头、分支页那行
  工具钉在会话列的左右两端（`padding-inline:24px`，整列宽），正文与输入框仍然居中、宽度仍归阅读列
  把手管，所以推把手时页签纹丝不动（实测 `x 311 → 311`、头部宽 `840 =` 会话列宽；参考实现就是这么
  做的，那张截图里页签在列左缘、正文在下面居中）；**树改成从左到右、根在最左** —— 列 = 深度、
  行 = 泳道，规则与上一版同构（主干占最上面那一行所以是一条水平直线、换行拐肘、深度优先），
  一个节点是一张两行卡（摘要 + 短 id + 轮次，短 id 真实现里就是 entry id 前几位）；**分支页可缩放
  可平移** —— `−`/`＋`（×1.2，40%–300%）、`适应`、`Ctrl/⌘+滚轮`（按指针锚定）、空白处拖动，
  进页面自动选"装得下就 100%、装不下才缩"（840px 列 → 88%），实现是 sizer 撑滚动 + `transform:
  scale()` 保证矢量不糊；**点节点只选中、按按钮才真的走** —— 固定头右边的按钮从「回到对话」变成
  主按钮「切到这一条并回到对话」，连点两下等于「就它了」；**对话页固定头右侧一条抬头写着
  `当前分支 <短 id> <摘要>`**，点它去分支页，只有一条走法时与页签一起收掉。留缺口：切分支仍只换
  第 2 轮正文（真实现是 09 的事）、根节点不可选（它是共同祖先）、缩放比例不持久化、树很大时要不要
  折叠仍是 09 的雾。
- [09 分支落地：顶部一个入口，整个会话区换成一棵横树](issues/09-branch-menu.md)：六条全落
  （`packages/web`）：固定头两行化，右上角「当前分支」块是唯一进门（≥2 条走法才渲染，单走法时
  那行只剩标题）；`render/branch-view.ts` 照抄原型几何（300/58/268×46，根在最左、主干占顶行、
  sizer+zoom、Ctrl+滚轮锚点缩放、按住拖画面、点选两拍、连点两下直接切），短 id 就是 entry id 前
  7 位；`turn-actions` 整块拆掉，入口只剩右键菜单（从此分支 / 查看分支图）与 chip；分支树在
  `state.ts` 每 baseline 折一次（`buildBranchTree`：后一个分支点挂前一个的 active option 下，
  节点 = 走法，工具步骤不铺、分支点不算一行，根卡 = 会话标题不可选）；分支页无输入框
  （`body[data-pane]` 一条 CSS 收掉 composer/状态行/banners）。真切换走 `POST /branch
  descend:true`。**过程修了 menu.ts 一个真 bug**（onOutside 挂 document 捕获相，真浏览器里任何
  菜单项都点不中；smoke 直接 dispatch handler 没暴露）。**新缺口**：服务端只报活跃链上的分支点，
  非活跃走法自己的子岔不在图里，切过去才长出来——「树很大」先不折叠。出图
  `research/shot-branch-{graph,selected,switched,single}.png`（脚本 `research/shots.ts`，全程真 UI）。
- [02 左栏 fork 的服务端现状与缺口](issues/02-fork-facts.md)：参考文献在 `research/sidebar-fork.md`。
  四条最吃重的：**`entryId: null` 复制的是整份日志，不是"最后一个已完成的轮次"**（`session-manager.ts:1584-1618`
  原样复制全部 entry + 全部 `leafIds`，只有 `leafId` 归位到被选中的那一条），所以左栏 fork 的语义是
  "**从这份记录接着往下走**"，文案不能让人读成"从最后一条继续"；**会话文件里没有标题字段**——
  `SessionHeader` 只有 `{type,id,cwd,createdAt,parentSession}`，标题永远由 `titleOfBranch` 从分支首条
  user 消息派生（`session-manager.ts:767-786`），于是**所有 fork 的服务端标题都等于源标题**，
  客户端算一个带 `（1）` 的标题会被随后的 `session_row` 帧覆盖（`mux.ts:576-578`）——这就是 01 的 ② 被改判的原因；
  **客户端算序号够用的字段都够**（`SessionRow` 自带 `title`/`parentId`/`createdAt`）但**不需要**，
  因为后缀走显示层；**fork 完不用客户端自己插行**——`hub.fork` 的 `announceHost` 已经让清单帧
  带上新行（`mux.ts:648-667`）。
- [03 「重开会话看不到工具结果」的根因](issues/03-replay-tools.md)：参考文献在 `research/replay-tools.md`。
  **数据在文件里，丢的是前端重放这一步**，严重度是"只是看不见"，本轮在 `packages/web` 内可修、不必开 core 票。
  三层事实：文件里**没有工具专属的 entry kind**——一次调用是 assistant `message` 的 `toolCall` 块，
  结果是**另一条** `role: "toolResult"` 的 `message` entry，靠 `toolCallId` 配对（已在真实 session JSONL
  上逐行实证）；丢在 `itemsFromSnapshot`（`state.ts:418-424`）——它只还原 `message`，从不构造
  `{kind:"tools",cards}`，而 `upsertMessage` 对 `toolResult` 直接早退（`state.ts:460`）、
  调用被 `contentToText` 降级成 `[调用 name]` 文本（`state.ts:662`），**丢的是整块工具过程**；
  **两条路不是同一个函数**——流式走 `upsertTool`（`state.ts:585-616`）造 tools item，重放只走
  `upsertMessage`，所以修法是"在重放里也喂同一个 `upsertTool`"，不是各修一遍。
- [10 重开会话工具结果不再丢](issues/10-reopen-tools.md)：修在 `state.ts` 的 `itemsFromSnapshot`
  ——新增 `replayMessage`，把 assistant 的 `toolCall` 块与 `toolResult` 消息喂给**与流式同一个**
  `upsertTool`（start 形状建卡、end 形状补丁），两条路共用一个造卡函数；先红后绿，新 smoke
  `scripts/smoke-replay.ts` 修复前 12 失败、修复后全绿（钉住文本/isError/diff/并行分组/卡片位置）。
  一处超票面：`submitting:false` 的快照把无结果的卡 `settleCards` 收掉（截断的记录不转圈），
  `submitting:true` 时留给活的 end 事件。`contentToText` 的 `[调用 name]` 降级留给 07，两票不各修。
- [05 排版 token 化](issues/05-type-tokens.md)：`style.css` 里近 60 处字号散值（10–14px 八档 +
  8 处骑 `--app-font-size` 的派生式）全部收进 04 拍的五档 `--dsw-fs-*`/`--dsw-lh-*`；对照表在票的
  Answer 里。`--app-font-size` 退役——设置滑杆的值由 `state.ts` 直接发布到 `--dsw-fs-body`，
  `--dsw-lh-body` 改为 `calc(fs * 25/15)` 派生，滑杆怎么拖字号与行高都不拆对；默认 14 抬到 15
  （`DEFAULT_APPEARANCE` 与 README 示例同步）。两处有意的判断：输入框正文（composer textarea）落
  body 档骑轴——它是用户自己的正文，跟气泡同轴；状态行读数钉 caption + 等宽（04 的改判）。
  `npm run check`（token 审计）绿。
- [06 左栏：去 logo、单行会话、拖宽记忆](issues/06-sidebar.md)：brand 整块删掉，连接指示挪进栏脚
  （窗口级事实住窗口级的位置）；会话行收成一行 32px，运行中/待审批收进左边 16px 槽的一颗琥珀点，
  「已打开」就是 `aria-current` 底色本身；fork 缩进整套删除（`rowsOf()` 建树留着）；工作区分组头
  hover 时文件夹换 chevron；右缘拖宽把手（`role="separator"`，键盘可达），宽度记进
  `appearance.sidebarWidth`（`SIDEBAR_WIDTH_RANGE` 208–360，服务端 clamp，客户端读 tokens.css 的
  `--dsw-sidebar-min/max`——config 模块跑在 Node 上，客户端不把它拉进 bundle），空按不覆写偏好。
  `scripts/smoke-sidebar.ts` 原本就没断言 brand，未改断言，全绿。


## Not yet specified

- **"细腻"剩下的那半边**——间距阶（4/8/12/16 还是 2px 微调）、圆角、分隔线的粗细与颜色、hover 过渡
  时长——原型给的是取向。字号阶已由 04 拍成五档 token（body 15/25、title 14/20、meta 13/18、
  caption 12/16、code 13/20，设置只驱动 body 一档），间距这一半在 05–07 落地时顺手收，
  收不动再单独一票。
- **朗读一遍整窗**（不只是左栏与会话这两列）：状态行、设置面板、审批接管卡、欢迎态有没有同样"小一号"
  的毛病。**17 号拍板五档维持现状后，这条雾回到原点**：若某个具体面仍读着小，按面开新票，
  不重开五档。
- **左栏那条"运行中/待审批"状态行**在右侧不再有角色行之后是否还够用——它现在是第二行，参考实现的
  会话行只有一行标题 + hover 才出现的操作区。
- **分支图在"大"的时候长什么样**：12 号已经给了缩放与平移，所以"看不见"不再是问题；剩下的是一条
  真分过十几次岔的记录铺开之后要不要折叠、要不要给一条路一个名字（而不是只有一行摘要）——
  09 落地时看到真数据再判。**09 落地后的新缺口**：服务端只报活跃链上的分支点，非活跃走法自己的
  子岔不在图里（切过去才长出来），所以"全树"与"当前视角的树"是两回事，要不要补全要开新票。
- **「只有一条走法」时的固定头**：13 号定的是「分支入口整块收掉」，那一行就只剩会话标题；
  但那时用户已经进不去分支页了（也对，没分支可看）。真实现里"当前分支"这个说法是否还成立
  （只有一条路时它**就是**这条路）等 09 落地时确认。**09 的答案**：整块收掉是对的——
  单走法时"分支"这个说法不成立，那一行只剩标题（`shot-branch-single.png`）。
- **分支页里还要不要别的东西**：现在这一页只有树 + 摘要行 + 固定头那行工具，是"总览"的字面实现。
  要不要给它一个"新会话/派生"的入口、要不要能按泳道折叠，等看到真数据（十几条走法）再判。

## Out of scope

- **空状态（hero）的重做**：前一个 effort 的 08 号已经拍板"保留现状"，这一轮不重开。
- **"完全权限"这一栏、插件栏、标准模式**：前一个 effort 的 Out of scope 继续有效。
- **参考实现的「轨迹」这一栏本身**：我们借的是它**页签的位置**，不是它的内容。这里第二个页签
  是「分支」，画的是会话自己的分支图（09 号）；把工具步骤铺成一条时间线那种"轨迹"不做。
