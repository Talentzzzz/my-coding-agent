# 03:活登记处——队列、activeRun、订阅按 id 收拢,打开链路随行

Type: task
Status: open
Blocked by: 01

## Question

今天「活的一半」散在三处:`SessionRuntime` 在 hub 手里、两个订阅集合
(`listeners` / `eventListeners`)在 Agent 实例上、`run`(RunScope 跨栈槽)也是
Agent 的属性。把它们收拢为一个**按 id 键控的窄登记处**:

- 登记处只装「进行中且磁盘上没有」的东西——队列、activeRun、订阅集合、运行槽;
  这是它与大对象/缓存的分界。归属(独立小服务,还是 SessionManager 旁的一张表)
  与**命名**在此票定:候选 `OpenSession`;不得与 `SessionRuntime` 注释里
  「A session's live half」的既有术语打架——`SessionRuntime` 本身保持今天的
  窄定义不动,登记处**装着**它,不替换它。
- 队列模式初始化时序保持:创建时读工作区设置的答案,config patch 原地改
  (现 `Agent.applyConfig` 的语义搬家)。
- **打开链路随行**:`openAgent()` 的种子→补齐(ADR-0006 §3)在新形状下由谁、
  何时跑——「打开会话」与「首次触碰」是同一条链;装配产物不再是一个 AgentConfig,
  而是登记处条目 + 各 Manager 缓存就位。fork / close 对登记处的增删一并落。
- 不变量:进程重启丢弃登记处全部条目,重开即重建,与今天 SessionRuntime 语义一致。

完成后 `npm run check` + `smoke-sessions.ts` / `smoke-api.ts`(若 hub 未动,
api 应原样绿)。
