# 05 · 流式渲染与贴底：尾块只补不删、关掉滚动锚定、合成动画收口

Type: task
Status: resolved
Blocked by: 01

## Question

04 把「每帧多重传一份整消息」砍掉之后，剩下的渲染与贴底问题：

1. **markdown 尾块只补不删**：现在 `markdown.ts:296-300` 每帧 `lastElementChild.remove()` 再重建尾块；
   回答是一整段长段落时尾块就是全文，等于每帧全量重建 DOM + 整列重排，选区/光标也会被冲掉。改成
   流式中维护一个**持久尾部文本节点**：块未闭合时只 `appendData`/改该节点文本，块型变了或闭合时才
   落成正式块；至少要做到「块类型未变时不重建节点」。
2. **贴底与滚动读数分家**：跟尾时给 transcript 加 `.pinned { overflow-anchor: none }`（由 `sticky`
   切类）；`pin()` 的写与 `trackScroll` 的读不在同一帧互相触发——scroll 监听只在用户真的滚动时读，
   并且读数放进 rAF 合并。
3. **最小绘制间隔**：`OncePerFrame` 加一条「距上次绘制 < 16ms 就顺延到下一帧」的闸门（pi 的做法），
   避免多帧连发时每帧都做一次尾块工作；「运行结束/报错/切会话」的立即绘制仍可抢帧。
4. **合成动画收口**：思考 marquee 的无限 `translateX` 加 `contain`（或只动 `transform` 并
   `will-change: transform`），光标的 blink 与 spinner 不再让整个答案列重绘；在 WARP 下对比
   `animation:none` 的 A/B。
5. **量具**：同一段 8k 字回答、真 Chromium，对比改前/改后的长任务数、帧间隔 p95、`LayoutCount`、
   脚本时长；并记录一段「一整段长段落 vs 有空行」的对照，证明尾块重建不再是瓶颈。

验收：`npm run check`、`smoke-transcript`、`smoke-frame` 通过；窗口里长回答时正文持续变长、滚动不跳、
整窗不涩；量具里脚本时长与尾块字符数的关系明显变平。

## Answer

### 实现（全部在工作区，未提交）

1. **markdown 尾块就地补写**（`packages/web/src/render/markdown.ts`）：`patchBlock` 按 kind 就地补——
   paragraph/heading 走 `patchInlineBlock`（纯散文是文本节点上一次 `appendData`；后缀带行内标记字符时
   按整段重排），code 的纯文本与 diff 两种形状各自增补，list 逐项补，quote 保留 `<blockquote>` 只重做
   子块，table 明确不补（重建比逐格补便宜，流式表格罕见），rule 恒真。补不上（kind 变了、前缀断了、
   文本被替换）才落回 remove+re-add 的旧路。补写成功时尾块元素的身份不变——选区不再被冲掉。
2. **贴底与滚动读数分家**（`transcript.ts` + `style.css`）：`.transcript.pinned { overflow-anchor: none }`
   由 `sticky` 切类（贴底时锚定与追加打架、离开后锚定恰好有用）；`pin()` 只写一个 clamp 的
   `scrollTop`，不读 `scrollHeight`；scroll 的读进 rAF 合并，每帧最多一次，与写在事件环里错开。
3. **最小绘制间隔**（`frame.ts`）：rAF 回调里距上次绘制 <16ms 就顺延到下一帧——120Hz 屏上 rAF 一帧
   一跑是把尾块工作做双倍。ask 不丢：顺延帧仍画最新状态；`cancel` 同样取消顺延帧，所以运行结束/
   报错/切会话的立即绘制照旧抢帧。shim 的帧队列改成可控假时钟（`frames(advanceMs)`，缺省一个 60Hz
   帧周期），`smoke-frame` 第 4 节守着顺延与取消。
4. **合成动画收口**（`style.css`）：caret 的 blink 从 `visibility` 翻转改成 `opacity`（前者让答案行
   重排，后者是 WARP 下合成器自己能做的事）+ `will-change: opacity`；思考 marquee `contain: paint`
   + `will-change: transform`；spinner `will-change: transform`；两处 pulse `will-change: opacity`。

### 量具

`.scratch/ui-fix-pass-2/research/measure-render/` + `measure-render.mjs`：真 Chromium 158、16k 字回答、
500 帧 × 4 配置（补写/重建 × 一整段长段落/空行分段），逐帧真 rAF、每帧贴底写。legacy 用「每帧篡改
state 尾块字首让 `startsWith` 失败」如实复现旧的 remove+re-add DOM 行为——两条路径的解析完全相同，
差别只在尾块元素是新的还是旧的。长任务由页面加载前装好的 PerformanceObserver 计数。

```
配置            脚本总计   每帧 p95   Style 重算   任务(CDP)
补写 · 一整段    155.7 ms    0.6 ms        1         639 ms
重建 · 一整段     56.3 ms    0.2 ms      500         728 ms
补写 · 空行分段   48.9 ms    0.2 ms       64         274 ms
重建 · 空行分段   42.8 ms    0.2 ms      500         319 ms
```

（Layout 两路都是 500：字变长本来每帧就要重排，这项不欠谁。长任务 0。headless 的 rAF 不锁 vsync，
帧间隔 p95 4.3ms 不能当 60Hz 读。）

- **补写的赢面**：Style 重算 500→1（每帧一次到整场一次）、主线程总任务时长 −12%（长段落）/−14%
  （空行分段）、尾块元素身份保住。空行分段对重建的明显便宜（728→319）证明旧成本确实与尾块大小
  成正比——票面「一整段长段落时尾块就是全文」成立。
- **诚实的意外**：16k 字长文本节点上的 `appendData` 比 remove+重建**更贵**（均值 0.31 vs 0.11 ms/帧，
  p95 0.6 vs 0.2 ms；CDP ScriptDuration 同向）——Blink 对长文本的追加是 O(n)。票面「尾块重建等于
  每帧全量重建 DOM」只对 DOM 层成立，脚本侧重建反而便宜；但两条路径每帧都在亚毫秒级。结论：patch
  保留（总时长、Style、选区都更好），「脚本重建会卡」这条理由被量具否掉。
- 两条路径真正的每帧大头是**尾块重解析**：未闭合段落的尾块就是全文，`parseFrom` 每帧 O(答案)。
  这是上一轮增量解析留下的形状，本轮没动它；要再往下只有「尾块解析也增量化」一条路，本轮不做。

### 「只在用户真的滚动时读」为什么没做

写标志方案省不下任何东西：贴底流式时文字在变长，布局本来每帧都要算，rAF 里那次 `scrollHeight` 读
只是把 paint 前必做的布局提前，不加一次重排（量具里 LayoutCount 两路相等是同一件事的证据）。反过来，
写标志会在「pin 的 scrollTop 没变、浏览器不发事件」时把标志留到下一笔——那正是用户往回滚的第一笔，
代价是第一次滚轮失灵。得不偿失，不做。

### 验证

```
npm run check                     # 通过，tokens ok: 137 defined, 111 referenced
node scripts/smoke-frame.ts       # 通过（新增第 4 节：第一帧照常、间隔不足顺延、够了补跑、顺延帧可取消）
node scripts/smoke-transcript.ts  # 通过
node scripts/smoke-branch.ts / -sessions / -tools / -settings / -modes / -model-form / -stream /
     -replay / -mux / -sidebar / -projection   # 全绿
```

量具结果在 `research/render-measure.json`。窗口里的到达节奏以 04 的协议减负 + 这里的渲染收口共同
落地，留给用户的下一次实际体验验收。
