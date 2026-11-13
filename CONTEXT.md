# my-coding-agent

带桌面 UI 的编码 agent 的领域词汇表。这里的词是代码与 ADR 里当术语用的名字；定义只说它是什么，
理由与取舍在 `docs/adr/` 与 `docs/architecture.md`。

## Language

### 编排与运行

**Agent（编排层）**：
持有会话表、命令面、审批账本与投影的服务；运行的宿主。
_Avoid_: orchestrator、编排器

**RunInput**：
一次运行的三件值（`state` / `bag` / `start`），没有依赖面；运行要用的服务是 `Agent` 自己。
_Avoid_: LoopOptions、参数袋、loopOptions

**run bag（运行袋）**：
一次运行开跑时重放一次盘得到的 transcript，整条运行只带这一只；落选择的写经 `Agent.recordSelection`
进行——需要另开全新袋时由编排层在自己的会话表上开，没有第二条开袋路径（ADR-0019）。
_Avoid_: transcript 缓存、session 副本
