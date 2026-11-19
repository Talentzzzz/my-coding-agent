# 0026：行存储并入 hub——`projection.ts` 退场，controller 与 mux 只认一个 service

日期：2026-11-19 · 状态：已接受，**已落地**（同日，`check` 与 9 个 smoke 全绿）
取代：[0025](0025-mux-is-the-connection-controller.md) 分层表的 `projection` 行（「有哪些行归
projection」）；0025 的其余决定与不变量原样保留

它满足 `docs/adr/README.md` 的三条：改回去要把行存储从 `hub.ts` 重新拆成独立文件、把
`publishRows` / `publishGone` 重新升回公开面、改回 4 个 smoke 的构造点；下一个人读 `hub.ts`
会问「行折算为什么站在编排层的 sink 里」，而这一次答案是**故意的**；放弃的是「机制（分发）与
内容（行长什么样）分文件」那条判据，换来的是 REST 与 WS 共同面对的唯一 service——
`SessionHub` 一个类回答"这个进程知道关于会话的一切"。

## 背景

[ADR-0025](0025-mux-is-the-connection-controller.md) 落地后的分层表写着三行分工：
`projection` 管"有哪些行"、`hub` 管"谁在看、有几个窗口"、mux 管连接帧序；依赖方向是
`mux → hub / projection / 答案表`、`projection → hub`、`hub → 无人`。`projection.ts` 是
server 包里一个独立文件：一张按会话的行 `Map`、一次磁盘播种、事件折算（`onEvent` 推
`modified` 与 title）、活字段叠加（`running` / `pending` 来自 hub 的订阅面）与 `sameRow`
去重。它经 `hub.subscribe` 跟随自己创建的每一行，经 `hub.publishRows` / `publishGone`
扇出——这两个扇出方法的**全部**调用者都是它自己。

这份归属被推翻，理由是**口子的数量**：REST 的 controller 调 hub，WS 的 mux 却要同时拿着
hub 与 projection 两样东西。一个想嵌 server 的宿主面对的不是"一个 service"，而是"一个
service 加一个挂在它身上的观察者"——而那个观察者的唯一依赖就是 hub、唯一消费者又是经 hub
扇出的两路（REST 兜底与 mux 概览）。

## 决定

1. **`projection.ts` 删除，行存储整体搬进 `SessionHub`。** `rowsBySession` / `following` /
   `probing` / `seeded` 四张容器与 `publish` / `liveRow` / `liveOf` / `follow` /
   `onRowEvent` / `probe` / `seed` / `ensureSeeded` 全部成为 hub 的成员；公开面新增
   `groups()` / `rows()` / `row(id)` / `refreshRow(id)` / `forgetRow(id)` 五个读刷新方法。
2. **跟随不再走订阅表。** 原来的 projection 是 hub 自己订阅面的一个消费者（`follow` 调
   `hub.subscribe`，声明 `event` / `state`、不要 baseline）。并入后行折算直接站在构造器给
   编排层的 sink 里：`onEvent` / `onState` 先折算行（只对 `following` 里的会话），再分发给
   订阅表。顺序与原来等价——projection 在播种那一拍就订阅了，永远排在任何窗口订阅之前。
3. **`publishRows` / `publishGone` 退成私有。** 它们的调用者只有行存储自己；`publishResync`
   与 `publishFailure` 的公开面不动。
4. **`MuxDeps` 收窄为 `{ sessionHub, approvalAnswers }`；`sessionListeners` 去掉 projection
   参数。** `onCreated` / `onRenamed` → `hub.refreshRow`，`onRemoved` → `hub.forgetRow`。
   `BootedServer` 不再暴露 `sessionProjection`；`close` 的顺序语义（行跟随最先放下）由
   `hub.close` 自己的开头承担。
5. **语义零变化。** 行字段、播种时机（首读播种、失败不缓存）、`sameRow` 去重、title 只随
   user 消息动、活字段叠加、删除顺序不变量（流先 `end`、行后 `session_gone`）逐条原样。

## 后果

- **换来的**：controller 与 mux 面对同一个口子；`MuxConnection.overview` 一行
  `sessionHub.rows()`；smoke 不再需要"造 hub、再造 projection 挂上去"的两步装配。
- **背上的**：`hub.ts` 一个文件同时回答"订阅怎么分"与"行长什么样"两个问题——两个变化轴
  （给行加字段、改订阅语义）现在落在同一个文件里；行存储是 hub 的第三张常驻容器，与订阅表、
  全局通道并列。
- **不变量仍在**：行更新不问有没有人在看；跟随挂在行的生命周期上（行出现即绑、行删除即解）；
  `hub → 编排层` 是 hub 唯一的重依赖，行存储没有给它添新的。

## 没有被取代的

0025 的其余一切：`MuxConnection` 是连接级 controller、hub 的 no-gap「注册与快照原子」、
`frames.ts` 的纯函数分工、wire 的写侧有界。ADR-0001 / 0024 里作为历史记录的 projection
行述不改——历史 ADR 不重写，取代关系以本文件与 README 清单为准。
