# 0021：懒身份改造——会话随第一条消息原子出生

日期：2026-11-15 · 状态：已接受，**已落地**（`check` 绿，smoke 逐个同色）

取代：[ADR-0013](0013-table-holds-live-half-only.md) 的第三条驻留理由（「没有未落盘的袋」，见文末修订）
取代者：无

## 背景

「会话随第一条消息才落盘」（[ADR-0008](0008-session-two-file-format.md)）在服务端留下了一个中间态：
`create` 之后、第一条消息之前，会话只存在于编排层内存的 `live.unwrittenSession` 上——重放造不出它，
于是它要一路被「文件尚未出生」的守卫护着：`getSessionBySessionId` 的未出生分支、
`tryRemoveAgentStateBySessionId` 的拒绝条件 3、`forkFrom` 与 `fileAbsPathOf` 的未出生读法、
`appendMessageEntry` 的出生摘除，还有 `live.openedOn` 这个只为 test-only 打开行存在的槽位。
web 客户端早已是草稿流（`DraftSession` 客户端持有、create 推迟到首条消息），旧协议下它却要走
create → PATCH mode → open → POST message 四步才能把一段对话开出第一句话。

多轮讨论确定的三个决策合流成一个设计：**① 删掉休眠的 `openedOn` 接缝**（生产装配链从不停它，
`openOptions` 只递 `{ session }`）；**② workDir 由用户先选、输入框禁用直到选了目录**；**③ 首条消息
前的模式选择随消息发送**。结论：服务端在第一条消息之前完全无状态——`live.unwrittenSession`、
「未开口会话」的守卫与概念一次性删除，会话 id、两个文件、模式指针、模型选择在同一个请求里原子出生。

## 决定

1. **`POST /api/sessions` 是出生证明**：body 必填 `{ text }`，可选 `{ workDirAbsPath?, behavior?,
   mode?, model?, thinkingLevel? }`；应答 201 `{ sessionId }`。id 仍由服务端铸（客户端不指名 id，
   避免路径注入与碰撞）。`workDirAbsPath` 沿 `workDirAbsPathForCreate` 的双重校验（400），未知
   mode/model 是 409——与既有会话上的同类变更对齐。`POST /api/sessions/:id/messages` 不动：对已
   存在的会话，mode 不随消息走（ADR-0018 的 PATCH 通道保持）。`optionalObjectBody` 删除（唯一消费者
   就是旧 create 的空 body）。
2. **`Agent.create(workDirAbsPath)` 删除，新增 `createAndPrompt(workDirAbsPath, text, options?)`**：
   `createSession` 铸 id → 对**本地袋**直接经 `SessionManager` setter 落 mode（校验，未知名字抛出）与
   selection（与 `applyModelSelection` 同一套规则，核心抽成袋级 helper `writeModelSelection` 两处共用）
   → `assembleAgentStateBySession` 进表 → `appendMessageEntry`（此刻两个文件出生，快照序列化带着
   mode/selection）→ 引擎开跑 → 返回 id。append/写盘抛错时 `agentStateMap.delete(id)` 再 rethrow——
   失败的出生不向外递 id。
3. **`resolveSettings` 删 `chosen` 参数**，模型回落链简化为「文件记录的选择 → 设置默认行 → 内置默认行
   → 第一行」；`live.openedOn` 与 `live.unwrittenSession` 两个字段连同其文档一起删除，装配不再暂存
   任何袋、不再保留任何覆盖。
4. **「未开口会话」的概念整体删除**：`getSessionBySessionId` 恒走 `sessionManager.open`（盘上没有文件
   的 id 就是本进程不知道的 id，404）；`tryRemoveAgentStateBySessionId` 剩「运行在途 / 审批停驻」两个
   拒绝条件；`forkFrom` / `fileAbsPathOf` 只认磁盘查找。
5. **web 客户端**：草稿流不变，四步折叠为一步——POST 出生证明（带 text、目录、草稿攒下的模式与席位
   选择）→ `openSession(id)`（订阅、收 baseline）→ `mux.retain(id, "send")`。顶部「新建会话」产出
   无目录草稿，输入框禁用直到目录芯片选定（选定即写入 `draft.workDirAbsPath`、侧栏草稿行随之归组，
   无目录草稿落进「未选择目录」的假组）；侧栏每组标题的「新建会话」与「添加目录」仍带目录出生、
   直接可用。`directoryForNewSession()` 删去草稿路径上的根目录回落；副标题、chip 标签与空态对「未
   选择目录」给出文案。草稿的 mode 不再 PATCH，随出生 body 发送；模型/档位沿用随消息机制不变。
6. **mux 不动**：未知 id 的 `open` 仍报错帧（mux 帧不铸造会话）。

## 被否掉的备选

- **客户端指名 id**——路径注入与碰撞的入口，服务端铸 id 的理由（ADR-0008 起的文件名约定）不变。
- **创建即落盘**——被否决的是它的反面结论（保留 create 空体端点）：一个没说过话的会话落盘会在
  侧栏留下幽灵行，与「没有对话就不是对话」的存储规则矛盾。
- **按默认合成未开口会话**——「未出生时用一个合成视图替它作答」仍要在每个读取点判断生死，守卫
  并没有减少，只是换了形状；删除中间态比美化它便宜。

## 后果

- **服务端在第一条消息之前完全无状态**：任何「文件尚未出生」的分支、守卫与字段都不存在了，
  `AgentState.live` 回到纯运行期状态（队列、在飞运行、partial、重试、挂起位）。
- **出生请求 fire-and-forget，客户端拿到 id 后才订阅**——若运行在订阅前启动失败（几十 ms 窗口），
  失败帧无人接收，表现为「消息发出、无回复、running:false」。评估：首 token 延迟远大于订阅延迟，
  窗口实际不可触；不为它给 fanout 加缓冲机制（ADR-0017 刚把扇出收进编排层私有方法）。
- **`inMemorySession`（永不落盘）与编排层不再兼容**：经编排层驱动的会话必须有真实目录与文件；
  smoke 里用它打开编排层的用例全部换成真实临时目录会话。`inMemorySession` 本身保留——不经
  编排层、只操作 `SessionManager` 的用例仍然合法。
- **`openAgent` 的 test-only 模型覆盖随之消失**：要在特定行上打开会话的 smoke 改为随第一条消息
  递 selection（`createAndPrompt` 的 options），或直接在会话快照上写选择。

## 对 ADR-0013 的修订

驻留理由从四类减为三类：**运行在途 / 审批停驻 / 在飞请求的读取边**（hub 侧的 observers 与 waiting
两条判据不变）。原第三条「没有未落盘的袋」（`live.unwrittenSession` 非空的会话永不驱逐）随中间态
一起消失——会话记录以文件为唯一形态，表里不再有任何重放造不出来的东西；驱逐判据就是那两个。
`tryRemoveAgentStateBySessionId` 因此少一个条件，`deleteSessionBySessionId` 的「文件从未写下」分支
不再可由编排层驱动出来。
