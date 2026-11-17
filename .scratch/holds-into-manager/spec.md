# Spec：holds 迁入 SessionManager（文件级）+ 删除改为「停掉再删」

Status: ready-for-agent（2026-11-17 按用户两条修正指令重写）

来源：2026-11-17 的一场设计讨论。用户先后拍板四件事：①持有簿记（holds）从 `SessionHub`（server 包）迁入 `SessionManager`（core 包）；②**Agent 类不知道 holds**——锁的进出完全内化在 SessionManager 自己的方法里，编排层与传输层都不感知（本条否决了上一版 spec 的「锁动词走门面」方案）；③holds 是**文件级**的，按会话文件对键控，不是 sessionId 级的；④删除从「有人用就 409 拒绝」改为「否决式：中止运行 → 删」。讨论过程中逐条重新推导并确认了既有设计的边界（锁罩改变会话的写入、读不拿锁、锁原语缺失时用簿记表补、原语到位时簿记可消失），本 spec 只把**改变**的部分立为决定，不推翻这些边界本身。

## Problem Statement

从用户的视角：

1. 点删除时，如果会话正在跑一轮对话，服务器返回 409「等它停下来再删」——但停它是我的意图，删除应该替我把运行停掉，而不是要求我先手动点停止、再点删除。
2. 一个停在审批闸门上的会话也删不掉（409），尽管我明确不再需要它的答案。
3. 从维护者的视角：持有簿记（「此刻谁在改变这个会话」的签到簿）住在传输层（hub）且按 sessionId 键控，但它保护的其实是会话文件。管文件的层（SessionManager）自己看不见并发问题，并发问题的知识泄漏到了传输层；而锁以 id 为单位，意味着文件层连「被锁的东西是什么」都要借门面层的身份来指名。换存储的那天，传输层里会留下一段别人看不懂的簿记，文件层里没有一个字提到锁。

## Solution

1. **簿记搬家、换键、换持有者。** holds 迁入 `SessionManager`，键从 sessionId 改为**会话文件对**（同一 stem 的 `.json` + `.jsonl`，以 `.jsonl` 绝对路径为规范文件键，Windows 上大小写折叠）。持有者从「server 命令的 hold/release 括号」改为 **SessionManager 自己触碰这对文件的公开方法**：方法在自己的长度内持有该文件的 hold，`remove` 是唯一跨 await 的持有者。Agent 门面不新增任何动词，controller 的 `holding()` 括号删除。签到簿归管文件的人保管，且只有他进出。
2. **删除改为否决式。** `remove` 的三道守卫换成三步动作：运行在飞则中止并等引擎收尾（复查到稳定）；然后进入文件闸、rm 两个文件、放闸；悬空审批不再是守卫——悬空调用随文件一起死，「最后一个动作赢」。删除从此不再以「有人在用」为由失败。
3. **读不拿锁的边界原样保留。** 快照读取、列表扫描、订阅不占 hold、不过闸；fork 对源的读也是读。闸罩的是「经 Manager 的写入」，运行在飞的写入由删除的第一步（中止 + 等收尾）覆盖——两半覆盖面相加恰好是全部写入方。
4. **wire 只有一处形状变化。** mux 帧一字不改；删除端点从「可能 409」变成「总是成功应答」；health 端点的 `held` 字段退场——簿记离开传输层后，server 对「谁被持有」不再有诚实的来源，报告一个借不来数字的形状比少一个字段更糟。

## User Stories

1. As a 桌面窗口用户, I want 在对话正在跑的时候点删除直接生效, so that 我不用先点停止、等它停、再点删除。
2. As a 桌面窗口用户, I want 删除一个停在审批闸门上的会话也能成功, so that 我放弃的会话不会因为没人答审批而一直挂在侧边栏。
3. As a 桌面窗口用户, I want 删除动作不被服务器以「有人在用」为由拒绝, so that 我点删除之后侧边栏的状态和我的意图一致。
4. As a 桌面窗口用户, I want 与删除撞车的在途设置修改不被无声复活成半个会话, so that 删掉的会话不会在侧边栏诈尸。
5. As a 桌面窗口用户, I want 读会话、看会话永远不被删除阻塞或阻塞删除, so that 浏览历史会话列表时没有任何额外等待。
6. As a 桌面窗口用户, I want 删除等待中的中止收尾完成（partial 落定、流关闭）后再动手删文件, so that 不会留下一个半死不活的会话。
7. As a 维护者, I want 持有簿记住在它所保护的文件的属主（SessionManager）身上, so that 并发问题在知道并发问题的那一层解决。
8. As a 维护者, I want Agent 门面与 server 包都不感知 holds, so that 消费边界（ADR-0012）与 ADR-0001 的「core 无 hold/release 动词」原样成立——上一版方案要新开 ADR 推翻 0001 的那半句，现在不需要推翻任何既定决定。
9. As a 维护者, I want hold 以会话文件对为单位而不是以 id 为单位, so that 锁的单位与锁保护的东西（两个文件）重合，id 只是进闸前的一次地址解析。
10. As a 维护者, I want 计数语义（纯计数、宽容 release、归零删条目）原样保留, so that 迁移不夹带行为变化，diff 可审。
11. As a 维护者, I want 这次对删除语义的反转写进新的 ADR, so that 半年后没人以为 409 是笔误。
12. As a 维护者, I want 计数表被明确标记为「存储原语缺失税」, so that 哪天换成带事务的存储，知道这张表该跟着消失而不是被搬进新存储。
13. As a smoke 测试作者, I want 删除语义的全部行为在 HTTP 表面可断言, so that 测试不用偷看内部状态。
14. As a smoke 测试作者, I want 文件闸的语义有 Manager 级的冒烟面可断言（删除闸内的写被拒、先标记后流的中间态由扫描自愈）, so that 闸的行为回归不依赖起 HTTP 服务器。
15. As a 未来的存储替换者, I want 「闸是唯一的锁单位、进出都发生在 Manager 方法里」这个边界, so that 换 MySQL 时方法变事务、调用方一字不动。

## Implementation Decisions

- **holds 迁入 SessionManager，按文件键控。** 一张 `Map<fileKey, { holds: number; closing?: Promise<void> }>`，键是会话文件对的 `.jsonl` 绝对路径（resolvePath + win32 大小写折叠，与既有 `absPathKey` 同法）；id → 文件的解析只在进闸前做一次，此后簿记的领域里没有 id。这使 SessionManager 成为第二个持有常驻表的服务（第一个是 ToolManager，ADR-0011）——对 ADR-0006 无属性服务形态的一次**有意识的修订**：该表是易失簿记（重启即空、不落盘、不可重建也不需重建），与 ToolManager 实例表同类；无状态门面的其他一切不变。
- **持有者内化，门面零动词。** Manager 每个触碰某会话文件对的公开方法（meta setter、append 族、`open`、`forkFrom` 写目标半、`remove`）在自己的长度内持有该文件的 hold。同步方法的进出是瞬时的——单线程进程里同步块不可被打断——它的意义不是互斥等待，而是**与 `closing` 闸的相遇点**：进门前发现闸被删除占着 → 以 `UnknownSessionError` 拒绝（读作「没有这个会话」——它正在消失，与原 hub「等过 closing 再发现文件没了」同一答案、同一错误种类）。`remove` 是唯一跨 await 的持有者，闸罩它全程。**内部帮手函数不重复进出**（公开方法持锁、内部互调不重复计账），替代上一版「内部方法不自锁」的决定——那条决定的初衷是防嵌套死锁，新形态里锁只有一个进出层，嵌套不存在。
- **运行写入不过闸。** 袋 → `persistEntry` 的写入不经过 Manager 公开方法，它们由删除序的第一步覆盖：中止 + 等收尾 + 复查（「中止-等待-复查直到无在飞运行」，有界——覆盖收尾窗口里新启动的恢复运行）。闸罩经 Manager 的读写，中止罩在飞的一轮，两个覆盖面相加恰好是全部写入方，谁也不重复、谁也不缺席。
- **controller 的 `holding()` 括号删除。** 命令的存在性 404 改由命令自己的 facade/Manager 调用路径提供（`UnknownSessionError` → transport 映射，与 `read` 现状同族）。**实现检查点**：逐条核对每个 mutating 命令在无所指 id 时确实沿自己的路径抛出（`prompt`、`applyConfig`、`branchTo`、`abort` 等），不许有命令从「提前 404」变成「改写了一个不存在的东西」。占不占 hold 的命令分类清单（现状 rename 不占、prompt 占）随括号一起消失，统一规则变成「触碰文件的 Manager 方法过闸，读不过」。
- **`remove()` 改为否决式**，`Agent.deleteSessionBySessionId` 内的新序：① `isRunning` → 中止该会话的运行并等引擎收尾，复查到稳定（abort 机制与 cancel 命令共用，现成）；② `SessionManager.remove(id)`：解析 id → 文件、进闸、**先删 `.json` 提交标记、后删 `.jsonl` 流**、放闸；③ 出表（`agentStateMap.delete`）。先标记后流是刻意的：`.json` 是诞生的提交标记，它先走，两步 rm 之间到达的一切新写入方（prompt 前置校验、grant、冷路径）都查 meta、都读到「不存在」——中间态读作半途夭折的诞生，由既有扫描自愈。`hasPendingApprovals` 从守卫中撤销；若它除删除外无消费者则一并删除，否则保留（suspended 显示缓存不依赖它）。
- **`closing` 闸随簿记搬家。** hub 的 `closing` Map 与 `hold` 里的「等过 closing」两段式逻辑退场，hub 不再有 holds / closing / 存在性校验——传输层簿记回归纯传输（watchers、feedMap、current）。删除中途到来的命令写以闸内拒绝（`UnknownSessionError`）收场，不再是「等待后 404」的两段式。
- **409 退场。** 「这个会话还有运行中的轮次或没答完的审批，等它停下来再删」这句错误与 controller 的映射一起退场。删除的失败只剩真正的病态（文件已损、id 非法）。
- **health 的 `held` 字段退场。** 这是本次 wire 的唯一形状变化（REST 一处；mux 零改动）。理由：`held` 报告的是持有簿记的内容，簿记搬走后 server 够不到它（ADR-0012），而让门面转发一个计数窄读就是让 Agent 知道 holds——正是被否决的方案。诊断面跟着簿记走：要观察持有状态，去看 Manager 的表（Manager 级冒烟面，见 Testing）。
- **文档与 ADR**：新开一条 ADR（约 0023）记录①迁移与②删除语义，明确修订/取代关系——0001 的「hold 住在 hub、hub 的 hold/release 是全部通道」半句（**修订**：住址与持有者变了；「core 的 Agent 不再有 hold / release 动词」半句**保持成立**，本 spec 不推翻它）、0006 的无状态门面（修订：第二个常驻表例外）、0022 的「守卫刻意只有三道」（取代：守卫变成动作）。`AGENTS.md` 的 `hold` / `service` 术语条目与 `docs/architecture.md` 相应章节随代码改写：hold 是 SessionManager 的文件级簿记，server 与编排层不感知。

## Testing Decisions

- 好的测试只断言**外部行为**（HTTP 应答、会话文件的存亡、行是否从列表消失），不断言内部计数、不偷看 Map。
- **smoke-api.ts（HTTP 表面，主接缝）**，新增/改写用例：
  - 空闲会话删除 → 成功，列表行消失（既有用例改写：不再有 409 分支）。
  - 运行中删除 → 202 应答先到，运行收到中止、流收尾，删除最终成功，无僵尸行。
  - 停在审批闸门（suspended）的会话删除 → 成功（旧用例断言 409，改为断言成功）。
  - 删除后对同一 id 的读 → 404；删除进行中到达的 mutating 命令 → 404（闸内拒绝），无孤儿文件残留。
  - health → 断言应答不再含 `held` 字段。
  - 时序敏感的用例用确定性手段构造（`createSessionAgent` 的 test-only 接缝 / 可控 gate），不靠 sleep 赌调度。
- **smoke-sessions.ts（Manager 级，第二接缝）**，新增一组文件闸语义用例（参照该文件既有的会话注册表断言风格）：
  - 同一 id 的两次进闸解析出同一文件键；对无所指的 id，进闸前即以 `UnknownSessionError` 拒绝。
  - 删除闸内的写（meta setter / append）→ 被拒，且删除完成后盘上无该会话的任何文件。
  - rm 的两步之间（可控 gate）：中间态下 `findSessionFilePathById` 回答 `undefined`，新写入方被存在性检查挡住；扫描清掉半途夭折的中间态。
  - 宽容释放的语义不随搬家消失：内部簿记的 release 对无人持有的文件键无异常、无变化。
- 既有回归：`npm run check`（check-server-facade 的口径收紧为「server 包里不存在任何 hold / release / holds 通道」——门面上没有、hub 里也没有，出现即失败）；与删除相关的既有 smoke 用例逐条改写为否决式语义。

## Out of Scope

- 换存储（MySQL/事务型）——spec 只在术语里记录「计数表是存储原语缺失税」，不迁移。
- 运行中止机制本身的改造——abort 与收尾路径沿用 cancel 命令的现成机制，本 spec 只是复用它。
- 队列（steer / followUp）、审批闸门内部、suspended 显示缓存的行为。
- hold 的改名（`claim→hold` 的历史不动；「hold」这个名字随簿记搬家继续用）。
- 多客户端裁判语义——ADR-0022 已撤销 send 引用，本 spec 不恢复。
- 给跨 await 的命令段恢复持锁——命令段不再持有任何东西；它的保护由「文件闸内拒绝」与「删除先停运行」两半拼出。上一版 spec 的「每条命令一个 hold/release 括号」边界随括号一起消失，存储替换者接到的对应物是「Manager 方法变事务」。

## Further Notes

- 讨论中的实验脚本留在 `.scratch/fs-race-test/test.mjs`：验证了文件系统没有「存在才写」的原子原语——unlink 可插进打开句柄之后、write 不报错（数据静默丢失）、rename 到已删目标会把文件造回来。这是「计数表是文件存储的缺失税」的实证根据，也是 rm 顺序反转（先提交标记后流）的直接论据：把「中间态读作不存在」交给已有的 commit-marker 读法与扫描自愈，而不是发明新的原子性。换 MySQL 后 `UPDATE ... WHERE id=?` 天生就是那个原语。
- ADR-0022 *没有被取代的*一节曾为 holds 留住 hub 给出理由（跨 await 短命令的唯一现形手段 + closing 串行化）。本 spec 保留其**目的**、更换其**实现**：跨 await 的保护不再靠「现形后拒绝」而靠「先停运行 + 闸内拒绝」，串行化原样活着——只是闸的主人从传输层换成存储层，闸的单位从 id 换成文件。
- hub 上的 hold / holdsOf / heldSessionIds / closing 全数退场后，`SessionHub` 剩下的簿记只有 watchers、feedMap 与 current——全部是传输层自己的东西。上一版 spec 里「计数窄读供 health」的门面动词因此不需要存在。
