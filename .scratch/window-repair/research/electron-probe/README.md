# 票 01 的 Electron 探针

冒烟（`scripts/smoke-desktop-observability.ts`）用假对象驱动 `observability.cjs`，它回答不了两件事：**真的
窗口会不会把说明页画出来**，以及**真的死掉的子进程/渲染进程到达处理器时字段长什么样**。这里三个探针
就是为这两件事留的现场记录。它们**不在构建图里**，要手工用 Electron 二进制跑。

跑法（每个探针都要求一个同名目录里的 `package.json` 指出 `main`，因为 Electron 加载的是**目录**）：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # 否则 Electron 退化成普通 Node
$e = "$PWD\packages\desktop\node_modules\electron\dist\electron.exe"

# ① ④ 那条没验过的路：渲染进程死后，data: 页还画得出来吗
New-Item -ItemType Directory -Force .scratch/window-repair/research/electron-probe/probe-renderer-report | Out-Null
Copy-Item .scratch/window-repair/research/electron-probe/package-renderer-report.json `
          .scratch/window-repair/research/electron-probe/probe-renderer-report/package.json
& $e "$PWD\.scratch\window-repair\research\electron-probe\probe-renderer-report"

# ② 真窗口里的报告：启动失败页 + 真崩一次渲染进程
New-Item -ItemType Directory -Force .scratch/window-repair/research/electron-probe/probe-window-report | Out-Null
Copy-Item .scratch/window-repair/research/electron-probe/package-window-report.json `
          .scratch/window-repair/research/electron-probe/probe-window-report/package.json
& $e "$PWD\.scratch\window-repair\research\electron-probe\probe-window-report"
Get-Content .scratch/window-repair/research/electron-probe/probe-window-report.log
```

## 实测结果（2026-10-16，Electron 44.5.1，本机）

`probe-renderer-report`：

```
probe: render-process-gone {"reason":"crashed","exitCode":2}
probe: main process is alive; webContents destroyed=false crashing=true
probe: step 1: can the inline data: page draw in the renderer that replaced the dead one?
probe: step 1 result: loadURL settled, the page says: report after a renderer crash
```

→ **`data:` 页是首选面**：渲染进程死了会换上新的，新的那个照画。这条就是票 ④ 要的那个事实。

`probe-window-report`（探针自己的窗口工厂用 `show: false`，和外壳的一样，所以"谁来显示这张窗口"是被测的那件事）：

```
probe: LOG desktop: agent 服务没有启动起来 —— Error: the server entry is missing at C:\nope\boot.ts
probe: 1 result: visible=true {"heading":"agent 服务没有启动起来","body":"agent 服务没有启动起来\nthe server entry is missing at …"}
probe: LOG desktop: the renderer went away (crashed, exit code 2)
probe: 2 result: a report window opened; visible=true {"heading":"窗口的渲染进程没了","body":"… exit code 2 …"}
probe: 2 result: dialog calls so far: 0 …        ← 页面画出来了，原生对话框没被用到
```

→ 报告在**真窗口**里画得出来、**真的显示出来**（`visible=true`），渲染进程真崩一次会开一张说明窗口而
不是留一个不重绘的窗口。

**这条 `visible=true` 修掉的是一个真洞**：外壳原来那张说明窗口是 `createWindow()` 出来的，而它只挂
`ready-to-show` 才 `show()`——`data:` URL **不触发 `ready-to-show`**，所以失败页原来画进了一张永远不显示
的窗口。现在报告走 `did-finish-load`（页面到达就显示），并且这一条被
`smoke-desktop-observability.ts` 的 §2 钉住。

> 日志文件是 UTF-8，用 `Get-Content` 读会按机器 ANSI 代码页显示成乱码（例如 `桌面` → `妗岄潰`）——这是
> 读法的问题，不是写入的问题。要核对中文，用编辑器打开。

**跑不到的那条**：`child-process-gone` 的真实触发。`in-process-gpu` 之下 GPU 不再是子进程，唯一的子进程
是 network service，而**杀掉它整个应用跟着死**（这个探针第一次就是这么结束的：第一版探针 kill 掉
network service 之后日志停在 `3: child processes to kill`，没有下一行）。所以那条路只能由冒烟用假事件
钉格式；真机的触发（GPU 连崩）今天被 `no-sandbox` 规避了，见 02 号。
