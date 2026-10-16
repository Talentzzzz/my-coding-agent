# Map：smoke 的封闭 agent home

`wayfinder:map`

## Destination

让 `~/.my-agent/sessions/` 不再被任何一次 smoke 运行弄脏：**跑完 README 清单里的全部 smoke，
`~/.my-agent/sessions/` 的目录清单前后零变化**——测试会话要么落在 smoke 自己的 scratch home 里、
要么被 finally 删干净。侧边栏里那一排 `Temp\probe-xxx` 式的假工作区从此不再增长。

## Notes

**领域与证据。** 本仓库的会话文件统一写在 `<AGENT_HOME>/sessions/--<cwd 虚线化>--/` 下
（`packages/core/src/session/paths.ts`），而 `AGENT_HOME` 是 **import 时刻**从 `MY_AGENT_HOME`
解析的常量（`packages/core/src/config.ts:6`）。凡是直接 `SessionManager.create` / 起真服务器的
smoke，都会把测试会话写进**机器真实**的 home——票 10 修的 `smoke:boot` 只是其中一个。

**清理史（本票的由来）。** 2026-10-16 在票 10 收尾时清过两轮残留，共 **369 个**目录、全部出自
本仓库的 smoke/量具：36 个 `my-agent-boot-*`（票 10 修复前）+ 333 个 Temp 工作区目录
（~3.6 MB）。前缀清单（按多少排）：`my-agent-mux*`（mux / mux-live，~120）、`my-agent-stream-*`
（~60）、`my-agent-approval*`（含 grace / cross / restart 变体，~30）、`my-agent-liveness*`（~20）、
`my-agent-verify19/20/22`、`my-agent-repro16/19/22`、`my-agent-projection*`、`mux-bp/check/dbg/review`、
`probe*`、`my-agent-diag*`、`my-agent-*shots*`、`my-agent-session(s)`、`my-agent-settings`、
`my-agent-tools`、`my-agent-wire`、`my-agent-ws-check`、`dbg`。清掉的都进了回收站，备份在
`%TEMP%\my-agent-boot-backup-2026-10-16\` 与 `%TEMP%\my-agent-sessions-cleanup-backup-2026-10-16\`。

**样板已存在。** [票 10](../../window-repair/issues/10-smoke-boot-red.md) 的修法是**权威样板**：
scratch home 先于一切应用模块 import 建立（写好自带模型的 `models.json`）→ 设
`process.env.MY_AGENT_HOME` → 应用模块全部**动态 import** → finally 随工作区一起删除。
静态 import 会先于 env 赋值求值，这是唯一一处容易踩的坑。回收站的 VB API 在本机
**报假异常但实际成功**（`Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory` 抛
FileNotFoundException、目录已进回收站）——验证要以目录计数为准，别以异常为准。

**哪些入口要清查（动手时逐个取证，不许凭猜）。** 至少包括：直接起服务器的
（`smoke-mux-live`、`smoke-liveness`、`smoke-boot`✅、`smoke-api` 的被测服务器）、直接
`openAgent`/`SessionManager` 的（`smoke-tools`、`smoke-session`、`smoke-sessions`、`smoke-approval`、
`smoke-projection`、`smoke-mux`、`smoke-backpressure`、`smoke-models`），以及一次性
verify/repro/probe 脚本（scripts/ 下残留的那些，逐个看有没有还活着的）。README 的
「两个坑」已要求 `finally` 删 `workspaceDir(root)`——但它没拦住
**settings 写进真实 home**（`SettingsManager.create` 的 global 层就是 `AGENT_HOME`），所以
删除工作区目录只是半个修法，隔离 home 才是整个。

## Decisions so far

<!-- 关掉的票依次列在这里：一行要点 + 指向该票的链接 -->

## Not yet specified

- **共享装置还是逐份照抄**：十几个 smoke 各自动态 import 一遍样板，还是提一个
  `scripts/agent-home.ts`（建 home、设 env、返回删除函数）让每份两行接入——样板只有一处
  import 顺序的玄机，倾向后者，等动手时按第一份的实际形状定。
- **smoke-api 的归属**：它测的是**别人起的服务器**，会话落在服务器的 home 里，smoke 自己隔离
  无效——README 那条 `npm run start & + smoke-api` 的组合要么文档里注明会写真实 home，
  要么换一个隔离的启动方式。
- **桌面外壳与 `npm run dev`**：它们**本来就该**用真实 home，不在本票范围。
