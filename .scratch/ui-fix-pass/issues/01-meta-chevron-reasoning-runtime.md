# 01 · 脚注复制按钮、行首三角、思考灰底、用时列对齐

Type: task
Status: resolved

## Question

四张图是小改动，但各自有确切的根因，且都在 `packages/web` 里：

1. **复制按钮（`优化/1.png`）**：`copyButton()` 造的是裸 `<button class="turn-copy">`，而 `style.css` 里只有 `* { box-sizing }` 之类的全局重置，没有按钮归零，于是浏览器给它 `buttonface` 底色 + 边框。图标走 `currentColor`（`--dsw-label-caption` 浅灰），落在浅色底上几乎看不见。user meta 行与 agent 脚注两处同款。
2. **三角只在 hover 出现（`优化/3.png`）**：`.tool-chevron` 是 `opacity: 0`，只有 `.tool > summary:hover` 和 `.tool[open]` 才置 1。思考行复用 `.tool`（`createReasoning()`），所以两处都“要悬停才有”。
3. **思考展开体没有灰底（`优化/4.png`）**：工具展开后的 `pre.tool-output` 有灰面板，`.reasoning-body` 只有 `margin: 4px 0 8px 22px` 的裸文字，没有背景、圆角、内边距。
4. **用时行贴最左（`优化/5.png`）**：`.transcript > *` 给了 `max-width` + `margin-inline: auto` + `padding-inline: 24px`，但 `.runtime` 在更后面写了 `margin: 16px 0`，简写把 `margin-inline` 覆盖成 0，于是这一行贴到容器左缘（截图里 x≈307，正文 x≈483）。

要变成：

- **复制按钮**：纯图标，无默认边框/底色/内边距；hover 才出现 `--dsw-bg-hover` + 更亮的 `color`；尺寸（24×24、13.5px 图标）与 `foot-chip` 的行高对齐；user meta 与 agent 脚注视觉一致。修复放在 `.turn-copy` 自身，不改全局 `button`，避免波及 `.button` / `.icon-button`。
- **三角**：始终可见（`--dsw-label-caption`），open 时转 90°；hover 只把行抬到 `--dsw-label-primary`，不再负责“让它出现”。工具行与思考行同时生效（它们共用 `.tool`）。
- **思考展开体**：与 `tool-output` 同一块灰面板——同一背景 token、同一圆角、同一内边距与滚动策略；左侧仍缩进到工具输出行首（22px），正文排版仍是 prose 而不是 mono。
- **用时行**：保留 `.transcript > *` 的列宽/居中/24px 内边距，只把 `.runtime` 的 `margin` 简写改成 `margin-block`，让它与正文同一左边界。

验收：窗口里逐张对照 `优化/1.png`、`3.png`、`4.png`、`5.png`；`npm run check` 通过（token 引用会被检查）。不新增字面色值，缺的 token 先补进 `tokens.css`。

## Answer

四条全部落在 `packages/web/src/style.css`，没有新增 token，也没有新增字面色值：

1. **复制按钮**（`.turn-copy`）：在本规则里补 `padding: 0`、`border: none`、`background: transparent`、
   `font: inherit`、`cursor: pointer`、`flex: none`，浏览器默认的 `buttonface` 底色与斜面消失，图标直接
   落在 transcript 的底色上。尺寸保持 24×24 / 13.5px；hover 才给 `--dsw-bg-hover` 与
   `--dsw-label-secondary`（默认是 `--dsw-label-caption`）。没有动全局 `button`，`.button` /
   `.icon-button` / 菜单行不受影响；user meta 与 agent 脚注共用这条规则，视觉一致。
2. **三角**（`.tool-chevron`）：删掉 `opacity: 0` 与「hover 或 open 才 `opacity: 1`」的两条规则，三角
   常显为 `--dsw-label-caption`；开合只剩 `transform: rotate(90deg)`。工具行与思考行共用 `.tool`，
   两处同时生效；`summary:hover` 仍只把行抬到 `--dsw-label-primary`，不再负责「让它出现」。
3. **思考展开体**（`.reasoning-body`）：并进 `.tool-output` 的共享盒规则——`margin: 4px 0 8px 22px`、
   1px `--dsw-border-l1`、`--dsw-radius-sm`；再与 `.tool-output` 共用 `--dsw-code-block` 背景、
   `10px 12px` 内边距、`max-height: 24rem` + `overflow: auto`。`.reasoning-body` 自己只留 prose 排版
   （`--dsw-fs-meta` / `--dsw-lh-meta` / `--dsw-label-secondary`）。左侧仍缩进到工具输出行首（22px），
   两处盒子由同一条规则定义，不会各自漂移。`.reasoning-body` 同时加进 `.tool-output` 那组滚动条规则。
4. **用时行**（`.runtime`）：`margin: 16px 0` 改成 `margin-block: 16px`。inline 方向仍由
   `.transcript > *` 的 `margin-inline: auto` 负责，于是它与正文落在同一条居中列上，不再贴容器左缘。

验证：

- `npm run check` 通过（四份 tsc + token 审计：`138 defined, 112 referenced`）。
- 新增 `.scratch/ui-fix-pass/research/verify-01.ts`：真服务器 + 脚本化传输 + 无头 Chromium，在窗口里读
  四处的 computed style，31 项断言全过（含 hover 后三角仍在、以及一轮真实流式里量到的计时行）。
  `--shots` 出图 `after-01-user-meta.png`、`after-01-foot.png`、`after-03-chevron.png`、
  `after-04-reasoning.png`、`after-04-tool-output.png`、`after-05-runtime.png`、
  `after-05-runtime-live.png`，与 `优化/1.png`、`3.png`、`4.png`、`5.png` 逐张对照。
- `scripts/smoke-transcript.ts`、`smoke-sidebar.ts`、`smoke-settings.ts`、`smoke-modes.ts`、
  `smoke-branch.ts` 全绿。
- 顺带补了 `scripts/dom-shim.ts` 的 `setInterval` / `clearInterval` 空实现：`smoke-transcript` 的流式
  用例在 06 号加入计时行后就撞在 shim 缺成员上（与本票的样式改动无关）；补上后这条 smoke 才能跑完。
