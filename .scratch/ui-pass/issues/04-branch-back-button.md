# 04 诊断并修复「回到对话」两个按钮失效

Type: task
Status: resolved
Label: feature
Resolution: 2026-10-17

## Question

分支页固定标题栏上的「回到对话」/「切到这一条并回到对话」两个按钮（`branch-view.ts` 的 `this.back` → `applySelection()`）失效了。先复现诊断根因，再修。

已知线索：

- `applySelection()` 在 `this.streaming` 时直接 return——若会话状态里 streaming 卡住为真，按钮就永远没反应。
- `this.back.disabled = moving && this.streaming`——同一条线索的另一面。
- 标题栏遮挡（图2：窗口控制按钮压住工具行）也可能吃掉点击。
- `window` 级 `pointerup` 处理器与按钮的关系需要过一遍。

验收：选中别的节点后点「切到这一条并回到对话」能移动并回对话；直接点「回到对话」能回对话。

## Answer

**两个按钮失效是两件事叠在一起，而票面四条线索里只有一条是主因。** 两条都修了，都能在真窗口里定罪。

### 1. 主因：两个按钮被布局挤到窗口外面（票面线索 3 的实体，但不是「遮挡」）

不是被窗口按钮压住，是**跑到窗口右边界之外**。而 `document.body { overflow: hidden }` 把窗口外的东西裁掉，所以它看起来既不灰、也不被压住，就是点了没反应——正好是报告里的样子。

机制（真窗口逐条实测，不是推的）：

- `.header` 是 grid item，它的自动最小尺寸等于**内容**，这个下限被 `.conversation`（grid，单列 `auto`）取为列宽。`auto` 列**可以比它的 grid 容器宽**，于是列被拉到 701.4px，而 `.conversation` 本身只有 435px。
- 分支页工具行的内容里有一对**不肯收缩**的控件（缩放组 154px、「回到对话」90px），行的最小尺寸因此有下限；这个下限就是被顶上去的那个内容下限。
- 720px 窗口（`main.cjs` 的 `minWidth: 720`，就是窗口能到的最窄）实测：列 701.4px、`.branch-tools` 占 x 309–962、**`.back-button` 在 x 872–962**，`document.documentElement.scrollWidth` 986px，`elementFromPoint` 打在按钮中心返回 `null`——按钮在窗口外。
- 把 `.header { min-width: 0 }` 摘掉/装回，同一页面同一尺寸复现与消失：摘掉 → 列 701.4px、按钮 x 872–962；装回 → 列 435px、按钮 x 606–696、`elementFromPoint` 命中按钮。

修法：`.header` 加 `min-width: 0`（票面没有的那一半，**关键的一半**）；`.branch-tools` 保留 `min-width: 0`，并给 `.branch-tools .header-spacer` 显式 `flex: 1 1 0`、给缩放组和出口按钮 `flex: none`（让「选中行」先让位，与注释里写的分工一致）。宽窗口不受影响（1280px：列 995px、按钮 x 1166–1256，改动前后一致）。

**与票 12 的关系**：`12-titlebar-band.md` 动手清单第 5 条登记的是同一个溢出，并说「加 `min-width: 0` 并允许收缩（原生型 `prototype/07-titlebar.html` 里已验证这一条）」。实测结论是：**只在 `.branch-tools` 上加这一条不够**（原型里没有 `.header` 这个 grid item，所以原型上看着好了）。票 12 若要复用这条，得连 `.header` 一起。已在票 12 上补了一行注记。

### 2. 次要真 bug：`applySelection()` 开头的 `if (this.streaming) return`（票面线索 1 的实体）

这个 `return` 拦的是**两个按钮**：移 leaf 是运行中的树不能动，回对话只是换页，跟 run 没有关系，却被同一句话一起挡掉。这是真 bug，已修：只有「移动」会被在跑的一轮拒绝，且拒绝时按钮是灰的、`title` 说明原因（`paintTools` 每次重画都会改写，所以一轮结束自己就恢复）。**拒绝不写进选择行**——选择行是「选中了哪一条」的读数，而能把它改回来的下一次重画要等这一轮结束，用它换一句 `title` 已经说过的话不划算。

### 3. 已证伪 / 已排除

- **`-webkit-app-region: drag` 不会吞掉子控件的点击**。Electron 44 真窗口 + 真 `sendInputEvent` 在 https 页面验过：带 `drag` 的容器里，没标 `no-drag` 的按钮照样收到完整的 `pointerdown/mousedown/pointerup/mouseup/click`。工具行上加 `no-drag` 是照 `.header-row > *` 的规矩补上的，不是这条 bug 的解药。
- **`titleBarOverlay` 的窗口按钮不遮分支页工具行**。工具行在 y 60–88，保留区是 y 0–40，票 1.png 的读数与本次实测一致，两者不相交。这条是票 12 的账。
- **`streaming` 卡死为真的假设站不住**。`state.streaming` 每个 baseline 都从 `session.submitting` 重建（`state.ts:288`），而 `submitting` 骑在 loop 的 `isStreaming` 上、在 `agent.ts:885` 的 `finally` 里必然被清掉并 `publish()`。所以「没人再发帧」的窗口里，下一次 baseline 就会把它解开；没有任何一条路能留下一份永久的 `streaming: true`。`render()` 也确实只在 `streaming` **变化**时才重画工具行，但这一条已不需要靠它解释按钮失效。
- **浏览器里两个按钮本来是好的**（真实 `Input.dispatchMouseEvent` 走过）。所以复现条件里缺的那一环就是窗口宽度：1280px 下溢出的 219px 落在窗口外没人看见，720px 下按钮整个出界。

### 4. 会话打开的竞态（顺手修的第三条）

`openSession()` 里 `setPane("chat")` 从 `await api.read()` **之后**挪到**之前**。读一条刚起步的会话实测能到 6 秒（本 harness 下 headless 也要 1.5 秒），这段时间里点开分支页，读完那次 `setPane("chat")` 会把面板从分支页拽回对话——留下一张画在已经离开的页面上的分支页（卡片 rect 全 0、按钮不响应）。放在 `await` 之前，换页就属于「点了这一行」而不属于「读回来了」；读失败时留在原页面而不是空白面板。`openSession` 的 doc 因此从「三件事有顺序」改成四件。

### 5. 量具与验证

- `scripts/smoke-branch.ts` 新增第 4 节（22 项）。走**真实监听器路径**：viewport 上 `pointerdown` + **window** 上 `pointerup`（票面线索 4 要过的那条路），不是调私有方法。覆盖：点节点只选中、两个按钮各自的作用、有 run 时「回到对话」照样回得去且不灰、有 run 时「移动」被拒且按钮灰、按下时按钮把原因说在 `title` 上、竞态按下不移动且选择行不被冲掉、run 结束后按钮重新可用、没有树时只有出口、以及两条 CSS 下限断言。
- `scripts/dom-shim.ts`：`window` 现在真的收/派发事件（`dispatch` / `listenerCount`），并导出 `FakeElement` / `FakeHTMLElement`（量具要造一个真的能通过 `instanceof Element` 的事件目标；`asElement()` 是类型桥，运行时会被擦掉，帮不上这个忙）。`DomShim.window` 的类型从 `unknown` 收成 `FakeWindow`。
- **目视确认做了，用真窗口**：`packages/desktop/scripts/launch.mjs --workspace <dir> --remote-debugging-port=9334 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`，再经 CDP 驱动（`Input.dispatchMouseEvent` 走真事件、`Page.captureScreenshot` 截图）。1280px 与 720px（窗口最窄）、浅深两色各看过：720px 下工具行占 x 309–696、按钮 x 606–696 完全在窗口内、`elementFromPoint` 命中；点另一个节点 → 按钮变 primary 且文字变「切到这一条并回到对话」→ 按下 → 面板回对话、chip 换到新走法；直接点「回到对话」→ 回对话、不换走法；点回当前走法 → 按钮回到非 primary 的「回到对话」。
- `npm run check` 通过；README 全量 smoke 清单 18 条全绿（含 `smoke:boot` 与两个 desktop smoke；`smoke-api` 需要服务器，未跑）。
- 复现夹具与脚本：`node .scratch/ui-pass/research/fixture-session.mjs` 写 `feed0001`（一个分支点、两条走法），配合上面的 CDP 驱动即可重演上面的读数；本次其余一次性脚手架（CDP 驱动器、各步骤 JSON、Electron 侧探针、量到的截图与日志）已删。

### 6. 已知偏离

- 票面线索 3「标题栏遮挡」按字面不成立（第 3 节已证伪），但**同一行的溢出**成立且是主因——这一条算按实情改写，不算跳票。票 12 仍要立顶带：工具行虽然回到了窗口内，它和标题行现在都还在 `titleBarOverlay` 的按钮保留区下方压着（票 12 的账）。
- 顺带修了会话打开竞态（第 4 节），票面没点名它；它给出的是同一个症状（「按钮都没反应」），且不改它这次验收在窄窗口下仍会挂。
- 给被拒的「移动」加了 `title`、给工具行加了 `-webkit-app-region: no-drag`：票面没要求，但前者是「按钮看起来能按却什么都不做」这一类报告的直接解药，后者是那一行进入可拖拽 band 后本来就该有的声明。
