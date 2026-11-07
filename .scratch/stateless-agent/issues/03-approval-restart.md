# 03:审批改为「结束重启」——运行结束、tool call 悬空、loop 加恢复机器

Type: grilling
Status: resolved

## Question

工具需要审批时,运行是挂起在内存里等(现状:`pendingApprovals` 存
`resolve` 闭包,Promise 停住),还是结束本轮运行、等审批到达后重启续跑?

## Answer

**结束重启**(AgentScope Java 同款)。等待中的审批 = transcript 里悬空的
tool call(有 tool_use 无 tool_result,派生态,不需要内存 Map);审批答案经
REST 到达后,由 loop 的恢复机器扫描悬空 call、按 toolCallId 配对答案、合成
工具结果、继续运行。孤儿悬空 call(没等到答案)合成错误结果收尾。

这个决定的红利:运行期瞬态全部出袋——`running`、`partial`、retry 五字段、
`accepted`/`promptWrites` 变成运行函数的局部变量;`pendingApprovals` 整个消失
(Promise 本就无法序列化)。「一次运行的生命周期」与「一个会话的生命周期」分离。

代价(已接受):
1. vendored `packages/loop` 加恢复机器(扫描/配对/合成,AgentScope 的分支表
   的 Node 版)——本 effort 唯一要动 vendored 代码的地方(票 15)。
2. UI 语义变化:等审批 = 本轮运行结束(流停、状态行归零),审批到达后开新轮
   继续(票 16/17)。
3. 悬空 tool call 从异常路径(仅崩溃产生)变为主路径,文件里的收尾语义要跟上。

内存挂起被否的理由重温:挂起的 Promise 成本≈0 且有 `approvalGraceMs` 兜底,
但它是袋里最大的不可序列化、跨栈最脆的状态;重启方案换取袋的纯度与恢复闭合。
