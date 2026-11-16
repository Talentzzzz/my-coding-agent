# 0022：send 引用撤销——单用户产品里，删除守卫只要三道

- 状态：**已接受**（2026-11-16 讨论定案，2026-11-17 落地，见 `.scratch/drop-send-reference/`）
- 取代：[0001](0001-transport-websocket-mux.md) 里 send 引用所依赖的半句——「订阅与 hold 是两个永不互相换算的问题」的论证默认**多客户端互不知情**（issue 13），那一半随之失效；以及 [0013](0013-table-holds-live-half-only.md) 时代沿袭下来的「waiting 是 hub 侧第四样簿记」的现状陈述（architecture.md §谁拥有一个会话）

## 为什么会有这份 ADR

`SessionHub.holds` 的一次追问链（起源：它为什么存在）把 send 引用逐段证伪了：

1. **send 引用防的「断网窗口」今天根本不受保护。** wait 按**连接**记账：连接拆除时 mux 释放这条连接上的全部 wait（与订阅同路）。所以「窗口 A 断网 → 运行结束 → 另一端删除 → 窗口 A 重连拿到 404」这条 timeline 里，删除发生时 `waiting` 已经是空的——现状代码拦不住，「无声撕裂」论证的核心场景并未被覆盖。
2. **运行中的删除由 `isRunning` 拦，不靠 waiting。** send 的寿命等于那次运行，而运行全程 `isRunning === true`——两者在这段完全重叠，唯一不重叠的是「运行刚结束、最后一帧在途、客户端尚未 unwait」的一小段。
3. **waiting 永远进不了 core**（「谁挂在这条连接上等结果」是连接层事实）——这正是它住在 hub 的原因，也是它无法随 ADR-0013 的形态折叠掉的原因。一块进不了任何层的机制，只剩被删一条路。

## 决定

**删除 send 引用的全部三个落点：**

1. **wire**：mux 上行帧 `wait` / `unwait` 两个类型删除。未知 `type` 本就丢弃并记日志，旧客户端无需过渡。
2. **hub**：`waiting` 表与 `awaitResult()` 删除；`remove()` 的守卫从四道减为三道（`holds` / `isRunning` / `hasPendingApprovals`），409 文案去掉「没送到的结果」。
3. **客户端**：retain / release / replay 里发 `wait` / `unwait` 的三处删除。客户端的 `"send"` 引用源保留——它仍回答「窗格走后，这条流要活到这轮运行结束」的**本地**订阅寿命问题，只是不再向服务端上报。

### 产品语义

本产品是**单用户**：发消息的人与点删除的人是同一个。`remove()` 那句「还有没送到的结果，等它停下来再删」是服务器替用户裁决了他自己的两个动作哪个算数。改为**最后一个动作赢**：delete = delete——有运行就拦（`isRunning` 已有，够了），空闲就删。删除顺手作废在途 send 的答案是用户的明确意图，不需要守卫代为保守。

## 被取代的是什么

| 原结论 | 本次 |
|---|---|
| [0001](0001-transport-websocket-mux.md)「订阅与 hold 永不互相换算」里隐含的多客户端裁判职责 | **失效**（部分）。订阅与 hold 仍然不互相换算——这条分离本身活着（订阅仍不拿 hold）——但它的论证曾默认多客户端互不知情、需要一个裁判替看不见彼此的客户端守住窗口；单用户桌面应用里，裁判的大部分职责落空，仅存的那部分由三道守卫覆盖。 |
| issue 13（`.scratch/agent-state/issues/13-subscription-vs-evict.md`）的结论：「send 引用的信号落地为 `wait` / `unwait`，驱逐判据七条」 | **取代**。该票的其余内容（先通知再删表、订阅表清行记账）不动。 |
| ADR-0013 时代 architecture.md 里「还有谁在等一个结果（`waiting`）」的现状陈述 | **改写**（现状文档随代码走，不属决定本身）。 |

## 没有被取代的

- **`holds` 本身。** 它对删除守卫里的 `isRunning` 毫无贡献，但对**跨 await 的短命令**（abort 的收尾窗、approve 的「记答案 → 启动恢复运行」之间）是 AgentState 看不见的唯一现形手段，且 `closing` 槽位依赖它串行化「hold 等删除」的反向窗口。纯同步命令（updateConfig / branch）确实不需要它——守护范围比旧文档论述的窄，这半句 drift 随本 ADR 修掉。
- **`isRunning` / `hasPendingApprovals` 两道守卫。** 真实的运行保护，不动。

## 后果

**换来：** 少两种帧类型、一张表、一道守卫、一个「永不互相换算」的概念；删除语义变成用户直觉的「最后一个动作赢」。

**放弃的（照实记）：** 连接着的客户端在最后交付瞬间可能看到「答案闪现后窗格关闭」；脚本客户端断连期间丢失在途答案。第二条可接受的理由：脚本应自己管理生命周期——第一版里唯一的脚本用户是 smoke 测试。

## 不可逆性与代价

**易逆转。** 三个落点是同一条语义的三半，恢复就是把它们加回去：两个帧类型（旧客户端早已不识别的 `type` 重现无兼容成本）、一张 `waiting` 表（形状见 issue 13 的登记，原样可抄）、一道守卫。唯一要重新回答的是**值不值**：本 ADR 的三条证伪若有一条被推翻（比如产品变成多用户），send 引用就该回来。

## 落地

- 代码：`protocol.ts`（`ClientFrame` 两动作）、`client-frame.ts`、`mux.ts`（`waits` 表与两个私有方法删除）、`hub.ts`（`waiting` / `awaitResult` 删除、守卫三道）、`web/src/client.ts`（`reportWait` 与三处发送删除）。
- smoke：`smoke-mux` 第 9 节（wait 挡删除、连接死亡释放、未知会话容忍）删除；`smoke-mux-client` 三条 wait/unwait 断言删除；`smoke-api` 无 waiting 断言，未动。
- 文档：`docs/architecture.md` 的 §谁拥有一个会话、§API 引言与 ClientFrame 小节；`AGENTS.md` 术语无 send 引用表述，未动。
