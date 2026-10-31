# 15:loop 恢复机器——悬空 tool call 的扫描、配对、续跑

Type: task
Status: resolved
Blocked by: 12, 14

## Question

给 vendored `packages/loop` 加恢复机器(本 effort 唯一动 vendored 逻辑的地方),
实现票 03 的「结束重启」:

- **扫描**:运行进入时检查 context 里悬空的 tool call(有 tool_use 无
  tool_result)。
- **配对续跑**:有审批答案(经编排层传入,按 toolCallId 键控)→ 合成对应的
  tool_result(含 deny 的 reason 语义,见现 `agent.ts:316-320` 的注释)→
  继续执行该批工具调用与其后的循环。
- **孤儿收尾**:无答案的悬空 call 合成错误结果(开关式,AgentScope
  `enablePendingToolRecovery` 的对应物),保证 provider 请求合法。
- 与 steering/followUp 取走点的交互:恢复运行同样在取走点消费信箱
  (0003 语义不变)。
- 与 abort 的关系:abort 的拒绝不经过审批链(现有 loop 归一化行为保持)。
- 验收:smoke 覆盖三个场景——有答案续跑、无答案孤儿收尾、恢复中再次 abort;
  `npm run check` 通过。

## Answer

已落地。`npm run check` 通过;smoke-approval-recovery.ts(本票的新 smoke)覆盖
全部三个场景,smoke-session / smoke-approval / smoke-approval-endpoint 及其余
smoke 通过(smoke-sidebar / smoke-projection / smoke-stream / smoke-mux-live
在干净 master 上同样失败,与本票无关,沿用票 13/14 的登记)。

- **闸门改 suspend**(主路径补全):票 14 的过渡闸门返回 block+terminate,
  循环给被挡调用写了错误结果——调用根本不悬空,横幅无从派生(这正是
  smoke-approval-endpoint 挂掉的原因)。本票给 `BeforeToolCallResult` 加
  `suspend: true`:循环在闸门处结束运行,**不给该调用写结果**,批内其余调用
  一并留在后面(它们的结果在恢复运行入口收尾),取走点全部跳过——排队消息由
  flushAccepted 落盘,留给恢复运行展示给模型。被 suspend 的调用不发出任何
  `tool_execution_*` 事件(批执行器改为先 prepare 后 emit,`runToolCall` 的
  嵌套调用把 suspend 折算成错误结果)。
- **恢复机器**(loop.ts):`runLoop` 的 prompt 改为可选,`RunLoopOptions` 加
  `recovery?: { answers?, enablePendingToolRecovery? }`。每次运行进入时扫描
  context 里的悬空调用(danglingToolCallsOf),在第一轮之前收尾:有答案的
  grant 走与活批完全相同的链(prepare→闸门→执行→afterToolCall);deny 合成
  answer.reason 的错误结果;无答案的孤儿合成「left unanswered, issue the
  call again」错误结果(开关默认开,关掉则留给宿主)。恢复中闸门再次
  suspend(grant 未清闸)则停止恢复、直接结束运行,不发出非法请求。
- **编排层**:`respondApproval` 改 async——grant 记录会话自己的审批选择
  (一条 `tool_config` entry,值为 `false`,即该工具不再问)后
  `startRun({ answers })`;`startRun` 收 `{ prompt } | { answers }`。deny 的
  reason 语句留在 core(随答案传入)。
- **晚到结果的接线修复**(scan 时发现的两处必须一起改,否则请求非法):
  1. `pairLateToolResults`(agent.ts,prepareRequest 内):账本是追加制,悬空
     调用的结果可能落在后来的 user 消息之后(prompt 先于恢复运行落盘、信箱
     flush 在闸门结束之后落盘),wire 上不合法;请求侧把晚到的 toolResult
     提回其 assistant 消息之后,文件保持诚实的追加序。
  2. `settle()` 补上 abort 已有的有界等待(运行槽清空比 idle promise 晚一个
     微任务),hub 的 reap 因此先 settle 再判悬空——「运行结束在闸门上」才是
     悬空出现的时刻。reap 宽限的语义随之从「等运行结束」改为「等悬空调用被
     回答」(`APPROVAL_WATCH_MS` 轮询)。
- **close() 不再代替用户回答**:悬空调用是合法的盘上状态(请求侧有修复),
  `Agent.close` 与 hub 的 shutdown 只停运行、不写 deny;遗弃的拒绝只属于
  显式的 `abort()` 与 reap 的宽限走完。冷读(`readSessionSnapshot`)的
  `pendingApprovals` 改为从账本派生——重启后悬空调用作为「还是个问题」被
  继承,smoke-approval 第 5 节按此改写(旧断言「重启不播种待答审批」是旧
  架构的内存挂起语义)。
- **abort 与恢复**:abort 的拒绝不经过审批链——恢复中被 abort 的运行,已恢复
  的调用保留自己的结果,无 deny 语句入账(smoke 场景 3);恢复运行同样在
  取走点消费信箱(smoke 场景 5,steer 在恢复运行的请求处被接受、turn 尾取走)。
