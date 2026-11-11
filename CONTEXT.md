# my-coding-agent

带桌面 UI 的编码 agent 的领域词汇表。这里的词是代码与 ADR 里当术语用的名字；定义只说它是什么，
理由与取舍在 `docs/adr/` 与 `docs/architecture.md`。

## Language

### 编排与运行

**Agent（编排层）**：
持有会话表、命令面、审批账本与投影的服务；运行的宿主，白名单回调的回答方。
_Avoid_: orchestrator、编排器

**LoopManager**：
一次运行的全部机械——引擎、填充链、压缩阶梯、重试泵、两个工具闸门、事件 sink 的组装与收尾。
零字段：要什么由 loopOptions 在调用时给，白名单之外不绕回编排层。
_Avoid_: Loop、引擎对象、run manager

**loopOptions**：
一次运行调用的唯一参数袋：`state` / `bag` / `start` 三件每次调用的值、六件服务依赖
（sessionManager、settings、tools、hooks、systemPrompt、api）、以及白名单回调。
它是一次调用的参数表，不是被持有的聚合袋（ADR-0013 已验证参数化不违反 ADR-0007）。
_Avoid_: LoopServices、LoopManagerConfig、services

**回调白名单**：
loop 经 Agent 传入的函数的封闭清单，每一项都答得出「为什么必须绕回编排层」（ADR-0008 的试金石）。
定有两项：`bagOf(id)`——开一只全新的袋（会话表私有、`live.unwritten` 只活在表上）；
`emit(state, session, event)`——事件 sink（落盘、清队列、投影的组合政策是编排层与窗口契约的
另一半，命令面的发布是同一契约的另一半边）。
_Avoid_: hooks（hooks 是六件依赖之一，不是白名单）、subscribe、onEvent

**run bag（运行袋）**：
一次运行开跑时重放一次盘得到的 transcript，整条运行只带这一只；中途落选择另开的全新袋
经白名单 `bagOf` 取，不走第二条开袋路径（ADR-0019）。
_Avoid_: transcript 缓存、session 副本
