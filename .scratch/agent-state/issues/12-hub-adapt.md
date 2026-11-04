# 12：hub 适配——pending / reap / evict 与新生命周期

Type: task
Status: resolved
Blocked by: 03, 04, 08

## Question

把 `SessionHub` 的三张表与两段计时器对齐到「打开即建、切走即清」。

- **`pending` 删除**（03 号票）：`has()` / `snapshotOf()` / `open()` 判据改为「Agent 的表里有，或磁盘上有」；
  `sessionOptions` 不再传 `openSessions`，改为在 `open()` 里 `agent.adopt(createAgentState(...))`。
- **`hosts`**：现在 `HostedSession` 就是「这个进程跑着它 + 有几个 claim + 正在 reap」。表本身可以留（它是
  claim 的计数器），但要定它和 `AgentState` 谁是「会话在跑」的判据——推荐 `hosts` 留、`AgentState` 的存亡
  跟随 `hosts` 的增删，两者同生同灭。
- **`evict`**：`Agent` 新增公开 `evict(id): boolean`，内部判 `live.activeRun === undefined && live.suspended === false`
  （04 号票），不满足返回 false；`hub` 在**最后一个 observer 离开**时调它（`observers` 的 `delete` 点）。
  `reap` 里现有的「settle → 有审批就等宽限 → 再 settle → 删 host → close」按 04 号票的答案删减。
- **`remove` / `close`** 两条路径同步改：`openSessions.delete` → `agent.evict`（或直接 `sessions.delete`，
  这两处是宿主收摊，不需要判据）。
- **`agentState(id)` 公开读法**：`projection.ts` 与 `feedsOf` 要读活会话的袋，别把 Map 露出去。
- 收账：`npm run check` 绿；`smoke-api` / `smoke-mux` / `smoke-sessions` / `smoke-liveness` /
  `smoke-desktop-close` / `smoke-desktop-observability` 绿。

## Answer

### 结论（一句话）

`pending` 整条退场（表 + `pendingManager` + `close()` 里的 `clear`），`has` / `snapshotOf` / `open` /
`remove` / `createUnpersisted` 五段按 03 §3/§4 的形状落地——创建即装配入表；驱逐边沿接在 observers 的
delete 点上（有 host 走 reap 尾巴、没 host 直接 `evict`）；reap 按删减成「settle → 删 host → 通知 →
close → evict」，宽限、deny、`approvalGraceMs`、`delay` 全删；票面的「同生同灭」被 03 §2 修正为
`hosts ⊆ 表`，落地如实。新增边沿引入了一处真实竞态（reap 通知 observers 拆流 → 拆流触发边沿 → 边沿
抢在 reap 尾巴前驱逐），以两处幂等护栏收束。`npm run check` 绿，票面六个 smoke 加十个相邻 smoke 全绿
（`smoke-api` 为 07/08 号票已登记的本机环境问题）。

### 落地形状

- **`pending` 三件套删除**：字段、`pendingManager`（含那句 `existsSync` 盘探针——`fileCreated` 本来就在
  袋上，03 §6）、`close()` 的 `pending.clear()`。
- **`has(id)`**：`this.agent.has(id) || SessionManager.findSessionFilePathById(id) !== undefined`——
  两分支（表 / 盘），hosted 被「表」吸收（`hosts ⊆ 表`）。
- **`snapshotOf(id)`**：`agent.has(id)` 即 `agent.snapshot(id)`（同步块内判与读，无 await）；否则
  `sessions.open(id)` 冷读一份，`Unknown session` 的拒绝话术归 `open`——手写的定位 + fill + 拒绝三步
  （02 §1 点名的第二处抄写）随之消失，`fillSession` 从 hub 的 import 里退场。
- **`open(id)`**：`agent.has(id) ? agentState(id) : await adoptFromDisk(id)`——表里有的不再重新装配
  （03 §3：打开 ≠ 重新装配，队列与订阅者都挂在原状态上）；`adoptFromDisk` = `open(id)` 重放 +
  `assembleSession` + `adopt` + **读回** `agentState(id)`（adopt 先到先得，host 必须跑在表里实际持有
  的那份上）。创建同型：`createUnpersisted` 变 async，`createSession` + `assembleSession` + `adopt`，
  两个调用方（`newSession` / `resolveCurrentId`）加 `await`。
- **`remove`**：`held` 改读 `agent.has(sessionId)`；其余（拒绝条件、`drop` 收尾）不动。
- **驱逐边沿（observers 的 delete 点）**：最后一个 observer 离开 → host 不在 → `agent.evict(id)`（判据
  在 Agent 侧，未落盘的袋天然被拒）；host 还在 → 不直接调 evict（`hosts ⊆ 表` 的执行面：删表只在 host
  已删之后），走 `void this.reap(host)`，以 `reaping` 防重入。
- **reap 删减**：宽限 watch、`denyAllApprovals` 调用、第二次 settle、`approvalGraceMs` /
  `DEFAULT_APPROVAL_GRACE_MS` / `APPROVAL_WATCH_MS` / `delay()` 全删。剩余：settle → claims 检查 →
  删 host → 通知 observers → `announceHost(undefined)` → `close` → 尾巴上 `evict`（判据判定；suspended
  与未落盘的袋留在表里——03 §7 定的寿命）。代价照 04 §4 记账：审批可悬空到进程重启或下一次运行收尾。
- **smoke 适配**：`smoke-approval.ts` 第 4 节按新语义重写（host 被收走而问题留存：重开拿到新 host、
  同一只袋——加了一条 `agentState(id).session === mount 的袋` 的同一性断言，即 03 §8 给 15 建议的那条；
  无人回答的审批永不 deny；反复开合不卡死）；`openRig` / `openCrossRig` 去 `approvalGraceMs`；
  `smoke-approval-endpoint.ts` 同去，并按 smoke-approval 第 1 节的既有样式加 bench claim（新语义下 run
  结束即 reap+evict，快照读会与驱逐竞态，这是让该 smoke 成立的最小适配，非放松）。

### 落地中发现并修掉的竞态

新边沿让「通知 observers」变成了驱逐的触发器，而 reap / remove 自己就在通知 observers——mux 收到
`observer(undefined)` 拆流，拆流触发边沿，边沿发现 host 已删（reap 先删后通知，03 §2 的顺序）就把状态
evict 掉，reap 尾巴上的 `agent.close` 随即抛 `Session is not running`（`smoke-mux` 实跑撞出）。修法三处，
全部幂等而非抑制边沿：reap 尾与 remove 的 close 各以 `agent.has(id)` 守卫（边沿先到 = 它做了同一件事，
不重复也不报错）；`hub.close()` 把删 host 挪到通知之前（否则关机时的拆流会对着一个正在收摊的 hub 走
reap）。`hosts.get(host.id) === host` 的同一性检查保留——它防的是误删替换后的新 host。

### 验证

- `npm run check` 绿（core / server / web tsc + token 审计）。
- 票面六个：`smoke-api` FAIL（mux 连不上 127.0.0.1:8080，07/08 已登记的本机环境问题，与改动无关）；
  `smoke-mux` / `smoke-sessions` / `smoke-liveness` / `smoke-desktop-close` / `smoke-desktop-observability`
  全绿。
- 相邻十个：approval / approval-endpoint / approval-queue / approval-recovery / session / stream /
  projection / mux-live / boot / mux-client 全绿。

### code-review 记录

两轴跑完，无硬伤；判断性意见均登记处置。

**Standards 轴（5 条，全为 judgement call）**
1. `remove` 与 `reap` 的「通知 + 条件 close」形状重复——保留：两处是 03 §2 明说的两条路（「差别只是前面
   要不要先 settle 一次」），抽帮手会把差别藏进参数里。
2. `sessionOptions(state, state.sessionSetting.workDirAbsPath)` 三处重复取 workDir——保留：入参形状是
   `OpenAgentOptions` 的（session 与 workDir 本就成对），冷路径的 workDir 另有来处，改签名利小弊大。
3. `state.session.sessionSetting.workDirAbsPath` 消息链——08 号票 review 已裁定不动（票面字段映射如此）。
4. smoke 白盒断言 `agentState(id).session === bag`——有意为之，是 03 §8 给 15 的建议检查，`agentState`
   本就是公开读法、未露 Map。
5. `Rig.bag` 与 `mountSession` 返回的 `state` 一物两名——保留：`bag` 是仓库对「账本袋」的术语，Rig 侧
   取其语义；`mountSession` 的返回名不改（它返回的就是装配用的 Session）。

**Spec 轴（2 条）**
1. `close()` 里逐 host 删除后原有的 `this.hosts.clear()` 被指冗余——保留：`close()` 是 async，await 窗口
   内仍可能有 claim 开出新 host，`clear` 仍是收尾那一扫（且为既有代码，非本次新增）。
2. bench claim / `Rig.bag` 判定为「有据的最小适配」，非 scope creep（见上）。

