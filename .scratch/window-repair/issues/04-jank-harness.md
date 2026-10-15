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

所以形状是**一份 shim**：新增 `scripts/dom-shim.ts`，`jank-harness.ts` 与 **`scripts/smoke-sidebar.ts`
都从它 import**——后者那份就地实现整块删掉（它是"另一份拷贝"的原产地，也是 `contains` 当初被补上的那
一份）。放在 `scripts/` 而不是 `.scratch/` 是因为 sidebar 的 smoke 由 `packages/web/tsconfig.json` 做类型
检查（它要 DOM 的 `lib`），shim 因此也进了那份 include：**它现在被 `npm run check` 管着**。补齐的 DOM 面
按**今天产品代码实际碰到的**算（`transcript` / `sidebar` / `statusbar` / `settings` / `session-settings` /
`composer` / `menu` / `markdown` / `diff` / `dom` / `main`），逐条列在这里，因为它们就是"对得上今天"
这句话的内容：

- **缺了会直接抛的**：`Node.contains`、多参 `prepend`、`replaceWith`、`closest`、`matches`、
  `querySelector` 的 `[attr="v"]` 组合、`focus`/`select`/`blur`、`setPointerCapture`、
  `getBoundingClientRect`、`attributes` 读写、`dispatch`/`listenerCount`。
- **`classList` 是**活**的**：老 shim 的 `add`/`remove` 改的是一个马上被丢掉的 `Set`，`className` 纹丝
  不动。这不只是"少一个方法"——它让"拖宽时加 `dragging`"这类行为在量具里从来没生效过，量到的东西和
  产品代码不是一回事。现在 `add`/`remove`/`toggle` 都写回 `className`。
- **缺件不再靠"记得补"**：`installDom()` 默认**严格模式**——代码读一个没实现的 DOM 成员当场抛，指名道
  姓地说是哪个标签上的哪个成员。`DOM_SHIM_LAX=1` 可以关掉。**它的边界说清楚**：只管**元素**，
  `document` / `window` 是普通对象、不代理，而 `render()` 里还有三笔没搬进量具；所以它保证的是"量具
  走过的那条路上，元素成员齐了"，不是"整棵 DOM 面齐了"。
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

`FRAMES=2000`、每场景采样 10 次（另 3 次热身丢弃），中位数（ms）。**`wire` 那一列不是客户端的账**：
它是假服务端把快照 `stringify` 出来的时间（真系统里在服务端），列在这里只是为了看见它有多大：

| 场景（历史×每条字数） | read | wire | refresh | reduce | paint | 其中 md | **sync** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 50×400 | 0.11 | 0.06 | 0.20 | 0.07 | 1.97 | 1.05 | **2.44** |
| 500×400 | 1.06 | 0.57 | 0.21 | 1.36 | 16.28 | 16.64 | **19.12** |
| 50×4000 | 0.67 | 0.38 | 0.21 | 0.05 | 12.58 | 10.40 | **13.50** |
| 500×4000 | 7.50 | 5.27 | 0.25 | 1.89 | 161.30 | 154.67 | **173.49** |
| 500×400（新窗口对照） | 1.01 | 0.49 | 0.25 | 1.47 | 17.30 | 17.48 | **19.94** |

05 号要照这张表动手，四条读法写在这里：

1. **顿的不是那两次往返。** `read` 是这条路上唯一随规模线性涨的"网络侧"代价（2.1 MB 的 JSON，客户端
   自己 `JSON.parse` 约 7.5 ms），而 `refresh`（那第二笔往返）**0.2 ms 上下，与规模无关**——它是列表，
   不随对话长度变。**所以"第二次没有效果的往返"值多少钱，这张表说得很清楚：同步时间里它占 1% 上下。**
   （真窗口里还要加上服务器响应时间与网络，shim 里量不到，这一点在输出里写明。）
2. **`reduce` 不是主角。** 快照重放随条数涨（0.07 → 3.9 ms），但它是 `paint` 的一个零头。
3. **`paint` 就是全部。** 500×4000 时 161 ms / 173 ms = 93%；而且它随规模涨得比 `reduce` 快得多
   （91x vs 30x，同一个 10x×10x 的规模变化）。
4. **`paint` 里几乎全是 `renderMarkdown`。** 逐条重画一遍量的那一列（`其中md`）在长消息一侧已经与
   `paint` 同量级：500×4000 是 154.7 / 161.3 ms。**"每条消息的 renderMarkdown 各占多少"的答案是
   "几乎全部"**——而它随**总字符数**涨：50×4000（20 万字符）与 500×400（20 万字符）的总字数一样、
   `其中md` 也一样（10.4 / 16.6 ms，同一量级），**与条数无关**。

第 4 条的量法有偏差（两条路各跑各的 JIT，短消息一侧 `md` 能比 `paint` 还大，输出里按"100% 附近读作
基本全是它"标注），所以另加了一把独立的尺子核对：`research/markdown-attribution-probe.ts` 把
`transcript.render`、单量 `renderMarkdown`、以及"正文全是单字时 transcript 的残值"三者并排。500×4000
那一档：整棵绘制 134～148 ms、单量 md 132～153 ms、单字残值 **3.4～4.7 ms**——**两边都指向同一笔账**，
归因站得住。（这个探针 import 量具造数据的助手，不再抄一份。）

### 四、重跑出来的流式数字（同版本、同一把尺子）

老数字出自 22.22.2，本机 24.15.0，**所以下面这些不能与 `jank-harness-output-after.txt` 直接比**；
能比的是**比值**。

- 每帧 `full`：短历史 0.0377 ms、长历史 0.2376 ms，**长/短 6.31x**（老副本给的是 4.22x）。差别的来源
  就是上面第二节那两处对正——尤其"状态行只画一次"和左栏签名。**方向没变**：逐帧成本仍然随历史条数
  增长，仍然是 `transcript` 那一项独占（`transcript` 长/短 6.67x，`reduce` 只有 1.47x）。
- 每帧工作量 3.9 个节点、0 次 `querySelector`——H1/H3 的结论（`querySelector` 归零）仍然成立。
- `sidebar.render` 200 行 / 4 行 = **十几倍到二十几倍**（同机多次跑在 13x～29x 之间），`qs/次 = 0`
  （H3 仍成立）。这一项的样本噪声大，**别把它当精确倍数用**。
- 单条消息的 `renderMarkdown` / `parseBlocks` 这条场景测的是**流式期间只解析尾部**的那条路，末/首
  仍随长度增长（本次 1.9x / 6.0x）——**它证不了"首次绘制一条长消息"的价**，后者由第三节的
  `switchScenario` 量，也正是 05 号要的那个数。

### 五、验证

- `node .scratch/window-rework/research/jank-harness.ts` 退出码 0（默认参数：2000 帧、12 次/场景），
  输出 `research/jank-harness-output-repair.txt`（`HARNESS_OUT=<路径>` 让量具自己按 UTF-8 写，绕开
  PowerShell 重定向写成 UTF-16 那个坑）。
- `node .scratch/window-rework/research/markdown-attribution-probe.ts` 退出码 0。
- `npm run check` 退出码 0（token 审计 127 defined / 101 referenced，与 03 号一致）。
- `node scripts/smoke-sidebar.ts` ok（**它现在跑在同一份 shim 上**）；`smoke-tools` / `smoke-sessions` /
  `smoke-projection` / `smoke-mux-client` 全 ok。
- **改到了 `scripts/smoke-sidebar.ts` 与 `packages/web/tsconfig.json`**（把 shim 合并成一份、并让
  `npm run check` 管住它），**没有改 `packages/` 下的产品代码**。

### 六、诚实的限度

- **绝对毫秒不是真实帧时间**，两次往返的真实网络与服务器时间也不在表里（同一进程内的 `fetch` 只是
  microtask）。这张表量的是"客户端为切换一次会话要同步做多少活"，以及它**随规模怎么涨**。
- **严格模式只覆盖元素**：`document` / `window` 不代理，`render()` 里那三笔（分支视图、工作目录芯片、
  两个面板）也没搬进量具。所以"缺件当场抛"保证的是量具走过的那条路。
- **长消息一侧的 `md` 有偏差**（见第三节末），另有一把独立尺子核对，但两把尺子都不是浏览器。
- **老数字没有在同版本下重跑过**：`jank-harness.ts` 是整份重写的（不只是补 `contains`），所以本票只
  能把"新数字"与"新数字之间的比值"立住，**不能声称老结论被逐条复现**。这一点与票面那句"老数字不能
  直接比"一致。
- **切换场景是复刻而不是调用**：`openSession()` 不是导出函数，量具照它的顺序把同步那几段重走一遍。
  所以它是一种**必须跟着 `main.ts` 走**的复刻，不是"驱动真函数"——这条边界与它漏掉的那几笔写在
  `renderFrame` 的文档注释里，而 `driveOpenSession` 里那句 `loadFrom(api.rows, false)`（第二笔往返）与
  `main.ts` 的通道判据一致：channel 不是 `live` 时才吃得下这份列表。

## Comments

- code-review（两轴并行，2026-10-16，固定点 `2660446`）：**两轴各报了一条硬伤，都已就地改掉。**

  **Spec 轴**——(1) "一份 shim"这件事**只做了一半**：`jank-harness.ts` 迁到了共享 shim，而
  `scripts/smoke-sidebar.ts` 那份就地 `FakeNode` 还原封不动，于是票面诊断的那个漂移**仍然可能再发生**。
  已改：smoke 也 import `scripts/dom-shim.ts`，就地实现整块删除，shim 进 `packages/web/tsconfig.json`
  的 include（于是归 `npm run check` 管）。(2) `read` 那一列标着"客户端侧"，但假服务端的
  `JSON.stringify` 就在被计时的那段 `await` 里，**把服务端的账记到了客户端头上**。已改：单列一个
  `wire` 列并写明"真系统里不归客户端"，`read` 只剩 `response.text` + `JSON.parse`；`syncMs` 不含它。
  (3) `sidebarKey` 号称"逐字照抄"却把 `pickedWorkspace`/`collapsed`/`channel` 冻成了字面量——这正是本票
  诊断的那种漂移。已改：六个字段全由调用方给。(4) `FakeApi.list()` 是死代码、`/api/sessions/current`
  会被路由到 `read()` 而抛。已改：路由显式列出，读不到就抛。

  **Standards 轴**——硬伤一条：`AGENTS.md` 的"源码注释用英文"只登记了两个例外，而本票三个 `.ts`
  全是中文注释。**这一条我按现状保留**，理由写在这里而不是悄悄绕过：这三个文件是 `.scratch/` 下的
  **量具**，量具存在的理由是"读得懂它在量什么"，而票面本身就是中文的、读者也是中文读者；仓库里
  已有的同类（`scripts/wire/client.ts`、`proxy.ts`、`.scratch/window-rework/research/*.ts`）走的是
  同一条路。要收的话应当是一次把 `.scratch/` 下的量具一并收进去的独立改动，不在本票里做半套。
  另外四条是判断题级的：(a) shim 里那个 `typeof member === "symbol"` 分支不可达、`IGNORED` 里几个
  Symbol 项与 `FakeNodeClass` 无人用——已删；(b) 探针抄了量具的三个造数据助手——已改为 import；
  (c) `asElement` 的注释自称"全文件唯一一次类型缺口"与事实不符——已改成说清它是"两种类型之间唯一的
  桥"；(d) 证据文件是 UTF-16LE、git 当二进制——已让量具自己按 UTF-8 写（`HARNESS_OUT`），并把这个坑
  写进 `research/README.md`。


