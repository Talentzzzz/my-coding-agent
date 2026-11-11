# 005：依赖方向守卫——check 里加一条 loop 边界检查

- label: wayfinder:task
- status: closed
- assignee: WorkBuddy（2026-11-12 实现会话）
- closed: 2026-11-12
- blocked-by: 004-landing（已解除）

## Resolution

守卫落地，`npm run check` 全绿。ADR-0022 状态是「已接受」但状态行明写「落地归票 004 / 005」，
「后果」「尚未决定」都给本票留了补写口子（票 004 补行数账同例），故按票面第一条路直接补 ADR；
票 resolution 照留（本节），map 的 Decisions so far 记一笔。

1. **`scripts/check-loop-boundary.ts`**（仿 `check-server-facade` 的正则小脚本），两条一起查：
   - **负向**：`loop-manager.ts` 不得在 **import 位置**（`from` / `import` 之后）引用模块说明符
     以 `/agent.ts` 结尾的路径——静态 import、side-effect import、`export … from`、动态
     `import()` 同一个正则命中；`./` 与 `../core/` 两种写法都算。注释先剥掉（facade 守卫的
     `withoutComments` 同一套写法照搬，本脚本不 import 它），loop 头上那条「绝不 import
     `agent.ts`」的文档注释不触发它；`./session/agent-state.ts`、`./context/agents-md.ts`
     这类近名说明符不误伤（`agent\.ts` 前必须有 `/`），普通字符串里的路径字样也不误伤
     （说明符必须紧跟 `from` / `import`）。
   - **正向**：`agent.ts` 必须仍 import `loop-manager.ts` 的公开面——决定 5 的单向性两个
     方向都钉住，守卫不因边界消失而空转；任一文件不存在时报错（守卫点名了目标，目标挪走
     属于须随 ADR 重开本守卫的事，不是静默放行）。
2. **接进 `npm run check`**：追加在 `check-server-facade` 之后，全绿输出
   「loop 边界 ok：loop 不 import agent.ts，方向单向」。
3. **自测**：临时 fixture 验证——loop 静态 import `./agent.ts`、side-effect `import "./agent.ts"`、
   `await import("./agent.ts")` 三种形式全报警；注释、普通字符串（含 `../core/agent.ts` 路径
   字样）、近名说明符不报警；agent.ts 缺 loop import 报警；真文件跑通 exit=0。
4. **文档收账**：ADR-0022「后果」末 bullet 改「行数账与守卫均已补」并记守卫口径；
   「依赖方向再次可检查」bullet 补脚本名；「尚未决定」第 3 件标**已定（票 005）**。

无 smoke 需要：本票不碰运行时，`npm run check`（core/server tsc + token 审计 +
server 门面守卫 + 本守卫）是唯一验证面。

随本票一并（用户指示）：`AGENTS.md` 的注释语言约定由「源码注释用英文」改判为
「文档与源码注释用中文，可保留必要的英文」，原规则与其两个既有例外一并作废。

## Question

0012 时代「依赖方向成了可检查的事实」靠的是 loop-manager.ts 值层面不 import agent.ts。
这次形状是白名单回调，等价的不变量是：**loop 对 Agent 的认识只能来自 loopOptions 里
传进来的回调与数据，不能 import `agent.ts`**。这票在 `npm run check` 里加一条
（仿照既有 `check-server-facade` 的做法）静态检查这条边界，并把它写进 ADR-0022 的
「后果」节（若落地时 ADR 还没关，直接补；已关则在票 resolution 里留一行、map 的
Decisions so far 记一笔）。
