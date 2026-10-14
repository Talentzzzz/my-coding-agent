# 03 卡顿热点清单

Type: task
Status: resolved
Blocked by: （无）

## Question

用户原话："页面很卡。" 在动手改之前必须把热点定下来，否则优化就是瞎猜。

**做法（不需要供应商密钥）**：用 `scripts/fake-transport.ts` 造一次**高频** token 流——比如一次 run 里
几千个 `message_update`——在一个最小 DOM 宿主里驱动**生产**的 `TranscriptView`、`Sidebar`、`state.ts`
的 `reduce` + `main.ts` 的 `apply` 路径。既有的最小 DOM 手法可以抄 `scripts/smoke-sidebar.ts` 与
`scripts/smoke-projection.ts`。

记录下来：

1. **每个帧上各阶段的耗时**：reducer / `transcript.render` / `renderMarkdown` / `sidebar.render` /
   `statusBar.render` / `settings.render`。
2. **有没有哪一步的耗时随对话长度增长**（即 O(n) per token）。重点怀疑这三处，逐个证实或排除：
   - `transcript.render` 里 `renderMarkdown(turn.body, item.text, turn.blocks)` 对**整条消息**重跑 markdown；
   - `main.ts` 的 `apply()` 每次都调 `render()`，而 `render()` 里又调 `renderSidebar()`（全量重画侧边栏）；
   - `renderTools` 每帧拼一个 `shape` 字符串。
3. **结论**：给出"哪几处每帧在做重活"的清单，每处附**实测数字**（帧数、总耗时、单帧最坏值），并严格区分
   "**确认是热点**"（有数字）与"**只是可疑**"（只有推理）。

产出 `.scratch/window-rework/research/jank-profile.md`，里面要含原始命令与原始数字，好让别人能重跑。

**这一票里不要改代码。** 修法属于 09。

## Answer

**结论：是 O(n) per token，而且不止一处。** 测量装置 `.scratch/window-rework/research/jank-harness.ts`
（窄 DOM 宿主中驱动生产的 `TranscriptView`/`Sidebar`/`StatusBar`/`SettingsPanel`/`Composer` + `state.ts` 的
`reduce`，逐帧复刻 `main.ts` `apply()`）。原始输出 `research/jank-harness-output.txt`，完整报告
`research/jank-profile.md`。**未改 `packages/` 任何代码。**

命令：`FRAMES=2000 node .scratch/window-rework/research/jank-harness.ts`（用 22.22.2 node）。

关键数字（同一条 8000 字流式回答，2000 帧；唯一变量是既有历史 50 vs 500）：

- `transcript.render`：**0.65ms → 3.30ms/帧（5.07x）**；每帧 `querySelector` 调用 **161 → 1511（9.4x）**，
  正好 = `items×3` —— 它每帧对**每条消息**跑 3 次 `querySelector`（`transcript.ts:170-198`）。**头号热点。**
- `renderMarkdown`（隔离测）：每帧随**当前消息长度**增长，首/末四分之一 **0.021 → 0.123ms（5.9x）**，
  单条 8000 字消息累计 **144ms** —— 每帧 `parseBlocks(整条 text)`，单条 O(T²)（`markdown.ts:227`）。
- `sidebar.render`：**4 → 200 工作区 = 0.61 → 30.9ms（50.7x）**，`querySelector`/次 4 → 200
  （`sidebar.ts:205-214` 每个工作区每帧一次）；且 `main.ts:344` 每帧无条件调用。
- `renderTools`：组内 4 → 40 卡，**新建元素/帧 40 → 400（10x）** —— 输出一变就整组 `replaceChildren`
  （`transcript.ts:271-291`）。
- `reduce`：0.0074 → 0.0126ms（1.70x），确为 O(对话长度)（`findIndex` + 整表拷贝），但绝对值小。
- `settings.render`：面板关闭时≈0；打开且切到模型页时 1→50 模型 = 0.05 → 1.16ms/次。

**确认热点**（有数字）：H1 transcript items 循环 + applyControls 每帧 3 次 querySelector；H2 每帧
re-parse 整条消息；H3 sidebar `groupFor` 每工作区每帧 querySelector；H4 `patchRow` 每行每帧重写 title；
H5 renderTools 整组重建；H6 `upsertMessage` 的 O(n) 拷贝；H7 `apply/render` 每帧无条件重画 sidebar/statusbar。
**只是可疑**（仅推理）：`transcript.ts:91` 每帧写 `scrollTop` 可能强制布局；H4 中 `toLocaleString` 占比；
长历史常驻 DOM 的布局代价。**没能测到**：真实浏览器 layout/paint/reflow、GC 与事件循环、真实 `Intl`、
Electron 开销、真实帧率。

修法留给 09；建议优先级 H1 > H2 > H5 > H3/H4 > H6/H7。

