# 17:窗口客户端适配——审批与运行状态的新语义

Type: task
Status: resolved
Blocked by: 16

## Question

`packages/web` 适配审批「结束重启」后的窗口语义:

- 审批 banner:数据源从「挂起的 Promise 广播」改为「账本悬空 call + 已答记录」
  的派生快照(16 票提供的语义);答复按钮的 POST 不变。
- 运行状态展示:等审批 = 本轮运行结束(流停、状态行归零)→ 答案到达后新轮
  恢复——状态行/流式渲染要表达「等待审批」与「恢复运行」两个新阶段,不把它
  误显示为普通完成或错误。
- 模式座位:按值匹配(ADR-0005)不变;`ToolState` 成为数据后前端可见语义
  无变化,若有接口出入以 16 票的 server 面为准。
- 客户端对供应商 SDK 一无所知的红线不变(只看协议消息)。
- 验收:`npm run build:web` 通过;`npm run desktop` 手测走 18 票清单。

## Answer

已落地。banner 的数据源在 16 票改掉 server 派生后就已就位——mux 的
`pushApprovalChanges` 按快照差分发 `approval_request` / `approval_settled`,
客户端既有的 fold 原样接住,本票没有为 banner 加一行客户端派生;改动集中在
**工具卡片的「等待审批」阶段**,那是两处把等待误显示掉的地方:

- **活跑路径**:loop 对被闸门 suspend 的调用**从不**发 `tool_execution_start`
  (loop.ts:447),所以窗口对等待中的调用一无所知——`approval_request` 帧现在
  负责造卡片(`upsertTool`,running:false + waiting:true)。卡片既不转圈也不
  显示「无输出」,行尾一颗不脉动的琥珀点(`.tool-wait`,与 `.tool-spin` 共形),
  展开体写明本轮在此调用前暂停。
- **重开路径**:`itemsFromSnapshot` 先按旧例 settle 非提交快照的无答卡片,
  再把 `snapshot.pendingApprovals` 点名的卡片标成 waiting——重开的 transcript
  显示的是一个仍站着的问题,不是一张普通完成的卡。
- **恢复运行**:grant 的续跑重发该调用,其 `tool_execution_start` 把卡片翻回
  running(`waiting:false`);deny 的合成结果走正常 end 事件收尾。孤儿收尾
  (宽限 deny)不发 loop 事件,`approval_settled(approved:false)` 自己把卡片
  按 error 收住——正常续跑的 end 事件随后整体覆写。
- **语义注释平移**:main.ts 两处旧表述(「等审批的运行仍报 submitting:true」、
  「run parked mid-tool」)改为结束重启语义——send 引用随轮结束释放,续跑由
  pane 引用照看;`reduceEnd` 清 approvals 的理由改写(等待的答案住在账本里,
  清空不丢事实;被收割的会话先 deny 后关闭、被删会话不能持有悬空 call)。
- **模式座位**:按值匹配原样未动;`ToolState` 在 web 无引用,无接口出入。
  供应商 SDK 红线不变,新增读的协议面只有 `approval_settled.approved`。

`npm run check`(含 token 审计)、`npm run build:web`、smoke-mux / smoke-api /
smoke-approval / smoke-approval-endpoint / smoke-approval-recovery 全绿。
`npm run desktop` 手测留给 18 票清单。
