# 冷启动审批点：快照标记方案

Status: ready-for-agent

## 问题

会话停在审批闸门时（结束重启语义，ADR-0006 §5），悬空 tool call 留在 JSONL 账本里，
进程重启不丢——点开那个会话，装配从账本派生 `pendingApprovals`（`packages/core/src/assembly.ts:216`），
审批卡片照常显示、可回答。

但**侧边栏的琥珀点在冷启动后不亮**：启动扫描只读每个会话的 `.json` 快照
（`session-manager.ts:684` 的 `readMetaFile`，对 `.jsonl` 只 stat 大小），行上的 `pending`
在 `toSessionRow`（`session-manager.ts:2291`）硬编码为 0。判断「有没有悬空 call」需要
全文配对 tool_use/tool_result，扫描刻意不付这个成本。于是用户重启软件后，列表里看不出
哪个会话在等他批——提醒丢在列表这一层。

**进程内同族缺陷已修（未提交，在工作区里）**：`projection.ts` 的 `onHost(undefined)`
不再硬清零 `pending`，改读 `hub.agent.snapshotOf(id)` 用账本派生值 settle 行；
`scripts/mount-session.ts` 补上了生产 `open` 会做的 `announceHost`；`smoke-approval.ts`
第 4 节加了三条行断言。本 spec 只解决冷启动层，**不要回退这些改动**。

## 决定

在 `.json` 快照里加一个 **`suspended` 标记**：suspend 时写 true，问题关闭时清掉。
启动扫描本来就读 `.json`，据此点亮行。标记是**纯显示缓存**：

- 它是 ADR-0006 后果一节留的升级口子——「可从磁盘重建的缓存」——的实例：
  随时可从 JSONL 重放重新算出，账本仍是唯一事实。
- **任何控制流都不读它**。`hasPendingApproval` / `respondApproval` / 恢复机器
  一律从账本派生（现状不变）。标记只服务列表那一瞥；点开 session 后以派生值为准。
- 侧边栏是一瞥，一瞥不该付全文重放的账。

### 被否决的替代

1. **启动时全文重放所有账本**：O(所有账本) 压在启动关键路径上，正是扫描存在意义要避免的。
2. **启动后后台逐个重放、算一个亮一个**：总量一分不少，只是挪后；每次启动重算上次进程
   已知的事，且账本只增不减（压缩缩的是 context，文件保留全文），成本随店龄单调涨。
   尾读启发式（最后一条 entry 不是 tool_use/tool_result 就跳过全文）能砍掉大部分，
   但那是启发式，崩溃边缘漏报，复杂度不值。

## 形状

- **磁盘**：`SessionMeta`（`session-manager.ts:72`）加可选字段 `suspended?: true`。
  **只在 true 时写**，缺省即 false——旧快照无字段读作 false，**版本不动、不迁移**。
  `readMetaFile` 的校验只查身份字段与版本，多一个字段天然兼容。
- **内存**：`SessionSetting`（`session-manager.ts:1043`）加 `suspended`。
  注意语义张力：SessionSetting 其余字段是用户选择，这个是派生运行事实——
  放这里是因为磁盘↔内存翻译**只有两个点**（fill 进、`metaOf` 出，见 `session-manager.ts:1037`
  附近的注释），不为一个字段开第三个翻译点。字段注释写明它是可重建缓存、不是选择。
- **翻译**：`fillSession`（`session-manager.ts:1248`）合并时 `meta.suspended === true`；
  `metaOf`（`session-manager.ts:1169`）拆分时仅 true 落字段。

## 写入点（三处，全在编排层/Manager，走既有原子重写）

写盘走 `recordMeta`（`session-manager.ts:1417`）→ `writeMetaFile`（:1351，temp+rename
原子整体重写）。`recordMeta` 的 change 返回 false 即 no-op——**只有翻转才付一次重写**。
新增 `SessionManager.setSuspended(bag, suspended)`，形态照 `setToolConfig`。

1. **运行收尾清扫**（`agent.ts` ~1259–1301；`live.suspended` 在 :1264 重置、
   收尾保留 suspended 运行的旗标）：`setSuspended(bag, live.suspended)`。
   这一处覆盖所有翻转：suspend 结束的运行写 true；恢复运行/普通运行结束写 false。
2. **`denyAllApprovals`**（`agent.ts:1067`，清 `live.suspended` 在 :1077）：
   同步 `setSuspended(bag, false)`。这是没有运行的收尾（abort/放弃清扫）。
3. **`forkFrom`**：复制当前值的那一处（title/model/level/工具/审批五值随拷）加上第六值。
   fork 整份复制 `.jsonl`，源的悬空 call 也在里面——fork 同样 parked，标记必须随拷。

**不是写入点**：`respondApproval`（`agent.ts:1028`）。回答到达时 call 仍悬空，
问题要到恢复运行关闭 call 才算关闭——由恢复运行的收尾清扫清标记。grant 写审批映射
（`setToolConfig`）与标记无关，两条路各写各的。

## 读取点

- `SessionInfo`（`session-manager.ts:223`）加 `suspended: boolean`，扫描/probe 建 info 时
  从 meta 取（缺省 false）。
- `toSessionRow`（`session-manager.ts:2291`）：`pending: info.suspended ? 1 : 0`。
  扫描（seed）与 probe（`findSessionRowById`）共用此函数，一条路改完两处生效。
- **projection 与 web 客户端零改动**：行 `pending ≥ 1` → `busyOf`（`web/src/render/sidebar.ts:101`）
  显示「待审批」+ 琥珀点。冷启动行 pending 为 1，tooltip 不带 N——数量是点开后的派生事实，
  一瞥不需要。host 在世时 live overlay 照旧以账本派生为准（进程内修复已保证）。

**附带闭合**：`projection.refresh`（重命名路径）对无 host 会话发布 probe 扫描行——
标记落地后这条路自动读到 pending 1，同族另一处「重命名 parked 会话把点弄灭」随之闭合。
加断言钉住（见 03 号票），不需要单独改 refresh。

## 崩溃窗口（写进 ADR，两个方向都自愈、都不 gate 行为）

- **漏报**：悬空 call 已落盘、收尾清扫未及写标记就崩 → 点不亮。点开即正确；下次运行收尾也纠正。
- **误报**：恢复已关 call、标记未及清就崩 → 点亮着但点开没问题。下一次状态发布/运行收尾纠正。
- 标记从不参与批/拒/恢复的判断，所以两个窗口都不影响正确性，只影响那一瞥。

## 测试计划（详见 03 号票）

- **smoke-approval §5 的 rig 先修**：现在父进程 `setSessionsDir(storeRoot)` 是进程内覆盖，
  spawn 的子进程只认 `MY_AGENT_HOME/sessions`，找不到会话——§5 在工作区里本就是红的
  （子进程报「未知的会话」），与本功能无关但挡着验证。修法：§5 用独立 scratch home，
  父进程 `setSessionsDir(join(restartHome, "sessions"))`，子进程 env `MY_AGENT_HOME=restartHome`。
- §5 加冷启动断言：子进程 healthy 后、`wire.open` 前，新连接的 overview `sessions` 帧里
  该会话行 `pending ≥ 1`、`running === false`。
- 标记生命周期：park 后直读 `.json` 有 `suspended: true`；回答+恢复后无；abort 收尾后无；
  fork parked 会话，fork 的 `.json` 有标记且行 pending 1。
- smoke-projection：对含 parked 会话的存储建**全新** projection（无 host、纯冷 seed），行 pending 1。
- 兼容：无字段的旧快照读作 pending 0。
- 重命名闭合断言：parked、无 host，rename 后行仍 pending 1。

## 文档计划（详见 04 号票）

- 新 ADR（下一个编号，当前应为 0021，以 `docs/adr/README.md` 为准）：决定、形状、
  三写入点、显示-only 不变式、崩溃窗口、fork 继承、被否决替代、与 ADR-0006 §5 及其
  缓存口子的关系。
- `AGENTS.md` session 词条：快照当前值列表补标记一句。
- `docs/architecture.md` 会话/审批相关节同步。
- 文档中文，源码注释英文（仓库约定）。

## 验收

1. 重启进程后不点开任何会话，侧边栏 overview 里 parked 会话行 `pending ≥ 1`。
2. 点开该会话，审批卡片照常、可批可拒，恢复续跑；回答落地后行归零。
3. 标记不出现在任何控制流判断里（grep 可证：读它的只有 toSessionRow 一路）。
4. 旧快照（无字段）行为不变。
5. `npm run check` 绿；smoke-approval（含修好的 §5）、smoke-projection、smoke-sessions、
   smoke-mux、smoke-approval-endpoint 绿。smoke-api 环境依赖（需运行中服务器），可选。

## 工作区注意

工作区有大量未提交 WIP（ADR-0019/0020、flat store、model-choice 等）及上述进程内修复。
本功能在其之上叠加，不回退、不顺手收账无关改动。