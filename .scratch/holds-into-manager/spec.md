# Spec：holds 迁入 SessionManager + 删除改为「停掉再删」

Status: ready-for-agent

来源：2026-11-17 的一场设计讨论。用户先后拍板两件事：①持有计数表（holds）从 `SessionHub`（server 包）迁入 `SessionManager`（core 包），锁动词经 `Agent` 门面暴露——理由是"只有管文件的那一层知道自己有并发问题，并发应该在那一层解决，不给别处添负担"；②删除从"有人用就 409 拒绝"改为"否决式：中止运行 → 等在途命令退场 → 删"。讨论过程中逐条重新推导并确认了既有设计的四条边界（锁罩整条命令、读不拿锁、锁原语缺失时用计数表补、原语到位时计数表可消失），本 spec 只把**改变**的部分立为决定，不推翻这些边界本身。

## Problem Statement

从用户的视角：

1. 点删除时，如果会话正在跑一轮对话，服务器返回 409"等它停下来再删"——但停它是我的意图，删除应该替我把运行停掉，而不是要求我先手动点停止、再点删除。
2. 一个停在审批闸门上的会话也删不掉（409），尽管我明确不再需要它的答案。
3. 从维护者的视角：持有计数表（"此刻谁在改变这个会话"的签到簿）住在传输层（hub），但它保护的其实是会话文件。管文件的层（SessionManager）自己看不见并发问题，并发问题的知识泄漏到了传输层——换存储的那天，传输层里会留下一段别人看不懂的簿记。

## Solution

1. **计数表搬家，语义不变。** `holds` 这张 `Map<sessionId, number>` 迁入 `SessionManager`。它仍然是纯计数、无生命周期：hold 校验 id 在磁盘上有所指后计数 +1，release 宽容地 -1（对没持有的 id 不抛错），归零删条目；读会话与订阅不占 hold；运行照旧在 202 应答时当场交还 hold（运行的在飞由 `isRunning` 单独回答）。变化只有住址：签到簿归管文件的人保管。
2. **锁动词走门面。** server 包够不着 Manager（ADR-0012 消费边界），所以 hold / release 以动词形式出现在 `Agent` 门面的公开面上，controller 的 `holding()` 包装器原地保留、内部改走门面。`check-server-facade` 守卫继续保证没有旁路。
3. **删除改为否决式。** `remove()` 的三道守卫换成三步动作：运行在飞则中止并等引擎收尾；然后等计数归零（在途命令是毫秒级，等待有上界）；悬空审批不再是守卫——悬空调用随文件一起死，"最后一个动作赢"。删除从此不再以"有人在用"为由失败。
4. **wire 一字不改。** 删除端点从"可能 409"变成"总是成功应答"，其余 REST 与 mux 表面不动。

## User Stories

1. As a 桌面窗口用户, I want 在对话正在跑的时候点删除直接生效, so that 我不用先点停止、等它停、再点删除。
2. As a 桌面窗口用户, I want 删除一个停在审批闸门上的会话也能成功, so that 我放弃的会话不会因为没人答审批而一直挂在侧边栏。
3. As a 桌面窗口用户, I want 删除动作不被服务器以"有人在用"为由拒绝, so that 我点删除之后侧边栏的状态和我的意图一致。
4. As a 桌面窗口用户, I want 与删除撞车的在途设置修改不被无声复活成半个会话, so that 删掉的会话不会在侧边栏诈尸。
5. As a 桌面窗口用户, I want 读会话、看会话永远不被删除阻塞或阻塞删除, so that 浏览历史会话列表时没有任何额外等待。
6. As a 桌面窗口用户, I want 删除等待中的中止收尾完成（partial 落定、流关闭）后再动手删文件, so that 不会留下一个半死不活的会话。
7. As a 维护者, I want 持有计数表住在它所保护的文件的属主（SessionManager）身上, so that 并发问题在知道并发问题的那一层解决。
8. As a 维护者, I want 锁动词只能经 Agent 门面到达, so that 消费边界（ADR-0012）依然可由 check-server-facade 机械地守护。
9. As a 维护者, I want 计数表的语义（纯计数、宽容 release、归零删条目）原样保留, so that 迁移不夹带行为变化，diff 可审。
10. As a 维护者, I want 这次对 2026-11-16 决定的反转写进新的 ADR, so that 半年后没人以为 hold 动词离开 core 是笔误。
11. As a 维护者, I want 计数表被明确标记为"存储原语缺失税", so that 哪天换成带事务的存储，知道这张表该跟着消失而不是被搬进新存储。
12. As a smoke 测试作者, I want 删除语义的全部行为在 HTTP 表面可断言, so that 测试不用偷看内部状态。
13. As a smoke 测试作者, I want Manager 级的计数语义有现成的冒烟面可断言, so that 锁动词的行为回归不依赖起 HTTP 服务器。
14. As a 未来的存储替换者, I want "每条命令一个 hold/release 括号"这个边界原样保留, so that 换 MySQL 时括号变事务、其余调用代码一字不动。

## Implementation Decisions

- **计数表迁入 SessionManager**（core），按 id 键控的常驻 `Map<id, number>`。这使 SessionManager 成为第二个持有常驻表的服务（第一个是 ToolManager，ADR-0011）——这是对 ADR-0006 无属性服务形态的一次**有意识的修订**，理由：该表是易失簿记（重启即空、不落盘、不可重建也不需重建），与 ToolManager 实例表同类；无状态门面的其他一切不变。
- **Agent 门面新增三个动词**：`hold(id)` / `release(id)` / 一个计数窄读（供删除等待与 health 端点）。转发到 SessionManager。这条**有意推翻** ADR-0001 于 2026-11-16 定下的"core 的 Agent 不再有 hold / release 动词；hub 的 hold / release 是全部通道"——推翻必须新开 ADR 记录，不许悄悄改 0001。
- **动词语义逐条保持**：hold 先做存在性校验（id 无所指 → `UnknownSessionError` → 传输层映射 404），再计数；release 用 `max(0, n-1)`，对无人持有的 id 宽容；计数归零删除条目。校验逻辑随计数一起迁入 Manager（它本来就是文件的主人），hub 不再做存在性检查。
- **`holding()` 包装器原地保留**在 controller 上（每条改变会话的命令一个 hold/release 括号，`try/finally` 保证失败也交还），内部调用点从 hub 换成门面。**读会话与订阅继续不拿 hold**（现状如此，不改）。
- **hub 的 `closing` 槽位保留**：删除进行到一半时到来的 hold 仍然等过 `closing` 再恢复，发现文件已没了就以 `UnknownSessionError` 拒绝。串行化"hold 等删除"的机制不动。
- **`remove()` 改为否决式**，新顺序：① `isRunning` → 中止该会话的运行并**等引擎收尾**（abort 机制与 cancel 命令共用，现成）；② 等计数归零，等待带**上界**（在途命令毫秒级；超上界报错而不是无限等）；③ 走既有删除路径（告别观看者 → `deleteSessionBySessionId` → 清 `closing`）。`hasPendingApprovals` 从守卫中撤销；若它除删除外无消费者则一并删除，否则保留（suspended 显示缓存不依赖它）。
- **删除不再有 409**："这个会话还有运行中的轮次或没答完的审批，等它停下来再删"这句错误与 controller 的映射一起退场。删除的失败只剩真正的病态（文件已损、id 非法）。
- **SessionManager 的内部方法不自锁**：文件读写方法不自己拿锁——锁只经命令级动词进出。否则 Manager 方法互相调用会嵌套拿锁，死锁风险自找。
- **wire 与 REST 零改动**：health 端点的 `held` 报告形状不变（经门面窄读）；mux 帧不加不减。
- **文档与 ADR**：新开一条 ADR（约 0023）记录①迁移与②删除语义，明确取代/修订的关系——0001 的"core 无 hold/release 动词"半句（取代）、0006 的无状态门面（修订：第二个常驻表例外）、0022 的"守卫刻意只有三道"（取代：守卫变成动作）与 0022 *没有被取代的*一节里"holds 住在 hub"的论证（住址部分失效、目的部分原样活着）。`AGENTS.md` 的 `hold` / `service` / `assembly` 术语条目与 `docs/architecture.md` 相应章节随代码改写。

## Testing Decisions

- 好的测试只断言**外部行为**（HTTP 应答、会话文件的存亡、行是否从列表消失），不断言内部计数、不偷看 Map。
- **smoke-api.ts（HTTP 表面，主接缝）**，新增/改写用例：
  - 空闲会话删除 → 成功，列表行消失（既有用例改写：不再有 409 分支）。
  - 运行中删除 → 202 应答先到，运行收到中止、流收尾，删除最终成功，无僵尸行。
  - 停在审批闸门（suspended）的会话删除 → 成功（旧用例断言 409，改为断言成功）。
  - 删除后对同一 id 的读 → 404。
  - 时序敏感的用例用确定性手段构造（`createSessionAgent` 的 test-only 接缝 / 可控 gate），不靠 sleep 赌调度。
- **smoke-sessions.ts（Manager 级，第二接缝）**，新增一组锁动词语义用例（参照该文件既有的会话注册表断言风格）：
  - hold → 计数 1 → release → 归零（条目消失，窄读回 0）。
  - 对从未 hold 过的 id release → 无异常、无变化。
  - 对无所指的 id hold → 抛 `UnknownSessionError`。
  - 删除进行中到来的 hold → 等过 `closing` 后以 `UnknownSessionError` 拒绝。
- 既有回归：`npm run check`（含 check-server-facade——门面动词是唯一通道，旁路即失败）；与删除相关的既有 smoke 用例逐条改写为否决式语义。

## Out of Scope

- 换存储（MySQL/事务型）——spec 只在术语里记录"计数表是存储原语缺失税"，不迁移。
- 运行中止机制本身的改造——abort 与收尾路径沿用 cancel 命令的现成机制，本 spec 只是复用它。
- 队列（steer / followUp）、审批闸门内部、suspended 显示缓存的行为。
- hold 的改名或语义重定义（`claim→hold` 的历史不动）。
- 多客户端裁判语义——ADR-0022 已撤销 send 引用，本 spec 不恢复。

## Further Notes

- 讨论中的实验脚本留在 `.scratch/fs-race-test/test.mjs`：验证了文件系统没有"存在才写"的原子原语——unlink 可插进打开句柄之后、write 不报错（数据静默丢失）、rename 到已删目标会把文件造回来。这是"计数表是文件存储的缺失税"这一术语的实证根据；换 MySQL 后 `UPDATE ... WHERE id=?` 天生就是那个原语。
- ADR-0022 *没有被取代的*一节曾为 holds 留住 hub 给出理由（跨 await 短命令的唯一现形手段 + closing 串行化）。本 spec 保留其**目的**、改变其**住址**：跨 await 的保护与 closing 串行化原样活着，只是簿记的主人从传输层换成存储层。
- 删除等待计数的上界取值是实现细节（毫秒级命令，秒级上界绰绰有余），不进 spec 正文。
