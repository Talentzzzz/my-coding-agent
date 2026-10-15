# 2 让窗口既启动得起来、又不用软件合成的**最小**开关组合

Type: research
Status: resolved
Blocked by:

## Question

用户那份排查记录已经把**症状**钉死了：这台机器上所有走 Chromium 沙箱的子进程启动即访问违例，GPU 连崩
后整个浏览器进程退出。也已经知道**仅 `disableHardwareAcceleration()` 不够**（关掉加速后 Chromium 照样
拉起独立的 GPU/网络子进程，照样崩），所以真正起作用的是 `no-sandbox`。

问题是那 12 行里**三个开关是一起加的**，其中两个的**必要性从没被单独验证过**，而它们正是"桌面端很卡"
的头号嫌疑：

- `disableHardwareAcceleration()` → 整窗**软件合成**（这个客户端还有 `backdrop-filter: blur(2px)`、
  20 个 `transition`、7 个 `animation`、7 个 `box-shadow`，全是无 GPU 时最贵的东西）；
- `in-process-gpu` → GPU 服务被搬进**浏览器主进程**，而 `main.cjs:77-91` 正是把 **agent 服务器**加载
  进那个进程的地方——一次忙的回合会和绘制抢同一个进程。

要查清的事实（**结论必须落在证据上，不许猜**）：

1. **`no-sandbox` 单独够不够？** 即：不加 `disableHardwareAcceleration`、不加 `in-process-gpu`，一个
   **不沙箱**的 GPU 子进程还会不会访问违例？**如果不崩，硬件加速就是可以拿回来的**——那 12 行里有两行
   可以直接删，"启动"和"卡"一起解决。**这一条是本票的主问题。**
2. 如果不够，**第二便宜**的配置是什么（`disableHardwareAcceleration` 但**不加** `in-process-gpu`，
   让退化的 GPU 待在自己进程里，别和 agent 共用）？
3. `disable-gpu-shader-disk-cache` 是否仍然必要——`DawnGraphiteCache` 那个共享冲突 **0x20 是缓存锁
   问题，不是崩溃问题**，两者要不要分开处理？
4. `webPreferences.sandbox: true`（`main.cjs:121`）在 `no-sandbox` 生效时是不是**死配置**——确认它到
   底有没有作用，还是纯噪音（03 号要清掉这个语义矛盾）。
5. **次要目标**：底层原因能不能真正定位（用户怀疑杀毒软件注入）。读
   `%LOCALAPPDATA%\CrashDumps\electron.exe.11344.dmp` 与 `electron.exe.26804.dmp`（2026-10-13
   23:41:15 / 23:41:35，旁边有 23:41:10 创建的 `%APPDATA%\electron-probe\`），能读出模块名或栈就说
   出来；**读不出来就诚实写"读不出来"，不要编**。
6. 每个候选组合的**实测代价**：窗口走的是软件还是硬件合成、首帧时间、以及在一次真实流式回合里窗口还
   跟不跟得上（跟着就行，别做完整性能工程——那是 04/05 号的事）。

**环境注意**：Electron 44.5.1；`no-sandbox` / `in-process-gpu` 的语义以 Electron / Chromium 的**一手
文档**为准；`ELECTRON_RUN_AS_NODE=1` 在环境里，直接跑 electron 二进制会退化成普通 Node，**必须走
`npm run desktop` 或 `launch.mjs`**；`npm run desktop` 每次还会先跑 `build:web`（约 1s）。启动出来的
窗口**不要留着**，测完就关。

产出：`.scratch/window-repair/research/minimal-switch-set.md`——"最小开关组合 + 证据 + 实测代价"，
让 **03 号照着落地**。

## Answer

**产出在 [`../research/minimal-switch-set.md`](../research/minimal-switch-set.md)**（原始日志、量具、
转储读法分别在 `research/switch-probe/`、`research/dump-read/`）。要点，按票面的六个问题：

1. **`no-sandbox` 单独够不够——够，而且在本机连它都不需要。** 今天 **GPU 进程从未被观察到活着**
   （300 ms 采样操作系统进程表只有 browser/renderer/utility；`getGPUFeatureStatus()` 九项全
   `disabled_*`/`unavailable_*`；WebGL 是 `Microsoft Basic Render Driver`；渲染进程从第一次采样起就带
   `--disable-gpu-compositing`；期间 `child-process-gone` 一次都没响）。**12 组配置全部产出了窗口与
   完整页面、0 次崩溃**（其中 10 组连测量回合也跑完；另 2 组是量具自己的 bug 导致没收场，见下）。
   所以"最小组合"是**空集**：`disableHardwareAcceleration()`、`in-process-gpu`、
   `disable-gpu-shader-disk-cache` 三条在本机都是空操作。
   **但那个条件是 10/13 的，不是今天的**——见第 5 点，所以落地形状是"删开关 + 写 ADR 记下历史与
   恢复路径"，不是"删了了事"。
2. **第二便宜的配置**因此不需要选：`disableHardwareAcceleration` 在这台机器上关的是**已经不存在**的
   GPU 进程，开着和删掉量不出差别（首帧 509–581 ms、帧 median 4.2 ms，各配置一致）。
3. **`disable-gpu-shader-disk-cache` 不必要**：**开着它**的全新 profile 里
   `GPUPersistentCache\DawnGraphiteCache\…` 照样被建出来；子进程命令行上也看不到与它有关的任何痕迹。
   缓存锁冲突 0x20 与崩溃确实是两件事，而今天本机没有 GPU 进程，那条冲突不可能发生 → **删**。
4. **`webPreferences.sandbox: true` 不要删。** 语义上它过去确实被 `--no-sandbox` 压过（渲染进程命令行
   里两个旗标同时存在就是现场），但开关一删，它就是**唯一**还在表达沙箱意图的地方；删它等于顺手把
   渲染进程的沙箱也关掉，**没人要求过**。保留，不加注解。
5. **底层原因：读出来了，但只读出一半。** 两份转储都是 **`0x80000003`（`__debugbreak`，FATAL）**、
   出错地址在 **`electron.exe` 自己**里（+0x72D4CB9）、栈上是 Chromium 原话
   `A +0x15A0: [11344:…:FATAL:content\browser\gpu\gpu_data_manager_impl_private.cc:417] GPU process isn't usable. Goodbye.`
   （逐字在 `research/dump-read/dump-read.txt` 的 `--- strings on the crashing thread's stack ---` 段）。
   **一个必须说的截断**：退出码在栈上是 `-1073741` + 一个非可打印字节，**完整的 `-1073741819`
   （= `0xC0000005`）这两份转储里读不出来**，它来自用户 10/13 的记录，是跨来源拼接，不是读出来的。
   **用户的"杀毒软件注入"不成立**（机器上只有 Defender，无 `AppInit_DLLs`、无 IFEO 劫持、electron.exe
   里没有任何杀毒模块）；**但确实有第三方代码被注入**：
   `C:\WorkBuddy\…\cli\vendor\sandbox\5.7.10\tsbx.dll`——**腾讯 WorkBuddy 的沙箱产品**，而 WorkBuddy
   **今天 08:13 升级到 5.8.2，`5.7.10` 目录已不存在**。这是"时间线吻合 + 今天不复现"的推断，不是因果
   证明；**GPU 子进程自己的转储不在手上，所以"是哪个模块越界的"这两份文件回答不了**（也没有做栈回溯，
   所以 `+0x72D4CB9` 只是"落在哪个模块"，不是"哪个函数"）。
6. **实测代价**：除一次例外，窗口走的是**软件合成**（`gpu_compositing: disabled_software`；例外那次是
   SwiftShader）。帧 median 4.2 ms / p95 4.3 ms、>33 ms 的帧几乎为 0；输入回路 median 4.1–4.3 ms。
   唯一那次 `max 2466.9 ms` 出现在裸跑那一轮、**几乎肯定是冷启动首帧**（只有推断，没有逐帧记录）。
   **那次例外要解释，别读成"软件渲染慢 4 倍"**：带 `enable-unsafe-swiftshader` 的那轮 WebGL 是
   SwiftShader，帧 median 16.6 ms ≈ 60 Hz 帧间隔，而其余各轮 4.2 ms ≈ 240 Hz——**两个数字量的是
   "有没有被 vsync 限住"，不是每帧成本**（隐藏窗口里 `rAF` 不被节流）。`in-process-gpu` 的"和 agent
   抢同一个进程"因此在本机不成立——但也**没被证伪**（那个服务不存在）；那是 04/05 号的量具该管的事。
   **没做到**：真实流式回合里的窗口跟随用的是合成回合；`web_fetch` 在本 session 解析不了域名，所以
   **一手文档没读成正文**，开关语义全部落在本机实测上（这一点请 03 号写 ADR 时补）。

### Comments

- **落地建议给 03 号**：删 `main.cjs:40` 与 `:46-48`、删 `:37-45` 那段"这台机器"的注释、保留 `:122` 的
  `sandbox: true`、把 ADR 写成**历史 + 恢复路径**（症状与转储证据、被否决的更便宜方案、只加载本机地址
  这个没被推翻的边界、以及"什么条件下可以把开关加回来"）。**不要**把三行开关留在文件里当幽灵配置。
- 一个方法论上的坑值得记：`Get-CimInstance` 读进程命令行会**在 184 字符处截断**浏览器主进程那一行
  （实测 browser 184 / utility 871 / renderer 1069），我因此差点得出"`appendSwitch` 到不了浏览器进程"。
  改用 `app.commandLine.hasSwitch()` 后，事实是 **`appendSwitch` 两种都到**——票面那条"开关要放在
  app 路径之前"是命令行写法的坑，与 `appendSwitch` 无关。顺带给 04/05 号的量具一条教训：**别拿 OS 的
  命令行当"开关生效没生效"的证据。**
- **评审后的三处改正**（两轴评审里 Spec 轴指出的，都已落进 `research/minimal-switch-set.md`）：
  ① 栈字符串原先**没有**被提交的证据文件支撑（`dump-read.txt` 里当时根本没有字符串），已修 `read.ps1`
  并把两段栈字符串与"负退出码可打印串"扫描一并提交，**同时把 `-1073741819` 降级为跨来源推断**；
  ② "12 组全部开出窗口"成立，但**"全部跑完测量"不成立**——最初那批 `argv` 的 2 组收了看门狗，
  表格里已标出；
  ③ 漏掉的那次 `enable-unsafe-swiftshader` 运行（帧 median 16.6 ms / 输入 median 15.4 ms 那一行）已补进
  代价表，并说明它量的是 vsync 有没有限住、**不能**用来比较每帧成本。

