# 07 会话：圆点、分隔线、工具一行

Type: task
Status: open
Blocked by: 01, 04

## Question

照 01 的原型改 `packages/web/src/render/transcript.ts` + `state.ts` + `style.css` + `composer.ts`。

要做的：

1. **去掉「智能体」这一行，而且不留替代物**（01 的 ⑥，第二轮反馈把初版的"每轮一个圆点"也否了）。
   `createTurn` 里的 `turn-role`（avatar + role-name）整个删掉，**并且不要在每一轮加任何标记**
   （用户的原话是"去掉每一轮那个点"）。改完之后的形状是：用户消息一条、**下面一条细分隔线**、
   然后就是内容。`initialFor()` / `labelFor()` / `.turn-role` / `.avatar` / `.role-name` 一并清理
   ——`labelFor` 还被分支那边用着（`labelOf`），别删错。
2. **正文里不再有 `[调用 read]`**：`state.ts` 的 `contentToText` 把工具块折成 `[调用 name]` 前缀
   拼进 `text`（`state.ts:662`），这是**正文丑**的直接来源。工具块改走它自己的
   `{ kind: "tools", cards }` item（那条路已经存在），`contentToText` 只留文本块。
   **注意两件事**：
   - `contentToText` 被工具输出复用了（前一个 effort 的 09 号明确点过 `state.ts:262,272`）——
     改之前先确认那两处不受影响，受影响就补一个只给正文用的变体；
   - 10 号修的是同一条链的**另一端**（重放时工具块压根没被还原成 tools item，`state.ts:418-424`），
     两票落在同一段代码上，**先读 03 的答案**（`../research/replay-tools.md`）再动手，别各修一次。
3. **工具组读作一行**：`renderTool`（`transcript.ts:535`）现在的 summary 是"chevron + 状态点 +
   工具名 + 参数预览"，要改成 01 定的读法：**名字在前、简短路径在后**、整行弱描色、hover 才提亮，
   点开才展开内容。一次工具调用读作 `Read  README.md`，参数里没有可用路径时显示什么要说清。
4. **输入框**：
   - **工作目录芯片搬到输入框顶部的最左边**（01 的 ⑦）：它现在是会话头顶一行（`transcript` 上方的
     `chip-row`），要挪到 composer 卡片**上方那一行**的最左边。芯片原来的三个读数（hero 芯片、
     左上角"新会话"、侧栏"当前"标记）语义不变，变的只是它画在哪；
   - 模型选择器从卡片**左下角挪到右下角**（"选模型的放在输入框右边"）；
   - 去掉那两行提示字（`composer.ts` 的占位文案与键盘提示，见 `../reference/02-hero-and-composer.png`）；
   - 输入框的尺寸按 04 的字号决定。
5. **状态行不加东西**（01 的 ⑪）：只有 `total` / `cache` / `context` 三个字段，别加"几轮几步"这一类。

`npm run check` + `scripts/smoke-stream.ts` / `smoke-tools.ts` 要绿。**答案里要看图**：
用 `.scratch/window-rework/research/shots.ts` 那套出前后两张，放进 `../research/`。
