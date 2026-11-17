# ADR：决定记录

一条 ADR 只回答一个问题：**这个决定为什么是现在这样，以及它被改过没有。**

- **实况**（现在长什么样）在 [`../architecture.md`](../architecture.md)。
- **结论清单**（哪些结论作废、哪些还在）在 [`../notes.md`](../notes.md) 第一节。
- **术语**（现在的词是什么意思）在 [`../../AGENTS.md`](../../AGENTS.md) 的 `## 术语`。

三处都不重复理由：ADR 是理由唯一的家，另外两处只链接过来。

## 清单

| 编号 | 决定 | 状态 |
|---|---|---|
| [0001](0001-transport-websocket-mux.md) | 传输改为一条常驻的 WebSocket mux | 已接受（2026-10-12），取代 `notes.md` 第一节的若干条 |
| [0002](0002-queued-writes-at-drain.md) | 排队消息在取走点落盘——store 的顺序就是循环回放的顺序 | 已接受（2026-10-15，20 号拍板并落地），取代「运行中接受的 prompt 立刻持久化」 |
| [0003](0003-shell-sandbox-switches-removed.md) | 外壳不再自带 `no-sandbox` 与 GPU 开关——那是给一台已经变了的机器打的补丁 | 已接受（2026-10-16，03 号落地），取代一段**从未提交过**的工作区补丁 |
| [0004](0004-modes-are-a-tool-config-choice.md) | 模式是一次工具集与审批集的选择，不是一个新状态层 | 已接受（2026-10-17，03 号拍板并落地） |
| [0005](0005-stateless-session-architecture.md) | 会话架构改为无状态服务与每请求重放，审批改为结束重启 | 已接受（2026-10-31，已落地，见 `.scratch/stateless-agent/`）；「薄壳门面」条款由 0006 重开 |
| [0006](0006-services-drop-instance-state.md) | 五个单例服务不持有实例状态——聚合袋拆除，「薄壳门面」条款重开 | 已接受（2026-11-01，已落地——08 号票跑绿 check 与 smoke 全套并总校文档，见 `.scratch/pure-services/`） |
| [0007](0007-loop-merged-into-agent.md) | 删掉 `Loop` 对象与 `packages/loop`——引擎并入 `agent.ts`，放弃与上游的逐文件对照 | 已接受（2026-11-02，已落地——03 号票合并并删包，见 `.scratch/loop-into-agent/`），取代 0001「`packages/loop` 一行都不改」那一半；决定 1/2 曾经历一轮「搬进独立对象又搬回」的往返，由 [0016](0016-loop-is-orchestration.md) 终止并恢复原状 |
| [0008](0008-session-two-file-format.md) | 会话是两个文件——`.json` 快照管「是什么」，`.jsonl` 日志管「说过什么」；打不开的配对直接删 | 已接受（2026-11-03，已落地——session-split 02 号拍板并落地，06 号票入档，见 `.scratch/session-split/`），取代 v≤4 的单文件格式与更早的「rename 是一条 entry」机制 |
| [0009](0009-open-session-over-mux.md) | 会话的打开与切换只走 mux 基线——`retain` 即导航，REST 读从前端导航路径退场 | 已接受（2026-11-03 用户拍板，已落地——01–04 号票跑绿 check、build:web 与 smoke 全套，见 `.scratch/mux-only-open/`） |
| [0010](0010-llm-folded-into-core.md) | 把 `packages/llm` 折叠进 core——全树只剩一个 `Context` 与一个 `Tool` | 已接受，已落地（2026-11-06，01–04 号票，`check` 与 `build:web` 绿、smoke 与改动前逐条同色零新红，零行为变化），取代 0007 决定 6 的 `AgentContext` 命名与「形状也住 `types.ts`」那一半，及其「llm 没有被并入任何人」的现状陈述 |
| [0011](0011-tool-manager-instance-table.md) | 工具回到一张常驻实例表——`ToolManager` 持有全部 `Tool`，引擎经它执行 | 已接受，已落地（2026-11-06，07–09 号票；2026-11-07 由 11 号票全量验收：`check` 与 `build:web` 绿、smoke 与改动前逐条同色零新红），部分取代 0005 / 0006 / 0010 |
| [0012](0012-agent-facade.md) | server 只认 `Agent` 公开面——Manager 的消费者收进 core，构造由 `createSessionAgent()` 吸收 | 已接受，已落地（2026-11-07，hub-agent-facade 01–07 号票，`check` 含新守卫 `check-server-facade` 与 `build:web` 绿、smoke 与基线逐条同色零新红），部分取代 0006 / 0011 |
| [0013](0013-table-holds-live-half-only.md) | 表只装 live 半——会话每次操作现读，`AgentState` 不再有 `session` | 已接受，已落地（2026-11-10，`check` 绿、smoke 与改动前逐条同色），整体取代此前「表内嵌会话记录」的形态 |
| [0014](0014-flat-session-store.md) | store 改平——`sessions/<id>.{json,jsonl}`，id 就是地址；旧布局惰性迁移，`Agent` 不再记路径 | 已接受，已落地（2026-11-10，`check` 绿；smoke 做了机械改写、未全量执行，见 ADR 文末），部分取代 0008 的「每工作目录一个 store 目录」 |
| [0015](0015-snapshot-suspended-marker.md) | 快照加 `suspended` 标记——冷启动审批点是纯显示缓存，账本仍是唯一事实 | 已接受，已落地（2026-11-11，cold-start-approval-dot 01–04 号票，`check` 绿、相关 smoke 单独跑全绿），0005 后果一节「可从磁盘重建的缓存」口子的实例，不取代任何决定 |
| [0016](0016-loop-is-orchestration.md) | loop 就是编排——删掉 `LoopManager`，一次运行回到 `Agent` | 已接受（2026-11-13，wayfinder 票 003），已落地（落地归票 004、验证归票 005、文档同步归票 006，见 `.scratch/wayfinder/loop-back-into-agent/`）；取代此前「独立运行对象 + 白名单回调」的全部安排，终止引擎归属的六次往返 |
| [0017](0017-fanout-folded-into-agent.md) | fanout 并入编排——删掉 `session/fanout.ts` 与 `SessionServices` 参数袋 | 已接受，已落地（2026-11-14，`check` 绿、smoke-sessions / smoke-api / smoke-mux 过、smoke-tools 与基线 c667b9f 逐字同色）；取代 0012 / 0016「没有被取代的」中保护 fanout 参数袋的两条 |
| [0018](0018-session-holds-mode-pointer.md) | 会话存模式指针——工具配置从「值的快照」改成「名字 + 审批增量」，`PUT /tools` 删除 | 已接受，已落地（2026-11-15，`check` 绿、README 清单 smoke 全跑——smoke-tools / smoke-api / smoke-desktop-observability 与基线同色）；取代 0004 的决定 3（施加模式 = 两条命令写值、座位按值匹配），盘上格式升至 v6，旧会话按约删除 |
| [0019](0019-settings-two-layers.md) | 设置三层——`GlobalSettings` / `SessionSettings` / 每次现算的 `Settings`；删掉项目级 settings.json | 已接受，已落地（2026-11-15，`check` 绿、smoke-settings / smoke-session / smoke-sessions / smoke-mux / smoke-models 等全绿——smoke-boot / smoke-api / smoke-approval 与 smoke-tools 的一个断言为环境既有失败，与改动前同色）；`tool-config.ts` 与 `model-choice.ts` 退场，解析语义收进 `resolveSettings` 一处 |
| [0022](0022-drop-send-reference.md) | send 引用撤销——mux 的 `wait` / `unwait` 帧与 hub 的 `waiting` 表删除，删除守卫从四道减为三道 | 已接受，已落地（2026-11-17，`check` 绿、smoke-mux / smoke-mux-client / smoke-sessions / smoke-projection / smoke-session 等全绿；smoke-boot / smoke-mux-live / smoke-liveness 的失败为本机 Node 22.14 与 ADR-0021 落地前的既有漂移，与改动前同色）；部分取代 0001「订阅与 hold 永不互相换算」论证里多客户端裁判的那一半，整体取代 issue 13 的结论 |
| [0023](0023-holds-into-session-manager-veto-delete.md) | holds 迁入 SessionManager——按会话文件对键控的文件闸，删除改否决式（停掉再删） | 已接受，已落地（2026-11-17，holds-into-manager 01–03 号票——core 的闸、编排层否决序、server 簿记退场与 202、check 收紧；04 号票补否决式冒烟、05 号票同步文档，见 `.scratch/holds-into-manager/`）；修订 0001 的 hold 住址与持有者（「core 无 hold/release 动词」保持成立）与 0006 的无属性服务（第二个常驻表例外），取代 0022 的「守卫刻意只有三道」 |

## 门槛

只有下面三条**同时**成立才值得一条 ADR：

1. **难以逆转**——改回来要动的不止一处；
2. **没有上下文会让人困惑**——读代码的人会问"为什么不是另一种更简单的写法"；
3. **是一次真实取舍的结果**——有被放弃的选项，且放弃它有代价。

不够格的结论写进 [`../notes.md`](../notes.md)；改主意时，那一条就地划线并指向取代它的 ADR。

## 编号规则

- **只增不改。** 四位数左补零（`0001`）。
- **改写一条已接受的 ADR 时不改原文**：新开一条，被取代的那条留在原处，把它的 `取代者` 一行指向新的，并让新 ADR 的 `取代` 一行指向它。
- **压缩（2026-11-14 修订）**：被整体取代、且其理由已被取代者逐条收编的 ADR，可整条删除；引用处改指取代者或就地内联，删除不留墓碑。删除后清单**重新连续编号**（重编只改编号、文件名与清单行，不改正文的决定与日期），编号不留空洞——这是对「只增不改」的唯一例外。
- 文件名是 `<编号>-<kebab-case 的短名>.md`；标题是 `<编号>：<一句话的决定>`。

## 写法

- **正文用中文**，代码标识符、路径、命令、API 名、线上协议保持英文（与仓库其余文档一致）。
- 一份 ADR 至少要有四件东西：**背景**（被改主意前的形态，以及当初为什么这么定）、**决定**、**后果**（换来了什么、背上了什么）、**不可逆性与代价**。写"为什么改主意"的 ADR 再加两节：**被取代的是什么**（逐条对照）与**没有被取代的**（明确不动、读者不该一起重开的东西）。
- 只记**已定**的。未定的写成"尚未决定"，未确认的事实单独列一节，并说清哪些判定**不依赖**它们——否则下一个人会把猜测当结论。
