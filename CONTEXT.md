# my-coding-agent

带桌面 UI 的编码 agent 的领域词汇表。这里的词是代码与 ADR 里当术语用的名字；定义只说它是什么，
理由与取舍在 `docs/adr/` 与 `docs/architecture.md`。

## Language

### 编排与运行

**Agent（编排层）**：
持有会话表、命令面、审批账本与投影的服务；运行的宿主。填充与压缩的算法半委托给注入的
`ContextManager`，存储经自己声明的端口触达。
_Avoid_: orchestrator、编排器

**ContextManager**：
填充链与压缩的**算法半**的持有者（触发计算、候选选择、token 估算、摘要产出、prompt 装配、结果归档）；
构造零依赖、无状态、一个实例服务所有会话。编排半（触发序列、记账、发事件）仍是 `Agent` 的私有方法。
_Avoid_: prompt builder、压缩管理器

**RunInput**：
一次运行的三件值（`agentState` / `session` / `start`），没有依赖面；运行要用的服务是 `Agent` 自己。
_Avoid_: LoopOptions、参数袋、loopOptions

**run bag（运行袋）**：
一次运行开跑时重放一次盘得到的会话记录，整条运行只带这一只；落选择的写经 `Agent.recordSelection`
进行——需要另开全新袋时由编排层在自己的会话表上开，没有第二条开袋路径（ADR-0013）。
_Avoid_: 会话缓存、session 副本

### 分层与存储

**端口（repository）**：
domain 对存储只认**消费方自己声明**的存储接口（`xxx-repository.ts` 住消费方包内，infra 逐存储域
实现、组合根注入）；端口面 = 触盘动词，hold 契约写在 `SessionRepository` 的接口文档里（ADR-0030）。
_Avoid_: ports 包、storage layer

**组合根（app / start）**：
`@my-agent/app` 的 `start(options)`——把 home 路径翻译成 infra 实现的唯一地点，随后注入 domain、
组装 case 与 trigger。
_Avoid_: boot、CLI
