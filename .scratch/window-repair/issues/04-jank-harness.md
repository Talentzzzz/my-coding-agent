# 4 修好卡顿量具，并给「切换会话」一条端到端测量

Type: task
Status: resolved
Blocked by:

## Question

`.scratch/window-rework/research/jank-harness.ts`（656 行，`064e34d` 加的）**今天跑不起来**：

    $ FRAMES=200 node .scratch/window-rework/research/jank-harness.ts
    TypeError: this.list.contains is not a function
        at Sidebar.ensureHeading (packages/web/src/render/sidebar.ts:312:18)
    [exit code: 1]

`FakeNode` shim 实现了 `prepend` / `replaceChildren` / `insertBefore` / `classList.contains`，**没有
`Node.contains`**；而 `sidebar.ts:312` 用它，那一行来自 `482673a`——比量具产出数字的 `064e34d`
**更新**。所以自 `482673a` 起这把尺子就废了，H6 之后的所有结论都是**读代码读出来的，从没测过**。

两件事：

1. **让量具重新跑起来。** 大概率就是一个 `contains`，但缺失的**全部** DOM 面要一次补齐——`411475f`、
   `ce1a589`、`077a7f4`、`55b207d`、`482673a` 都在 `064e34d` 之后动过 sidebar / transcript，别只补到
   能跑，要补到**量具测的东西和今天的产品代码对得上**。
2. **给"切换会话"补一条场景。** 现在**没有任何量具驱动 `openSession` 端到端**，所以"切换会话会卡一下"
   的墙钟时间从来没被拆开过：两次 HTTP 往返、快照重放（`itemsFromSnapshot`）、每条消息的
   `renderMarkdown` 各占多少，全是未知。**05 号要照这条测量动手。**

诚实限度照抄老票：shim 量出来的**绝对毫秒不是真实帧时间**，可靠的信号是**同一把尺子下短 vs 长的比值**。
Node 版本也变了（老数字出自 22.22.2，本机 24.15.0），所以**老数字不能直接比**——要么同版本重跑，要么
只比比值。

## Answer

量具修好了，而且**两条路各自量了一遍、互相印证**：`node .scratch/window-rework/research/jank-harness.ts`
退出码 0，输出落在 `research/jank-harness-output-repair.txt`。

### 一、它为什么坏，以及"只补一个 `contains`"为什么不够

票面猜的那个 `contains` 是对的，但它只是**第一个**缺件。补上之后一个接一个：老 shim 与今天的产品代码
之间隔了 `411475f`、`ce1a589`、`077a7f4`、`482673a`、`e42fdf7`、`d44e5d6`、`e26408a`、`caa373c` 八次
改动。真正的问题不是"缺了几个成员"，而是**同一个 shim 被两份代码各抄了一遍**：
`scripts/smoke-sidebar.ts` 里那份有 `contains`，量具里那份没有，于是 sidebar 的 smoke 一直是绿的、量具
从 `482673a` 那天起就废了。

所以形状是**一份 shim**：新增 `research/dom-shim.ts`，`jank-harness.ts` 从它 import。补齐的 DOM 面按
**今天产品代码实际碰到的**算（`transcript` / `sidebar` / `statusbar` / `settings` / `session-settings` /
`composer` / `menu` / `markdown` / `diff` / `dom` / `main`），逐条列在这里，因为它们就是"对得上今天"
这句话的内容：

- **缺了会直接抛的**：`Node.contains`、多参 `prepend`、`replaceWith`、`closest`、`matches`、
  `querySelector` 的 `[attr="v"]` 组合、`focus`/`select`/`blur`、`setPointerCapture`、
  `getBoundingClientRect`、`appendChild` 之外的 `attributes` 读写、`listenerCount`。
- **`classList` 是**活**的**：老 shim 的 `add`/`remove` 改的是一个马上被丢掉的 `Set`，`className` 纹丝
  不动。这不只是"少一个方法"——它让"拖宽时加 `dragging`"这类行为在量具里从来没生效过，量到的东西和
  产品代码不是一回事。现在 `add`/`remove`/`toggle` 都写回 `className`。
- **`contains` 之类不再靠"记得补"**：`installDom()` 默认**严格模式**——代码读一个没实现的 DOM 成员当场
  抛，指名道姓地说是哪个标签上的哪个成员。量具今天跑得完，就等于今天要的 DOM 面齐了。`DOM_SHIM_LAX=1`
  可以关掉它。
- **一个只有全量跑才会踩到的坑**：老 shim 把每个创建过的节点存进一张表供 `getElementById` 查——于是被
  丢掉的整棵 DOM 永远回收不了。第一次全量跑（2000 帧 + 12 次切换 × 5 场景）在切换那一段
  `FATAL ERROR: Ineffective mark-compacts … JavaScript heap out of memory`（4 GB）。改成从页面根往下
  走之后正常。**这个崩法本身是旧结构的后果，不是量具在测产品代码。**

### 二、量具测的折叠顺序也对不上今天

`main.ts` 的 `apply()` / `render()` 自老副本以来动过，逐条对正：

- 老副本每帧**画两遍状态行**（`apply()` 里一次、`render()` 里又一次，第二个门形同虚设）；今天只画一次。
- 老副本的左栏签名是 `${version}|${activeSessionId}|${currentWorkspace}|${collapsed}|${channel}`；今天
  `renderSidebar()` 看的是 `${rows.version}|${followed}|${目录}|${pickedWorkspace}|${collapsed}|${channel}`
  （`main.ts:708`）。**两者的差别在切换会话时是"要不要重画整列"**，照抄错的那个会量出"左栏不重画"。
- 补上今天 `renderFrame` 里逐段门控的顺序（reachable → 输入框/排队 → 错误条 → 状态行 → 左栏 → 标题与
  模型位 → 通知区）。

**量具的边界写进了源码注释**：`render()` 里还有三笔没搬进来——`branchView.render()`、工作目录芯片两行、
两个面板（只在 `open` 时跑）。三者都由 baseline 的稀有字段驱动、与消息**条数**无关，所以流式那张表不受
影响；切换会话那张表因此少了它们那一点。

### 三、切换会话：端到端，三笔账拆开了

新场景 `switchScenario` 走的是 `openSession()`（`main.ts:1047`）那条路：真 `fetch` + 真 JSON 文本
（假传输层返回 `JSON.stringify` 的字符串，让生产的 `SessionApi` 自己 `JSON.parse`——要是直接给对象，
"把 n 条消息的 JSON 解析成对象"这笔账就凭空消失了）→ `reduce(baseline)` → 首次绘制 → 第二笔往返
`listWorkspaces`。真窗口里两段 `await` 之间的东西全在主线程同步跑完，用户感觉到的"顿一下"就是它。

`FRAMES=2000`、每场景采样 10 次（另 3 次热身丢弃），中位数（ms）：

| 场景（历史×每条字数） | read | refresh | reduce | paint | 其中 md | **sync** |
| --- | --- | --- | --- | --- | --- | --- |
| 50×400 | 0.12 | 0.19 | 0.08 | 1.77 | 1.02 | **2.15** |
| 500×400 | 1.07 | 0.21 | 1.29 | 15.18 | 15.82 | **17.79** |
| 50×4000 | 0.76 | 0.18 | 0.05 | 10.52 | 12.10 | **11.59** |
| 500×4000 | 8.79 | 0.29 | 2.70 | 168.13 | 166.47 | **194.06** |
| 500×400（新窗口对照） | 0.90 | 0.26 | 1.28 | 15.24 | 15.53 | **17.57** |

05 号要照这张表动手，四条读法写在这里：

1. **顿的不是那两次往返。** `read` 是这条路上唯一随规模线性涨的"网络侧"代价（500×4000 时 2.1 MB 的
   JSON，客户端解析约 8.8 ms），而 `refresh`（那第二笔往返）**0.2 ms 上下，与规模无关**——它是列表，
   不随对话长度变。**所以"第二次没有效果的往返"值多少钱，这张表说得很清楚：同步时间里它占 1% 上下。**
   （真窗口里还要加上服务器响应时间，shim 里量不到，这一点在输出里写明。）
2. **`reduce` 不是主角。** 快照重放随条数涨（0.08 → 2.70 ms），但它是 `paint` 的一个零头。
3. **`paint` 就是全部。** 500×4000 时 168 ms / 194 ms = 87%；而且它随规模涨得比 `reduce` 还快
   （95x vs 39x，同一个 10x×10x 的规模变化）。
4. **`paint` 里几乎全是 `renderMarkdown`。** 逐条重画一遍量的那一列（`其中md`）在长消息一侧已经与
   `paint` 同量级：500×4000 是 166.5 / 168.1 ms。**"每条消息的 renderMarkdown 各占多少"的答案是
   "几乎全部"**——而它随**总字符数**涨：50×4000（20 万字符）与 500×400（20 万字符）的总字数一样、
   `其中md` 也一样（12.1 / 15.8 ms），**与条数无关**。

第 4 条的量法有偏差（两条路各跑各的 JIT，短消息一侧 `md` 能比 `sync` 还大，输出里按"100% 附近读作
基本全是它"标注），所以另加了一把独立的尺子核对：`research/markdown-attribution-probe.ts` 把
`transcript.render`、单量 `renderMarkdown`、以及"正文全是单字时 transcript 的残值"三者并排。500×4000
那一档：整棵绘制 155～188 ms、单量 md 188～217 ms、单字残值 **4 ms**——**两边都指向同一笔账**，归因站
得住。

### 四、重跑出来的流式数字（同版本、同一把尺子）

老数字出自 22.22.2，本机 24.15.0，**所以下面这些不能与 `jank-harness-output-after.txt` 直接比**；
能比的是**比值**。

- 每帧 `full`：短历史 0.0352 ms、长历史 0.2437 ms，**长/短 6.91x**（老副本给的是 4.22x）。差别的来源
  就是上面第二节那两处对正——尤其"状态行只画一次"和左栏签名。**方向没变**：逐帧成本仍然随历史条数
  增长，仍然是 `transcript` 那一项独占（`transcript` 长/短 7.30x，`reduce` 只有 1.76x）。
- 每帧工作量 3.9 个节点、0 次 `querySelector`——H1/H3 的结论（`querySelector` 归零）仍然成立。
- `sidebar.render` 200 行 / 4 行 = **29.0x**，`qs/次 = 0`（H3 仍成立）。
- 单条消息的 `renderMarkdown` 末/首 = 1.9x、`parseBlocks` = 6.0x——**这里有一条与老副本不同的读法**：
  老副本的 `markdownScenario` 每帧往同一个容器里画且只解析尾部，末/首 3.9x；现在同样只解析尾部，但
  **它证明了单帧随长度增长，证不了"首次绘制一条长消息"的价**——后者由第三节的 `switchScenario` 量，
  也正是 05 号要的那个数。

### 五、验证

- `node .scratch/window-rework/research/jank-harness.ts` 退出码 0（默认参数：2000 帧、12 次/场景），
  输出 `research/jank-harness-output-repair.txt`。
- `npm run check` 退出码 0（token 审计 127 defined / 101 referenced，与 03 号一致）。
- `node scripts/smoke-sidebar.ts` ok；`smoke-tools` / `smoke-sessions` / `smoke-projection` /
  `smoke-mux-client` 全 ok。**没有改任何产品代码**，这一票的改动全部在 `.scratch/` 下。

### 六、诚实的限度

- **绝对毫秒不是真实帧时间**，两次往返的真实网络与服务器时间也不在表里（同一进程内的 `fetch` 只是
  microtask）。这张表量的是"客户端为切换一次会话要同步做多少活"，以及它**随规模怎么涨**。
- **长消息一侧的 `md` 有偏差**（见第三节末），另有一把独立尺子核对，但两把尺子都不是浏览器。
- 老数字**没有**在同版本下重跑过：`jank-harness.ts` 是整份重写的（不只是补 `contains`），所以本票只
  能把"新数字"与"新数字之间的比值"立住，**不能声称老结论被逐条复现**。这一点与票面那句"老数字不能
  直接比"一致。

