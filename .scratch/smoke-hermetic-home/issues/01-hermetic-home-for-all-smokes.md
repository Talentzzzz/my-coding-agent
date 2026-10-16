# 01 所有 smoke 都共用真实 agent home：把票 10 的 scratch home 样板推广到每一个会写会话的入口

Type: task
Status: open
Blocked by:

## Question

2026-10-16 票 10 修 `smoke:boot` 时发现：本仓库**每一个**直接建会话或起服务器的 smoke 都把测试会话
写进了机器真实的 `~/.my-agent/sessions/`。当天清了两轮，共 **369 个**残留目录、**十几种前缀**
（`my-agent-mux*` ~120、`my-agent-stream-*` ~60、`my-agent-approval*` ~30、`my-agent-liveness*` ~20、
`verify19/20/22`、`repro*`、`projection`、`mux-bp/check/dbg/review`、`probe*`、`diag`、`shots`、
`session(s)`、`settings`、`tools`、`wire`、`ws-check`、`dbg`——完整证据在
[map.md 的 Notes](../map.md)）。这病只会再犯：下次跑一遍 README 清单就又长出几十个，
侧边栏的假工作区也跟着涨。

**根因只有一个**：会话文件统一写在 `<AGENT_HOME>/sessions/--<cwd 虚线化>--/`
（`packages/core/src/session/paths.ts`），而 `AGENT_HOME` 是 **import 时刻**从 `MY_AGENT_HOME`
解析的常量（`packages/core/src/config.ts:6`）——smoke 不隔离 home，测试会话就落在真实 home。
README 那条"`finally` 必须删 `workspaceDir(root)`"只是半个修法：它拦不住 **settings 写进真实
home**（`SettingsManager.create` 的 global 层就是 `AGENT_HOME`），票 10 还证明它拦不住
models.json 被读到、更拦不住一次崩溃跳过 finally。

**要落的**：

1. **先取证**：对 README 清单里的每个 smoke（`smoke-mux-live`、`smoke-liveness`、`smoke-tools`、
   `smoke-session`、`smoke-sessions`、`smoke-approval`、`smoke-projection`、`smoke-mux`、
   `smoke-backpressure`、`smoke-models`、`smoke-sidebar`、`smoke-transcript`、`smoke-api`……）
   快照 `~/.my-agent/sessions/` 前后对比，列出**哪些真的会写**、哪些本来就不写（比如纯协议的
   `smoke-mux-client`）——动手名单以证据为准，不许凭猜。scripts/ 下残留的一次性
   verify/repro/probe 脚本顺手过一遍，还活着的纳入、死掉的记一句删不删。
2. **样板推广**：以
   [window-repair 票 10](../../window-repair/issues/10-smoke-boot-red.md)
   （落地见 `scripts/smoke-boot.ts` 头部注释）为权威样板——scratch home 先建好（写好自带模型的
   `models.json`，无需密钥）→
   `process.env.MY_AGENT_HOME = <scratch>` → 应用模块**动态 import**（静态 import 会先于 env
   赋值求值，这是唯一一处玄机）→ finally 随工作区一起删除。十几个 smoke 逐份照抄还是提一个
   `scripts/agent-home.ts` 共享装置，动手时按第一份的形状定（倾向共享，两行接入）。
3. **验收就是票面那句话**：跑完整份 README smoke 清单，`~/.my-agent/sessions/` 前后快照**零变化**；
   `npm run check` 与全部 smoke 保持绿。README 的「两个坑」一段扩成三个（或改写成指向共享装置），
   把"隔离 home"立成约定。
4. **不做的**：桌面外壳、`npm run dev`、`smoke-api` 的**被测**服务器本来就该用真实 home，不在
   本票范围；`smoke-api` 自己的归属问题记在 map 的 Not yet specified，随本票顺手定即可。

## Answer
