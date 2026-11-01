# 06:Agent 无属性化——方法收 id,谁用谁向 Manager 现取

Type: task
Status: open
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
