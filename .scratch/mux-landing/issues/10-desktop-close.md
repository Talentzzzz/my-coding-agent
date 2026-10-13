# 10 - 桌面外壳关停顺序

Type: task
Status: resolved
Blocked by: 04

## Question

`packages/desktop/main.cjs` 的 `before-quit`：常驻连接下"没人会主动结束的响应"是最坏情况，关停顺序按 mux 连接层（票 04）的 `close()` 语义重排，保证窗口退出时进程能干净结束。

## Answer

**2026-10-13 落地。** 顺序被真正重排的地方是"服务器先下去、进程后走"，而不是 `close()` 内部（那一段票 04 已按 `connections → sessions → listener` 落地）。

**1. 新文件 `packages/desktop/shutdown.cjs`：关停序列搬出 `main.cjs`，`app` 按参数传入。** 一个理由，和 `boot.ts` 把 `muxUpgrade()` / `sessionListeners()` 抽出来是同一条：冒烟里重写一遍这些行，证的是脚本自己那份副本。这个文件不碰任何 Electron API，只对 `app` 调两个方法（`quit` / `exit`），所以能用假 app 驱动**真的**那段序列。它是 CJS——外壳就是 CJS。

**2. 顺序（`beforeQuit`）**：

- 第一次 `before-quit` **`event.preventDefault()`**——Electron 的 quit 不等 promise，不拦住的话进程会在 `close()` 中间被拆掉，而这在常驻连接下是常态不是例外；
- `close()`：连接（订阅在会话还在时就释放）→ 会话 → listener，**upgrade 之后的 socket 随 listener 一起 `destroy()`**（`http.ts` 自持的那份集合）——正是票 04 + 票 17 实测的结论，所以这里等的是一个会返回的 promise，不是一条永不结束的响应；
- 服务器引用在 `await` **之前**清掉，且不只为防重入：macOS 的 `activate` 会照 `server.url` 重开窗口，一个正在下去的服务器不该是那个 URL；
- 落定后**第二次 `app.quit()`**，这一次 `inFlight` 直接放行 → `will-quit` → 退出。

**3. 预算 5 s，超时 `app.exit(0)` 并记一行日志。** 取的是 `smoke-boot.ts` 断言 `close()` 返回时用的同一个数（"最坏情况在场时 `close()` 在预算内返回"）——过了它，服务器不是慢而是卡住了，而"关不掉的 app"比"少写最后一次"更糟。旧代码那种"发出去不管"永远不会卡住 app，这个性质不能顺手丢掉。

**4. 与旧图票 15 §4 那句"`void closing.close()` 不 await 这一条不动"的关系。** 那句是"落地时不必改"的实现注记，理由写在它后面——"Electron 的 quit 不等它，而进程退出本身会关掉 socket"。本票要的正是**让 Electron 等**：拦住第一次 quit、等 `close()`、再要一次。它没有动票 15 的决定 8（mux 自持 upgrade 后的 socket 并在 `close()` 里 `destroy()`、不拿 `closeAllConnections()` 当机制），也没有动任何 wire/会话语义。

**5. `scripts/smoke-desktop-close.mjs`（新，纯 Node，不需要 Electron 也不需要供应商密钥）**：四组——①有服务器：第一次 quit 被拦、`close()` 期间没有 quit、`close()` 落定**先于**第二次 quit、重入的那次不再被拦、`close()` 与 `quit` 各一次、预算没触发；②`close()` 抛错：照样退出、不是放弃路径、日志带原因；③`close()` 永不落定：按给定预算（20 ms）走放弃路径、不装作正常退出、日志写明；④还没服务器就 quit：连拦都不拦。末尾照 `smoke-boot.ts` 的形状放一条 **`unref()` 的自然退出看门狗**——预算定时器若没被清掉，进程就被它自己抓住。27 条断言，0.36 s 自行退出。

**验证**：`npm run check` 绿（tsc ×4 + token 审计）；`npm run smoke:boot` 绿（含"最坏情况在场时 `close()` 返回"与"子进程带一条常驻连接退出"）；`node scripts/smoke-desktop-close.mjs` 绿。另有一次**真实 Electron 的临时探针**（未提交，`app.disableHardwareAcceleration()` 起、不建窗口）驱动真的 `shutdown.cjs`，实测事件序 `quit → close → settled → quit → will-quit`、`process 'exit'` 的 code 为 0——即"进程确实等到 `close()` 落定之后才走"。

**本票没有回答 / 登记备查**：

- **窗口那条路径里，窗口先没了。** Windows 上 X 按钮是 `close` → `window-all-closed` → `app.quit()` → `before-quit`，所以渲染进程的常驻连接在 `close()` 之前就随窗口断了，订阅是经 socket 关闭（`mux.forget` → `teardown`）释放的，不是经 `mux.close()`；"订阅在会话还在时释放"这条语义在这一条路径上因此发生在窗口消失**之后**。结果不受影响（会话由 `hub.close()` 收尾），故不为此拦 `window` 的 `close` 事件——那要引入一个"拦住了就必须自己把窗口关掉"的重入面，换不到任何可观察的东西。
- **`--screenshot` 那条路径（`app.quit()` 在窗口还活着时调用）现在走完整顺序**：捕获运行会在服务器关干净之后才退出。
- **这台机器上没法跑带真窗口的端到端**：GPU 进程崩（`GPU process isn't usable. Goodbye.`），带窗口的外壳起不来。所以窗口 + 常驻连接那一半由 `smoke-boot.ts` 的最坏情况承载，本票的探针证的是 Electron 的退出语义与 `shutdown.cjs` 的次序。
- `packages/desktop/scripts/inspect.cjs` 自己 `await server?.close(); app.quit();`，没有 `before-quit` 处理器，因此不存在本票这条竞态；它是开发脚本，未动。
