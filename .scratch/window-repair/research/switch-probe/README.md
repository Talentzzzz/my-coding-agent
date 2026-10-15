# 票 02 的开关量具

这个目录回答一个问题：**`packages/desktop/main.cjs` 里那 12 行未提交的开关，哪几行还有用。**

它**不改生产代码**——这是它存在的理由。做法是让 Electron 加载这个目录（`package.json` 的 `main`
指向 `controller.cjs`），controller 先按环境变量把开关加上，**然后 `require` 真正的
`packages/desktop/main.cjs`**。所以窗口、服务器、失败面全是生产的，而"改一行再跑一次"的诱惑被绕开了
——那会变成量自己那次编辑。

```powershell
# 仓库里没有 pwsh，用 Windows PowerShell（本 session 的 shell 就是它）
$e = "$PWD\packages\desktop\node_modules\electron\dist\electron.exe"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # 否则 Electron 退化成普通 Node

# 一组变体（六组矩阵，`-ViaArgv` 换成真命令行传法）
& .\.scratch\window-repair\research\switch-probe\run-matrix.ps1 [-ViaArgv]

# GPU 进程到底存不存在：每 300 ms 采样操作系统的进程表
& .\.scratch\window-repair\research\switch-probe\gpu-sightings.ps1
```

`controller.cjs` 的环境变量：

| 变量 | 作用 |
| --- | --- |
| `PROBE_SWITCHES` | 逗号分隔的开关，逐条 `app.commandLine.appendSwitch()` |
| `PROBE_SOFTWARE=1` | 额外调 `app.disableHardwareAcceleration()`（它不是命令行开关，没法写进上面那串） |
| `PROBE_VIA_ARGV=1` | 开关不由 controller 加；调用方把它们放在**真命令行**上（`--no-sandbox` …） |
| `PROBE_LOG` | 日志文件；每行带 `+Nms` 墙钟 |
| `PROBE_MEASURE=1` | 页面稳定后跑一次"帧 + 输入"回合 |
| `PROBE_SETTLE_MS` / `PROBE_TIMEOUT_MS` | 观察前的等待 / 整体看门狗 |

## 测量回合量了什么

120 帧 `requestAnimationFrame`，每帧强制一次 `backdrop-filter` 样式读（这个客户端最贵的那种绘制），
报告 **median / p95 / max** 与**超过 33 ms 的帧数**；然后 40 次"敲一个字符 → DOM 给出回答"的墙钟，
报告 **median**（手感）与 **max**（卡顿感）；最后是 WebGL renderer（用来一眼看出走没走 WARP）。
帧时间与输入延迟都按分布报，**不报平均**——平均会把用户唯一能感觉到的那次停顿盖掉。

## 证据以什么形式提交

`.gitignore` 里有 `*.log`，而这一票的全部证据就是那些日志，所以它们**逐字**拼进了
[`probe-output.txt`](probe-output.txt)（26 次运行，每段一个 `== logs/<名字>` 标题，按产生时间排序）
——那才是提交的证据文件。`logs/*.log` 是它的来源，重跑会重新生成，重建用：

```powershell
node .scratch/window-repair/research/switch-probe/make-evidence.mjs
```

> **为什么重建脚本是 `.mjs` 而不是 `.ps1`**：Windows PowerShell 5.1 把**无 BOM 的 `.ps1`** 按机器
> ANSI 代码页读，脚本里的中文会变成乱码并**解析失败**。所以这个目录里的 `.ps1` 一律只写 ASCII
> （`run-matrix.ps1`、`gpu-sightings.ps1`、`../dump-read/read.ps1` 都是），凡是要说中文的脚本写成
> `.mjs`（Node 按 UTF-8 读源码）。这一步踩过一次，记在这里省下一个人同样的时间。

`logs/` 里按运行分批：

| 文件 | 哪一次运行 |
| --- | --- |
| `00-baseline.log`、`gpu-forced.log` | 最初的两次：完全裸跑、以及把 GPU 兜底路也堵掉 |
| `01`–`06-*.log` | 六组矩阵（`appendSwitch` 传法）：`no-sandbox` / `+in-process-gpu` / `+disableHardwareAcceleration` / 三个齐全 / 只 `in-process-gpu` / `+disable-gpu-shader-disk-cache` |
| `gpu-process-sample.log` | 采样那次：渲染进程命令行长什么样 |
| `sightings-*.log` | 三次进程表采样（GPU 启用 / GPU 启用 + 不沙箱 / 裸跑）；脚本数出来的计数（`browser=34 renderer=33 utility=34`）在 `../sightings.txt` 每段末尾 |
| `timeline-*.log` | 每秒记一次窗口可见性（带 / 不带 GPU 旗标） |
| `real-shell-screenshot.log` + `real-shell.png` | 真外壳走自己的 `--screenshot` 路：整窗 1280×820 画出来了 |
| `shadercache-flag-on.log` | 全新 profile 里开着 `disable-gpu-shader-disk-cache` 跑一次，看缓存目录建不建 |
| `provenance-*.log` | 同一组开关分别用 `appendSwitch` 与真命令行传：`app.commandLine.hasSwitch()` 与子进程命令行各看到什么 |
| `cmdline-truncation.log` | 量 `Get-CimInstance` 报告的命令行有多长（browser 184 / utility 871 / renderer 1069） |
| `final-validation.log` | 量具改完之后的收尾校验 |
| `stall-*.log` | 修量具 bug **之后**的 6 次复跑（3 次带 `disableHardwareAcceleration`、3 次不带） |
| `../matrix-output.txt`、`../matrix-argv.txt` | 两种传法各自的矩阵 stdout |
| `../sightings.txt` | `gpu-sightings.ps1` 三次运行的 stdout。每段先是那 3 个探针 **controller** 的日志，末尾一行才是脚本自己数出的进程类型计数——**它不是进程表的原始 dump** |

> **`gpu-forced.log` 那一行要看清楚**：它是本票**第一次**探针（`enable-unsafe-swiftshader`），
> WebGL 因此是 **SwiftShader**，帧 median 16.6 ms ≈ 60 Hz（其余各轮 4.2 ms ≈ 240 Hz，没被 vsync
> 限住）。**别把这两个数字读成"软件渲染慢 4 倍"**——它们量的是有无限帧，不是每帧成本。详见
> `../minimal-switch-set.md` §4。

**一个读日志的坑**：`Get-Content` 按机器的 ANSI 代码页读，中文会显示成乱码（`新建会话` → `鏂板缓浼氳瘽`）。
那是读法的问题，不是写入的问题——要核对中文，用编辑器打开，或者别管它（结论不依赖中文字符串）。

结论、每一条对应的证据、以及给 03 号的落地建议在
[`../minimal-switch-set.md`](../minimal-switch-set.md)。
