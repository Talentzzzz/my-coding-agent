# 0023：holds 迁入 SessionManager——文件闸与删除的否决式

日期：2026-11-17 · 状态：已接受，**已落地**（holds-into-manager 01–03 号票：core 的闸、编排层的
否决序、server 的簿记退场与 202、check 收紧；04 号票补否决式冒烟、05 号票同步文档，见
`.scratch/holds-into-manager/`）
取代：[0001](0001-transport-websocket-mux.md)（部分——hold 的**住址与持有者**那半句：hold 曾住在
hub 的 `holds` 表、由 server 命令的 `hold` / `release` 括号进出；「core 的 `Agent` 不再有
hold / release 动词」那半句**保持成立**，本 ADR 不推翻它）、
[0006](0006-services-drop-instance-state.md)（部分——`SessionManager` 成为第二个持有常驻表的服务，
与 `ToolManager`（[0011](0011-tool-manager-instance-table.md)）同类；无属性门面的其余一切不变）、
[0022](0022-drop-send-reference.md)（部分——「守卫刻意只有三道」：守卫变成动作，409 退场）

## 背景

hold 由三棒递到今天：wire 语义定于 0001（原名 `claim`），计数 2026-11-16 从编排层上移 hub
（0021 文末后续），删除守卫 2026-11-17 从四道减为三道（0022）。落地后的形状：一张
`Map<id, count>` 住在 `SessionHub`，server 的 mutating 命令以 `holding()` 括号进出
（`hold(id)` 校验 id、计数 +1；`release(id)` 计数减一），`remove` 以三道守卫拒绝
（`holdsOf > 0 || isRunning || hasPendingApprovals` → 409「等它停下来再删」），`closing`
槽位串行化「hold 等删除」。

这套安排留下两个错位：

1. **并发知识住在不管文件的层。** holds 保护的是会话文件对（同一 stem 的 `.json` +
   `.jsonl`），却按 sessionId 键控、住在传输层：管文件的 `SessionManager` 自己看不见并发问题，
   锁以 id 为单位意味着文件层连「被锁的东西是什么」都要借门面层的身份来指名。换存储的那天，
   传输层里会留下一段别人看不懂的簿记，文件层没有一个字提到锁。
2. **删除以「有人在用」为由失败。** 409 要求用户先手动停止、再点删除——停它本来就是他的意图；
   停在审批闸门上的会话删不掉，尽管没人会再来答审批。0022 已把产品语义定为「最后一个动作赢」，
   但只减了 send 一道守卫：409 还在，删除仍会因「有人在用」而失败。

## 决定

1. **holds 迁入 `SessionManager`，按文件对键控。** `Map<fileKey, { holds, closing? }>`，键是
   `.jsonl` 绝对路径经 `absPathKey`（resolvePath + win32 大小写折叠）折叠的规范文件键——锁的
   单位与它保护的东西重合，id 只是进闸前的一次地址解析，此后簿记的领域里没有 id。
2. **持有者内化，门面零动词。** Manager 每个触碰会话文件对的公开方法（meta setter、append 族、
   `open`、`forkFrom` 的写目标半）在**自己的同步块长度内**进闸出闸；单线程进程里同步块不可被打断，
   它的意义不是互斥等待，而是与 `closing` 闸的相遇点——进闸撞上一次进行中的删除，以
   `UnknownSessionError` 拒绝，读作「没有这个会话」，与「等过 closing 再发现文件没了」同一答案、
   同一错误种类，只是不再等待。`remove` 是唯一跨 await 的持有者，闸罩它全程、进闸即立
   `closing`。`Agent` 门面不新增任何动词，controller 的 `holding()` 括号删除，命令的存在性 404
   改由命令自己的调用路径提供（`open` → `UnknownSessionError` → transport 的 404，与 `read`
   现状同族）；占不占 hold 的命令分类清单随括号一起消失，统一规则变成「触碰文件的 Manager
   方法过闸，读不过」。
3. **易失簿记，存储原语缺失税。** 这张表是对 0006 无属性服务的**有意识修订**（第二张常驻表，与
   `ToolManager` 的实例表同类）：重启即空、不落盘、不可重建也不需重建。它存在的原因是文件系统
   没有「存在才写」的原子原语（实证：`.scratch/fs-race-test/test.mjs`——unlink 可插进打开句柄
   之后、write 不报错、rename 到已删目标会把文件造回来），「两个写入方不同时碰一对文件」只能靠
   进程内的计数表补出来。rm 因此**先删 `.json`（诞生的提交标记）、后删 `.jsonl`（流）**：两步
   之间到达的一切新写入方（prompt 前置校验、grant、冷路径）都查 meta、都读到「不存在」，中间态
   读作半途夭折的诞生，由既有扫描（`settleSessionFiles` / `fillSession` 的 prune）自愈；反过来的
   顺序会留下 meta 还在、流却没了的中间态，读作「会话在但记录残缺」，每个读者都要另作解释。换成
   事务型存储的那天——方法变事务、调用方一字不动——这张表跟着消失，不是搬进新存储。
4. **删除改否决式。** `Agent.deleteSessionBySessionId` 的序：① 运行在飞则 `abort` 并等引擎
   收尾，然后**复查到稳定（有界）**——收尾窗口里可能有新起步的恢复运行（grant 的恢复、被接受过的
   prompt），每轮之间让出一个宏任务轮；到界仍不稳也继续往下走，否决式、删除赢；②
   `SessionManager.remove(id)`：文件闸罩全程，闸内 rm 两个文件；③ 无条件出表。悬空审批不再是
   守卫：abort 自带的 `denyAllApprovals` 合成结果收尾，悬空调用随删除序一起死。删除从此不再以
   「有人在用」为由失败，失败只剩真正的病态（文件已损、id 非法）。
5. **wire：DELETE 202、409 退场、health `held` 退场。** `DELETE /api/sessions/:id` 应答
   200→202：hub 的 `remove` 同步只做存在性校验（无所指 → `UnknownSessionError` → 404，与
   「第二次删除是 404」一致——删除进行中或完成后文件已消失）、向观看者告别、清未指名落点，然后
   **不 await** 删除——否决序分离在后台跑完，202 应答先到（运行中删除应答先于收尾）；分离
   promise 挂中文诊断日志，删除的失败只剩病态。409 的「还有运行中的轮次或没答完的审批，等它
   停下来再删」与 controller 的映射一起退场。health 的 `held` 字段退场：簿记离开传输层后 server
   对「谁被持有」不再有诚实的来源（ADR-0012），而让门面转发一个计数窄读就是让 `Agent` 知道
   holds——正是被否决的方案；报告一个借不来的数字比少一个字段更糟。mux 帧一字不改。

## 被取代的是什么

| 原结论 | 本次 |
|---|---|
| [0001](0001-transport-websocket-mux.md) 的 hold：住在 hub，`hold` / `release` 是全部通道 | **修订**。住址换成 SessionManager 的表、持有者换成 Manager 方法自己的进出闸、键从 id 换成文件对。「core 的 `Agent` 不再有 hold / release 动词」**原样成立且更深**：门面连窄读都不给，server 包零 hold 通道——由 `check-server-facade` 收紧为机器检查。 |
| [0006](0006-services-drop-instance-state.md) 的无属性服务 | **修订**（有意识的）。`SessionManager` 持一张易失簿记表——与 `ToolManager`（0011）同类，代价同类地圈死：单写者（只有 Manager 进出闸）、易失（重启即空、不需重建）；「类壳保留、构造注入、不养聚合袋」原样成立。 |
| [0022](0022-drop-send-reference.md)「守卫刻意只有三道」 | **取代**。守卫变成动作：中止 → 有界复查 → 闸内 rm（先 `.json` 后 `.jsonl`）→ 出表。0022 的「最后一个动作赢」产品语义由此才真正完成——那次只减了 send 一道，409 还在。 |
| 0022 *没有被取代的*一节为 holds 留住 hub 的两条理由（跨 await 短命令的唯一现形手段 + `closing` 串行化） | **目的保留、实现更换**。跨 await 的保护从「现形后拒绝」改为「先停运行 + 闸内拒绝」；串行化原样活着，只是闸的主人从传输层换成存储层、闸的单位从 id 换成文件。 |

## 没有被取代的

- **读不拿锁。** 快照读取、列表扫描、订阅不占闸；fork 对源的读也是读。闸罩「经 Manager 的
  写入」，运行在飞的写入由否决序的第一步（中止 + 等收尾 + 复查）覆盖——两半覆盖面相加恰好是
  全部写入方，谁也不重复、谁也不缺席。「读」指袋在手的**热读**——它从不进闸；冷路径的唯一入口
  `open` 做磁盘 I/O 且可能 prune（删掉打不开的配对），是与写入同族的落盘动作，所以进闸——
  「快照读取不过闸」与「`open` 过闸」的张力即在此化解：过闸的是打开动作，不是任何一次读取。
- **hold 的计数语义。** 纯计数、宽容释放（对无人持有的文件键无事发生）、归零删条目——hub 旧
  `release()` 的语义原样搬进 Manager 的 `leaveHold`。
- **订阅与 hold 永不互相换算**（0001、0022 保留的那半）：订阅是连接上的状态，回答「这条连接
  要不要这个会话的内容」，与「谁在改变这个会话」仍是两个问题——只是后者不再有 server 侧的形状。
- **删除的存在性语义。** 第二次删除仍是 404，不是静默 no-op；对无所指的 id，闸前的地址解析即以
  `UnknownSessionError` 拒绝。

## 后果

换来的：

- 并发问题回到知道它的那一层：签到簿归管文件的人保管，且只有他进出；传输层簿记回归纯传输
  （watchers、feedMap、current）。
- 删除与用户意图一致：运行中点删除直接生效（202 先到、中止与收尾在后），停驻审批闸门的会话可
  删，侧边栏状态在应答拍就与意图对齐。
- 「server 不感知 holds」从约定变成机器检查：`check-server-facade` 的 bannedMembers 增补
  `.hold(` / `.release(` / `.holdsOf(` / `.heldSessionIds(` / `.holds`，出现即失败。

背上的：

- `SessionManager` 不再是无属性的：一张进程级易失表，失效问题由「单写者 + 易失」回答（0011
  的四问法在此的三条答案：Manager 自己建、只有 Manager 写、重启即空无需失效）。
- 删除的应答与完成分离：202 之后否决序仍在后台跑，失败以诊断日志报告——调用方失去了「删除的
  结果可同步得知」的保证（它本来也只覆盖守卫拒绝这一种）。
- 有界复查是兜底不是保证：到界仍不稳也继续删——删除赢，被砍的运行以 abort 的语义收场。

## 不可逆性与代价

- **难逆转。** 迁移横跨 core 的两个文件与 server 的全部控制器，七个 smoke 脚本的 hold 断言面
  （计数断言、monkey-patch 接缝、409 删除节）整批改写为外部行为断言——回去要把这套观察手段重建
  一遍。
- **没有上下文会让人困惑。** 0006 说无属性、0001 说 hold 住在 hub、0022 说三道守卫，而代码里
  Manager 有表、hub 无 hold、删除永不 409——这份 ADR 就是那个「没有，被取代的只有这三半，其余
  全部还在」。
- **是一次真实取舍。** 放弃的是「删除的失败可同步预期」（409 → 202）与「server 能报告谁被持有」
  （health `held`）；换来的是锁的单位与保护物重合、以及一个不再与用户争辩的删除。

## 落地

- 代码：`packages/core/src/session/session-manager.ts`（`holds` 表、`enterHold` /
  `leaveHold` / `holding`、`remove` 的闸内 rm 与 `closing`、`setRemoveGate` 测试缝）、
  `packages/core/src/agent.ts`（`deleteSessionBySessionId` 的否决序）、
  `packages/server/src/hub.ts`（`holds` / `closing` / `hold` / `release` / `holdsOf` /
  `heldSessionIds` 全删，`remove` 改否决式分离）、`packages/server/src/controllers/sessions.ts`
  （`holding()` 助手与 5 个使用点删除、409 映射删除、202、health `held` 退场）、
  `scripts/check-server-facade.ts`（bannedMembers 收紧）。
- smoke：smoke-sessions / approval / approval-endpoint / stream / projection / mux / boot 七个
  脚本机械适配——hold/release 括号去掉、holdsOf 计数断言改写为等价外部行为断言或删除、409 删除
  节按否决式改写（202、第二次 404、文件真消失）；smoke-api 删除节 200→202。否决式新用例归
  04 号票。
- 文档：`AGENTS.md` 的 `hold` / `service` 词条与规则节；`docs/architecture.md` 的装配、
  SessionManager 一节与 §谁拥有一个会话。
