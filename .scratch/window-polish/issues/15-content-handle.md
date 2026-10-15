# 15 阅读列把手：04 号拍板从未落地

Type: task
Status: resolved
Blocked by:

## Question

用户反馈「对话页左右调整」没有实现——**这是真的**。04 号拍了板（一个把手管正文最大宽度），
但 `packages/web/src` 里 `contentWidth` 一处都不存在：今天只有左栏把手（06 号）落了地，
正文宽度的那一半从未执行。这是本 effort 里"Decisions so far 说做了、代码里没有"的唯一确证缺口。

要把 04 号第 ① 条真正落到 `packages/web`：

1. 把手 DOM 与拖拽：正文宽度按「列宽 − 70（默认 gutter 35px 两侧）/ 列宽 − 40（拖到最宽 gutter 20px）」
   计算，clamp 到 `--dsw-content-min/cap`（600 / 1280）；把手往右推 = 变宽还是变窄照 01 的 ⑩
   （阅读列把手**往右推是变窄**——注意 13 号重定尺度后语义要以"两侧留白变化"为准核对）。
2. 宽度记 `appearance.contentWidth`（px、可缺省），持久化路径照 `sidebarWidth` 现成的两条规则：
   存拖出来的偏好值、读回 clamp 到当次量程、按下未拖动不覆写；服务端 clamp 照 `SIDEBAR_WIDTH_RANGE`
   的路子补一条（config 模块跑在 Node 上，客户端读 tokens.css 的 `--dsw-content-min/max`）。
3. 窗口或左栏宽度一变就重算（13 号第 6 条），会话顶部固定头不跟着正文宽度动。
4. 跑 `npm run check`（token 审计）+ `smoke-sidebar.ts`，出图走
   `.scratch/window-rework/research/shots.ts` 那套（前后各一张）。

## Answer

四条全部落地，实测核验过（真服务器 + 生产 bundle + 真浏览器，`research/shots-content.ts`）。

1. **把手 DOM 与拖拽**：`packages/web/src/main.ts` 新增 `.content-resizer`，绝对定位在
   `.transcript-body`（新加的包裹层，把手与滚动容器分层，绝对定位的把手不能住在滚动容器里）
   内、骑在阅读列左缘上。公式照 13⑥：默认 = `列宽 − 70`、上限 = `min(1280, 列宽 − 40)`、
   下限 600；列过窄时上限赢（`Math.min(max, Math.max(min, v))` 的自然结果——窄窗正文先填满）。
   方向照 01⑩：往右推变窄，位移乘 −2，把手跟得住指针。量程的四个数全部落 `tokens.css`
   （`--dsw-content-min/cap/gutter/gutter-tight`），客户端运行时读回；题干写的
   "`--dsw-content-min/max`" 以 04 的拍板为准是 `cap`，实现照 04。
2. **持久化**：`appearance.contentWidth`（px、可缺省），`core/config.ts` 补
   `CONTENT_WIDTH_RANGE = {600, 1280}` 与 `clampContentWidth`（`mergeSettings` 解析时 clamp，
   手改文件越界拉回不出界）。客户端照两条规则：存拖出来的值、按下未拖动不覆写；显示值每次
   布局变化重算（`ResizeObserver` 骑在会话列上——窗口和左栏两个来源一并覆盖，13⑥）。
   **顺带修了一处既有缺口**：`PATCH /api/settings` 的 appearance 白名单原本只收
   `theme`/`fontSize`——06 号的 `sidebarWidth` 一直被服务端静默丢弃，持久化从未真正打通。
   两条宽度一起收进白名单（各自过 clamp），这条超出 15 的字面范围，但 15 的持久化路径
   就是照 sidebarWidth"现成的两条规则"写的，路不通则两条都不通。
3. **消费端**：`.transcript > *`、`.banners`、`.composer-wrap` 改读 `--dsw-content-width`
   （运行时由把手写；tokens.css 里的 46rem 只是首帧前的暂值）；状态行从 40rem 改为
   `calc(var(--dsw-content-width) - 6rem)`，"比输入框窄一步"的关系在任意宽度下保持。
   固定头不消费该变量，实测 header = 列宽 = 1042、正文 972 → 612 时头不动。
4. **验收**：`npm run check`（token 审计过）、`smoke-sidebar.ts`、`smoke-api.ts`、
   `smoke-session.ts` 全过；出图 `research/shot-content-before.png`（默认 972）/
   `shot-content-after.png`（拖右 180 → 612），刷新后偏好读回 612，服务端 clamp 实测
   9000 → 1280、非数字丢弃不覆盖。脚本与存量截图收在 `research/`。

**一处自主决定（可推翻）**：把手带上了键盘路径（←/→，步进 16，方向与拖拽一致）与
separator 语义，照左栏把手的现有先例——两个把手是一门语法。键盘提交与拖拽同规：
存 clamp 后的屏上值，撞着当次量程的按键不把更宽的偏好悄悄写进文件。
