# 01:smoke 全套隔离 agent home——不再写真实 `~/.my-agent`

Type: task
Status: open
Blocked by: 无

## Question

2026-10-31 的真实事故:历次 smoke 跑在真实 agent home 上,把用户的
`models.json` 覆盖成假行(`scripted` @ `127.0.0.1:1`,连 key 都只剩假的),
并在 `sessions/` 里留下 216 个指向 Temp 临时目录的工作区、1500+ 条假会话,
侧边栏被埋,每条消息 Connection error。备份与清理见
`.scratch/home-cleanup-20261031/`。

根因:`packages/core/src/config.ts` 的 `AGENT_HOME` 在**模块导入时**读
`process.env.MY_AGENT_HOME`,而绝大多数 smoke 静态 import `@my-agent/core`
后直接建 SessionHub——sessions 与 models 全部落进真实 home。只有
smoke-mux-live 给了 `settingsHome`,smoke-boot 自带封闭 home。

要做的事:

1. 找一条**单点**修法并落地,候选:
   - 所有 smoke 经 `npm run smoke:<name>` 包装脚本跑,包装里
     `MY_AGENT_HOME=$(mktemp -d)`;README「验证一次构建」同步改;
   - 或每个 smoke 第一行 `process.env.MY_AGENT_HOME = await mkdtemp(...)`
     再 `await import("@my-agent/core")`(静态 import 全改动态,机械化);
   - 或 core 提供 `configureAgentHome(dir)` 测试入口,导入前无可变状态。
   权衡后选一个,宁动 README 也不留「有的 smoke 隔离、有的不隔离」的中间态。
2. `AGENT_HOME` 是 const:确认修改后没有任何路径能在导入后改变它指向的真实
   home(密钥红线仍成立)。
3. 回归:任意挑三个今天污染过的 smoke(建议 smoke-projection /
   smoke-session / smoke-approval),跑完确认 `~/.my-agent/sessions` 零新增。
4. 顺带审一遍 `scripts/snapshot.mjs`、`scripts/wire/*` 有没有同样的写面。
