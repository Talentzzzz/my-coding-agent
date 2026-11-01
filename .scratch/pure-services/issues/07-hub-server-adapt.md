# 07:hub/server 适配——hub 只持单例,REST 处理器以 id 调用

Type: task
Status: resolved
Blocked by: 06

## Question

`packages/server`:hub 删除 per-session 的 Agent 实例簿与会话对象簿,只持五个
单例 + 一个共享 `Agent`;所有 REST 处理器改为以 URL 里的 sessionId 调用 Agent
的新签名方法。

- `createRoutes()` 与 `Router` 不解释任何新 URL;mux 帧与订阅表一字不改
  (ADR-0001 红线)。命令在被施加时作答的语义不变。
- claim 语义保持:改变会话的请求与在飞运行各在其长度内持 claim;订阅不拿 claim。
  取数路径变为「Manager 现取」后,复核 claim 覆盖点没有漏(接 08 后雾区的
  原子性问题,此处只保证不倒退)。
- 宽限计时、快照、审批端点(`POST /api/sessions/{id}/approvals/{toolCallId}`)
  的行为照旧,只是取数方式变了。
- desktop 外壳(`bootServer` 调用点)与 `session-factory.ts` 的残骸清理:
  不再需要的装配函数删除。

完成后 `npm run check` + `smoke-api.ts` / `smoke-mux.ts` / `smoke-mux-live.ts`
/ `smoke-boot.ts` / `smoke-backpressure.ts`。

## Answer

**结论:hub 现在只有五个单例、一个 `Agent`、一张 claim 表。** 一个编排层服务本进程跑的所有
会话——这正是 06 票把 Agent 做成无属性服务要换来的东西;06 票已把 hub/控制器的调用点全改成
id 首参,本票把它推到最后一步:不再每次打开 `new Agent`。

### 一个共享 Agent 的前提:三处 per-session 闭包搬家

`openAgent` 之所以是 per-open 的,不是因为 Agent 有状态,而是因为它当时的三个构造参数是
**会话级的闭包**。三处各有归处,都不进"聚合袋":

1. **hooks → 事件带 `sessionId`**。`context` / `before_tool` / `after_tool` 的事件各加一个
   `sessionId`(`hooks.ts`),Agent 在三个 `apply` 调用点传入。默认处理器随之变成进程级:
   `installDefaultHooks(hooks, agent, openSessions)`——闸门用 `event.sessionId` 调
   `authorize`,输出兜底从**登记处条目**取 workspace(条目不在就只做硬裁剪,不臆造归档目录)。
   这与 ADR-0007 §6「hooks 是进程级不可变配置」是一致的,只是把"处理器属于哪个会话"从闭包
   挪到了事件上。
2. **提示词构建器 → 收 `(workspace, agentsMd, toolNames, approvals)`**。前两样是那次打开的
   装配产物,所以 `OpenSession` 新增 `agentsMd` 字段(装配时 `loadAgentsMd` 读好,挂在条目上);
   Agent 每请求从条目里取,构建器自己不再捕获任何会话。语义不变:AGENTS.md 仍是"打开时读一次"。
3. **委派对 → `OpenSession.localTools`**。这是唯一真正与会话绑定的工具(`SubAgent` 闭包着父
   会话的 workspace/模型/transcript),它原来是 `createToolRegistry` 之后 `register` 进去的,
   于是**每个会话必须有自己的注册表**。现在它是装配字段,记在条目上;`registryView(registry,
   localTools)` 是"进程目录 + 该会话自有工具"的只读视图,Agent 每次解析工具时用它
   (`toolsOf(entry)`)。注册表本身回到进程结构,`ToolRegistry.register` 只剩"给测试加一个
   工具"这一条路。活跃集合的派生、`allTools`/`activeTools` 的快照字段都读同一个视图,窗口
   看到的与今天一致。

### session-factory 的拆分与残骸

- `ensureSession(options)`:**装配 + ensure 条目 + adopt 袋**(原 `openAgent` 的前半),返回
  它解析出的 `{ sessionManager, openSessions }`;
- `createSessionAgent(services)`:**registry + hooks + 提示词构建器 + 装默认 hooks → 一个
  Agent**,不再碰任何会话;
- `openAgent(options) = ensureSession + createSessionAgent`,保留给"要独占一个会话"的调用者
  (smoke、SubAgent 子会话);
- `installDefaultHooks(hooks, agent, openSessions)` 从原来的内联闭包提出来导出,两份构造
  因此共用同一套默认值(不会漂)。
- 删除:`SessionHub.sessionOver()`、`agentOptions()`(更名 `sessionOptions()`,并补上
  `openSessions`)、`assemble()` 里"把 subagent 工具注册进注册表"那条路。

### hub 与传输层

- `SessionHub` 新增 `readonly agent: Agent`,构造时 `createSessionAgent({...})` 建一次;
  所有 `host.session.X()` 变 `this.agent.X()`,控制器 `claiming()` 把 `hub.agent` 交给回调,
  投影的 feeds/快照/sessionManager 也走 `hub.agent`。mux 只经 hub 方法,**一字未改**;
  `createRoutes()`/`Router` 未动。
- `HostedSession` 只剩 `id` / `absWorkspaceRoot` / `claims` / `reaping`:它不再是"会话对象",
  而是**claim token**。这是本票唯一偏离票面的判断,见下面第一条判断性意见。
- claim 语义复核:不变的四处——`claiming()` 每次命令拿一个、`release()` 退一个;订阅仍不拿;
  `reap` 仍先 `settle` 再判宽限,`settle` 等的就是"在飞运行";ticket 06 在 `reap` 里加的
  "每拍校验 host 仍归本 hub"原样保留(条目现在由 hub 的 `openSessions` 持有,`close` 删条目,
  校验点没变)。宽限、`snapshotOf`/`snapshotNow`/`timestampOf`、审批端点全部原样。
- desktop:`bootServer` 调用点未改(`BootOptions` 未动,票 18 修的 `cwd` 命名保持),
  `smoke-boot`/`smoke-desktop-*` 全绿。

### 判断性意见(备案)

1. **claim 表没有并进 `OpenSession`**。票面说"删除会话对象簿",但 `claims`/`reaping` 是
   传输层的事实(谁能用这个会话,ADR-0001),核心侧从不读它;搬进条目等于让 core 拥有一个它
   永远不读的计数器,和 `listeners`/`eventListeners` 那种"宿主写、Agent 只发布"的字段也不同
   类。所以留着的是**一张按 id 的 claim token 表**,里面没有任何会话对象——被删掉的是
   `HostedSession.session: Agent` 这个 Agent 实例簿,以及它承载的一切。
2. **`agentsMd` 与 `localTools` 上条目**是 ADR-0007 §4「装配产物=条目」的直接延伸:两样都是
   "那次打开解析出来的东西",而条目就是它们的家。代价是条目多两个字段、少一点纯数据味
   (工具是闭包);换来的是提示词与工具解析都不再需要 per-session 编排层。
3. **一个 transport 的后果**:脚本化答案现在全进程一份(hub 的 Agent 用 `HubOptions.api`),
   smoke 不能再"给每个会话一只 fake"。`smoke-approval` 的两会话段因此改成一条队列里排两发
   相同 `toolCallId` 的调用;谁需要按会话区分的答案,只能靠 `FakeResponseFactory` 读上下文。
   这是 ADR-0007 §6 的必然结果,记录在案以便 08 票权衡。
4. **新增 `scripts/mount-session.ts`**:几个 smoke 需要"自己的设置袋(把 `read` 放上闸门)"
   而不是磁盘设置,原来靠 `openAgent` 造一个独立 Agent 再塞进 `hub.hosts`;现在条目与编排层
   是分开的,它们改为 `ensureSession`(用 hub 的 `sessions`/`openSessions`)+ 挂 claim token。
   把两处私有穿透集中到一个有注释的 helper 里,而不是散在四个 smoke 里。它**只管设置袋**:
   模型行必须落在 hub 自己读的那份存储上——`pumpAttempts` 是拿 `AgentConfig.models` 判"这个
   会话有没有行"的,给会话一份私有 `ModelSource` 只会让每次请求都答"还没配置模型"。
5. **`HubOptions.modelsHome`**(随本票新增,与 `settingsHome` 同款 pass-through):模型行读写的
   那个 agent home。发现它的原因是第 4 条:smoke 需要把行交给 hub,而 hub 原先只有真实的
   `models.json` 一个落点——于是 `smoke-stream` / `smoke-projection` / `smoke-mux` 这些脚本
   一直在往开发者自己的模型清单里写测试行。现在被本票改到的四个 smoke 各自拿
   `<tmp>/agent-home`,读写都落在临时目录里。

### smoke 迁移与验证

迁移:`smoke-approval`(mount + 单 transport 双会话 + 宽限段的"被 reap 后读冷快照")、
`smoke-approval-endpoint`、`smoke-stream`(`sabotagePersistence(hub)`)、`smoke-sessions`
(身份断言从"Agent 对象身份"改为"登记处条目身份":one session per id = 一个条目)、
`smoke-projection`(`hub.agent`)。
`tsconfig.json` 的 include 补上 `scripts/mount-session.ts`(四个 smoke 依赖它,而 smoke 通常
不在检查集里);`npm run check` 绿;smoke 全套绿——approval / approval-endpoint / approval-recovery / api /
backpressure / boot / branch / default-model / desktop-close / desktop-observability / frame /
liveness / model-form / models / modes / mux / mux-client / mux-live / projection / replay /
session / sessions / settings / sidebar / stream / tools / transcript。

