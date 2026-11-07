# 08 形态收账：ADR 与 AGENTS.md 术语表

Type: task
Status: closed
Blocked by: 04

## Question

按已落地的新形态写一条新 ADR（修订 ADR-0007 §6 的「hub 协调五个服务」叙述：hub 只认 Agent 公开
面，Manager 的消费者收进 core），被取代处加指针；AGENTS.md 术语表「service / assembly / hub」
相关句子逐句改写；`docs/architecture.md` 对应小节同步。格式沿用 ADR-0014/0015/0016 的收账方式
（取代者指针 + 就地标注）。

## Answer

已落地（commit 3ca66e7 + review 修正一并入本票收账）。`npm run check` 绿（tsc ×2 + tokens +
守卫），smoke-tools / smoke-sessions 同色——文档零行为变更。ADR 编号按票 05 的预留占用 **0017**
（`docs/adr/0017-agent-facade.md`），hub.ts 六处既有引用对上。

### ADR-0017

- 决定六条：①公开面三类方法（生命周期八、窄读五、设置目录五 + 扫描转发三，共二十一个；
  `ModelPins` 随打开实参现取）②状态对象不出 core（`agentState()` private）③构造吸收
  （`HubOptions` 实为 `{ workDirAbsPath, sessionId?, settingsHome?, modelsHome?, api?,
  model?, thinkingLevel? }`）④机械守卫 ⑤冷路径契约 per-method ⑥票 05/07 顺延的两处收口
  （`workDirOf` 删、`fileAbsPathOf` 留、`sessionManager` 字段改缝口径）。
- 取代：0007（部分——仅决定 6 的**消费面**：「由 hub 装配、在 hub 手里协调」的旧叙述）与
  0016（部分——仅决定 7 的「hub 自己那只」那半）；两处头部加取代者指针、决定处就地标注，
  原文一字未动。另有专节「为什么界线要由守卫而不是由 review 背书」与「没有被取代的」
  （0001 wire、0011 会话表、0016 表形态、0007 会话域、fanout 的 `SessionServices`、
  `openAgent()`）。
- `docs/adr/README.md` 清单补 0017 行。

### AGENTS.md 与 architecture.md 同步

- AGENTS.md：service 条补「消费边界是另一条」三句；assembly 条改工厂造三只 Manager 的新口径
  （并修正「递的只是 homes 与 api」，钉子随打开实参）；AgentState 条 `adopt` → `Agent.open`、
  补「类型不出 core，server 侧只见纯数据窄读」。
- architecture.md：顶部图（「四个域服务 + 一个编排层」→「一个编排层 + 它身后的域服务」）、
  core/server 两段、目录布局 hub.ts 括注、装配与设置（`Agent.open` 进表、构造对代码块换工厂
  签名、「会话管理器是唯一由调用者决定的协作者」段改写、`HubOptions.settings` 措辞清零）、
  Hook 节的 `ADR-0007 §6` 引用改 0017、延迟创建窗口改编排层的表承担、谁拥有一个会话、
  `HostedSession` 图摘已死字段 `workDirAbsPath`、请求流程 hub 行去掉「活登记处」旧词。

### code-review（两轴并行）的修正

Standards 轴三处事实错：方法计数十九 → 二十一（生命周期 8 + 窄读 5 + 设置 5 + 扫描 3）；
「公开字段只剩 sessionManager」补 `hooks` 不是 Manager 的说明；「死缝」句把
`OpenAgentOptions.sessionManager`（死缝，只服务冷读）与 `Agent.sessionManager`（冒烟缝）
分开。Spec 轴两处口径：architecture core 段「两类方法」补齐三类；AGENTS.md 钉子措辞
（见上）。全部按核对结果修正。

