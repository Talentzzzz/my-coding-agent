# 07 会话：圆点、分隔线、工具一行

Type: task
Status: resolved
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

## Answer

五条全落，全部在 `packages/web` + 一处 smoke 改判，core 未动。出图
`research/shots-transcript.ts`（bootServer + 假传输 + 本机 Chromium，09 号已证实的路），
前后各两张：`shot-transcript-{before,after}.png`（整窗一轮对话）、
`shot-composer-{before,after}.png`（输入框特写）。

1. **角色行整个没了，也不留替代物。** `createTurn` 里 `turn-role`（avatar + role-name）删掉，
   非用户回合与用户回合只剩同一个 `section + body`；`labelFor` / `initialFor` 两个函数与
   `.turn-role` / `.avatar` 两条 CSS 一并清掉（确认过分支侧用的是 `BranchWay.label`，与这对函数
   无关，没删错）。轮与轮之间唯一的标记是**用户气泡下那条细分隔线**——它挂在用户回合自己的
   `::after` 上，而不是作为独立元素插在回合之间，所以 transcript 按 item 摆位的 reconcile
   一行没改。前图里调用消息与回答各有一行「智 智能体」，后图只剩气泡、分隔线、内容。

2. **正文里不再有 `[调用 read]`。** 10 号留给 07 的那一条如约收掉：`upsertMessage` 的正文路径
   加了 `withoutToolCalls` 过滤，工具调用块不再折成 `[调用 name]` 拼进 `text`——调用有自己的
   item（工具组，流式与重放共用同一个 `upsertTool` 造卡），一条只有调用的消息从此**没有正文**，
   连同 item 一起不出现。`contentToText` 本体一字未动：票面点名的三处工具输出消费
   （`tool_execution_update` 的 `partialResult`、`tool_execution_end` 的 `result`、重放的
   `toolResult`）喂进来的都是工具结果内容，其中没有调用块，正文专用的过滤不值得在工具路径上
   再走一遍。`smoke-replay.ts` 的位置断言随票改判：原来钉「组夹在调用消息与回答之间」，现在
   调用消息没有 item，改钉「组夹在**问题**与回答之间」，外加一条「call-only 消息不留正文」。

3. **工具组读作一行。** 照原型重写：卡片没有边框盒了，一行 `Read  README.md`——名字在前
   （500 重、secondary 色）、简短参数在后（mono、caption 档、弱描色），整行 tertiary 色、
   hover 才提亮到 primary；chevron 平时透明，hover 出现、open 时驻留并转向。running 用行尾一个
   琥珀脉冲点（运行中的卡不可能带 diffstat，两个 auto margin 不同时上同一条线）；diffstat 钉在
   行尾；错误卡的名字直接上错误色，展开逻辑照旧。**settled 卡不再有状态点**：原型的一行读法里
   没有它的位置——运行中由行尾脉冲点说话、错误由名字的颜色说话，一个恒绿的点在一行里什么都
   不说（评审指出答案漏了交代这条取舍，补上）。展开后的内容（`tool-output` 与 `.diff`）是
   行下的缩进块，缩进 22px = chevron 12 + gap 10，读作这一行的延续。
   **参数里没有可用路径时显示工具名 alone**——`previewOf` 认不得的参数不造占位符，展开里
   自然有全部内容。

4. **输入框。** ① 工作目录芯片从「空会话才显示的 hero 行」改为**常驻** composer 卡上方最左：
   `hero-row` 更名 `composer-head`，按 items 是否为空隐藏它的那段 render 逻辑整块删除——它的
   位置由「它盖着的输入框」决定，不由 transcript 的状态决定，01 ⑦ 的语义（`POST /api/sessions`
   的 cwd、新会话落点、侧栏「当前」三处同源）原样没动。② 模型选择器连同思考档位与会话设置的
   齿轮整座推到**右下角**（seat `margin-left: auto`），发送键在最右。③ 两行提示字删掉：
   textarea 的 placeholder 属性与 `.composer-hint` 元素（连同 `setStreaming` 里换提示文案的
   分支）一并清除。④ 字号：05 已经拍过 textarea 骑 **body 档**（15/25，滑杆值直发），07 不推翻。

5. **状态行零改动。** 核对过 `statusbar.ts` 本就只渲染 `total` / `cache` / `context` 三个字段，
   一行没动。

**验证**：`npm run check` 绿（token 审计 122 定义 / 100 引用）；`smoke-replay` / `smoke-stream` /
`smoke-tools` / `smoke-sessions` / `smoke-models` / `smoke-mux` 全绿。`smoke-api` 在干净 HEAD 上
也同样失败（「the mux connection failed」，与本票无关，先行存在，值得单独查）。

**出图顺带撞出一个未修的边角**：transcript 的消息 item 以 `role:timestamp` 为身份，而
`fakeAssistantMessage` 的时间戳默认取 `Date.now()`——两条 scripted 回答落在同一毫秒时重放会合成
一个 item（出图脚本已改为显式时间戳绕开）。真实路径里两次消息隔着一整轮工具执行，撞不撞得到
不好说；要是哪天 transcript 里两条消息粘成一条，先查这里。
