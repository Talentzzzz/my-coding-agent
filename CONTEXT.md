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
一次运行调用的唯一参数袋：`state` / `bag` / `start` 三件每次调用的值、传输 `api` 与 prompt builder
`systemPrompt` 两件既有形状、以及回调面（19 动词 + `emit` sink）。
它是一次调用的参数表，不是被持有的聚合袋（ADR-0013 已验证参数化不违反 ADR-0007）。
_Avoid_: LoopServices、LoopManagerConfig、services

**回调白名单**（别名：回调面）：
loop 经 Agent 传入的函数的封闭清单，每一项都答得出「为什么必须绕回编排层」（ADR-0008 的试金石）。
定稿为 **19 动词 + `emit`**：读（`contextMessages` / `contextEntries` / `modelCatalog` / `modelChoice` /
`activeTools` / `approvals` / `bashSettings` / `retrySettings`）、写（`recordSelection` / `setSuspended` /
`appendMessage` / `appendCompaction` / `appendTrimToolCallArgs` / `appendClearToolResults`）、
执行（`executeTool`）、接缝（`rewriteContext` / `decideBeforeTool` / `decideAfterTool`）、窗口（`publish`）。
三只 Manager 与 hooks 对 loop 完全不可见；`bagOf` 已随 `recordSelection` 收编退出——开袋是编排层的
事，loop 不再自开袋。
_Avoid_: hooks（hooks 是编排层侧的服务，它的三个消费者已拆成接缝三动词）、subscribe、onEvent

**run bag（运行袋）**：
一次运行开跑时重放一次盘得到的 transcript，整条运行只带这一只；落选择的写经回调 `recordSelection`
进行——需要另开全新袋时由编排层在自己的会话表上开，loop 不再有第二条开袋路径（ADR-0019）。
_Avoid_: transcript 缓存、session 副本
