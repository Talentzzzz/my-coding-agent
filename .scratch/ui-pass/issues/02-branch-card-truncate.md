# 02 分支图卡片单行截断

Type: task
Status: resolved
Label: feature

## Question

分支图节点卡片（`packages/web/src/render/branch-view.ts` + `style.css` 的 `.gnode`）现在会换行、把卡片撑高，图占太多地方。改成：

- 卡片固定高度，标题单行显示，超长用 `…` 截断（`shorten` 已有，但 CSS 侧的 `.full` 悬停展开是换行源头，需要一并处理——悬停看全文改走 `title` tooltip，不再撑开卡片）。
- 布局常量（`NODE_H`/`LANE_H`）随单行卡片收紧。

验收：任意长消息的分支图里，所有卡片同一高度、无换行；悬停能看到整句（tooltip）。

## Answer

- **卡片变成"一行字 + 一条 meta"的固定高度盒子**：paint 写 `style.height`，标签退化成**一个** `span.lbl` 装着整句——截断交给 CSS 的 `text-overflow: ellipsis`（`.lbl` 补 `display: block` / `min-width: 0`）。`shorten()`、`PREVIEW`、`.short`/`.full` 两行结构与 `.gnode:hover { height: auto; min-height: var(--node-h) }`、`.gnode:hover .lbl { white-space: normal }` 全部删掉：整句仍在 `card.title` 里，悬停看全文改走 tooltip，卡片不再被撑开。
- **高度收成令牌，不再写成字面量**：`NODE_H`/`LANE_H` 不是"随单行卡片收紧的数字"，而是 `tokens.css` 里的 `--dsw-branch-node-h` / `--dsw-branch-lane-h`，由 `--dsw-lh-meta`、`--dsw-lh-caption`、`--dsw-fs-delta` 派生。理由：窗口的字号滑杆把 `--dsw-fs-base` 从 10px 推到 22px，字面量 44px 只在默认字号下成立，拉到顶会把 meta 行裁掉，而删除 `.gnode:hover` 的 auto 高度也一并删掉了那个退路。paint 用 `cardMetrics()` 从样式表读回两个值（`main.ts` 读内容列是同一条路），读不到才落到默认字号的兜底值；`layout()` 因此接 `CardMetrics`，行距随字号一起长。默认字号下卡片 44px、行高 56px（`LANE_H` 58 → 56）。
- **tooltip 那半句原本是假的**：`card.title` 取的是服务端 `previewOfMessage` 截出来的 label，超过 64 字符就只剩前 61 个——"悬停看整句"对长消息不成立。按用户当面的选择，把上限抬到导出的 `BRANCH_LABEL_MAX = 200`（`session-manager.ts`，`core` 再导出），非活跃走法只有这一份文本可读（它们没有消息进快照），所以这是唯一能扩的地方；`smoke-tools.ts` 新增 `exerciseBranchLabelPreview()` 断言长句整句到达、无空白超长文本仍被裁到上限。
- **字号一变就得重量**：字号不是新树，`render()` 那一次比较会跳过重画，卡片会留在旧高度。新增 `BranchView.remeasure()`（页面没打开就什么都不做，`enter()` 自会重画），由 `main.ts` 的 `saveSettings` 在 `applyAppearance()` 之后调用——分支页开着时侧边栏仍在，这条路够得着。
- **新增 `scripts/smoke-branch.ts`**（`node scripts/smoke-branch.ts`，无需密钥，已进 README 清单与 `packages/web/tsconfig.json`），29 项：拿共用 DOM shim 驱动生产的 `BranchView`，用新的 `styleMetrics` 把令牌值喂进去，断言任意长句（含六层长链）下所有卡片同一固定高度、行距就是令牌行高、每张只有一行标签、没有 `.full`/`.short` 残留、`title` 是整句；再把 `tokens.css` 当文本读回来，用小 `calc()` 算术求值器断言 `.gnode` 读的是令牌、默认字号下就是 44/56、字号拉到 22px 时卡片跟着长高且行距仍装得下它；最后断言 `remeasure()` 在有/无打开两种情况下的行为。
- **顺带修了量具的两处缺件**（`scripts/dom-shim.ts`）：`append`/`prepend`/`replaceChildren` 接受字符串子节点（真 DOM 会现造文本节点，`paintSummary` 的中文夹 `<b>` 写法本来依赖它），补 `createElementNS`、`scrollLeft`，把 `document` 从 `unknown` 收成具名的 `FakeDocument`，并新增 `styleMetrics` 让量具能给 `getComputedStyle` 喂值。
- **顺带收了一个既有的洞**：`scripts/smoke-transcript.ts` 从来没进任何 tsconfig，`npm run check` 从没看过它——这次一起进了 web 项目，那个 `unknown` 报错就是它藏着的第一处。
- 已知偏离：`scripts/dom-shim.ts` 的新增注释跟着该文件既有的中文注释走，与 AGENTS.md「源码注释用英文」不一致；该文件通体中文且文件头自称如此，改一种语言只会让同一文件更乱，故照旧。
- 验证：`npm run check`、`npm run build:web` 通过；smoke 清单里 `smoke-tools` / `smoke-sessions` / `smoke-projection` / `smoke-mux` / `smoke-backpressure` / `smoke-sidebar` / `smoke-transcript` / `smoke-settings` / `smoke-branch` 全绿，`smoke:boot` 也跑过。
