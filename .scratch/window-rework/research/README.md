# 卡顿量具：怎么跑、量什么、哪里不能信

本目录里与"逐帧成本 / 切换会话成本"有关的东西，**零产品代码改动**：

| 文件 | 是什么 |
| --- | --- |
| `jank-harness.ts` | 量具本身：流式一帧的成本、以及 `openSession()` 端到端的一次会话切换 |
| `fixtures.ts` | 造数据的助手（`snapshotWith` / `messageBody` / `textOfMessage` / `longAnswer` / `MODEL` / `USAGE`）；量具 import 时会把整张表跑一遍，所以**要造同一批数据的探针从这里 import，不要 import 量具** |
| `markdown-attribution-probe.ts` | 独立核对量具里"其中md"那一列的归因 |
| `jank-harness-output-repair.txt` | 2026-10-16 那次默认参数的**原样输出**（`FRAMES=2000`，切换场景每档采样 10 次 + 3 次热身） |
| `../../../../scripts/dom-shim.ts` | **唯一一份**最小 DOM 宿主，量具从这里 import |

> 老文档 `jank-profile.md`（03 号）描述的是**修好之前**的装置：它的行号、门槛与场景清单都指旧副本。
> 装置本身以本文件与 `jank-harness.ts` 的头部注释为准。

`fixtures.ts` 存在的理由是"只留一份"：探针要造同一批快照但不想顺带跑完量具整张表，而抄第二份正是
04 号诊断出的病根（同一个 shim 被抄两遍、然后漂移）。**要加造数据的助手就加在这里。**

## 产品代码侧的另一个用户：`scripts/smoke-transcript.ts`

05 号加的分批绘制（`TranscriptView.renderDeferred()`）不在本目录，驱动它的回归在
`scripts/smoke-transcript.ts`——它用同一份 shim 的 `frames()` 把延迟队列一帧帧跑完，断言两条路画出
同一个、连跑多帧不长树、中途来的帧说了算。跑法 `node scripts/smoke-transcript.ts`。

给那条路量价的那把尺子也在它的票目录里：`.scratch/window-repair/research/switch-paint-probe.ts`
（整块画 vs 分批画，同一批 items），原样输出在旁边的 `switch-paint-output.txt`。它 import 的是本目录的
`fixtures.ts`。

## 跑法

```powershell
node .scratch/window-rework/research/jank-harness.ts
FRAMES=200 node .scratch/window-rework/research/jank-harness.ts          # 冒烟用的小规模
SWITCH_RUNS=4 FRAMES=200 node .scratch/window-rework/research/jank-harness.ts
DOM_SHIM_LAX=1 node .scratch/window-rework/research/jank-harness.ts      # shim 缺件只警告不抛
node .scratch/window-rework/research/markdown-attribution-probe.ts
node .scratch/window-repair/research/switch-paint-probe.ts               # 切换会话：整块 vs 分批
node scripts/smoke-sidebar.ts                                           # 同一份 shim 的另一位用户
node scripts/smoke-transcript.ts                                        # 同上，驱动 transcript
```

## 五条不能忘的限度

1. **绝对毫秒不是真实帧时间。** shim 没有布局、没有绘制、没有事件循环——它量的是算法代价（节点访问、
   元素构造、字符串解析、数组拷贝）。可靠的信号是**同一把尺子下短 vs 长的比值**，以及**同一把尺子下
   各阶段之间的占比**。真实帧时间至今没有量过（见 `../map.md` 的 "Not yet specified"）。
2. **版本要同。** 老数字出自 Node 22.22.2，本机是 24.15.0；表头印了 `node=`，**跨版本不比数字，只比
   比值**。
3. **切换会话的两次 HTTP 往返跑在同一进程里。** 量到的是**客户端**这一侧的解析与重画代价；`stringify`
   那一端（真系统里是服务端）被单独列成 `wire` 一列，网络延迟与服务器响应时间则**根本没量**。
4. **"量具跑得完 = DOM 面齐了"有个边界**：严格模式只管**元素**，`document` 与 `window` 是普通对象、
   不代理；而 `render()` 里还有三笔没搬进量具（分支视图、工作目录芯片、两个面板）。它保证的是"量具走
   过的那条路上，元素成员齐了"。
5. **"一步"不等于"一帧"，逐帧加起来的数会偏小。** `shim.frames()` 跑的是**一帧的整个回调**，而一次
   `stepPending()`（= `Drain.step()`）在预算内可以跑好几批。05 号因此量错过一次：把每一步的墙钟相加
   当作"分批绘制的总代价"，稳定得到旧路的 0.4～0.6x，而同一件事**一整段连续测**就是 1.0x
   （`.scratch/window-repair/research/switch-paint-probe.ts` 的文件头有经过）。**要总量就连续测一段，
   要"最坏一帧占住多久"才逐步测**，别把两者混成一个数。

## 为什么 `scripts/dom-shim.ts` 缺件会当场抛

量具曾经静默废掉过一次：`482673a` 让 `sidebar.ensureHeading` 开始用 `Node.contains`，sidebar 的 smoke
补上了、量具那份 shim 没补，于是量具从那天起跑不起来，之后的结论全是读代码读出来的
（[票 04](../../window-repair/issues/04-jank-harness.md)）。所以 `installDom()` 默认**严格模式**：代码读
一个没实现的成员当场抛，指出是哪个标签上的哪个成员。

**修法是"只剩一份"**，不是"两边都记得补"：`scripts/smoke-sidebar.ts`（原先那份现成 shim 的出处）与
量具现在都 import `scripts/dom-shim.ts`。它放在 `scripts/` 而不是本目录，因为 sidebar 的 smoke 要在
`packages/web` 那个带 DOM 类型的 tsconfig 下被类型检查——`.scratch/` 不在任何 tsconfig 的 include 里。

写这个 shim 时踩过的两个坑，别再踩：

- **`classList.add/remove` 必须写回 `className`。** 老 shim 改的是一个马上被丢掉的 `Set`，`className`
  纹丝不动——"拖宽时加 `dragging`"这类行为因此从来没在量具里生效过。
- **别把创建过的节点存在一张表里供 `getElementById` 查。** 那会把整棵被丢弃的 DOM 钉在堆上：全量跑
  （2000 帧 + 12 次切换/场景）会让 Node 的 4 GB 堆满，报
  `FATAL ERROR: Ineffective mark-compacts near heap limit`。真 DOM 里摘下来的节点可以回收，这里也必须
  能——按 `id` 找就从页面根往下走。

## 一处量具会**多报**的地方（05 号动手前知道）

`transcript.render()` 里那句 `container.scrollTop = container.scrollHeight` 在浏览器里是**布局后**的
读-写：`scrollHeight` 要重新量一次内容，所以它触发一次强制同步布局。**shim 没有布局**——`scrollHeight`
就是个初始为 0 的普通属性，赋值跟读一个字段一样便宜。所以逐帧成本里那笔"强制布局"在这里**根本没被
量到**，真实帧只会比这张表更贵，不会更便宜。

## PowerShell 写输出的坑

本仓库的 shell 是 Windows PowerShell 5.1：`Get-Content` 按机器 ANSI 代码页**读**，`>` 重定向按
**UTF-16LE 写**。中文会显示成乱码、产物会变成满地带 NUL 的二进制，git 也把它当二进制、没法 diff。
所以量具**自己**按 UTF-8 写那份证据副本，走 `HARNESS_OUT`：

```powershell
$env:HARNESS_OUT = "$PWD\.scratch\window-rework\research\jank-harness-output-repair.txt"
node .scratch/window-rework\research\jank-harness.ts
```

不设 `HARNESS_OUT` 就只打印到 stdout（默认行为）。

