# 05:ToolState 的归属——账本派生,还是键控缓存?

Type: grilling
Status: resolved
Blocked by: 01

## Question

`ToolState`(活跃工具集 + 审批覆盖,前作票 11 的纯数据袋)在新形状下住哪?这是
五单例里唯一悬而未决的归属问题:

- **账本派生(候选,更彻底)**:`getRecordedToolConfig` 已能从 `tool_config`
  entry 读回活跃集与审批映射,且 `setActiveTools` / `applyConfig` / 审批 grant
  都**立即**落 entry——活性似乎从不久存于账本之外。若成立,ToolState 连键控缓存
  都不需要:谁用谁现派生,与 modelState 消失同理;全局默认的 fallback
  (`globalDefaultToolState`)照旧是派生链的一步。
- **键控缓存(保底)**:若存在「活性超前于账本」的窗口(分支移动
  `applyBranchToolConfig` 的中途态?subagent 的收窄注册表?),则按 id 键控,
  形状同 02/04 票。

先裁决,后实施:`ToolManager`(定义注册表,全局只读)无属性化,按结论改造
ToolState 的读写路径。裁决要对照代码逐条过:每一个今天写 `ToolState` 的位置,
是否同栈内就有一条 entry 落账本。

完成后 `npm run check` + `smoke-tools.ts`。

## Answer

**裁决:账本派生。** ToolRegistry 的可变 `state` 字段整个拆掉,键控缓存不需要。
逐条过今天的五个写点:

1. `Registry.setActive` ← `Agent.setActiveTools`——同栈
   `appendToolConfig`(`agent.ts`),落账本。
2. `Registry.setApprovalOverride` / `mergeApprovalOverride` ←
   `Agent.applyConfig` 审批半——同栈 `appendToolConfig`,落账本。
3. `mergeApprovalOverride` ← `Agent.respondApproval` 的 grant 半——同栈
   `appendToolConfig`,落账本。
4. `applyRecordedToolConfig`(装配 replay、`applyBranchToolConfig`)——写的就是
   `getRecordedToolConfig` 的读回,活性从不超过账本,删掉后连写点都不剩。
5. `Registry.register`(装配时收编委托对)——**不落 entry,但不是选择**:它做的
   只是「没选过 = 全集」这个缺省把 local 工具带上;派生链的 fallback
   (`globalDefaultToolState` → `defaultToolNames` 用 `registry.names()`)本就
   含 local 名字,`register` 不再推进 activeToolNames 后结论不变。

两个疑点窗口都不成立:`branchTo` 移叶与重派生之间全同步、无观察者,不存在中途
态可读;SubAgent 子会话的收窄 loadout(`subagentToolState()`)是构造期常量种子,
之后从不变异——它是 seed 不是活性。种子照旧走 `OpenAgentOptions.toolState`
(经 `AgentConfig.toolSeed` 传入),recorded 有 entry 则压过 seed。

**实施**(读写路径改造;`ToolDefinitions` 全局只读、无每实例状态,无需动):

- `tools/registry.ts`:注册表只剩结构——`names` / `build` / `register` 收编
  local 工具、`activeNames(state)` / `active(state, run)` 收派生好的
  `ToolState` 现建执行集。删 `setActive` / `setApprovalOverride` /
  `mergeApprovalOverride` / `toolState()`,`createToolRegistry` 不再收 state。
- `session/tool-config.ts`:`applyRecordedToolConfig`(改注册表)替换为纯派生
  `toolStateOf(sessionState, settingsState, registry, seed?)`——recorded 压过
  seed,seed 缺省落到 `globalDefaultToolState` 的活视图;narrowing 在读时做,
  语义与原 apply 相同。index.ts 导出同步换名。
- `agent.ts`:三个写点直写 `appendToolConfig`(写的仍是合并后的完整 map,与旧
  账本约定一致);`setActiveTools` 的未知名校验移到 Agent(错误文案原样);
  `applyBranchToolConfig` 降为 `emitBranchToolConfig`——移叶后无需任何 apply,
  剩下的只有向其他流广播;`AgentConfig.tools` 文档改为「结构而已,选择不在这」。
- `session-factory.ts`:装配不再 replay(`applyRecordedToolConfig` 调用删除),
  seed 原样传给 config;`readSessionSnapshot` 用同一个 `toolStateOf` 现派生,
  冷读与活会话仍由同一段代码作答。`options.tools`(测试自备注册表)保留,
  `toolState` 不再被它忽略——两者可同时给,seed 归 seed、结构归结构。

一处语义收敛(有意):旧形状里「调用方自备注册表且不给 toolState」的 fallback
是注册表自身的全集状态,无视设置里配的全局工具集;现在统一走
`globalDefaultToolState`——自备注册表决定的是「存在什么」,不该顺带决定「选了
什么」。smoke 里自备注册表的用例都在不配 `tools` 的内存设置下跑,行为不变。

第二处(复查发现,同为有意):旧 `applyBranchToolConfig` 无条件用
`globalDefaultToolState` 当 fallback,分支移动到没记录的分支会丢掉传入的
loadout;新派生里 seed 继续作 fallback——装配与分支移动两处旧的不一致就此
统一(旧代码自己也不一致:装配时 seed 压过全局默认,移叶时反过来)。此路只有
被播种的会话(SubAgent 子会话)能走,而子会话从不分支,实际不可达;为它保留
一个 apply 步骤不值得。

验证:`npm run check` 绿;`smoke-tools` / `smoke-session` / `smoke-sessions` /
`smoke-approval` / `smoke-approval-recovery` / `smoke-approval-endpoint` /
`smoke-branch` / `smoke-modes` / `smoke-settings` / `smoke-replay` /
`smoke-stream` 全绿。`smoke-api` 报「the mux connection failed」,stash 改动后
在改动前的树上同样失败——既有环境问题(与 `.scratch/smoke-isolation/` 所记同
类),非本票引入。AGENTS.md 词条与 architecture.md 平移随 06/07/08 票走。
