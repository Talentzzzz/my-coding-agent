# 1 外壳的失败面必须看得见

Type: task
Status: resolved
Blocked by:

## Question

今天 `packages/desktop` 里**没有任何崩溃观测**：`child-process-gone`、`render-process-gone`、
`gpu-process-crashed`、`uncaughtException`、`showErrorBox` 一律 **0 处**；而
`await mainWindow.loadURL(...)`（`main.cjs:247`）**不在 try/catch 里**。10/13 那次 GPU 连崩之所以要靠
人肉翻日志与转储才看清，正是因为这两个洞——用户那份排查记录是**手工**做出来的。

要落的是**观测面**，不是策略：

1. **子进程死亡（GPU / network / renderer）要说一句话**——窗口上或日志里，而不是"什么都没发生"；
2. **`loadURL` 失败要被抓住并报告**——它自己的注释点名了 `ERR_FAILED`，代码却没接；
3. **`bootServer` 要有超时**——现在它**挂起**（而不是拒绝）的话就是永远没有窗口、没有日志
   （`main.cjs:232-238` 只接 reject；`shutdown.cjs:21` 有预算，boot 没有）；
4. **报告走哪儿**要从"渲染坏掉时哪条路还画得出来"来定：原生 `dialog.showErrorBox`，还是现有的内联
   `data:` 页面 `reportStartupFailure`（`main.cjs:180-197`）——**今天连这个都没验过**，而
   `data:` 页面在一个渲染进程也崩掉的机器上能不能画出来，正是最该知道的那件事。

**超时/重试的"策略"（等多久、重试几次、要不要换端口重来）不在这张票里**——那是 map 的雾。这票只让
失败**可见**。

按本仓库惯例跑 `npm run check` 与 `smoke-desktop-close`（外壳退出顺序）。

## Answer

### ④ 那条没验过的路，先验：`data:` 页在渲染进程死后画得出来

`webContents.forcefullyCrashRenderer()` → `render-process-gone {reason:"crashed", exitCode:2}`：
**主进程活着，`loadURL(data:…)` 随后 settle，新渲染进程把页面画出来并答出了它自己的标题**
（`.scratch/window-repair/research/electron-probe/probe-renderer-report.cjs`，本机 Electron 44.5.1，
实测原文：`step 1 result: loadURL settled, the page says: report after a renderer crash`）。所以**页面是
首选面**，原生对话框只在"连页面都画不出来"时兜底。这台机器上 `showMessageBox` 在有窗口时不会自己
settle（探针里 5 s 超时），这正是 `showErrorBox` 只能是兜底、不能是首选的原因：它会阻塞到有人点掉。

### 落成的形状

`packages/desktop/observability.cjs`（新）——和 `shutdown.cjs` 同一条理由独立成文件：**冒烟要用假对象
驱动真的处理器**，写在 `main.cjs` 里的行是驱动不了的。Electron 的一切都从参数进来（`app`、窗口工厂、
`boot`、`dialog`、`windowFor`），所以它能在纯 Node 里被 import。

- ① `child-process-gone` → 一行日志：`GPU process GPU Process went away (crashed, exit code
  0xC0000005)`（`${type} process ${name} ${why}`）。负的 Windows 退出码按转储里的十六进制打
  （`0xC0000005` 就是 10/13 那个 `-1073741819`）；`clean-exit` 单独成句，不冒充崩溃。
- ② `render-process-gone` → 一行日志 **+ 一张说明窗口**（`createWindow()` 造的真窗口，画 `data:` 页）。
  同一个窗口的第二次死亡只记日志，不再弹第二个窗口；已经关掉的窗口什么都不弹。
  **顺手修掉一个真洞**：原来那张说明窗口只挂 `ready-to-show` 才 `show()`，而 `data:` URL
  **不触发 `ready-to-show`**——失败页画进了一张永远不显示的窗口。现在报告走 `did-finish-load`，
  真窗口实测 `visible=true`。
- ③ `bootServer` 进 `bootWithinBudget()`：预算 **20 s**（`BOOT_BUDGET_MS`）。挂起和拒绝现在都是
  "一行日志 + 说明窗口"，不再是永远没有窗口。**预算之后才到达的启动会补一行**——"慢"和"卡死"因此
  分得开，而不是靠猜。策略（重试、换端口）按票面不在这里。
- ④ `await mainWindow.loadURL(booted.url)` 进 try/catch → `observability.report(LOAD_FAILED_HEADLINE,
  error)`。macOS `activate` 重开窗口那条 `loadURL` 也接了，标题由 `observability.cjs` 导出的一处常量给
  出，两个失败点不会各写各的。
- 主进程的异常 → 报告（日志 + 窗口），**进程留着**：`uncaughtException` 与 `unhandledRejection` 都接
  （后者不加就整类失败保持沉默）。这不是"策略"：外壳的两件事（服务器、窗口）都是别人的子进程，进程死在
  一次杂散异常上，代价是用户正在进行的对话。理由写在模块里。
- 原生 `showErrorBox` 只在一处兜底，而且是**两种**到不了页面的情况：说明页自己 `loadURL` 失败，或者连
  窗口都造不出来（`createWindow()` 抛）。两者都验证过，包括它自己抛异常也不会把进程带走。
- **语言**：诊断行是**英文**，与这台外壳既有的诊断一致（`shutdown.cjs` 与 `main.cjs` 自己的
  `desktop: …` 行都是英文；AGENTS.md 把诊断划给中文，外壳是那里的既定例外，新模块跟邻居一致比一半中文
  一半英文更小；这一点写进了模块头与 `docs/architecture.md`）。页面与原生对话框里的文案是**中文**，
  因为那是窗口文案。

### 证据

- `node scripts/smoke-desktop-observability.ts`（新，已进 `tsconfig.json` 与 README 的*验证一次构建*）
  ——假 app/窗口/对话框驱动真模块，**46 项全过**。
- 真窗口实测（`.scratch/window-repair/research/electron-probe/`，走真模块 + 真 `BrowserWindow`，
  探针的窗口工厂用 `show: false`）：
  1. `report("agent 服务没有启动起来", …)` → `visible=true`，窗口里读到
     `{"heading":"agent 服务没有启动起来","body":"… the server entry is missing at C:\\nope\\boot.ts …"}`；
  2. `forcefullyCrashRenderer()` → 日志行 `the renderer went away (crashed, exit code 2)`，**另一张说明
     窗口**打开、`visible=true`，读到 `{"heading":"窗口的渲染进程没了","body":"… exit code 2 …"}`；原生
     对话框 0 次（页面画出来了，不需要它）。
- 真外壳跑通：`npm run desktop` → `desktop: server on http://127.0.0.1:49401  workspace …`，窗口开出
  来、45 s 内 stderr 空、无崩溃。
- `npm run check` 退出码 0（token 审计 127 defined / 101 referenced）；
  `node scripts/smoke-desktop-close.ts` 全过（退出顺序没被动过）。

### 一条诚实的边界

本机跑不到 `child-process-gone` 的**真实**触发：`in-process-gpu` 之下 GPU 不再是子进程，而唯一的子进程
是 network service——**杀掉它整个应用就跟着死**（探针第一次就是这么结束的），所以那条路只能由冒烟用
假事件钉住格式。真机 10/13 的触发是 GPU 连崩，那条路今天被 `no-sandbox` 规避了（02 号）。

