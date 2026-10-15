# 15 阅读列把手：04 号拍板从未落地

Type: task
Status: open
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
