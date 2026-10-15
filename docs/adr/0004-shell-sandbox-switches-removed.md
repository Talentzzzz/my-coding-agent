# 0004：外壳不再自带 `no-sandbox` 与 GPU 开关——那是给一台已经变了的机器打的补丁

- 状态：**已接受**（2026-10-16，[03 号](../../.scratch/window-repair/issues/03-land-the-switches.md)落地；结论与证据由 [02 号](../../.scratch/window-repair/issues/02-minimal-switch-set.md)产出，收在 [`.scratch/window-repair/research/minimal-switch-set.md`](../../.scratch/window-repair/research/minimal-switch-set.md)）
- 取代或失效：`main.cjs` 里一段**从未提交过**的工作区补丁——`app.disableHardwareAcceleration()` 加三条 `appendSwitch`（`no-sandbox` / `in-process-gpu` / `disable-gpu-shader-disk-cache`），外面裹着一段"这台机器"的注释。它不在任何提交里（`git log -S no-sandbox -- packages/desktop/main.cjs` 为空），所以这次删除**不产生 diff**——本 ADR 与 `.scratch/window-repair/` 是它唯一的记录
- 取代者：尚无。反转时**不要**改这份 ADR——照下面「恢复路径」加回开关、并**新开一条** ADR 记下反转的代价

## 背景

2026-10-13 这台机器上 `npm run desktop` 开不出窗口。用户当时的排查记录是：**所有走 Chromium 沙箱的子进程一启动就访问违例**（`exit_code=-1073741819`，即 `0xC0000005`），GPU 进程连崩十次左右之后 Chromium 放弃，整个浏览器进程退出，`loadURL()` 于是抛 `ERR_FAILED (-2)`——而**同一个 URL `curl` 是 200**。为了让窗口开得出来，工作区里加上了四条东西，并在现场验证"加上就开得出、不加就开不出"：软件渲染、子进程不沙箱、GPU 服务搬进浏览器进程、外加关掉 GPU shader 磁盘缓存。

那段注释自己写下了它是什么——「**这台机器**上每个沙箱子进程都崩」——而这个前提在 2026-10-15 08:13（+08:00）变了：转储里被注入的那个第三方沙箱产品（腾讯 WorkBuddy 的 `C:\WorkBuddy\resources\app.asar.unpacked\cli\vendor\sandbox\5.7.10\tsbx.dll`）随 5.8.2 升级消失——**这是"时间线吻合 + 今天不复现"的推断，不是因果证明**。于是这四条成了**照着一个已经不成立的条件写下的规避**，其中两条还各自有代价（见下），而它们一直是**未提交的工作区状态**：一次误操作就没了，且下一个人读到"窗口靠 `--no-sandbox` 才开得出来"没有任何上下文。

## 决定

**四条全部删除，不留幽灵配置。** `webPreferences.sandbox: true`（`main.cjs:109`）改为**保留、不加注解**。

**在 10/13 那个条件下，唯一承重的是 `no-sandbox`**，这一点是用户当时现场验证的：仅 `disableHardwareAcceleration()` **不够**——关掉加速后 Chromium 照样拉起独立的 GPU/网络子进程，照样崩。所以"删掉四条"不是"删掉四条同等的东西"，而是删掉一条当时的必需品加三条搭车的，**前提是那一条今天不必需了**。

## 证据：为什么今天四条都不必需

全部在 2026-10-15/16 本机实测（Windows 11 26200、Electron 44.5.1；原始日志、量具、读法在 `.scratch/window-repair/research/`）。

**A. 10/13 那次崩溃是真的，转储里留下了它的名字。** `%LOCALAPPDATA%\CrashDumps` 两份转储（`electron.exe.11344.dmp` 23:41:15、`electron.exe.26804.dmp` 23:41:35）都是：

```
exception: code 0x80000003, parameters 0x1 0x0 0x0 0x0
faulting address is in ...\electron\dist\electron.exe +0x72D4CB9
崩溃线程栈上的可打印串，逐字：
    A +0x15A0: [11344:1013/234110.262:FATAL:content\browser\gpu\gpu_data_manager_impl_private.cc:417]
               GPU process isn't usable. Goodbye.
    A +0x7E0:  xited unexpectedly: exit_code=-1
```

> **一处必须说的截断。** 那个退出代码在栈上是 **`-1073741` 后面跟一个非可打印字节**（`A +0x1D48: -1073741h`）；
> `read.ps1` 专门扫了一遍"看起来像负退出码的可打印串"，两份转储都只给出 `-1073741`。**完整的
> `-1073741819`（= `0xC0000005`）不在这两份转储里**——它来自用户 10/13 的记录，是**跨来源拼接**，
> 不是读出来的。（`exit_code=-1` 里的 `-1` 是同一种截断，不是"退出码 −1"。）

即：不是"渲染进程访问违例"，而是**浏览器主进程被自己的 `FATAL` 主动打断**——GPU 子进程反复死掉之后 GPU manager 放弃。模块表里 85 个模块，其中 7 个不在 `C:\Windows` 下：`electron.exe` 自己、**1 个 WorkBuddy 沙箱 DLL**（上面那个 `5.7.10\tsbx.dll`）、5 个搜狗输入法组件。没有 GPU 驱动——崩的是主进程，驱动在另一个进程里。

**B. 今天这台机器上，GPU 进程根本没有被观察到活着。** 300 ms 采样操作系统进程表只有 `browser` / `renderer` / `utility`；`app.getMetrics()` 里从来没有 `GPU` 条目；`getGPUFeatureStatus()` 是 `gpu_compositing: disabled_software`、`webgl/rasterization/video_*: unavailable_software` 或 `disabled_software`；WebGL renderer 是 WARP（`Microsoft Basic Render Driver`）；渲染进程从第一次采样起就带着 `--disable-gpu-compositing`。整个测试期间 `child-process-gone` / `gpu-process-crashed` **一次都没响**。

于是四条各自成了空操作：

| 被删的 | 为什么今天是空操作 |
|---|---|
| `disableHardwareAcceleration()` | 它要关的 GPU 进程**从未被观察到活着**（300 ms 采样看不见"出生即死"的进程，所以这是"没观察到"，不是"证明它没被启动过"）；开关打开与关上，首帧、帧 median、可见性，没有差别 |
| `no-sandbox` | 12 组配置含完全裸跑全部开出窗口、`child-process-gone` 一次没响——今天没有子进程在崩，所以没有东西需要它去修 |
| `in-process-gpu` | 没有 GPU 服务可搬进主进程（`app.getAppMetrics()` 里从来没有 `GPU` 条目，进程表里也从来没有） |
| `disable-gpu-shader-disk-cache` | 开着它的**全新 profile** 里 `GPUPersistentCache\DawnGraphiteCache\…` 照样被建出来；子进程命令行上也看不到它 |

12 组配置（含**完全裸跑**，含把 GPU 兜底路也堵掉的 `--use-angle=d3d11 --ignore-gpu-blocklist`）全部产出窗口与完整页面、**0 次崩溃**；各配置的帧 median 都是 **4.2 ms**（`p95` 4.2–4.3 ms），除了那唯一一轮 `enable-unsafe-swiftshader`（16.6 ms ≈ 60 Hz，量的是 vsync 限没限住，**不是**每帧成本）。`ready-to-show` 的 26 个样本落在 **504–737 ms**，各配置之间量不出差别——那 737 ms 是唯一明显偏高的样本，只出现一次。其中 2 组的测量回合没收场，那是量具自己的 PowerShell 引号 bug（修掉之后同样配置连跑 6 次全部正常），**不是窗口的问题**——不要照着它改任何东西。

**C. 本轮落地时又当面验了一次，而且走的是生产启动路径。** 开关删掉之后 `npm run desktop:screenshot`（`build:web` + `scripts/launch.mjs`，真实窗口、真实服务器、真实页面）退出码 0，写出 1280×820 的截图，整窗画全：左栏工作区与会话、输入框、状态行都在。删之前同一命令同样成功——两条都成功这一点**本身就是本 ADR 的要点**。

**D. `webPreferences.sandbox: true` 曾经是死配置，现在是唯一活的那一句。** 在 `--no-sandbox` 还在的日子里，渲染进程命令行里 `--enable-sandbox` 与 `--no-sandbox` **同时存在**，Chromium 按后者执行——那就是矛盾的现场。开关一删，这一句不再被任何东西压过；删掉它等于顺手把渲染进程的沙箱也关掉，没有人要求过这件事。（一个能被后来读者验证的痕迹：矛盾不存在了，"死配置"这个描述随之失效。）

## 被取代的是什么

| 原事实（那段工作区补丁） | 本次 |
|---|---|
| `app.disableHardwareAcceleration()`：软件渲染是"有窗口与没窗口"的差别 | **取代**：删。今天软件渲染与它无关——Chromium 本来就没拿到可用 GPU |
| `appendSwitch("no-sandbox")`：沙箱子进程在这台机器上必崩 | **取代**：删。10/13 的注入条件已消失（B、A 的时间线） |
| `appendSwitch("in-process-gpu")`：让绘制与 agent 别分家 | **取代**：删。没有 GPU 服务可搬；把 GPU 服务搬进跑着 agent 服务器的那个进程，本来就是一张要还的账 |
| `appendSwitch("disable-gpu-shader-disk-cache")` | **取代**：删。它没阻止缓存被创建，而"缓存锁冲突 0x20"需要**两个进程同时**去拿同一目录的锁——今天没有第二个进程 |
| 一段解释"这台机器"的注释 | **取代**：删。它描述的条件已经不成立，留着就是漂移。理由移到本 ADR |

## 没有（也不该）被取代的边界

**这条规避当时是对的，理由是它有一个没被推翻的边界；边界今天仍然成立。** 窗口只加载**它自己那台**服务器：`bootServer({ host: "127.0.0.1", port: 0 })` 返回的 `booted.url`，除此之外什么都不加载——`setWindowOpenHandler` 把 http/https 交给系统浏览器、一律 `deny`，`nodeIntegration: false`、`contextIsolation: true`、`webSecurity: true`。所以即便在 `--no-sandbox` 生效的日子里，"子进程不再被操作系统隔离"这件事的暴露面也只有本机回环上的自有内容。**删掉开关是把这一层纵深防御还回来，不是把它拿走**；而"窗口不得加载任意外部网页"这句话在任何一种配置下都是承重的，改它需要一条新的 ADR。

同样没有被取代的：**失败面照旧**（`observability.cjs` 的 `child-process-gone` / `render-process-gone` 一行一报），它正是让这四条可以被量、被删的那只眼睛——下次同样的死法会自己留下日志。**`smoke-desktop-close` / `smoke-desktop-observability` 不依赖任何开关**，所以删掉它们不需要动测试。

## 被否决的更便宜方案

| 方案 | 为什么否决 |
|---|---|
| 留着这四条不提交也不解释 | 这是一份**已验证有效的规避**停在未提交状态：一次误操作就没了，而读到它的人会以为这是漂移。要么落地要么删，没有第三种 |
| 只删注释、把四条留在文件里当"幽灵配置" | 与上一条相反方向的同一宗罪：配置还在生效，而解释它的那段话已经因为不成立而被删——下一个人无法判断能不能动它 |
| 只删 `in-process-gpu` 与 shader cache，留 `no-sandbox` | 即便如此也**删它**：`no-sandbox` 是四条里唯一有真实安全代价的那条，而今天它什么都不买。（真要只留一条，留的必然是它——它是当年唯一承重的那个；这一点在「恢复路径」里） |
| 改成"仅当检测到注入模块时才加开关" | 探测第三方注入（`AppInit_DLLs` 为空、无 IFEO 劫持，注入来自被 harness 启动这一事实本身）没有可靠的运行时判据；写一个探测不了的探测器比删掉更糟 |
| 保留 `--no-sandbox` 以换取"下次崩溃时窗口一定能开" | 拿一个**每天**都在支付的隔离损失，去赌一个**可能再也不发生**的故障模式；而失败面已经能在一行日志里说出真相 |

## 恢复路径

**条件。** 窗口又开始开不出来、或启动后不久就没了，而 `observability.cjs` 的那行日志给出 `child-process-gone`（尤其 `type: "GPU"` 或 network utility）——即 10/13 那个形状回来了：可能换了一台同类机器、可能某个注入型产品回退、也可能杀毒软件升级后开始注入子进程。

**顺序。** 按当时的证据梯度加，**不要一次加四条**：

1. 先只加 `app.commandLine.appendSwitch("no-sandbox")`（`app` ready 之前）。当时现场验证的就是这一条承重，其余三条是搭车的。
2. 若窗口开得出来但仍崩在不该崩的地方，再加 `app.disableHardwareAcceleration()` 与 `in-process-gpu`，并**重新量一次代价**（`in-process-gpu` 把 GPU 服务搬进跑着 agent 服务器的进程，这不是免费的）。
3. `disable-gpu-shader-disk-cache` **只在看到 `DawnGraphiteCache` 共享冲突（0x20）时才加**——它是缓存锁的事，不是崩溃的事。

**加回去的时候要一起做的三件事**：在同一提交里**新开一条 ADR**（本 ADR 保持原样，把它的"取代者"指向新的）；把 `webPreferences.sandbox: true` 与 `--no-sandbox` 的矛盾**就地注解**（那一句会重新变成死配置，这次要说明它被谁压过）；如果那次是靠换机器/杀毒软件/沙箱产品升级"修好"的，写明**是哪一次变更**——"时间线吻合"不是因果证明，别让下一个人把它当结论。

**一个不必做的动作**：不要去读 `packages/desktop/main.cjs` 的历史找那四条——**它们从未被提交过**（本 ADR 与 `.scratch/window-repair/` 是它们唯一的记录）。

## 代价与后果

**换来的。** ① 一个未提交的工作区补丁变成一条有记录的删除；② 窗口的四个进程（浏览器、渲染、utility、以及将来可能回来的 GPU）重新走 Chromium 默认的沙箱与进程模型，`webPreferences.sandbox: true` 从死配置变回生效配置；③ `in-process-gpu` 那张"绘制与 agent 抢同一个进程"的账不再欠着；④ 因为删掉的是规避而不是修复，**下一次同样的死法必须以日志的形式出现**，而不是被一个开关静默吞掉。

**背上的。**

1. **本机无法证伪"删了会不会重新崩"**：这台机器上 Chromium 从未拿到可用 GPU，所以"删掉开关"与"不崩"之间的因果不可在本机验证。能证的是"今天这个条件下四条都不起作用"。
2. **"今天不复现"是推断，不是因果证明**：被注入的 `tsbx.dll` 在转储里，同一产品在 10/15 被升级——时间线吻合，而"是它传染给子进程的"没有被证明（**GPU 子进程自己的转储不在手上**，两份都是主进程的；也没有做栈回溯，`+0x72D4CB9` 只是"落在哪个模块"）。
3. **换机器可能反转。** 本 ADR 的结论是**本机**的（用户是在这台机器上跑这个窗口的）。换一台同类机器、或那个沙箱产品回退，结论可能反过来——这正是"恢复路径"存在的理由。
4. **一处跨来源拼接，读的时候要小心**：完整的 `-1073741819`（`0xC0000005`）**不在那两份转储里**——转储里只读到 `-1073741` 加一个非可打印字节。完整值来自用户 10/13 的记录，是拼出来的，不是读出来的。

## 一个反直觉的事实，别读错

**在这台机器上，"删掉这些开关"不等于"拿回硬件加速"。** Chromium 从来没拿到可用 GPU：两块 GPU（Intel UHD + RTX 4070 Laptop）都健康，但给 Chromium 的是 WARP。本机**不存在**硬件合成的对照，所以 ADR 里不能承诺任何性能收益，也不该把"删掉 `disableHardwareAcceleration`"说成性能修复。真要衡量窗口的绘制成本，那是 04/05 号的量具该管的事；本 ADR 只管"哪几行该留在文件里"。

## 证据的限度（诚实声明）

- **一手文档没读成正文。** Electron / Chromium 对 `--no-sandbox`、`in-process-gpu` 的官方语义，在这一轮里 `web_fetch` 解析不了域名（`getaddrinfo ENOTFOUND`），只有搜索结果标题。所以本 ADR 的开关语义**全部落在本机实测**上；要走文档的路，需要一个能通网的环境。
- **没有真实流式回合的窗口跟随**：量具用的是合成回合。
- **一个方法论上的坑，留给下一个人**：`Get-CimInstance` 读进程命令行会**在 184 字符处截断**浏览器主进程那一行，据此差点得出"`appendSwitch` 到不了浏览器进程"——事实是两种传法都到（用 `app.commandLine.hasSwitch()` 验的）。**别拿操作系统的命令行当"开关生效没生效"的证据。**

## 不可逆性

**这次删除本身是可逆的**——四条都是几行代码，`恢复路径`那三步就是逆操作，所以严格说它没有"改回来要动很多处"的那种不可逆性。真正不可逆的是**知识**：那四条只有一个来源（一段从未提交的工作区状态），一旦删掉而没人写下为什么，**下一次故障时没有人知道曾经有过这个规避、也不知道它当时是在什么条件下被验证有效的**——接手的人会从零开始重新诊断一遍 10/13。这就是这份 ADR 存在的全部理由，也是"删掉但必须留下记录"这个形状的根据。

**恢复路径可逆，但代价不可逆**：只要按那三步把 `no-sandbox` 加回来，窗口的隔离就再次关掉，而这次是**有记录、有意识地**关掉——ADR 里必须写明是哪一次机器变更让诊断重新成立（见「恢复路径」末段）。两种状态各有各的代价，没有一种可以让两边都不付。

### 附：落地形状（这次实际动了什么）

- `packages/desktop/main.cjs`：**工作区里**删掉了 `app.disableHardwareAcceleration()`、三条 `appendSwitch`、以及那段"这台机器"的注释。**注意这一条不产生 diff**：那 12 行从未被提交过（`git log -S no-sandbox -- packages/desktop/main.cjs` 为空），所以删掉它们只是让工作区回到 `HEAD` 的字节——`git hash-object packages/desktop/main.cjs` 与 `git rev-parse HEAD:packages/desktop/main.cjs` 相等。`webPreferences.sandbox: true`（现在是 `main.cjs:109`）原样保留。
- `packages/desktop/observability.cjs`：`watch()` 的文档注释里有一句拿 `no-sandbox` / `in-process-gpu` 当"子进程为什么会死"的例子——那两行已经不在了，改成"子进程死一行就够"的本义，并指向本 ADR。
- `docs/architecture.md`：新增一行「沙箱与 GPU 开关」，把"今天一条都不加"这个**实况**与指向本 ADR 的链接放在那里（理由是这份 ADR 的家）；「失败面」那一行的理由改成不再引用已经不存在的开关。
- 验证：`npm run check`（退出 0）、`smoke-desktop-close`、`smoke-desktop-observability`（都 ok）、以及真实窗口的 `npm run desktop:screenshot`（**删之前与删之后都**退出码 0、写出 1280×820 的整窗截图；**没有把截图当成产物提交**，要复现就跑那条命令）。`npm run smoke:boot` **仍是红的**，但与本 ADR 无关——那是 `approval_request` 一帧没到加一个泄漏句柄，见 [10 号票](../../.scratch/window-repair/issues/10-smoke-boot-red.md)，改动前后逐字一致。注意 `smoke-desktop-close` / `smoke-desktop-observability` **不依赖任何开关**，所以删掉它们不需要动测试。
