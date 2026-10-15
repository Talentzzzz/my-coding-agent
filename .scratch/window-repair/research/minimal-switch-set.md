# 最小开关组合 + 证据 + 实测代价

票 02 的产出，给 **03 号照着落地**。

## 结论（先给要落地的东西）

**在这台机器上，那 12 行里没有一行还在起作用，三条全部可以删。** 证据不是"没崩"，而是：

- 今天 **GPU 进程从未被观察到活着**——不是崩了又重启，是采样里没有。我按 300 ms 采样操作系统的进程表
  （`browser` / `renderer` / `utility` 三种，没有 `gpu`），`app.getGPUFeatureStatus()` 九个能力全
  `disabled_*` / `unavailable_*`，WebGL renderer 是 `Microsoft Basic Render Driver`（WARP），
  渲染进程从第一次采样起就带着 `--disable-gpu-compositing`，utility 带着
  `--use-angle=d3d11-warp-webgl`。**Chromium 在启动早期就把 GPU 判成不可用并走了兜底路**；整个测试期间
  `child-process-gone` / `gpu-process-crashed` **一次都没响过**。
  （**方法上的限度**：300 ms 采样看不见"出生即死"的进程，所以严格说这条是"从未观察到活着"，不是
  "证明它没被启动过"。）
- 在这个状态下：
  - `disableHardwareAcceleration()` **是空操作**：它要关的东西已经没了（关掉它、打开它，首帧
    509–581 ms、帧时间 4.2 ms、可见性，全部一样）；
  - `in-process-gpu` **是空操作**：没有 GPU 服务可搬（`app.getAppMetrics()` 里从来没有 `GPU` 条目，
    进程表里也从来没有）；
  - `disable-gpu-shader-disk-cache` **是空操作**：`DawnGraphiteCache` 在开着它的全新 profile 里照样
    被创建（见 §5）。
- 所以票面那条主问题的答案在这台机器上是：**`no-sandbox` 单独够不够——够，因为现在连 `no-sandbox`
  都不需要**。**12 组配置全部产出了窗口与完整页面、0 次崩溃**；其中 **10 组连测量回合也跑完了**，
  另 2 组（最初那一批 `argv` 传法）窗口开出来了、页面也完整，但**测量回合没有收场**，45 s 看门狗收尾
  ——那 2 次是**我量具自己的 bug**，不是窗口的问题，修掉之后同样配置连跑 6 次全部正常收场（详见 §4
  末那一段，别把它读成"窗口打不开"）。

**但**这条结论有一个必须一起落地的前提，否则下一个人会在另一台机器上踩空：**10/13 那次崩溃是真的，
它在转储里留下了名字**——那是被注入的**第三方沙箱产品**（腾讯 WorkBuddy 的 `tsbx.dll`，版本
`sandbox\5.7.10`），而**同一个产品今天早上 08:13 被升级到 5.8.x，`5.7.10` 目录已经不在**。也就是说
"这台机器的子进程一启动就访问违例"这个条件**今天已经不成立**，而规避补丁是照着一个不成立的条件写的。

于是 03 号要落地的形状是：

1. **删掉那三行开关**（`main.cjs:46-48`）与 `app.disableHardwareAcceleration()`（`:40`）；
2. **删掉那段"这台机器"的注释**（`:37-45`）——它描述的条件已经不成立，留着就是漂移；
3. **`webPreferences.sandbox: true` 保留**（见下：它现在是对的，`--no-sandbox` 没了它才真正生效）；
4. **写那条 ADR**（票 03 自己的要求）。ADR 要写的是**历史**：10/13 为什么必须禁沙箱（转储证据）、
   那个条件是什么、今天为什么不再需要、以及**恢复路径**——万一哪天同样的崩溃回来（比如沙箱产品
   回退，或换一台同类机器），照 ADR 里那三行加回去。**不要**把"三行开关"留在 `main.cjs` 里当
   幽灵配置。
5. **加一条哨兵**（不是本票强制，但强烈建议，理由见"给 03 的建议"）：外壳已经能观测
   `child-process-gone` 与 `render-process-gone`（票 01），下次同样的死法会自己留下日志——ADR 里
   指过去，别再加开关。

> **落地前提的诚实声明。** 上面的结论是**本机实测**（Windows 11 26200、Electron 44.5.1、2026-10-16）。
> 换机器、或沙箱产品回退，结论可能反转。**用户是在这台机器上跑这个窗口的**，所以按本机落地是对的；
> ADR 的作用就是把"当时为什么"钉住，好让反转时有人看得出来。

---

## 1. 环境与机器（先钉住"这是哪台机器"）

| 项 | 值 | 怎么得到的 |
| --- | --- | --- |
| 机型 | ASUS TUF Gaming F16 FX607JIR | `Win32_ComputerSystem` |
| 系统 | Windows 11 家庭版 中文版，10.0.26200 | `Win32_OperatingSystem` |
| GPU | Intel UHD Graphics（驱动 32.0.101.6790）/ NVIDIA RTX 4070 Laptop（32.0.16.1714） | `Win32_VideoController`，两块都 `Status=OK`、`CM_PROB_NONE` |
| Hypervisor | `HypervisorPresent = True` | `Win32_ComputerSystem` |
| Electron | 44.5.1（`packages/desktop/node_modules/electron/package.json`） | 直接读 |
| 沙箱产品 | WorkBuddy 5.8.2（腾讯），安装在 `C:\WorkBuddy`，**2026-10-15 08:13** 落地 | 目录 `CreationTime` + `Uninstall` 注册项 |

**关键的一点**：这台机器有两块健康的 GPU，但给 Chromium 的是 **WARP（`Microsoft Basic Render Driver`）**。
所以"窗口是不是硬件合成"这个问题在本机的答案**永远是"不是"**，跟那三个开关无关。这一点必须写在
ADR 里，否则下一个人会以为"删了开关就能拿回硬件加速"。

还有一条**确凿但与显示无关**的硬件噪声，供参考：`Microsoft-Windows-WHEA-Logger` 在 10/14 09:52 与
10/15 08:10 各记了一次 `A corrected hardware error has occurred. Component: PCI Express Root Port`
（Event ID 17）。它是"已纠正"的、不是崩溃，我没有把它和 GPU 可用性连起来——**没有证据，所以不下结论**，
只记在这里。

---

## 2. 转储读出来了：不是猜的

读法与我写下的工具在 `research/dump-read/`（本机没有 cdb/windbg，也没有 .NET SDK，所以按 minidump
的公开偏移直接读）。两份转储 `electron.exe.11344.dmp`（23:41:15）与 `electron.exe.26804.dmp`
（23:41:35），**同样的异常、同样的地址**：

```
exception: thread 32300 / 5364, code 0x80000003, flags 0x0, address 0x7FF7164C4CB9
exception parameters: 0x1 0x0 0x0 0x0
modules loaded: 85
faulting address is in ...\electron\dist\electron.exe +0x72D4CB9
```

**读出来了什么**：

1. **异常码是 `0x80000003`（一个 `__debugbreak()` 断点），不是 `0xC0000005`。** `parameters[0]=1`
   正是 `FATAL` 走的形状。也就是说：**这两份转储是浏览器主进程自己被 `FATAL` 主动打断的那一下**，
   不是"渲染进程访问违例"。
2. **出错地址落在 `electron.exe` 自己里面**（+0x72D4CB9），**不在 GPU 驱动、不在沙箱 DLL**。
3. **栈上有 Chromium 自己的话**——这是 `read.ps1` 从崩溃线程那 16,552 字节栈里读出的可打印串，
   **逐字**在 `dump-read.txt` 的 `--- strings on the crashing thread's stack ---` 那两段里：

   ```
   A +0x788: [11344:1013/234110.262:ERROR:content\browser\gpu
   A +0x7E0: xited unexpectedly: exit_code=-1
   A +0x1438: gpu_data_manager_impl_private.cc:417: GPU process isn't usable. Goodbye.
   A +0x15A0: [11344:1013/234110.262:FATAL:content\browser\gpu\gpu_data_manager_impl_private.cc:417] GPU process isn't usable. Goodbye.
   A +0x1D48: -1073741h
   A +0x2140: IPC.mojom.Channel
   ```

   第二份是同一句话的另一次采样（`A +0x15B0: [26804:1013/234131.260:FATAL:…gpu_data_manager_impl_private.cc:417] …`）。
   **这正是票面那条症状链**：GPU 子进程反复死掉，GPU manager 放弃并 `FATAL`，整个浏览器进程退出，
   于是 `loadURL()` 拿到 `ERR_FAILED`。

   > **一处必须说清的截断。** 那个退出代码在栈上是 **`-1073741` 后面跟一个非可打印字节**；
   > `read.ps1` 专门扫了一遍"看起来像负退出码的可打印串"，两份转储都只给出 `-1073741`。
   > **完整的 `-1073741819`（= `0xC0000005`）在这两份转储里读不出来。** 它只能由"用户 10/13 记录里的
   > `exit_code=-1073741819`"与"这里的 `-1073741…` 前缀"拼出来——**那是推断，不是这两份文件里读到的**。
   > 我上一版把这个数字写成了"栈上的完整值"，那是错的，已改正。
   > （相关地：`A +0x7E0: xited unexpectedly: exit_code=-1` 里的 `-1` 也是同一种截断，不是"退出码 −1"。）

4. **模块表里有什么**：85 个模块，其中 **7 个不在 `C:\Windows` 下**，`read.ps1` 把它们单列出来
   （`dump-read.txt` 的 `modules NOT under C:\Windows`）：`electron.exe` 自己、**1 个 WorkBuddy 沙箱
   DLL**、以及**5 个搜狗输入法组件**。**没有 GPU 驱动**
   （`nvlddmkm` / `igd*` / `d3d11` / `dxgi` / `vulkan` / `nvgpu` 一个都不在）——因为崩的是主进程，
   GPU 驱动在**另一个**进程里，这 85 个模块里看不到它。

### 5 号次要问题：底层原因能不能定位——**能定位到"谁在里面"，不能定位到"哪条指令"**

- **用户怀疑"杀毒软件注入"这个假设，证据不支持。** 机器上只有 Windows Defender（
  `SecurityCenter2`），`AppInit_DLLs` 为空（`LoadAppInit_DLLs=0`），没有 `IFEO` 劫持，
  **在 `electron.exe` 里也没有任何杀毒 DLL**。
- **但确实有第三方代码被注入 `electron.exe`，名字写下来了**：

  ```
  C:\WorkBuddy\resources\app.asar.unpacked\cli\vendor\sandbox\5.7.10\tsbx.dll
  ```

  这是 **WorkBuddy（腾讯）的沙箱产品**，它给被它启动的每个进程注入 `tsbx.dll` / `tsbxldr.dll` /
  `tsbxlow.dll` / `sandbox_ffi.dll` 这一套。而 **02 号这一轮的所有测试、以及 10/13 那次崩溃，都是
  从一个被这个产品包着的 harness 里启动的**——用户当时跑的正是诊断这件事的 agent 会话。
- **时间线是这条推断的支点，而且是本机核实过的**：

  | 时间 | 事件 | 证据 |
  | --- | --- | --- |
  | 10/13 23:40:56 / 23:41:10 / 23:41:31 | `electron.exe` 三次 Application Error（`0xc000000d` 一次、`0x80000003` 两次） | 事件日志 |
  | 10/13 23:41:15 / 23:41:35 | 两份转储落盘 | 文件时间 |
  | 10/15 08:13:31–08:13:35 | WorkBuddy 5.8.2 落地，`vendor\sandbox\5.8.5` 出现 | 安装时间 |
  | 10/15 之后 | **`vendor\sandbox\5.7.10` 已不存在**（转储里写的正是 5.7.10） | `Test-Path` = False |
  | **10/16 全天** | **12 组配置，0 次崩溃，窗口每次都开** | 见 §4 |

- **读不出来的那一半，直说**：**GPU 子进程自己的转储不在手上**（只在子进程里崩，两份 CrashDumps 都是
  主进程的）。所以"GPU 进程里是哪个模块越界"这件事**这两份文件回答不了**。我没有去猜它是 `tsbx.dll`
  ——**唯一的直接证据是"它被注入进来了"**，而"它是不是传染给了子进程"是推断，ADR 里要这么写。
- **还有一条我没能做的验证**：把同一个 shell 放到"不被沙箱产品包着"的环境里跑一次。本 session 本身就在
  DSH 之下（进程链 `powershell ← DeepSeek Harness ×3`），而 DSH 与沙箱产品是否真的在同一条注入链上，
  我没有独立证据，只看到 `tsbx.dll` 在转储的模块表里。**所以"升级修好了它"是"时间线吻合 + 今天不复现"
  的推断，不是因果证明。**

---

## 3. `no-sandbox` 单独够不够（主问题）

票面问的是"不加 `disableHardwareAcceleration`、不加 `in-process-gpu`，一个**不沙箱**的 GPU 子进程还
会不会访问违例"。把这个问题翻译成可测的句子：**在只有 `no-sandbox` 的配置下，窗口开不开、GPU 进程在不在、
崩不崩。**

本机实测（`research/switch-probe/`，`logs/` 里是原始日志）：

| 配置 | 窗口 | 页面 | GPU 进程 | 崩溃 | 测量回合 | ready-to-show |
| --- | --- | --- | --- | --- | --- | --- |
| **完全裸跑**（不加任何开关，`softwareRendering=false`） | ✅ | ✅ | 无 | **无** | ✅ | 737 ms |
| `no-sandbox`（argv） | ✅ | ✅ | 无 | **无** | **未收场 ⚠** | 509–581 ms |
| `no-sandbox` + `in-process-gpu`（argv） | ✅ | ✅ | 无 | **无** | **未收场 ⚠** | 524 ms |
| `no-sandbox`（appendSwitch） | ✅ | ✅ | 无 | **无** | ✅ | 542–581 ms |
| `no-sandbox` + `disableHardwareAcceleration()` | ✅ | ✅ | 无 | **无** | ✅ | 511 ms |
| 三个开关齐全（= 现在 `main.cjs` 的状态） | ✅ | ✅ | 无 | **无** | ✅ | 515 ms |
| 只 `in-process-gpu` | ✅ | ✅ | 无 | **无** | ✅ | 527 ms |
| `no-sandbox` + `disable-gpu-shader-disk-cache` | ✅ | ✅ | 无 | **无** | ✅ | 556 ms |
| `--use-angle=d3d11 --ignore-gpu-blocklist`（**把 GPU 的兜底路也堵掉**） | ✅ | ✅ | **仍然没有** | **无** | ✅ | 525–543 ms |

**答案：够——而且在这个条件下"单独"这个问法已经过期了，因为现在连 `no-sandbox` 都不需要。** 12 组里
`child-process-gone` / `render-process-gone` / `loadURL` 抛错，一次都没有出现；**每一组都产出了窗口与
完整页面**（`visible=true`、页面正文读得出来）。

**⚠ 那两行**是**最初**那批 `argv` 传法的运行：窗口开出来了、页面完整，但**测量回合没有收场**（45 s
看门狗）。原因是我量具里的一处 PowerShell 引号 bug——**不是窗口的问题**：修掉之后同样配置连跑 6 次
（3 次带 `disableHardwareAcceleration()`、3 次不带）全部正常收场。细节在 §4 末。**所以"全部开出窗口"
成立，"全部跑完测量"不成立**，这两行就是差别所在。

**一个方法论上的坑，第 3 节必须写下来**（因为它差点让我得出一个错的结论）：我一开始用
`Get-CimInstance` 读进程命令行，**它在 184 个字符处就把浏览器主进程那一行截断了**（实测：browser
`length=184`，而同一次运行的 utility 871、renderer 1069——上限在 260 上下，浏览器那行本来就短）。
于是我看见"渲染进程有 `--no-sandbox`、浏览器那行没有"，差点得出"`appendSwitch` 到不了浏览器进程"。
**那条推断是错的，而且是读法的错**：`Get-CimInstance` 是 CIM 的定长字符串字段，长命令行会被截。
换用 Electron 自己的账本之后，事实是：

- `app.commandLine.appendSwitch("no-sandbox")` → **浏览器进程自己也看得到**
  （`app.commandLine.hasSwitch("no-sandbox") === true`，`in-process-gpu` 同理）；
- 用真 argv 传时（`electron.exe <app> --no-sandbox …`），浏览器那一行**因为开关写在最前面**所以
  在截断前就看得见，`hasSwitch` 当然也是 `true`；
- **两条路的结论一致，差别只在"哪一行读得到"。**
- 顺带一条留给 04/05 号的量具教训：**不要拿 OS 的命令行当"开关生效没生效"的证据**，用
  `app.commandLine.hasSwitch()`。

**即：票面那条"开关必须放在 app 路径之前"的坑，与 `appendSwitch` 无关——`appendSwitch` 两种都到。**
（票面记的那条坑是命令行写法的坑，本来就不是 `main.cjs` 的写法。）

---

## 4. 每个候选配置的实测代价（6 号问题）

量具是 `research/switch-probe/controller.cjs`：它 `require` 真正的 `packages/desktop/main.cjs`，只在
它**之前**加上开关（**没有**改生产代码——不然就是量自己那一次编辑）。每个配置都是真窗口、真服务器、
真页面。

**量了什么**：`ready-to-show`（首帧可显示的墙钟）、页面 `did-finish-load`、一个 120 帧的
`requestAnimationFrame` 回路（每帧强制一次 `backdrop-filter` 样式读，正是这个客户端最贵的那种绘制，
报告 **median / p95 / max** 与 **超过 33 ms 的帧数**）、以及 40 次"敲一个字符 → DOM 给出回答"的
输入回路（**median** 是手感，**max** 是卡顿感），最后是 WebGL renderer。

| 配置 | 首帧 | 帧 median / p95 / max (ms) | >33 ms | 输入 median (ms) | WebGL |
| --- | --- | --- | --- | --- | --- |
| 裸跑 | 737 ms | 4.2 / 4.3 / 2466.9 | 1 | 4.1 | Basic Render Driver |
| 三开关齐全（现状） | 515–543 ms | 4.2 / 4.3 / 8.4 | 0 | 4.2–4.3 | Basic Render Driver |
| `no-sandbox` only | 581 ms | 4.2 / 4.3 / 8.4 | 0 | 4.1 | Basic Render Driver |
| `no-sandbox` + `in-process-gpu` | 524–529 ms | 4.2 / 4.3 / 8.3 | 0 | 4.1 | Basic Render Driver |
| `no-sandbox` + `disableHardwareAcceleration()` | 511 ms | 4.2 / 4.3 / 4.3 | 0 | 4.1 | Basic Render Driver |
| 只 `in-process-gpu` | 527 ms | 4.2 / 4.3 / 8.3 | 0 | 4.1 | Basic Render Driver |
| **`ignore-gpu-blocklist,enable-unsafe-swiftshader,…`**（第一次探针，见下） | — | **16.6 / 16.8 / 16.8** | 0 | **15.4** | **SwiftShader (Vulkan)** |

**读数**：

- **窗口走的是软件合成**，在**除最后一行之外**的每一个配置里（`gpu_compositing: disabled_software`）。
  **本机不存在"硬件合成"的对照**——Chromium 在这台机器上从没拿到可用的 GPU——所以**"删掉
  `disableHardwareAcceleration` 就能拿回硬件加速"这条在本机无法成立**，也不该写进 ADR 当承诺。
- **最后一行（16.6 ms / 15.4 ms）必须解释，不然它会被读成"软件渲染是 4 倍慢"。** 那一轮
  （`logs/gpu-forced.log`，本票**第一次**探针）带 `enable-unsafe-swiftshader`，WebGL 因此变成
  **SwiftShader**（CPU 光栅化，不是 WARP）。
  **16.6 ms ≈ 60 Hz 的帧间隔**，而其余各轮的 4.2 ms ≈ 240 Hz：前者是**被 vsync 限住的**，后者是
  **没被限住的**（隐藏窗口里 `requestAnimationFrame` 不被节流）。所以这两个数字量的**不是**"每帧成本"，
  而是"有没有踩到 vsync 边界"——**用它们比慢快是不成立的**。能被这一条支持的结论只有：**SwiftShader
  那一轮稳定在 ~60 fps（`max` = `p95` = 16.8 ms，很整齐），没有掉帧**；而"软件合成贵不贵"这个问题，
  本票的量具**答不了**（要答它得量合成器自己的帧时间，那是 04 号的尺子）。
  这一行我第一版漏掉了，是评审指出来的，补在这里。
- **首帧 0.5–0.7 s**，各配置的差别在噪声里（一次 737 ms 是唯一明显偏高的样本，只出现一次，我没有
  重复到能说它是配置差异）。
- **帧时间在 4.2 ms 上下，>33 ms 的帧几乎为 0**（除上面那条 SwiftShader 的 16.6 ms）。唯一那次
  `max 2466.9 ms` + `over33=1` 出现在**裸跑**那一轮；它**几乎肯定是第一帧**（那一轮 120 帧的均值
  24.76 ms，只有一帧超 33 ms ⇒ 漏掉的就是它；第一帧里包含首次 `backdrop-filter` 的编译/上传）。
  **我只有这个推断，没有逐帧记录**，所以别把它当结论；但它在 20 多次运行里只出现过一次、且与开关
  无关——**这是"首帧贵"，不是"持续卡"**。
- **输入回路 4.1–4.3 ms**，WARP 那六种配置一个样（SwiftShader 那轮 15.4 ms，即 60 Hz 节流）。20 个
  `transition`、7 个 `animation`、`backdrop-filter: blur(2px)` 在这台机器上**没有**表现成"卡"。
- `in-process-gpu` 把 GPU 服务搬进 agent 进程这件事，**在本机量不出代价，因为那个服务不存在**。
  票面担心的"忙的一回合和绘制抢同一个进程"因此**在本机不成立**；但它也**没被证伪**——真正该问的是
  "有一天 GPU 回来了会怎样"，那是 04/05 号的量具该管的事。

**给 04/05 号的交接**：本票的量具能给出真窗口的帧时间与输入延迟（它们要的东西的一部分），
但**不是**长期 FPS 观测，也**没有**在一次真实流式回合里跑过（票面 6 号那句"跟不跟得上"我用
`synthetic` 回合代替了——**这是本票没做到的一点，明说**）。量具留在
`research/switch-probe/`，README 在那边，可以直接扩。

### 一次差点被写进结论的量具故障（**保留记录**）

`--use-angle=d3d11 --ignore-gpu-blocklist` 放真命令行、又不加 `disableHardwareAcceleration()` 时，我
**最初**的 4 次里有 3 次看到：页面加载好了、窗口可见，但测量回合没有收场，45 s 看门狗收尾。当时我以为
是"WebGL 上下文创建挂住"，**那是错的**。

修掉量具里一处 PowerShell 引号 bug（survey 读子进程命令行的那段，`\"…\"` 在
`execFileSync` 的参数里被解析坏了，每次都吐一个 `ParserError`）之后，**同样的配置连跑 6 次
（3 次带 `disableHardwareAcceleration()`、3 次不带）全部正常收场，帧时间一样**。

所以：**那 3 次卡住的是我自己的测量脚本，不是窗口。** 我**没能**定位到确切成因（bug 与卡住在时间上
吻合，但"一个被 try/catch 吞掉的 ParserError 怎么会让 45 s 的等待不收场"我没有查到根因），
而症状与"app 挂住"不符（那个进程是活的、窗口可见、页面完整）。**记在这里的原因是：03 号不要
照着它改任何东西。** 量具的 bug 已经修了；`logs/provenance-argv.log` 与 `logs/provenance-appendSwitch.log`
是**修后**的两批，`logs/stall-*.log`、`logs/timeline-*.log` 是复跑。

---

## 5. `disable-gpu-shader-disk-cache` 还必要吗（3 号问题）

**不必要，而且它在本机是纯粹的装饰。**

- **它没有阻止缓存被创建**（这是本条的承重事实）：在一个**从未跑过**的全新 profile 里
  （`disableHardwareAcceleration()` + 该开关），`GPUPersistentCache\DawnGraphiteCache\3N6D5DEHLNDIL7WAV3UDV3VWNSN2RNCU\`
  照旧被建出来。对照：10/13 那个 profile 里也是同一条路径。
- **子进程的命令行里看不到任何与 shader cache 有关的东西**：渲染进程与 network utility 的命令行里只有
  `--no-sandbox` 与 Chromium 自己加的 GPU 兜底旗标。**注意别把这句读成"开关没送达"**——OS 的命令行读法
  不可靠（见 §3 那条截断），这条只说明"它在子进程的命令行上没有可见痕迹"。
- 结论：**"缓存锁冲突 0x20"与"崩溃"是两件事**（票面自己已经这么判断了，实测支持它）。前者需要
  **两个进程同时**去拿同一个缓存目录的锁；而今天本机没有 GPU 进程，这条冲突**不可能发生**。
- **删掉它不会让缓存冲突回来**；而**留着它的收益，本机量不出来**。

→ **03 号：删。** 如果 ADR 里想留一句"若将来 GPU 回来且两实例共 profile，再考虑它"，那是记录，不是配置。

---

## 6. `webPreferences.sandbox: true` 是死配置吗（4 号问题）

**今天的答案是"它是对的，别删"**——但票面问的那半（`--no-sandbox` 生效时它是不是被压过）要分成两段说：

- **语义上**：Chromium 的 `--no-sandbox` 与 `webPreferences.sandbox: true` 是**矛盾**的，冲突时
  `--no-sandbox` 赢（渲染进程不再沙箱化）。所以**在开关还在的那些日子里，它确实是死配置**。
- **本机观察**：把 `--no-sandbox` 放上真命令行时，渲染进程的命令行里**同时**有 `--enable-sandbox` 与
  `--no-sandbox`——Electron 两边都写了，Chromium 按 `--no-sandbox` 执行。这就是那个矛盾的现场。
- **但**：一旦按本票结论**删掉 `--no-sandbox`**，`webPreferences.sandbox: true` 就是**唯一**还在表达
  沙箱意图的地方，**它不再被任何东西压过**。删掉它等于顺手把渲染进程的沙箱关掉——**没有人要求过这件事**。

→ **03 号：保留 `main.cjs:122` 的 `sandbox: true`，不加注解。** 理由是可以被后来的读者验证的：
开关没了之后，那个矛盾也就不存在了，"死配置"这个描述随之失效。**不要**为了让注释说得通而去删它。

---

## 7. 没做到的事（明说）

- **一次真实流式回合里的窗口跟随**：本票用的是合成回合（§4），**没有**跑真实模型回合。
- **GPU 回来了的对照**：本机做不到（GPU 对 Chromium 不可用）。所以"删掉开关会不会重新崩"在本机是
  **不可证伪**的——能证的是"今天这个条件下它不起作用"。
- **GPU 进程自己的转储**：不在手上（见 §2）。
- **一手文档**：本 session 里 `web_fetch` 解析不了域名（`getaddrinfo ENOTFOUND`），所以
  "Electron / Chromium 的一手文档"这一条**我只有搜索结果标题，没有读成正文**。因此本票的开关语义
  **全部落在本机实测上**，没有靠文档转述。**这一条请 03 号在写 ADR 时补：** 一手出处值得引，而那需要
  一个能通网的环境。

**一条下一个人会用得上的环境坑**（本票踩了一次）：**Windows PowerShell 5.1 把无 BOM 的 `.ps1` 按机器
ANSI 代码页读**，脚本里的中文会变成乱码并解析失败（报的是"字符串缺少终止符"这类看不懂的错）。所以
本票留在 `research/` 里的 `.ps1` 一律只写 ASCII，凡是要说中文的脚本写成 `.mjs`（Node 按 UTF-8 读源码）。
AGENTS.md 里那条"编辑源码要用编辑器工具、别走 shell 文本往返"讲的是**内容**，这一条讲的是**脚本文件本身的
编码**，两者叠加时最容易浪费半小时。

---

## 8. 原始记录在哪

| 路径 | 是什么 |
| --- | --- |
| `research/switch-probe/controller.cjs` | 量具：`require` 真 `main.cjs`，在它之前加开关；`PROBE_*` 环境变量控制变体、采样、run 一次测量回合 |
| `research/switch-probe/run-matrix.ps1` | 六组矩阵；`-ViaArgv` 换成真命令行传法 |
| `research/switch-probe/gpu-sightings.ps1` | 每 300 ms 采样操作系统进程表，看 GPU 进程到底存不存在 |
| **`research/switch-probe/probe-output.txt`** | **26 次运行的原始探针输出逐字副本**——本票所有数字的来源（`*.log` 被 `.gitignore` 挡掉，所以证据以这份 `.txt` 提交；重建用同目录 `make-evidence.mjs`） |
| `research/switch-probe/README.md` | 怎么重跑、每个 `logs/*.log` 是哪一次 |
| `research/switch-probe/matrix-output.txt`、`matrix-argv.txt` | `appendSwitch` 与真命令行两种传法的矩阵运行 stdout |
| `research/switch-probe/sightings.txt` | `gpu-sightings.ps1` 三次运行的 stdout：每段先是那 3 个探针 **controller** 的日志（`switches=[] … via=appendSwitch`、`browser sees no-sandbox=…`），末尾一行才是脚本自己数出来的**进程类型采样计数**（`browser=34 renderer=33 utility=34`）——**它不是进程表的原始 dump** |
| `research/switch-probe/logs/real-shell.png` | 真外壳截的整窗图（1280×820）：证明那条路今天开得出窗口、画得全 |
| `research/dump-read/read.ps1` + `dump-read.txt` + `README.md` | minidump 的读法与原始输出（§2） |
