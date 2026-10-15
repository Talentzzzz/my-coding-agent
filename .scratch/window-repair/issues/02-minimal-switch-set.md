# 2 让窗口既启动得起来、又不用软件合成的**最小**开关组合

Type: research
Status: open
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
