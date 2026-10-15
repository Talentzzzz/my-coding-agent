# 卡顿量具：怎么跑、量什么、哪里不能信

本目录里与"逐帧成本 / 切换会话成本"有关的三件东西，**全部零产品代码改动**：

| 文件 | 是什么 |
| --- | --- |
| `dom-shim.ts` | **唯一一份**最小 DOM 宿主。量具从这里 import；`scripts/smoke-sidebar.ts` 里还留着一份独立的旧副本（本票没动它），两边曾因此漂移过一次——见下 |
| `jank-harness.ts` | 量具本身：流式一帧的成本、以及 `openSession()` 端到端的一次会话切换 |
| `markdown-attribution-probe.ts` | 独立核对量具里"其中md"那一列的归因 |
| `jank-harness-output-repair.txt` | 2026-10-16 那次默认参数的**原样输出**（`FRAMES=2000`，切换场景每档采样 10 次 + 3 次热身） |

> 老文档 `jank-profile.md`（03 号）描述的是**修好之前**的装置：它的行号、门槛与场景清单都指旧副本。
> 装置本身以本文件与 `jank-harness.ts` 的头部注释为准。

## 跑法

```powershell
node .scratch/window-rework/research/jank-harness.ts
FRAMES=200 node .scratch/window-rework/research/jank-harness.ts          # 冒烟用的小规模
SWITCH_RUNS=4 FRAMES=200 node .scratch/window-rework/research/jank-harness.ts
DOM_SHIM_LAX=1 node .scratch/window-rework/research/jank-harness.ts      # shim 缺件只警告不抛
node .scratch/window-rework/research/markdown-attribution-probe.ts
```

## 三条不能忘的限度

1. **绝对毫秒不是真实帧时间。** shim 没有布局、没有绘制、没有事件循环——它量的是算法代价（节点访问、
   元素构造、字符串解析、数组拷贝）。可靠的信号是**同一把尺子下短 vs 长的比值**，以及**同一把尺子下
   各阶段之间的占比**。真实帧时间至今没有量过（见 `../map.md` 的 "Not yet specified"）。
2. **版本要同。** 老数字出自 Node 22.22.2，本机是 24.15.0；表头印了 `node=`，**跨版本不比数字，只比
   比值**。
3. **切换会话那一段的两次 HTTP 往返在同一进程里**，量到的是客户端这一侧的解析与重画代价，**不含**
   网络与服务器时间。

## 为什么 `dom-shim.ts` 缺件会当场抛

量具曾经静默废掉过一次：`482673a` 让 `sidebar.ensureHeading` 开始用 `Node.contains`，sidebar 的 smoke
补上了、量具那份 shim 没补，于是量具从那天起跑不起来，之后的结论全是读代码读出来的
（[票 04](../../window-repair/issues/04-jank-harness.md)）。所以 `installDom()` 默认**严格模式**：代码读
一个没实现的成员当场抛，指出是哪个标签上的哪个成员。**量具跑得完 = 今天产品代码要的 DOM 面齐了。**

写这个 shim 时踩过的两个坑，别再踩：

- **`classList.add/remove` 必须写回 `className`。** 老 shim 改的是一个马上被丢掉的 `Set`，`className`
  纹丝不动——"拖宽时加 `dragging`"这类行为因此从来没在量具里生效过。
- **别把创建过的节点存在一张表里供 `getElementById` 查。** 那会把整棵被丢弃的 DOM 钉在堆上：全量跑
  （2000 帧 + 12 次切换/场景）会让 Node 的 4 GB 堆满，报
  `FATAL ERROR: Ineffective mark-compacts near heap limit`。真 DOM 里摘下来的节点可以回收，这里也必须
  能——按 `id` 找就从页面根往下走。

## PowerShell 读输出的坑

本仓库的 shell 是 Windows PowerShell 5.1：`Get-Content` 按机器 ANSI 代码页读。中文会显示成乱码
（`新建会话` → `鏂板缓浼氳瘽`）。那是读法的问题，不是写入的问题——要核对中文请用编辑器打开。
