# 03 卡顿热点清单 —— 实测结果

> 结论一句话：**是 O(n) per token，而且不止一处。** 每来一个 `message_update`，`transcript.render`
> 会对**整列消息**逐条跑一遍控制补丁（每条 3 次 `querySelector`），`reduce` 会对整个 `items` 数组做一次
> `findIndex` + 整表拷贝，`renderMarkdown` 会把**整条消息**重新 `parseBlocks` 一次，而 `main.ts` 的
> `render()` 每帧都无条件重画侧边栏。历史 50 → 500 时，单帧 `transcript.render` 从 **0.65ms 涨到 3.30ms**；
> 侧边栏工作区 4 → 200 时，单次 `sidebar.render` 从 **0.61ms 涨到 30.9ms**；单条 8000 字消息的
> `renderMarkdown` 累计 **144ms**（逐帧随消息长度变慢）。

## 诚实声明：这套数字是什么，不是什么

- 测量宿主是 `scripts/smoke-sidebar.ts` 那套 `FakeNode` 手工 DOM shim 的扩展版，**不是浏览器**。
  shim 里没有布局引擎、没有合成、没有真实 `Intl`。所以**绝对毫秒数不代表真实帧时间**。
- 它度量的是**算法代价**：节点访问数、元素构造数、字符串解析、数组拷贝。这些计数在 shim 与浏览器里
  同量级；因此**同 shim 下"短 vs 长"的比值**是可靠信号，它直接回答"每帧成本是否随规模增长"。
- 驱动的是**生产代码**：`TranscriptView` / `Sidebar` / `StatusBar` / `SettingsPanel` / `Composer`
  以及 `state.ts` 的 `reduce`，逐帧复刻 `main.ts` `apply()` 的调用顺序。唯一没有直接 import 的是
  `main.ts` 里的 `apply()` / `render()` 本身（入口文件，import 即执行），按源码逐句复刻。
- 下文的 max 值常被 shim 的 GC 抖动抬高（如工具组 4 卡出现 20ms 的孤立点）；**稳健信号是 p50 与
  "每帧工作量"计数**，两者都在文中单列。

## 原始命令

```bash
# 完整规模（写进 jank-harness-output.txt）
FRAMES=2000 node .scratch/window-rework/research/jank-harness.ts \
  > .scratch/window-rework/research/jank-harness-output.txt 2>&1

# 小规模冒烟（几十秒内）
FRAMES=300 node .scratch/window-rework/research/jank-harness.ts
```

Node 用 `C:/Users/a1368/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`（类型擦除直跑 `.ts`）。
装置：`.scratch/window-rework/research/jank-harness.ts`；原始输出：`jank-harness-output.txt`。
无需服务器、无需供应商密钥、不开窗口。**本次未修改 `packages/` 下任何代码。**

---

## 1. 逐帧各阶段耗时：短历史(50) vs 长历史(500)

同一条 8000 字流式回答、同样 8000/4 = 2000 帧；唯一变量是**既有消息条数** 50 vs 500。

| 阶段（复刻 `apply()`） | 短(50) mean / p95 / max ms | 长(500) mean / p95 / max ms | 长/短 mean |
|---|---|---|---|
| reduce（`state.ts`）| 0.0074 / 0.0159 / 0.2716 | 0.0126 / 0.0239 / 0.2328 | **1.70x** |
| transcript.render | 0.6514 / 2.0738 / 4.8065 | 3.3043 / 5.1263 / 8.9323 | **5.07x** |
| sidebar.render | 1.1768 / 1.8750 / 4.7924 | 1.1779 / 1.9062 / 4.8829 | 1.00x |
| header（heading + `composer.setSelection`）| 0.0093 / 0.0176 / 0.1962 | 0.0139 / 0.0241 / 0.2015 | 1.50x |
| statusBar.render | 0.0087 / 0.0157 / 0.2553 | 0.0100 / 0.0177 / 0.2518 | 1.15x |
| renderNotices（`banners`）| 0.0009 / 0.0017 / 0.1003 | 0.0012 / 0.0018 / 0.1049 | 1.28x |
| **full（整帧合计）** | **1.8546 / 3.4736 / 6.9768** | **4.5199 / 6.9228 / 10.8787** | **2.44x** |

**每帧工作量（与时间无关的硬证据）：**

| 计数/帧 | 短(51 items) | 长(501 items) | 比值 |
|---|---|---|---|
| `querySelector` 调用次数 | 161.0 | 1511.0 | 9.4x |
| `querySelector` 走过的节点数 | 2109.5 | 12459.5 | 5.9x |
| 新建元素 | 5.7 | 5.7 | — |

—— `153 = 51×3`、`1503 = 501×3`：**`transcript.render` 对每条消息、每帧跑 3 次 `querySelector`**，
多出来的 8 次正好是侧边栏每个工作区一次。数字与代码逐条对上，不是估算。

> 绝对耗时在浏览器里会更大（真实 `querySelector` 比 shim 的 DFS 更贵）。这里的价值是**比值**：
> 对话长 10 倍，`transcript.render` 慢约 5 倍、`querySelector` 调用多 9.4 倍——**明确 O(n) per token**。

## 2. `renderMarkdown` / `parseBlocks`：成本随**当前消息长度**增长（与对话长度无关）

把 `renderMarkdown` 单独拿出来，喂同一条 8000 字回答、2000 帧：

| | mean ms | 首四分之一均值 | 末四分之一均值 | 末/首 | max ms |
|---|---|---|---|---|---|
| `parseBlocks`（`markdown.ts:105`）| 0.0685 | 0.0229 | 0.1135 | **5.0x** | 1.3814 |
| `renderMarkdown`（`markdown.ts:227`）| 0.0719 | 0.0210 | 0.1234 | **5.9x** | 1.2771 |

- 单条消息的 `renderMarkdown` 累计 = **143.9ms**。
- 首/末四分之一的文本长度比 ≈ 7x，耗时比 ≈ 5.9x —— **每帧成本 ∝ 消息当前长度**，
  于是**单条消息整体是 O(T²)**：`renderMarkdown` 每帧都 `parseBlocks(整条 text)`，哪怕只新增 4 个字符。
- 拆开看：`parseBlocks` 占了 `renderMarkdown` 的几乎全部（104/108ms 级别）；增量追加 DOM 那部分很便宜。
  **重活是"每帧把整条消息重新解析一遍"，不是 DOM 追加。**

## 3. `sidebar.render`：成本随**画出的工作区/行数**增长，且每帧都跑

（折叠态每个工作区只画 4 行，所以用"N 个工作区各 1 行"才能让屏幕上真的出现 N 行。）

| | mean ms | p50 | p95 | `querySelector`/次 |
|---|---|---|---|---|
| 4 个工作区 | 0.6096 | 0.534 | 1.0135 | 4.0 |
| 200 个工作区 | 30.8989 | 28.9936 | 49.2531 | 200.0 |
| 比值 | **50.7x** | 54.3x | 48.6x | 50x |

两处来源，都在 `sidebar.ts`：

- `groupFor`（`sidebar.ts:205-214`）**每次 render 对每个工作区** `querySelector(".workspace-current")`
  → 每帧 O(工作区数) 次 DOM 查询（`querySelector`/次 = 4 与 200 直接对应工作区数）。
- `patchRow`（`sidebar.ts:265-289`）**每行每帧**重写 `button.title`，其中 `formatDate` 走
  `toLocaleString`（`sidebar.ts:614`）——随画出的行数增长。

值得注意的是：侧边栏成本**与对话长度无关**（短/长历史那列是 1.00x），但它**每帧都在跑**
（`main.ts:344` 的 `render()` 无条件调 `renderSidebar()`），所以它是一份**恒定叠加**在每帧上的成本。

## 4. `renderTools`：输出增长时整组重建

一组卡，持续更新其中一张卡的输出（`tool_execution_update`）：

| | p50 ms | max ms | 新建元素/帧 |
|---|---|---|---|
| 组内 4 卡 | 0.0171 | 20.55（GC 抖动）| 40.0 |
| 组内 40 卡 | 0.1017 | 31.05（GC 抖动）| 400.0 |
| 比值 | **5.9x** | — | **10x** |

`renderTools`（`transcript.ts:271-291`）每帧为整组拼一个 `shape` 字符串（O(卡数)），
一旦某张卡的 `output.length` 变了就 `replaceChildren(...cards.map(renderTool))` **重建整组**——
`nodes/帧` 精确等于 `10 × 卡数`。放大到"一组几十张卡"时，这是每帧 O(卡数) 的建树。

## 5. `settings.render`：仅面板打开时跑，成本随模型行数增长

| | mean ms | p50 | 新建元素/次 |
|---|---|---|---|
| 1 个模型 | 0.0503 | 0.0423 | 56 |
| 50 个模型 | 1.1571 | 0.832 | 2359 |

面板默认关闭，`main.ts:356` 用 `if (settings.open)` 门控，所以**流式期间它基本为 0**；
一旦打开并停在"模型"页，每次 render 都会重建体（我强制让 signature 失效以模拟内容变化），
O(模型数)。**关闭状态下不是热点；打开时是一个 1ms 量级的偶发成本。**

---

## 热点清单

### 确认是热点（有实测数字）

| # | 位置 | 机制 | 数字 |
|---|---|---|---|
| H1 | `transcript.ts:69-92` 的 `render` items 循环 → `applyControls` `:170-198` | 每帧遍历**全部** items；每条消息无条件 3 次 `querySelector`（`.branch-button`/`.fork-button`/`.branch-nav`），与是否变化无关 | 51→501 items：querySelector/帧 161→1511（9.4x），qsNodes 2109→12459，transcript.render 0.65→3.30ms（5.07x） |
| H2 | `markdown.ts:227-249` → `parseBlocks` `:105` | 每帧对**整条消息文本**重新解析（即使只增 4 字） | 单条 8000 字消息累计 144ms；每帧随长度增长，首/末四分之一 0.021→0.123ms（5.9x）→ 单条 O(T²) |
| H3 | `sidebar.ts:205-214` `groupFor` | 每次 render、每个工作区一次 `querySelector` | 4→200 工作区：querySelector/次 4→200，render 0.61→30.9ms（50.7x）；且 `main.ts:344` 每帧无条件调用 |
| H4 | `sidebar.ts:265-289` `patchRow` | 每行每帧重写 `button.title`（含 `formatDate`→`toLocaleString`）| 含在 H3 的逐行增长中；短/长历史侧边栏恒为 ~1.18ms/帧（确认每帧在跑） |
| H5 | `transcript.ts:271-291` `renderTools` | 每帧拼 O(卡数) 的 `shape` 串；输出一变就**整组重建** | 组内 4→40 卡：新建元素/帧 40→400（10x），p50 0.017→0.102ms（5.9x） |
| H6 | `state.ts:413-456` `upsertMessage`（经 `reduce`）| 每帧 `items.findIndex` + `[...items]` 整表拷贝 → O(对话长度) | 50→500：reduce 0.0074→0.0126ms（1.70x）。**确为 O(n)，但绝对值小** |
| H7 | `main.ts:278-300` `apply` + `:340-365` `render` | 每帧无条件走 `renderSidebar()` + `statusBar.render()` + `renderNotices()`，与本次帧是否真的改了它们无关 | 已含在上表；statusBar 0.009–0.010ms/帧、sidebar 见 H3/H4 |

### 只是可疑（有推理，**没有**单独实测数字）

- **`transcript.render` 末尾的 `container.scrollTop = container.scrollHeight`（`transcript.ts:91`）**：
  每帧写 `scrollTop` 在真实浏览器里可能强制一次布局/回流；shim 里只是一次赋值，**没能测量**这次
  强制同步布局的代价。列为首要可疑点（最坏情况下它把上面的 DOM 写操作变成每次都要 reflow）。
- **`formatDate`/`toLocaleString` 是 H4 里的大头**：整行 patch 的总量有数字，但"其中多少来自
  `toLocaleString`"没有单独拆出来测；Node 与浏览器的 `Intl` 性能也不同。属推理。
- **DOM 节点无限增长的累积代价**：长历史 = 501 个 `<section>` 常驻 DOM。本节量的是"每帧的 JS/DOM 操作
  代价"，**没有**量真实浏览器里"节点多 → 布局/合成变慢"这一项。属未证实的结构隐患。

### 我没能测到的（明确缺口）

1. **真实浏览器的布局、合成、绘制**：shim 无布局引擎，所以 reflow/paint 与强制同步布局完全没覆盖。
2. **事件循环与 GC 的真实占用**：我用 `nodes`/`appends` 近似分配量，但没测分配频率、GC 暂停。
3. **真实 `Intl` 性能**（`toLocaleString`）在浏览器/WebView 下与 Node 的差异。
4. **Electron/WebView 层开销**，以及真实帧率（我没有用 60fps 口径测掉帧，只测了每帧算法耗时）。
5. **多工作区 + 多会话同时在线**的复合规模（我分别压了 items 与 workspaces，没有一起压到极端）。

## 给 09 的落点提示（仅排序，不含改法）

按"每帧成本 × 增长维度 × 增长幅度"排序，最该先动的是 **H1**（唯一随**对话长度**线性增长的每帧热点，
且 3 次/消息的查询随消息数乘性放大），其次 **H2**（单条消息 O(T²)，长回答越写越卡）、**H5**（工具密集
会话），再是 **H3/H4**（每帧恒定、随工作区/行数增长）。**H6/H7** 是结构性的小成本，顺手可收。
