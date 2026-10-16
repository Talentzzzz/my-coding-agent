# 01 桌面端启动验证与修复

Type: task
Status: resolved
Label: feature

## Question

用户已把机器切成独显直连。原样 `npm run desktop` 启动一次，验证 `.scratch/../../../问题/启动.md` 里记录的两条崩溃路径（GPU 进程 0xC0000005、渲染进程沙箱 0x80000003）是否消失：

- 启动成功 → 无需任何固化，在 Answer 里记录结论。
- 仍崩 → 按已定决策把 `--disable-gpu --no-sandbox` 固定加进 `packages/desktop/scripts/launch.mjs`（或 main.cjs 的命令行开关），注释用英文说明是本机 GPU 驱动 + 沙箱冲突所致。

注意：从 AI 代理的沙箱 shell 里启动可能自身就带着作业对象，复现出沙箱冲突不一定是机器本身的结论；以用户在自己终端里启动的结果为准。

## Answer

- **独显直连没有解决问题**：改完后原样启动，症状与 `问题/启动.md` 完全一致——GPU 进程连环 `0xC0000005`、渲染进程 `0x80000003`、最后 `GPU process isn't usable. Goodbye.`，GPU 持久缓存 0x20 文件锁照旧刷屏。结论：崩溃与显示模式无关，GPU 驱动路径本身在这台机器的 Chromium 下不可用。
- **按预案固化**：`packages/desktop/main.cjs` 顶部（app ready 之前）加了 `app.disableHardwareAcceleration()` 与 `app.commandLine.appendSwitch("no-sandbox")`，英文注释说明原因并指向 `问题/启动.md`；注释里写明换机器后删这两行即可恢复硬件加速。没动 `launch.mjs`——固化在 main.cjs 里无论从哪个入口启动都生效。
- **验证通过**：`npm run desktop` 重新启动，server 正常监听，stderr 无任何崩溃日志，进程持续存活，窗口正常打开。

