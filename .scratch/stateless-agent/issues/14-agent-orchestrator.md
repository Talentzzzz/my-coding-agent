# 14:Agent 编排层——五单例合龙,删除旧有状态类

Type: task
Status: resolved
Blocked by: 08, 09, 10, 11, 13

## Question

把 `packages/core/src/agent.ts`(约 1738 行)改造为编排单例,合龙前四票:

- public 行为保持方法名与语义:`prompt` / `steer` / `followUp` / `abort` /
  `respondApproval`(签名的状态参数形态按 13 票的 SessionRuntime 定)。
- 每请求补齐链(以 prompt 为例):写选择进 `s.model` → `fillModel` →
  重放账本 → `buildSessionContext` → `forModel` → `fillTools` 产物装配 →
  审批默认值合并(全局 getApprovals + ToolState)→ `buildSystemPrompt`
  (提为编排内纯函数)→ `runLoop(context)` ——context 直接传,**不进任何袋**。
- 运行期瞬态改为局部变量:`running` / `partial` / retry 五字段 /
  `accepted` / `promptWrites`;`lastStamp` / `lastQueued` 从账本派生。
- 事件 emit:产出事件后经 hub 订阅表扇出(订阅表在 mux,见 16 票对接)。
- `session-factory.ts` 的 `openAgent()` 改为补齐链装配;删除旧 `Agent` 类的
  全部会话字段与 `pendingApprovals` 的 Promise 机制(审批改走 15/16 票的
  结束重启链路;本票先行接线,恢复机器未就绪前审批端点可暂以「结束 + 悬空」
  最小语义运行)。
- 不变量红线:选择每次移动恰好一条 entry;abort 不留半成品;
  `adoptCurrentRow` 的活行语义在重放+补齐链中保持。
- `npm run check` + `smoke-sessions.ts` / `smoke-tools.ts` / `smoke-models.ts`
  通过(`smoke-api.ts` 可能要等 16 票)。

## Answer

已落地,`npm run check` 与 smoke(sessions / tools / models / session /
branch / replay / modes / settings / transcript / liveness / boot / frame /
backpressure / api / mux / default-model / desktop-close /
desktop-observability)通过。**双轴 code-review(Standards/Spec)通过**,
采纳三点:`RunScope.retryError` 是死状态(旧代码同病,一并删除)、`abort()`
的收尾清扫与运行槽清空之间隔一个微任务(补一个有界等待)、审批 grant 路径
改为落一条 `tool_config`(见下)。

- **编排层**:Agent 收成纯编排——只留五个单例句柄(workspace / ledger /
  settings / models / tools)+ 接缝(hooks、runtime、transport、prompt
  builder)+ 模型种子(`modelState`,模型域的纯数据袋,票 10 的形态)。
  Loop **每运行现造**:streamFn、retry 泵、before/afterTool、prepareRequest、
  事件订阅全部闭包在 `startRun` 里,运行结束即弃。`running` 由运行槽
  (`run`)与 `runtime.activeRun` 回答;每请求补齐链在 `prepareRequest`
  里按票面顺序一字排开。
- **瞬态出袋**(ADR-0006 §5):`partial` / `accepted` / `promptWrites` /
  `pendingToolResultViews` / retry 字段 / `lastQueued` 全部进 `RunScope`
  ——`startRun` 的局部量;`RunScope` 在编排层上只有一个读取槽 `run`
  (跨栈句柄,与 `runtime.activeRun` 同一结构性角色:abort 走 activeRun,
  快照/排队读瞬态走 `run`)。`lastStamp` 从账本派生(扫全文件消息时间戳
  取最大,重启不可能重发一个已存在的 stamp);`lastQueued` 以运行局部量
  做发布去重基线——队列深度本就不在盘上,票面的「从账本派生」对它按
  「从 runtime 派生」执行。
- **审批:结束 + 悬空,先行接线**:Promise 机制整个删除。闸门
  (`authorize`)对要问的调用返回 block 理由,`beforeTool` 附加
  `terminate: true`(hooks 的 `before_tool` 答案加了这一可选字段),运行在
  闸门处结束;`pendingApprovals` 改为**账本派生**——新
  `session/dangling.ts` 的 `danglingApprovalsOf(buildContextEntries())`,
  有 tool_use 无 tool_result 即悬空,只在**空闲**会话上报告(运行中悬空
  是结果正在落地的瞬态,报告会在每个工具批上闪横幅)。`approve` 更名
  `respondApproval`(server 端点同步改调用,REST 面不动):deny 落带理由的
  错误结果;grant 落「已批准、请重发」的结果并**把该工具记为会话自己的
  审批选择**(一条 `tool_config` entry,与 config patch 同一条机制),使
  重发的调用过得了闸门——票 15 落地后改为按 call id 配对续跑,此处注释
  已写明过渡语义。`denyAllApprovals` 平移为「对悬空 call 落 deny 收尾」,
  只在空闲会话上动作;`abort`/`close` 各自等待运行沉降后再清扫。
- **账本读取的口径**:编排层经 SessionManager 门面读账本(`fillSession`
  在打开时重放出状态,追加即时落盘,`buildContextEntries` 每请求现取视图)
  ——门面每请求 `fillSession` 全文重放留给 16 票的 hub 适配一起收(hub 的
  pending 会话流程与 fork/rename 仍依赖门面,单方面绕开会造出双路径)。
- **smoke 适配**:smoke-session 的审批节改写为过渡语义(闸门结束运行、
  悬空调用从账本派生、deny/grant 两条回答路径),smoke-boot 的「最坏情况
  在场」改用**永不回答的供应商调用**(守 abort 信号)维持「close() 在
  运行在场时返回」的证据——审批不再停住运行,旧 parked 前提失效。
- **登记给后续票**:smoke-approval.ts 与 smoke-approval-endpoint.ts 失败
  ——它们整篇测的就是本票删除的 Promise 挂起机制(宽限期、
  approval_request 帧、挂起中的回答),由 15/16 按新语义重写;
  smoke-stream / smoke-projection / smoke-mux-live 在干净 master 上同样
  失败,与本票无关(票 13 已登记)。AGENTS.md 的 approval 词条与
  architecture.md 的 `before_tool` 一节已随本票改为结束重启表述;
  architecture.md 的持有模型一节(每会话一个 Agent 实例)等 16/18 票
  hub 适配落地后一并改写。

## Comments
