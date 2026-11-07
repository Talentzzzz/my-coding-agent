# 16:hub / server / mux 适配——审批新语义与 claim 覆盖恢复

Type: task
Status: resolved
Blocked by: 14

## Question

把 server 层接到新架构上,核心是审批语义的变化:

- `POST /api/sessions/{id}/approvals/{toolCallId}`:不再 resolve 挂起的
  Promise(机制已随 14 票删除),改为**记录答案并触发恢复运行**——编排层
  重放账本、恢复机器按 toolCallId 配对续跑(15 票)。
- 快照(`snapshot.ts`)与事件流适配:pendingApprovals 的来源从内存 Map 改为
  「账本悬空 tool call + 已记录答案」的派生;`approvalGraceMs` 宽限计时器
  的落点改为「对悬空 call 的超时收尾」(mux.ts:109 现注释语义平移)。
- claim 不变:改变会话的请求与在飞运行各在其长度内一个 claim;恢复运行
  同样要走 `SessionHub.claim()`;订阅继续不拿 claim(ADR-0001 不变)。
- REST 面与 mux 帧协议不变(ADR-0001);`GET /api/models` 仍只报 `hasApiKey`。
- `denyAllApprovals` 语义平移:abort / 会话关闭时对悬空 call 落 deny 收尾。
- `npm run check` + `smoke-api.ts` + `smoke-mux.ts` 通过。

## Answer

已落地。大部分 server 适配随 14 票一并进了树（编排层落地时 server 端点同步改了调用，
REST 面未动），本票核对逐项落点、收掉两笔递延（门面重放决策、文档持有模型表述），
并把 14 票登记的旧语义 smoke 重写收尾。

- **审批端点**：`approve` 只读检查（`hasPendingApproval`，账本派生）→ `onApproval`
  先记答案 → `respondApproval` 触发恢复运行（不 await，202 语义）。读检查在记录之前，
  所以一次被 409 拒掉的尝试不被记入任何表。
- **快照与事件流**：`pendingApprovals` 在活会话与冷读两条路上都由
  `danglingApprovalsOf(buildContextEntries())` 派生（`session/dangling.ts`），
  只在空闲会话报告；「已记录答案」不再是独立的派生输入——恢复运行把答案落成
  tool_result，悬空随即消失，没有第二份答案账要记。
- **宽限计时器落点**：`SessionHub.reap()`——settle 之后对悬空 call 等
  `approvalGraceMs`，宽限走完且无 claim 才 `denyAllApprovals("No window answered
  this approval.")`；宽限内 claim 到达则让开（注释已写明结束重启下的语义平移）。
- **claim 不变**：审批端点、prompt、abort 等仍经 `claiming()` → `hub.claim()`；
  恢复运行由端点持有的那次 claim 发起，run 本身靠 settle/reap 逻辑保活，与
  prompt 的运行同一条路。订阅不拿 claim，ADR-0001 原样。
- **deny 平移**：`abort()` 等运行沉降后对悬空 call 落带理由的 deny；
  `SessionHub.close()`（进程关停）刻意**不** deny——transcript 是唯一状态，
  重启继承的该是一个仍可回答的问题，不是一次没人做出的拒绝（注释已写明）。
  `remove()` 对有悬空 call 的会话仍是 409。
- **门面重放决策**（14 票递延项）：**保留 fill-at-open，不做每请求全文重放**。
  `SessionState` 是纯数据、`fillSession` 是磁盘→状态的唯一入口（打开、冷读、
  重启重开都走它）；host 在手时该 manager 是文件唯一写者（claim 保证），
  追加即时落盘，内存状态从不与文件分叉——这正是 ADR-0006 后果一节允许的
  「可从磁盘重建的缓存」。每请求重放会打破 pending 会话流程（`create()` 后
  文件尚不存在，`fillSession` 会拒绝），换来的是单写者规则已经保证的东西。
- **smoke**：`smoke-approval-endpoint.ts` 已按新语义重写（409 契约、顺序敏感、
  拒绝零记录），`smoke-approval.ts` 已改 mux 级新语义，`smoke-approval-recovery.ts`
  （15 票新增）覆盖恢复机器三场景——三者全绿。`npm run check`、`smoke-api.ts`、
  `smoke-mux.ts` 通过。smoke-stream / smoke-projection / smoke-mux-live 仍失败
  ——13 票已登记为干净 master 上的既有失败（mux-live 是本机临时目录的历年
  smoke 残留扫进行表），不属本票，留给 18 票全量验证处置。
- **文档**：architecture.md 的持有模型表述（图、core/server 职责、目录注释、
  装配一节、真相之源一节、谁拥有一个会话）与 AGENTS.md 的 session / assembly
  词条随本票改为无状态表述；ADR-0006 与 adr/README.md 的索引行随本票一并入库
  （07 票的文件此前一直未提交）。
