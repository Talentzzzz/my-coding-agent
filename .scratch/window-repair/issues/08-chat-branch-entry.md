# 8 「当前分支」永远可见（不建页签）

Type: task
Status: resolved
Blocked by:

## Question

用户 2026-10-16 报的是「**对话 和 分支 的选项还是没有出现**」。查证之后先纠正一处前提：

- **那两个页签从来没有在真客户端里存在过。** `packages/web/src` 上 `git log -S` / grep 全空；它只活在
  一次性原型 `.scratch/window-polish/prototype/index.html:517-521`，而且 `:244` 明写第五轮把它拆掉了。
  今天仅剩的入口是会话列固定头里的「当前分支」chip（`main.ts:147-152`）。

**决定（用户 2026-10-16，已澄清"就按原来的吧"的歧义）：不建那两个页签。** 所以 13 号"拆掉两个页签、
换成 chip"的那一半**维持有效**，本票**不**重开它。

**被推翻的是 09 号**：它定的是"≥2 条走法才渲染 chip，单走法时整块收掉"，而用户报的病正是
**单走法的会话里什么都没有**。所以本票重开 09 号的**可见性那一半**。

**要做的，以及一个不能只翻 `hidden` 的坑：**

1. 今天 `main.ts:874` 是 `branchChip.hidden = tree === undefined;`，而
   `buildBranchTree`（`state.ts:131-133`）在 `branchPoints.length === 0` 时**直接返回 `undefined`**
   ——也就是说**单走法下根本没有 `tree` 对象**。所以"永远可见"不是把那行删掉就行：得先有一个**没有
   树也能读的形态**。要定：
   - 单走法时 chip 读作什么（今天它拼的是 `fork 图标 + 「当前分支」 + 短 id + 那条走法的摘要`
     `main.ts:150` 与 `:876-877`，而短 id 与摘要都来自 `tree`）；
   - 点它进哪儿（`setPane("branch")` 会落在 `branch-view.ts:216` 的空态上，那句文案是"这条会话还没有
     分支。对一条用户消息右键选「从此分支」，再发一条消息，这里就会长出第二条走法。"——**这句
     正好是单走法用户需要的引导**，确认它读得通、位置对）。
2. **重画门控要跟着改**：`main.ts:867-870` 的 `branchSig` 在 `tree === undefined` 时是 `"none"`，
   单走法下永远不重画——可见性变了这个签名必须能区分。
3. **CSS 与它的理由要一起改**：`style.css:668-674` 现在写着"disappears whole when the conversation has
   fewer than two ways, where 'branching' names nothing"——那条理由被用户推翻了，注释与规则一起改。
4. **顺带定一个矛盾**：`main.ts:143-145` 的注释声称"其他门也一并隐藏"，但**是假的**——右键用户消息 →
   「查看分支图」（`main.ts:1307`）**没有任何分支点门槛**，单走法也能进分支页。chip 永远可见之后，
   这扇门是**冗余了要收掉**，还是**保留成第二条路**？按"一个入口最好只有一处"的既有取向判（09 号当时
   就是按这个把常驻按钮拆掉的）。

改完跑 `npm run check` 与 `smoke-sidebar`；出图走
`.scratch/window-rework/research/shots.ts` 那套（`desktop:screenshot` 在本机必崩）。

## Answer

2026-10-16，commit `a62a73c`（"The branch chip stands on single-way sessions too"）。

1. **chip 永远可见**：`branchChip.hidden = true`（初始）与渲染里的 `hidden = tree === undefined`
   都删了。单走法形态 = fork 图标 + 「当前分支」，短 id 与走法摘要清空（它们本就来自 `tree`）。
   点击照旧落 `setPane("branch")`，分支页空态那句引导文案未动、位置确认合适。
2. **重画门控**：`branchSig` 保留 `"none"` 作为单走法签名——它与任何树签名可区分，树与 `"none"`
   之间任何移动都会改变签名触发重画，chip 的内容跟着签名走，不会卡死。
3. **CSS**：`style.css` 的 branch-chip 块注释连同被推翻的理由一起重写；规则体本身不含隐藏逻辑
   （隐藏一直由 JS `hidden` 控制），无需改。
4. **冗余入口收掉**：按「一个入口最好只有一处」，右键菜单里的「查看分支图」删除，chip 成为唯一
   门；`openUserMenu` 顺带加了空菜单守卫——流式期间右键用户消息不再弹任何菜单（旧行为是弹出仅含
   「查看分支图」的菜单，该入口已不存在）。

验证：`npm run check` 与 `smoke-sidebar` 全过；code-review（standards + spec 双轴）无硬违规，
仅修掉一句过时注释表述。未出图（`shots.ts` 那套留给视觉确认时再跑）。
