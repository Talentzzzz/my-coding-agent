# 06:Agent 无属性化——方法收 id,谁用谁向 Manager 现取

Type: task
Status: resolved
Blocked by: 02, 03, 04, 05

## Question

`packages/core/src/agent.ts`(约 1980 行):删掉全部会话属性,Agent 收成纯编排
服务。这是本 effort 最重的一票:

- **构造只收服务**:`sessionManager` / `settingsManager` / `models`(ModelSource)/
  `toolManager` / `api`(ChatTransport)/ `hooks` / `systemPrompt` 构建函数。
  `AgentConfig` 的会话字段(workspace / modelState / runtime / tools)全部删除。
- **公开方法改 `(sessionId, 请求自己的参数)`**:`prompt` / `steer` / `followUp` /
  `abort` / `respondApproval` / `branchTo` / `setActiveTools` / `applyConfig` /
  `applyModelSelection` / `denyAllApprovals` / `close`;getter 变方法:
  `snapshot(id)` / `usage(id)` / `isLooping(id)` / `hasPendingApprovals(id)` 等。
- **方法体内形状二**:每样数据在用到它的那一行向属主 Manager 现取
  (`sessions.stateOf(id)`、工作区从登记处、模型从账本派生 + `fillModel` 现算),
  局部变量作为参数传给下一步;内部辅助方法(`prepareRequest` / `startRun` /
  `pumpAttempts` / `beforeTool` / `afterTool`…)收显式参数,不收 id、不收袋。
- **modelState 消失**:选择随消息到达;没带选择时从 `getRecordedSettings` 派生;
  `adoptCurrentRow` 的活行语义在每次现算处保持。
- **run 槽位搬家**:RunScope 的跨栈读取槽移入活登记处条目(03 票的产物),
  abort / 快照 / 排队经登记处取,不经 Agent 属性。
- **一次调用栈只解析一次**的纪律:公开方法解析出的局部量贯穿全栈,杜绝同请求
  两次取袋拿到不同引用。
- 不变量红线(照前作 14 票):选择每次移动恰好一条 entry;abort 不留半成品;
  事件次序与消息帧形状一字不变(窗口零改动的验收线)。

完成后 `npm run check` + smoke 全套(stream / sessions / tools / models /
branch / replay / modes / settings / transcript / liveness / approval)。

## Answer

**裁决一:modelState 不消失,种子落登记处条目。** 票面「modelState 消失:没带选择
时从 `getRecordedSettings` 派生」的严格形式被否,改为装配种子记在
`OpenSession.modelSelection` 上(类型仍是 `ModelState`,引用 readonly、内容按旧
bag 语义原地变)。三个理由:

1. **装配种子没有家**——宿主 `--model` pin、`selectModel` 的回退链
   (`--model` → transcript 记录 → 内置默认 → 首行)、subagent 子会话继承的父
   模型,都是「打开那一刻已解决的答案」,不是账本里读得回来的东西;
2. **分支移动到未记录分支时「保持当前选择」的既有规则需要它**——纯派生会在移
   叶时把选择丢回全局默认,而票 05 刚把「seed 作 fallback」的规则统一过;
3. **未发送选择的可见性**——`applyModelSelection` 之后、首个请求之前,快照必须
   能看到选择;纯派生看不到还没写进账本的东西。

这与 03 票「装配产物=条目」同形,ADR-0007 §5 的严格表述(「不再有驻留内存的
per-session 模型状态」)被本裁决收窄为「**Agent 不再驻留模型状态**」:种子是条
目的装配字段,不是 Agent 属性;活行事实每次请求仍由 `adoptCurrentRow` 经
`fillModel` 原地重铺;选择随消息施加、由 `recordSelection` 按账本基线记账。纪律
原样,家从 Agent 属性换到条目。ADR-0007 §5 的改写归 07/08 票,本票只平移被直接
证伪的句子。

**裁决二:`SessionManager.adopt(state)` 例外通道。** 票 02 定过「未落盘不入缓
存」;但 hub 的 pending 未落盘会话与 smoke 自备的袋需要 `stateOf(id)` 在首条消
息落盘前就能按 id 应答同一个袋——否则 openAgent 之后所有按 id 的调用无处取袋。
`adopt` 把调用方自备的袋注册进 fill-at-open 缓存,是该规则的显式例外通道
(class doc 已改);openAgent 无条件 adopt `options.sessionState`,与 hub 的
pending 袋同一条路。

**第三处(票面构造清单的两处出入,同为有意):** 构造收的服务是
`{sessionManager, models, tools, openSessions, api?, hooks?, systemPrompt}`——
没有 `settingsManager`(设置袋是条目上的装配字段,Agent 经袋读写,不再经管理
器;队列模式搬移同票 04 的形状),也没有 `toolManager`(票 05 已裁决注册表只是
结构、无 per-实例状态,不需要一个管理器壳)。

**实施**(逐文件):

- `session/open-session.ts`:条目新增 4 个装配字段 `workspace` / `settings`
  (SettingsState)/ `modelSelection`(ModelState)/ `toolSeed?`;
  `createOpenSession(seed)` 换单 seed 签名;`OpenSessions.get(id)`。条目仍不装
  账本——红线未破。
- `session/session-manager.ts`:`adopt()`;fill-at-open cache 的 class doc 修订。
- `agent.ts`:整文件重写。构造只收服务;公开方法全改 `(id, …)`
  (snapshot / usage / sessionFile / modelName / thinkingLevel / thinkingLevels /
  isLooping / activeTools / getApprovals / hasPendingApprovals /
  hasPendingApproval / isRetrying / retryAttempt / onChange / onEvent / prompt /
  steer / followUp / abort / settle / close / branchTo / setActiveTools /
  applyConfig / applyModelSelection / respondApproval / denyAllApprovals /
  authorize / maybeCompact);私有辅助全收显式参数(state, entry, scope…),
  `compactFor` 是 maybeCompact 的私有实现;hooks 类型、RunScope、事件形状未动。
  run 槽与装配读取全部经 `entryOf(id)` → 登记处条目。
- `session-factory.ts`:`OpenAgentOptions.openSession?` 换
  `openSessions?: OpenSessions`;openAgent = ensure 条目(工厂里读 queue modes
  + 装配字段,时点不变=首次触碰)+ adopt 袋 + `new Agent`;默认 hooks 留在
  openAgent(闭包 sessionId / workspace),gate 走
  `session.authorize(sessionId, …)`;`Assembled` 去掉 settingsManager 字段。
- `tools/subagent.ts`:buildChild 返回 `{agent, state}`;job 存 childState;读
  走 `deps.parentSessionManager + childState`;prompt / abort / close / modelName
  全带 childId。
- `hub.ts`:`HostedSession` 构造改 `(sessionId, session, root)`;
  `openSessionFor` 删除;`sessionOver` 传
  `openSessions: this.openSessions`;所有 `session.X()` 带 id;fork / rename /
  timestampOf 改走 `this.sessions`(服务 + stateOf)。
- `controllers/sessions.ts` / `projection.ts`:所有调用带 sessionId;投影的
  `state` 改 `manager.stateOf(sessionId)`。
- 一处 smoke 揪出的产品修复:`hub.reap` 的审批等待循环原来裸轮询
  `hasPendingApprovals`,hub.close 清登记处后下一拍抛「Session is not
  running」——循环改为每拍校验 host 仍归本 hub,竞态胜负后、动 host 之前再校验
  一次;被关掉(host 移除)的会话不再由 reap 作答。entryOf 对非运行 id 的抛出是
  票 06 的形状带来的新碰撞面,修在 hub 侧(reap 是唯一跨 close 边界轮询的地方)。

**验证**:`npm run check` 绿;smoke 全套绿——boot / desktop-close /
desktop-observability / tools / sessions / projection / mux-client / mux-live /
mux / liveness / backpressure / sidebar / settings / modes / transcript / frame
/ branch / session(含 stream)/ models / default-model / model-form / stream /
replay / approval / approval-endpoint / approval-recovery。`smoke-api` 在临时
server 上本次通过——票 05 记录的「the mux connection failed」既有环境问题未复
现。code-review 两轴:spec 无实质缺口(红线全过);standards 的 4 处硬伤(两处
tab 缩进、两处孤儿注释)已修。判断性意见备案:`OpenSession.modelSelection` 与
术语表「model selection(随消息的选择)」同名是有意的——条目上存的就是会话的
常设选择、输入框的随消息选择覆盖它,两者同形(`ModelSelection` 的形状),名字
是诚实的那一个;`abort`/`close` 的公开方法互调会按 id 重解析一次,两个解析器都
是缓存背书的同对象返回,不可分歧,是 id-first 形状的接受代价。

**文档**:architecture.md(装配一节的 config 携带句、openAgent 形状图、
`session.settingsManager` 暴露句、`Agent.prompt(message)` 签名)与 AGENTS.md
(assembly / OpenSessions 两词条)只改 06 直接证伪的句子;hub/server 与词条的
大改归 07/08 票。
