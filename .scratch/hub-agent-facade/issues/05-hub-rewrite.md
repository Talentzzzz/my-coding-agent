# 05 hub 重写：只认 Agent

Type: task
Status: closed
Blocked by: 04

## Question

按 01 的映射重写 `hub.ts`：import 里不再出现任何 Manager 与 `createSession` /
`readSessionSnapshot`，`agentState()` 直读清零；hosts / claims / observers / waiting / reaping
这些传输层状态留在 hub（ADR-0001 的界线不动）。注释按新形态改写（引用新 ADR 编号）。

## Answer

机械部分（import、`agentState()` 直读、四个私有构建方法）已随票 04 落地并记在那边的 Answer 里；
本票做剩下的注释改写，外加一处机械迁移的漏网死字段。`npm run check` 绿（tokens ok），
smoke-boot / tools / sessions / projection / mux-client / mux-live / mux / liveness / backpressure /
settings / modes / session / models / default-model / approval / approval-endpoint /
approval-recovery 十七条全 PASS，smoke-api 对临时端口的服务器 PASS（smoke-approval 本轮未闪失）。

### 注释改写（引用新 ADR 编号 = ADR-0017，票 08 落地时必须占用这个号，否则回来改这批引用）

- 三处 `ADR-0007 §6` 引用改 `ADR-0017`：`HostedSession` 类文档（「the process's one
  orchestrator」）、`SessionHub` 类文档（「one orchestrator serves every id」）、`agent` 字段文档
  （「the only consumer of the process's managers」）——hub↔编排层↔Manager 的界线从此归新 ADR 叙述。
- 构造函数行内注释补上 `(ADR-0017)`（「the managers are the orchestrator's own」）。
- 「the store」措辞清零：`fork` 行内注释（「the held bag's own file, or the facade's disk scan」）、
  `remove` 行内注释（三处改 facade 口径，且删掉「the store has nothing to delete」的旧说法）。
- `fork` 文档里一句旧形态残留重写：原「Only `close` moves the orchestrator's table」已不实
  （`evict` 同样移表）——改为「门面的 `forkFrom` 只写两个文件、不 adopt 任何东西（ADR-0017）；
  状态只经编排层自己的 close 与 evict 离表，从不经 hub 之手」。
- `absRoot` 文档删掉对已删字段的悬空 `{@link HostedSession.workDirAbsPath}`，改说：会话自己的
  目录由表持有、hub 不需要副本——fork 的源路径解析在门面里（ADR-0017）。

### 票外偏离：摘除死字段 `HostedSession.workDirAbsPath`

它存在的唯一理由是 fork 的 held 路源解析（读 host 上的目录再定位源文件），票 04 已把那半搬进
门面的 `forkFrom`；全仓（packages + scripts）确认零读者。构造参数随之收缩，唯一外部构造点
`scripts/mount-session.ts` 同步改一行。`open()` 行内注释相应改述「并发 open 下跑在赢家上」的
保证来源（门面的 id 读回）。

### 连带标记（留给票 07 验收裁定，本票不动 core）

摘字段让 `Agent.workDirOf` 与 `Agent.fileAbsPathOf` 成为零消费者（前者是票 01 映射表里点名的
方法，砍它是公开面裁定）：`workDirOf` 原本就只服务 hub 的这一处；`fileAbsPathOf` 的文档
「A fork names the source by this path」也已不实（`forkFrom` 在门面内部解析，不经它）。
两者去留随票 07 与票 08 的新 ADR 一起收。
