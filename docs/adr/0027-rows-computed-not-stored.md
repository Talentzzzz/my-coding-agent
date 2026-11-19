# 0027：行存储退场——行是现算的快照加增量推送，服务端不为行养内存

日期：2026-11-19 · 状态：已接受，**已落地**（同日，`check` 与 24 个 smoke 全绿）
取代：[0026](0026-projection-folded-into-hub.md) 的决定 1/2（行存储作为 hub 的常驻容器、
跟随集合与播种）；0026 的其余部分（controller 与 mux 只认 hub 一个 service、`publishRows` /
`publishGone` 私有）继续成立

它满足 `docs/adr/README.md` 的三条：改回去要把 `rowsBySession` / `following` / `probing` /
`seeded` 四张容器装回 hub、把 `session_row` 帧改回整行、改回客户端的整行替换；下一个人读
`hub.rows()` 会问「为什么每次都扫盘」，而这一次答案是**故意的**；放弃的是「一次扫描、内存供数」
的读取成本与「`sameRow` 去重」的空帧压制，换来的是服务端对行**零内存**——行与
`SessionSnapshot` 同一个模式：第一次查询给当前态，之后随事件推增量。

## 背景

[ADR-0026](0026-projection-folded-into-hub.md) 把原 `projection.ts` 的行存储并进 hub：四张
常驻容器、一次播种、事件折算、`sameRow` 去重。它工作得很好，但它是一份**内存里的行**——
hub 由此背上第三张常驻表、两个失效面，而这张表回答的问题（"这台机器上每个会话在做什么"）
本可以从磁盘与活半**每次现算**：冷的一半是目录扫描，活的一半是编排层袋里的两个读数。

## 决定

1. **hub 不持有行。** `rowsBySession` / `following` / `probing` / `seeded` 全删。`rows()` /
   `row(id)` / `groups()` 每次现算：`listDirectories()`（或按 id 探测）给冷半，活半在场的
   会话从袋里叠 `running` / `pending`（`withLiveFields`，与 `snapshotOf` 共用同一处活冷分岔）。
   没有播种、没有缓存、没有失效面。
2. **推送是增量，不是整行。** 协议新增 `SessionRowPatch`（`id` + 其余字段可选），`session_row`
   帧的载荷变为它。sink 折算成事件自带的字段：`entry_appended` 推 `{id, modified, title?}`
   （user 消息才有 title）、`branch_changed` 推 `{id, title}`、快照推 `{id, running, pending}`。
   **去重退场**：hub 无旧值可比，冗余由客户端的幂等合并吸收。`publishState` 只在消息边界与
   手势上触发（token 走 `message_update`，不发布状态），所以没有流量洪峰。
3. **完整行只在手势上出现。** 出生、fork、存储型改名（`refreshRow`）探测一次盘、推整行——
   这是服务端唯一为单行读盘的时刻。删除推 `session_gone`。
4. **客户端持有行表。** `SessionRows.put` 改逐字段合并：缺席字段读作"没动"；未知 id 的增量
   **丢弃**——只有完整的行可以自表身份。这条规则同时是隐藏目录过滤在客户端的延续：隐藏目录
   的行从不在客户端的表里（overview 过滤一次、resync 摘走），它的增量落空为零。`modified`
   以 max 合并——"最近活动"只前进，这是旧存储端守卫（`at <= modified` 不发布）的化身。
5. **mux 的 no-gap 照旧成立。** overview 首读期间到达的增量扣在连接自己的 `overviewBacklog`
   里，`sessions` 帧写出后按序冲刷——与观看流上 baseline 的 backlog 同一个模式，暂存队列的
   生命周期是这一条连接的开场，不是存储。
6. **REST 的行也现算。** `/api/directories` 改经 `hub.groups()`（含活字段叠加），controller
   只问 hub。

## 后果

- **换来的**：服务端对行零内存、零失效面；hub 回到"两样簿记"（订阅表 + 全局通道）；行的读取
  与 `SessionSnapshot` 共享同一套心智——现算、推送、无驻留。
- **背上的**：每次 overview 一次目录扫描（header 级读，桌面规模下廉价）；wire 上有冗余增量
  （同值的 `running` / `pending` 反复到达），客户端合并幂等、渲染有 version 门；mux 无法再
  按目录压制增量（增量不带 workDir），隐藏目录的压制依赖客户端的"未知 id 丢弃"。
- **顺带的修复**：`SessionHub.remove` 的同步存在性检查补上闸感知（`SessionManager.isClosing`
  → 门面 `isDeletingSession`）——202 应答先到之后落进 unlink 窗口的第二次删除曾被答成 202，
  规格承诺的 404 现在靠判定成立，不靠赌 unlink 的时机（ADR-0023 的"读作「没有这个会话」"
  对第二次删除同样成立）。

## 没有被取代的

0026 的其余一切：REST 与 WS 只认 hub 一个 service、`publishRows` / `publishGone` 私有。
0025 的连接 controller 分工、hub 的 no-gap「注册与快照原子」、`frames.ts` 纯函数、wire 有界
——全部原样。ADR-0001 / 0024 / 0026 里作为历史记录的行述不改。
