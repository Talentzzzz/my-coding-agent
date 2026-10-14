# 09 让"过程"实时可见

Type: task
Status: resolved
Blocked by: 02, 03

## Question

用户的两句抱怨落在这里："**思考不能合并和展开切换**"、"**页面很卡**"。

**动手前必须先读两个依赖的答案**：02（思考内容在哪一步丢的）与 03（热点在哪）。不要绕过它们凭感觉改。

**要做的：**

1. **思考块**：能合并显示、能展开 / 折叠切换。
   **具体做法完全由 02 的结论决定**——
   - 如果缺口在服务端（压根没发 thinking），这一票就不止是前端，要连着 `packages/ai` 或 `projection.ts`
     一起动；
   - 如果只是客户端没画，就是 `state.ts` + `render/transcript.ts` 的小改。
   两条路的成本差一个数量级，所以**先确认再动手**。

2. **按 03 的热点清单修卡顿**，逐条给出"改前 / 改后的实测数字"。数字用 03 那套脚本重跑，保证可比。
   修法要守住既有设计：transcript 是热路径，一次 `message_update` 的成本必须与**增量**成正比而不是与
   "对话至今的长度"成正比（`transcript.ts` 开头的注释就是这么写的——看清它原本的意图，别把它改坏）。

3. **工具过程的"逐步展开"**：确认工具卡片在运行**中**就出现、输出增量刷新。
   `renderTools`（`transcript.ts:271-291`）用的是 `shape` 字符串做重建键，理论上已经支持——**确认它真的
   在真窗口里动起来**，并修掉不动的部分。

4. 跑 `npm run check` + `smoke-stream.ts` / `smoke-sidebar.ts` / `smoke-session.ts`。

**答案里带数字**：哪几处每帧在做重活、改完单帧耗时降了多少、以及思考块最后是从哪一层来的。

## Comments

**02 号追加（配合 01 的思考块外观规格，把范围钉死）。** 结论不变——**仍只改 `packages/web`**——但落地时有两处必须处理，否则"流式思考"这个态根本出不来：

1. `packages/web/src/state.ts:435`：现状 `if (text.length === 0) return items;` 会把"只有思考、还没正文"的消息**整条丢掉**。一旦把 thinking 从正文分流出去，流式早期 `text` 就是空的 → item 被丢弃 → **收起的那一行永远无法先于正文出现**。必须让"thinking 非空"的 item 放行。
2. `packages/web/src/state.ts:240-247`：reducer 只取了 `event.message`，把 `event.assistantMessageEvent` 丢了。思考**文本**的推进不依赖它（`message_update` 每次带的是累计全量），但"**思考是否仍在流式**"要靠它按 `thinking_start` / `thinking_end` 维护——否则就只能用消息级的 `item.streaming`，会在"思考已停、正文仍在流"的那一段误显示流式态。

**建议的字段形状**（已绑现状数据形状，附录在 `research/thinking-path.md`）：`Item` 的消息支新增
`thinking?: { text: string; redacted?: boolean; running: boolean }`。`text` 就是 `ThinkingContent.thinking`
的 Markdown 原文（供应商侧逐段拼接、保留换行，`anthropic-messages.ts:575`）；`redacted_thinking` 与普通
思考**是同一块形状**（`anthropic-messages.ts:536-543`），同一个字段旁挂一个 `redacted` 布尔位即可。

抽取放在 `upsertMessage` 的**调用点**做，**不要改 `contentToText`**——它被工具输出复用了（`state.ts:262,272`）。

**`redacted` 不需要任何特殊视觉分支。** `redacted_thinking` 在供应商侧已经被归一成**同一个思考块形状**
（`{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true }`，`anthropic-messages.ts:536-543`），
所以外观上它照样是"一行「思考」+ 摘要"，09 只需把这个布尔位带在同一个字段上。这一条已由 01（只管外观）
与 02（只管数据）双向确认，两边无异议。

即 09 的范围精确化为：`state.ts`（新增字段 + 在 `upsertMessage` 分流 thinking + 解上面两个坑）+
`render/transcript.ts`（收起 / 展开 DOM）+ `style.css` / `tokens.css`。仍不涉及供应商 / agent / server。

**03 号的热点清单已就位**（细节与原始数字见 `../research/jank-profile.md`，装置是 `../research/jank-harness.ts`，
重跑命令 `FRAMES=2000 node .scratch/window-rework/research/jank-harness.ts`）。**按这条顺序修**：

| 序 | 热点 | 实测 | 位置 |
|---|---|---|---|
| H1 | `transcript.render` 每帧对**每条消息**跑 3 次 `querySelector` | 0.65 → 3.30 ms/帧（历史 50 → 500 条）；`querySelector` 调用 161 → 1511 = `items × 3` | `render/transcript.ts:170-198`（`applyControls`） |
| H2 | `renderMarkdown` 每帧重解析**整条**消息 | 单条 8000 字累计 144 ms，O(T²) | `render/markdown.ts:227`（`parseBlocks`） |
| H5 | `renderTools` 输出一变就整组 `replaceChildren` | 4 → 40 卡时新建元素/帧 40 → 400 | `render/transcript.ts:271-291` |
| H3 | `sidebar.render` 每个工作区每帧一次 `querySelector` | 工作区 4 → 200 时 0.61 → 30.9 ms | `render/sidebar.ts:205-214` |
| H4 | `patchRow` 每行每帧重写 title（含 `toLocaleString`） | 有整行数字，未拆出 `formatDate` 占比 | `render/sidebar.ts` |
| H6 | `upsertMessage` 的 O(n) 拷贝 | `reduce` 0.0074 → 0.0126 ms | `state.ts:413-456` |
| H7 | `apply`/`render` 每帧**无条件**重画 sidebar + statusbar | — | `main.ts:344` |

修完**必须用同一套装置给出改前 / 改后的数字**，否则这一票不算完成。

03 明确**没能**测到的（别拿它当已验证）：真实浏览器的 layout/paint/reflow、GC 与事件循环占用、真实 `Intl`
性能、Electron 层开销、真实帧率。其中一条**可疑但未证实**值得顺手看一眼：`transcript.ts:91` 每帧写
`container.scrollTop = scrollHeight`，在真实浏览器里可能强制 reflow。

## Answer

**结论：三件事全部落地，改动全在 `packages/web`（外加 `SessionRows` 一个版本号）。思考块最后是从消息的 `content` 数组里的 `thinking` 块来的**——02 已证供应商 → agent → server 原样带通，本票只在 `upsertMessage` 的调用点把它从正文里分流出来，`contentToText` 一字未动（工具输出路径照旧折进文本）。同一套装置（`research/jank-harness.ts`，FRAMES=2000，改前数字即 03 的 `jank-harness-output.txt`）重跑，**整帧（500 条历史）4.52 → 0.110 ms/帧（41x）**；改后完整输出 `research/jank-harness-output-after.txt`。

### 1. 思考块：合并显示、可展开/折叠

- **数据**（`state.ts`）：`Item` 消息支新增 `thinking?: { text; redacted?; running }`，形状即 02 附录建议的。`thinkingOf()` 从 `content` 分流思考块（按序 `"\n\n"` 连接，`redacted` 落同一字段的布尔位）；`withoutThinking()` 把思考从正文路径剔除，**正文不再含 `[思考] …`**。抽取在 `upsertMessage` 里做，`contentToText` 未动。
- **02 点名的两个坑都解了**：
  1. 早退 `text.length === 0` 现在放行 `thinking` 非空的消息——"只有思考、还没正文"的收起行先于正文出现；
  2. reducer 透传 `event.assistantMessageEvent?.type`（可选链是故意的：wire 类型必填，但一个坏帧不该掀翻整个窗口），`running` 按 `thinking_start/delta` 置真——`thinking_end` 与 `text_*` 帧自然落回假，"思考已停、正文仍在流"时不再误显流式态。
- **渲染**（`transcript.ts`）：思考行是 `<details class="reasoning">`，summary = 图标 + 「思考」 + 首行预览；**收起时正文 Markdown 完全不解析**（只在 open 时 `paintReasoning`），所以一条很长的收起思考对流式零成本；`running` 是一个 class。折叠状态归 `<details>` 原生管，视图不记。`redacted_thinking` 供应商侧已归一成同一块形状，无特殊视觉分支。
- **摘要行按 01 的 §6**：完成后取思考的**首行**；流式中取**最近完成段落的首行**（`reasoningPreviewOf`）——还在写的尾段不进摘要，避免摘要每个 token 都重写。与参考实现的偏差（有意，且只在样式层）：流式态用 summary 呼吸动画（token 化的 `pulse`）替代参考的右侧渐隐遮罩/TextShimmer；展开态的 sticky 标题行与「运行中」无障碍文本未做，如实留缺口。
- **样式**（`style.css`）：`reasoning` 一节只用既有 token，`npm run check` 的 token 审计通过（104 defined / 81 referenced）。
- **重载一致**：baseline → `itemsFromSnapshot` → 同一个 `upsertMessage`，历史消息的思考同样可折叠（02 推断④就此坐实）。

### 2. 按 03 的热点清单修卡顿（同一装置重跑，改前 / 改后）

| 序 | 热点 | 改前（03，FRAMES=2000） | 改后 | 修法 |
|---|---|---|---|---|
| H1 | 每条消息每帧 3 次 `querySelector` | 500 条历史：**1511 次/帧**，transcript.render **3.30 ms/帧** | **0 次/帧**，**0.107 ms/帧** | 控件节点建时存引用（`BranchControls`），render 不再搜索；再加 identity 快路径——reducer 只重建变化的那条 item，未变的每帧只付一次 `===` |
| H2 | 每帧重解析整条消息 | 单条 8000 字累计 **144 ms**，mean 0.072 ms/帧 | **28.6 ms**，mean 0.014 ms/帧（**5x**） | `renderMarkdown` 带状态：settled 块保留，尾块按**字符偏移**切片重析（`MarkdownState.tailOffset`）——每帧成本 ∝ 还在写的那个块，不再 ∝ 全文；每帧只剩 `startsWith` 前缀校验是 O(T)（native memcmp，换安全） |
| H5 | 工具组输出一变整组重建 | 40 卡 **400 新建元素/帧** | **11.3/帧**（只重建变化的卡） | 组内逐卡 shape 对账 + `place()` 就位；读者打开的 `<details>` 不再被整组 `replaceChildren` 冲掉 |
| H3 | 每工作区每帧一次 `querySelector` | 200 工作区：**qs 200/次**，**30.9 ms** | **qs 0**，**0.23 ms**（**138x**） | 「当前」标记存进 `DrawnNode`（`head`/`mark` 引用），换工作区是移动节点不是搜索 |
| H4 | 每行每帧重写 title（含 `toLocaleString`） | 含在 H3 的逐行成本里 | tooltip 缓存进 `RowParts`（变了才写）；`formatDate` 每个创建时间戳只算一次；`relativeTime` 走 `Intl` 的月份-日期分支按时间戳缓存（该标签与"现在"无关） | 每帧每行的 Intl 调用归零 |
| H7 | 每帧无条件重画 sidebar + statusbar + 通知区 | sidebar **1.18 ms/帧** 恒定叠加 | 流式帧 **0.0005 ms** | `render()` 逐段门控：sidebar 看 `rows.version/followed/currentWorkspace/collapsed/channel`（`SessionRows` 每次变更自增 version），statusbar 看 usage 引用，通知区看 models/approvals 引用，标题看值；`apply()` 里 approvals 的单独重画并入通知区（本来就是重复画） |
| H6 | `upsertMessage` O(n) 拷贝 | reduce 0.0126 ms | **0.0015 ms** | `indexOfMessage` 尾优先（流式目标几乎总是最后一条）；整表拷贝保留（状态不可变的既有设计，注释里写明了为什么） |
| — | 整帧合计 | 短(50) 1.85 / 长(500) **4.52** ms/帧 | 0.026 / **0.110** ms/帧 | — |

**诚实边界**（03 没测到的仍然没测，别当已验证）：
- transcript.render 在 500 条历史下仍有 ~0.11 ms/帧的**线性走查**（每条 1 次 Map.get + 1 次 `===` + `place()` 一次比较）——**DOM 工作已是 O(delta)**，但走查本身仍 O(items)；要归零得让 reducer 把"动了谁"带给视图，是状态形状的改动，本票没做。
- markdown 的 `startsWith` 校验每帧 O(T)（native 字节比较，8 KB 量级 ≈ 亚微秒）。
- `transcript.ts` 末尾的 `scrollTop` 赋值**未动**（仍只在 sticky 时执行）；真实浏览器的强制 reflow 依旧测不到。
- shim 测不到的（layout/paint/reflow、GC、真实 `Intl`、Electron 开销、真实帧率）依旧测不到；本表只覆盖算法代价，可靠的信号是**同装置下的比值**。

### 3. 工具过程的逐步展开

确认在跑：`tool_execution_start` 一到就建卡（`running`，显示"运行中…"，`<details>` 默认展开），`tool_execution_update` 逐帧刷新输出，`renderTools` 的逐卡 shape 对账保证**只有输出变了的那张卡被重建**——装置的 `toolsScenario`（4 卡/40 卡，持续更新一张卡的输出）与 `smoke-tools`/`smoke-mux-live` 覆盖；逐卡重建同时保住了读者已展开的其它卡。

**真窗口验证**（不再只是 shim）：`research/live-window.ts`（bootServer 服务生产 bundle + 脚本化 transport：思考→真 read 工具→再思考→正文）+ `research/drive-window.ts`（本机缓存的真 Chromium 打开页面、真输入框发一句话、流式期间每 300ms 采样 DOM）。实测序列（截断自驱动器输出，截图 `research/streaming.png` / `expanded.png` / `settled.png`）：

- `t=0.6s`：**正文还是空的，收起的思考行已经出现**（`reasoning=1, tools=0`）——02 的坑 1 在真窗口成立；
- 流式中摘要随**最近完成段落**推进：`先想一下要读哪个文件…` → `工作区里应该有 note.txt…` → `工具读完了，两行都在`（思考结束的帧正确回落到首行）；
- `t=2.1s`：`read` 的工具卡带着输出出现在记录里（`tools=1`）；running 态没有被采样到——本机 read 毫秒级完成，运行中的渐显只在 shim 装置里可观察（toolsScenario 证实该状态类确实被设置）；
- 点击 summary 展开：`open=true`，展开体渲染完整思考 Markdown（截图 `expanded.png`）。

诚实说明：这是**真浏览器 + 生产 bundle + 真服务器**，但不是 Electron 外壳本身（外壳只是同一 bundle 的另一层壳）；`[调用 read]` 这类占位文本出现在消息正文里是 `contentToText` 的既有行为，不属本票。

### 验证

- `npm run check`：通过（tsc ×4 + `tokens ok: 104 defined, 81 referenced`）。
- `scripts/smoke-stream.ts` / `smoke-sidebar.ts` / `smoke-session.ts` / `smoke-tools.ts`：全绿。
- `research/transcript-order-harness.ts`（05 的排序断言）：绿——identity 快路径没有破坏"按 items 序就位"。
- 真窗口：`research/live-window.ts` + `research/drive-window.ts`（真 Chromium + 生产 bundle + 脚本 transport），见第 3 节。
- 改后完整数字：`research/jank-harness-output-after.txt`（同装置、同参数，可与 03 的 `jank-harness-output.txt` 逐项对照）。

### 代码复核结论（两轴）

- **规范轴**：无硬违反（tab/双引号/分号、无 `any`、`.ts` 导入、注释英文、样式全 token）。6 处判断题级坏味道，已采纳的：`renderTools` 复用 `place()` 的放置循环；未采纳的：`thinkingOf`/`withoutThinking` 共用谓词（两处、形状各异，合并反而糊）、`main.ts` 六个门控变量捆一个对象（各自语义不同，就地成对读写）、`phase?: string` 换类型（wire 上就是字符串联合）。`dateLabels` 无界增长有界于"每条旧行一条"，注释已声明。
- **规格轴**：H6 的整表拷贝保留（状态不可变的既有设计，03 自己标注"绝对值小"）；identity 快路径与逐段门控是"成本 ∝ 增量"的落实；外观偏差已在上文声明。
