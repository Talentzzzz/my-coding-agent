# 13:SessionRuntime 落地——唯一的跨栈内存态

Type: task
Status: resolved
Blocked by: 08

## Question

落地 `SessionRuntime`,并让 hub 持有它取代现有 `HostedSession` 中的会话状态部分:

- 接口:`{ steeringQueue, followUpQueue, activeRun? }`。三者的共同定义:
  **正在进行的、磁盘上没有的**。activeRun 含 AbortController 与本次运行的
  局部上下文句柄(abort 跨栈递送的落点)。
- hub:`Map<sessionId, SessionRuntime>`;创建时机=会话第一次被碰到
  (open 或首条消息),销毁时机=关闭(现 hub 的 opening/closing 生命周期
  对应收拢)。
- 进程重启:SessionRuntime 从零重建,排队消息清零,文件里的会话完好——
  不需要任何恢复机制(与 0003「排队在取走点落盘」不冲突:被取走的消息才落盘,
  信箱里没消费的本来就允许丢)。
- `AgentState` 概念删除:会话的其他一切(账本/设置/模型/工具)在 B 路线下
  每请求从磁盘与配置重放,不驻留内存。
- `npm run check` 通过;hub 的既有 smoke(`smoke-api.ts`)通过。

## Answer

已落地(commit fb682a0),`npm run check` 与 smoke(api / mux / sessions /
tools / session / approval / approval-endpoint / liveness / modes / branch /
replay / settings / models / frame / backpressure / boot / default-model /
transcript / mux-client)通过。

- **core 新增 `session/session-runtime.ts`**:`SessionRuntime = { steeringQueue,
  followUpQueue, activeRun? }`,零方法袋;`ActiveRun = { abortController,
  promise, resolve }`——AbortController 是 abort 跨栈递送的落点,promise/resolve
  是本次运行的局部上下文句柄(等待收敛、由结束运行的引擎点火)。工厂
  `createSessionRuntime(steeringMode, followUpMode)` 按工作区队列模式现造。
- **loop**:run 的注册点从 `Loop` 私有 `activeRun` 移到宿主提供的 runtime;
  `LoopOptions` 收必填 `runtime`,`LoopRuntime`/`ActiveRun` 导出为 loop 侧的
  结构化视图(loop 不依赖 core)。`signal` / `abort()` / `waitForIdle()` /
  并发守卫 / `dispatchEvent` / `finishRun` 全部读写 `runtime.activeRun`。
- **Agent / 工厂**:`AgentConfig.runtime` 必填;Agent 不再自建队列
  (`applyConfig` 把模式补丁写到 runtime 上的队列,`flushAccepted` 清的也是它),
  `prompt` 的 drain 钩子从 runtime 取。`openAgent` 缺省现造一个 runtime,
  hub 传入自己持有的那个——不传的调用方(smoke、subagent 子会话)得到
  与进程重启后等价的空 runtime。
- **hub**:`Map<sessionId, SessionRuntime>`(`runtimes`);`open()`(每次首条
  消息与 claim 都汇入)里 `runtimeFor` 建造,reap / remove / close() 三处随
  host 关闭销毁;进程重启不残留任何东西,无恢复代码。
- **票面两点按分工延后**:「取代 HostedSession 中的会话状态部分」本票只落到
  队列与 activeRun 这一半,Agent 其余字段(running/partial/accepted/modelState
  等)由票 14 的编排层收拢;「AgentState 概念删除」在本票的落实形态是红线——
  SessionRuntime 只许装这三样,账本/设置/模型/工具不进袋。

## Comments

- 双轴 code-review(Standards/Spec)通过:Standards 无硬违规,采纳两点——
  `ActiveRun`/`LoopRuntime` 从 loop 导出(否则 `LoopRuntime` 引用私有类型),
  `ActiveRun` 文档点明 promise/resolve 即票面的「局部上下文句柄」。Spec 指出的
  两处「缺失」均属票 14/15 分工(见上),无范围蔓延之害。
- smoke-stream / smoke-projection / smoke-mux-live 在干净 master(6e872ce)上
  同样失败(后者扫描到本机临时目录里历年 smoke 残留),与本票无关,未动。
