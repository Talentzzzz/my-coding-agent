# 002：白名单答辩——回调清单与 loopOptions 字段

- label: wayfinder:grilling
- status: closed
- assignee: WorkBuddy（2026-11-11 实现会话）
- closed: 2026-11-11
- blocked-by: 001-run-inventory（已解除）

## Resolution

与用户逐项答辩后钉死（判据 = 0008「为什么不是把问题原路转回去」）。定下的词落进了
[CONTEXT.md](../../../CONTEXT.md)（新建，含 LoopManager、loopOptions、回调白名单、run bag）。

### 回调白名单（定稿：两项）

1. **`bagOf(id)`**（现 `this.bag`，recordSelection:1595，全引擎唯一摸会话表处）——答辩成立：
   会话表编排层私有、不注入（0019「没有被取代的」第一条），`live.unwritten` 只活在表上；
   「落选择开全新的袋」必须走唯一入口，loop 自己开袋就是第二条副本路径。结构上拿不到，只能绕回。
2. **`emit(state, session, event)`**（dispatchEvent 整体收编为白名单回调）——用户拍板 A 案：
   落盘（message_end 落账本）、清队列（agent_end 且非 suspended）、投影（按事件类型 publish）
   的**组合政策**是编排层与窗口契约的另一半，命令面（denyAllApprovals / abort / branchTo 的发布）
   是同契约的另一边；两个实现者分居两文件 = 漂移面。与旧 `subscribe` 的分界：无 listener 表、
   无跨包函数类型、闭包在运行栈现建（与现状逐字相同），且它是白名单仅有的两条之一而非七条绕回之一。
   runEngine 内照旧包成 `AgentEventSink` 闭包。

**审批闸门：确认不动，零改动**——`beforeTool` 调 `hooks.apply("before_tool", …)`，默认处理器
（装配时注册）才调 `Agent.authorize`；hooks 是六件依赖之一，这条缝 0012 就批准了。

### 答辩淘汰（loop 自答，不进白名单）

- **投影 publishState×5**（run finally / retryCallbacks×2 / endRetry / dispatchEvent）：
  `publishState(state, session, services)` 三件依赖 loop 全有，现建 services 自答。
- **approvalsOf**（prepareRequest:1513）：对快照的纯读，同上自答；审批账本的写侧与命令
  （respondApproval / authorize / danglingApprovals）留 Agent 不动。
- **setSuspended**（run:1190）：`sessionManager` 方法，有依赖即自答。
- **live 半槽位**：经参数 `state` 写，不是回调。
- 注意：retry 事件现状就绕过 dispatchEvent 直调 emitEvent+publishState，故 loop 无条件 import
  fanout；此项裁决只关乎 dispatchEvent 组合政策的归属。

### loopOptions 字段清单（定稿，修正票面「已知必有」）

- **每次调用的值**：`state`（AgentState）、`bag`（Session，运行袋）、`start`（RunStart）。
- **六件依赖**（0013 形状回归，LoopManager 零字段）：sessionManager、settings、tools、hooks、
  systemPrompt、api——用户拍板 A 案：进参数袋、单袋，不构造持有。
- **白名单回调**：`bagOf(id)`、`emit(state, session, event)`。
- **票面「已知必有」修正（以盘点为准，不进袋）**：模型（runEngine 内 `let model`，每请求由填充链
  重建，0008 决定 8）、abort controller（runEngine 内新建、注册 live.activeRun）、闸门
  （toolCallHooks 由 runEngine 从 hooks 依赖现组）、transport（重试泵包装，run 内现建）、
  thinkingLevel（骑在 ModelChoice 上，每请求 modelChoiceOf 派生，从不单独传）。
- **maybeCompact 缺口**：loop 暴露压缩入口，模型计算四行（modelChoiceOf + modelCatalog +
  modelFor，agent.ts:1091–1095）搬进 loop；Agent.maybeCompact 只递 state / bag / entries / now /
  signal / transport?，不再摸 settingsManager。

## Question

形状已定丙（白名单回调），但清单本身还没定。这票和用户一起把两样东西钉死：

1. **回调白名单**：盘点（票 001）分出来的「编排层语义」访问点，逐项答辩——
   「为什么这个必须绕回 Agent？」答不上来的改成 loop 自己拿。已知的候选：
   - 事件分发（订阅者表在 Agent 手里）——大概率收编现有 `emit` sink；
   - 审批闸门（审批账本是编排层的）——注意现在它已经走 `Hooks.before_tool`、
     处理器调 `Agent.authorize`，可能**已经是回调形状**，只需确认不动。
2. **`loopOptions` 字段清单**：运行入口三处（`startPromptedRun`、恢复路径、`maybeCompact`）
   各要传什么。已知必有的：run bag（0019）、模型、abort controller、事件 sink、闸门、
   transport、thinkingLevel；以盘点为准补全。

注意 0008 的判词在这票里是试金石：白名单里每一项都要能说出它为什么不是「把问题原路
转回去」。过程中按 domain-modeling 的习惯把定下的词（LoopManager、loopOptions、回调
白名单等）落进 `CONTEXT.md`（若建）。
