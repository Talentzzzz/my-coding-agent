# 005：依赖方向守卫——check 里加一条 loop 边界检查

- label: wayfinder:task
- status: open
- assignee:
- blocked-by: 004-landing

## Question

0012 时代「依赖方向成了可检查的事实」靠的是 loop-manager.ts 值层面不 import agent.ts。
这次形状是白名单回调，等价的不变量是：**loop 对 Agent 的认识只能来自 loopOptions 里
传进来的回调与数据，不能 import `agent.ts`**。这票在 `npm run check` 里加一条
（仿照既有 `check-server-facade` 的做法）静态检查这条边界，并把它写进 ADR-0022 的
「后果」节（若落地时 ADR 还没关，直接补；已关则在票 resolution 里留一行、map 的
Decisions so far 记一笔）。
