# 交接文档：SessionHub 生命周期机器移除（2026-11-16）

> 给下一个窗口：本文件记录一次已基本完成的重构——把 `SessionHub` 的 host 生命周期机器
> （`HostedSession` / `hostedSessionMap` / `open` / `reap` / `announceHost`）整体删除。
> 代码与全部 smoke 已完成并全绿；**剩余工作只有文档对齐**（见 §5）。

## 1. 背景与决策

- 起因：逐层追问 `hostedSessionMap` 的必要性（"记它干啥 → 为什么记开着的 → 不记会坏吗"）。
- 代码级审计结论：防双 loop 由 core 的 `AgentState` 表 + 队列负责（一会在飞、二个排队）；
  事件分发按 sessionId 走 sink → feedMap，从不检查 host；袋空闲自散（ADR-0013）。
  host 机器没有任何"不记就坏"的硬依赖。
- 用户决策：**全删**。删除不是清理死代码，而是改一条契约——见 §2 的新旧对照。

## 2. 新契约（删除前 → 删除后）

| 旧语义 | 新语义 |
|---|---|
| hold = 打开会话（拼装 HostedSession + 计数） | hold = 校验 id 对磁盘 + 纯计数；**不拼装任何东西** |
| 最后一个 hold 释放 → reap（settle → 关会话 → 摘表 → 通知） | release = 计数减一，仅此而已；没有 reap |
| 会话"开着"是一段有边界的区间 | **"开着"这个概念不存在了**；袋随运行生灭，文件是唯一事实 |
| 观看（watch）只在 host 存在时拿到 feed，host 生灭触发重绑/收流 | watch 注册同一拍**恒交 feeds**（feedMap 按 id 分发，冷会话同样成立）；`undefined` **只在会话被删除或进程收摊时**到达 |
| 活/冷基线：`hub.live.includes(id)` | `hub.isLive(id)` = `agent.hasLiveHalf(id)`（袋在表中） |
| 停驻审批的袋靠 reap"留在表上" | 袋自己留在表上（停驻拒绝散袋），回答后由恢复运行的结束路径散袋 |
| abort 的弃置清扫留下空袋（reap 兜底） | `Agent.abort` 末尾自己散袋（新加，见 §3 core） |
| 关机遍历 hostedSessionMap 逐个停 | `Agent.closeAll()`（新加）——运行比请求活得久（202 语义），只有 core 知道谁在跑 |
| projection 靠 `onHostChange` 跟随 | projection **跟随自己创建的每一行**（publish 新行 → follow；forget → 解绑） |
| 出生/fork 发现：hub `announceHost` | 出生/fork 发现：controller 的 `SessionListener.onCreated`（boot 接线 → `projection.refresh`）；mount 类 smoke 自己调 refresh |
| 删除守卫：holds / opening / isRunning / hasPendingApprovals | 删除守卫：holds / isRunning / hasPendingApprovals / **waiting**（新增了 wait 守卫）；`closing` 槽位保留 |

**未变的承诺**：观看不占 hold；no-gap 基线（活半在场 → 同步 `snapshotNow` 写 baseline，同一同步块；
冷半 → 异步 `snapshotOf` + backlog）；停驻审批跨会话存活、重开可答；删除忙碌会话 409。

## 3. 已完成的改动

### core（packages/core/src/agent.ts）
- 新增 `hasLiveHalf(id)`：`agentStateMap.has(id)`。**注意**：不能用
  `isRunning || hasPendingApprovals` 替代——后者是账本事实，冷会话账本里悬着调用它也为真，
  会污染 projection 的行叠加（这个 bug 被 smoke-projection 的 stripped-marker 检查抓出来过）。
- 新增 `closeAll()`：停掉表中全部在飞运行并落定，供 `hub.close()` 关机。
- `Agent.abort` 末尾新增空闲袋散袋（弃置清扫后不再有 reap 兜底）。

### server
- `hub.ts`：**整体重写**。删除 HostedSession/hostedSessionMap/opening/reap/announceHost/
  onHostChange/HostListener/feedsOf/tryReapBySessionId/count。保留：holds（纯计数）/
  watchers/feedMap/closing（仅删除串行化）/waiting（新增删除守卫）/isWatched/
  heldSessionIds()（health 用）。新公开面：`isLive(id)`、`watch`（恒交 feeds）、
  `hold(id): Promise<void>`、`release(id): void`。
- `mux.ts`：open 改为 watch 恒 bind → `hub.isLive` 分岔（活=同步 snapshotNow 写 baseline；
  冷=readColdBaseline）；bind 尾部的 baseline 写入移除；pushBaseline 用 isLive；
  watcher(undefined) 仅删除/收摊时 → endStream。
- `projection.ts`：删 onHost 四分支；publish 新行时 follow、forget 时解绑；
  `liveOf(sessionId)` 按 `hub.isLive` + `hub.snapshotNow` 叠加，袋不在则继承扫描行。
- `controllers/sessions.ts`：`SessionListener.onCreated` 新增（birth/fork 触发）；
  `holding()` 改 hold(id)/release(id)；health 的 `live` 字段改为 `held`（heldSessionIds）。
- `boot.ts`：sessionListeners 接 onCreated；`projection` 参数改为可选（部分 smoke 不接）。
- `packages/web/src/api.ts`：health 类型 `live` → `held`（客户端只消费 workDirAbsPath）。

### scripts（7 个 smoke + mount-session）
- `mount-session.ts`：不再探内部表/announceHost，返回 `{ id, session }`；发现改由使用方 refresh。
- `smoke-projection.ts`：出生/fork 发现改为手动 `projection.refresh`（扮演 controller listener）；
  停驻标记段落改用**全新 hub**（真重启模拟，袋表为空，标记语义才可测）；
  onHostChange 测试块删除；watch 段改为"观看不需要任何重绑"。
- `smoke-stream.ts`：hold 释放不再结束车道——断言反转为"观看不是持有，车道长存"；
  散袋断言改轮询（散袋发生在运行 finally 里，agent_end 监听者可能抢跑）。
- `smoke-mux.ts`：车道 end 断言反转为"车道不随 hold 释放结束"；wait 段删除守卫改述。
- `smoke-sessions.ts`：entry-identity 断言（hold 不再拼装袋）删除或改为"hold 拼装不出任何东西"；
  收摊等待删除；health/尾部改 isLive。
- `smoke-approval.ts`：parked-approval 语义重写——"host 被 reap"改为"holds 表清空而袋拒绝散"； 
  `hasLiveHalf` 教训的回归就在这里；`driveToApproval` 返回 `{ wire }`；serve/Graph 暴露 projection。
- `smoke-boot.ts` / `smoke-approval-endpoint.ts`：机械替换 + "nothing is left running" 改 isLive。

## 4. 验证状态（全绿）

- `npm run check`：tsc×2 + tokens + server 门面守卫 ✅
- smoke-boot / smoke-sessions / smoke-mux / smoke-approval-endpoint /
  smoke-stream / smoke-projection / smoke-approval ✅ 全部 ok

## 5. 剩余工作（按优先级）

1. **docs/architecture.md 对齐**（3 处 reap 残留）——重点段落：
   - "谁拥有一个会话"一节：仍写着 hold 计数在编排层、`Agent.hold/release`、tryEvict、
     "打开与切换都是一次订阅" 附近的生命周期描述——全部按 §2 新契约重写；
   - hub 一节：`SessionHub` 的职责描述（hosts 表、reap、驱逐边）；
   - 图（`一条常驻连接 ─┐ 订阅表…` 那段 ASCII）：`host (SessionHub)` / `holds 计数` 的位置。
2. **AGENTS.md**（1 处 reap）：术语表 hold 条目——"收摊（reap）与删除（remove）动手前要问的问题"
   改为"删除（remove）动手前要问的问题"；"计数在 hub（SessionHub.holds，读法是 holdsOf，
   2026-11-16 从编排层上移）"之后的行为描述需补一句：hold 只计数、不拼装、无生命周期。
3. **ADR 不动**（历史记录，仓库惯例）：ADR-0001/0005/0009/0013/0015 里的 reap/host 表述保留原文。
4. 可选收尾：
   - `hub.ts` 里 `waiting` 字段声明在 `awaitResult` 之后（字段提升无碍，但顺序与别处不同风格）；
   - `smoke-session-view.ts` 未受影响（不触 hub 生命周期），无需处理；
   - 观察一次真实桌面运行（`npm run desktop`）确认侧栏行随运行实时移动（projection 新跟随模型
     的端到端确认，smoke 已覆盖但真机走一遍更稳）。

## 6. 这次的两个教训（写给下一个窗口）

- **`hasPendingApprovals` 是账本事实，不是驻留事实。** 它对冷会话（账本里有悬空调用）也为真。
  "进程持有"的唯一判据是 `agentStateMap.has(id)`——为此 core 加了 `hasLiveHalf`。
- **改生命周期契约时，smoke 的断言有一半是在测契约本身。** 7 个脚本约 60 处调用点里，
  机械替换只占少数；大量 `until(!live.includes(id))` 是在测"收摊行为正确"——每一条都要
  裁决：删掉、反转、还是改写成新契约的断言。smoke-projection 的 stripped-marker 检查
  抓住了 `isLive` 谓词的语义错误，这正是"测试在测契约"的价值。
