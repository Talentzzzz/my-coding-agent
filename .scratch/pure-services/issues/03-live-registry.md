# 03:活登记处——队列、activeRun、订阅按 id 收拢,打开链路随行

Type: task
Status: resolved
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

## Answer

落成 commit `2f14102`(8 个文件,新文件
[packages/core/src/session/open-session.ts](../../../packages/core/src/session/open-session.ts))。

**归属与命名(票面要在此定)**:登记处是 core 里的**独立小服务**——`OpenSessions`
类,条目采纳票面候选名 **`OpenSession`**,都住在 `session/open-session.ts`、由
core 导出面出。不并入 SessionManager:那个服务的领域是「随时可从磁盘重建的账本
缓存」,登记处的领域恰恰是「不能从磁盘现建」,合并会把本 effort 一直维护的
durable/live 边界重新糊起来。hub 构造一份进程级实例(`openSessions` 字段)。

**条目装什么**:四处全部收拢——`runtime: SessionRuntime`(`SessionRuntime` 窄
定义一字不动,条目**装着**它,正是 ADR-0007 §4 要求的形状)、`listeners`、
`eventListeners`、`run`(跨栈 RunScope 槽;RunScope 随之从 agent.ts 导出,条目
type-import——与 protocol.ts ↔ agent.ts 的既有 type-only 环同型,无运行时环)。
条目**不**装账本:未落盘会话的 `SessionState` 留在 hub 的 `pending` 表(票 02
已裁),它是耐久半自己的袋,不在 ADR-0007 §4 的清单里——条目与账本缓存是两张
表、永远是两张表。

**队列模式时序原样**:`OpenSessions.ensure(id, create)` 收调用方的工厂,设置
(steering/followUp 模式)只在真建条目那一刻读——hub 的 `openSessionFor` 是唯一
工厂,把读设置的时机留在首次触碰;`Agent.applyConfig` 的原地改一行没动,只是
摸的路径从 `this.runtime` 换成条目里的 runtime。

**打开链路随行**:hub.`open()` 的 `openSessionFor`(ensure,首次触碰建条目)+
`openAgent()` 的种子→补齐 = 「打开会话」与「首次触碰」同一条链,由 claim 驱动。
`AgentConfig.runtime` 更名 `openSession`(条目进 config);openAgent 无条目可收
时兜底自建一个独立条目(测试路径,行为与重启后重开一致)。**装配产物完整换形
(AgentConfig 消失、只剩条目 + Manager 缓存)不是本票的形状**——modelState 拆除
与 Agent 无属性化是 06 票、hub 只持单例是 07 票;03 落的是链路与登记处,票面
「不再是 AgentConfig」读作目的地而非本票验收线。

**fork / close 增删**:close 的删落在 hub 三个收摊点(reap / remove / closeAll,
原 `runtimes.delete` 的位置);**fork 不增条目**——没人 claim 过的 fork 没有活
的一半可装(没有队列在排水、没有运行在飞),它的首次触碰就是首次 claim,由
`open` 建条目;这条决定写进了 `fork()` 的文档注释。

**验证**:`npm run check` 绿;smoke 全套绿(session / tools / models / mux /
approval×3 / projection / stream / branch / replay / modes / settings /
transcript / liveness / frame / mux-client / sidebar / model-form /
default-model / boot / backpressure / mux-live),smoke-api 对临时 server(端口
5188/5189、scratch agent home)跑绿;smoke-sessions 增登记处六条(ensure 首触
建、队列模式落位、复用同一引用、delete 连订阅一起丢、重触建新、重启清空)。

**code-review 记录**:两轴评审无硬违规。三个判断题:条目里 `runtime` 的消息链
(`this.openSession.runtime.*`)留待 06 拆 Agent 时自然消解;`opens`/`live` 命名
按评审意见改为 `openSessions`/`openSession`;mode 参数对(clump)是前作既状,
createSessionRuntime 本就收这对。Spec 轴抓到的两处已回:重启 smoke 原是空断言
(改为 clear 后 ensure 必须重建出不同引用)、fork 的不增条目原无落字(补文档)。
