# 01 - 砍掉 send 引用（wait/unwait 与 waiting 表）

Type: task
Status: resolved

## 背景

2026-11-16 的一次架构讨论（起源：追问 `SessionHub.holds` 为什么存在）得出的结论：`waiting` 表与 mux 的
`wait` / `unwait` frame（send 引用，issue 13）防的是一个**本产品里不存在的竞态**。

### 已经查实的事实

1. **send 引用防的「断网窗口」今天根本不受保护。** wait 按**连接**记账：连接拆除时 mux 释放这条连接
   上的全部 wait（`mux.ts` `MuxConnection`，与订阅同路）。所以「窗口 A 断网 → 运行结束 → 另一端删除 →
   窗口 A 重连拿到 404」这条 timeline 里，删除发生时 `waiting` 已经是空的——现状代码拦不住，
   「无声撕裂」论证的核心场景并未被覆盖。
2. **运行中的删除由 `isRunning` 拦，不靠 waiting。** send 的寿命等于那次运行，而运行全程
   `isRunning === true`——waiting 与 isRunning 在这段完全重叠，唯一不重叠的是「运行刚结束、
   最后一帧在途、客户端尚未 unwait」的一小段。
3. **waiting 永远进不了 core**（「谁挂在这条连接上等结果」是连接层事实），这是它住在 hub 的原因，
   也是它无法随 ADR-0013 的形态折叠掉的原因。
4. **剩余的保护价值**只有两点：连接着的客户端在最后交付瞬间的体验（答案闪现后窗格立刻收 end），
   以及非人类客户端（脚本 / `curl`——但第一版里唯一的脚本用户是 smoke 测试）。

### 产品语义的判断

本产品是**单用户**：发消息的人与点删除的人是同一个。`remove()` 那句 409「还有没送到的结果，
等它停下来再删」是服务器替用户裁决了他自己的两个动作哪个算数。主张改为**最后一个动作赢**：
delete = delete——有运行就拦（`isRunning` 已有，够了），空闲就删，删除顺手作废在途 send 的答案
是用户的明确意图，不需要守卫代为保守。

### 仓库现状选择（被本 issue 挑战的那半）

ADR-0001 把订阅与等待定为「两个永不互相换算的问题」，其论证默认多客户端互不知情（issue 13）。
搬进单用户桌面应用后，裁判的大部分职责落空。

## 提议的改动

1. **wire**：删除 mux 上行帧 `wait` / `unwait` 两个类型；未知类型本就丢弃并记日志，客户端兼容无需
   过渡。
2. **hub**：删除 `waiting` 表与 `awaitResult()`；`remove()` 的守卫从四道减为三道
   （holds / isRunning / hasPendingApprovals），409 文案去掉「没送到的结果」。
3. **客户端**：删除发 `wait` / `unwait` 的两处（send 时与最后一帧渲染后）。
4. **文档与记录**：ADR-0001 不能悄悄改——新开 ADR 记「单用户产品里 send 引用撤销」，并列明
   ADR-0001 的哪些半句随之失效；`AGENTS.md` 术语 `hold` 段里 send 引用的表述、`docs/architecture.md`
   的 `wait` / `unwait` 段落与 mux 帧表、issue 13 的登记，一并改。
5. **smoke**：`smoke-mux` 里 wait/unwait 的帧交互用例删除；`smoke-api` 若有「waiting 期删除 409」的
   断言则一并删。

## 不砍的（讨论中确认保留）

- `holds` 本身：它对运行毫无贡献（`remove()` 问运行用的是 `agent.isRunning()`），但对**跨 await 的
  短命令**（abort 的收尾窗、approve 的「记答案 → 启动恢复运行」之间）是 AgentState 看不见的唯一
  现形手段，且 `closing` 槽位依赖它串行化「hold 等删除」的反向窗口。纯同步命令（updateConfig /
  branch）确实不需要它——守护范围比文档论述的窄得多，这半句 documentation drift 可以顺手修，
  不属于本票。
- `isRunning` / `hasPendingApprovals` 两道守卫：真实的运行保护，不动。

## 代价

- 收益：少两种帧类型、一张表、一道守卫、一个「永不互相换算」的概念；删除语义变成用户直觉的
  「最后一个动作赢」。
- 放弃的：连接着的客户端在最后交付瞬间可能看到「答案闪现后窗格关闭」；脚本客户端断连期间
  丢失在途答案（可接受：脚本应自己管理生命周期）。

## Comments

- 2026-11-16 建立。源自对 `SessionHub.holds` 职责的追问链：holds → 「两个 loop 踩踏」被证伪（引擎
  已串行化）→ holds 实际职责（短命令窗口 + 404 校验）→ waiting 的保护范围被逐段证伪 → 单用户
  语义下判定 send 引用不值得保留。落地前先写 ADR（本仓规则：推翻 ADR 要新开一条，不悄悄改）。

## Answer

- **ADR**：[0022-drop-send-reference](../../../docs/adr/0022-drop-send-reference.md) 落地了本票的全部五点提议；ADR-0001 的取代者行补了指向，ADR 清单加行。`AGENTS.md` 的 hold 段本就没有 send 引用的表述，未动。
- **wire**：`protocol.ts` 的 `ClientFrame` 回到两个动作（`open` / `cancel`），`client-frame.ts` 的解析分支与注释同步。
- **hub**：`waiting` 表与 `awaitResult()` 删除；`remove()` 守卫三道（holds / isRunning / hasPendingApprovals），409 文案去掉「没送到的结果」。
- **mux**：`MuxConnection.waits` 与 `startWaiting` / `stopWaiting` 删除，`close()` 只拆订阅。
- **客户端**：`client.ts` 删掉 `reportWait` 与 retain / release / replay 三处发送；`"send"` 引用源保留——它仍回答本地订阅寿命（流活到运行结束），只是不再上报服务端。
- **smoke**：`smoke-mux` 第 9 节整节删除（原第 10 节 shutdown 顺位为 9）；`smoke-mux-client` 三条 wait/unwait 断言与 `opens()` 注释删除；`smoke-api` 本就没有 waiting 断言，未动。
- **验证**：`npm run check` 绿（token 审计与 facade 守卫含在内）；smoke-mux / smoke-mux-client / smoke-sessions / smoke-projection / smoke-session / smoke-approval-endpoint / smoke-approval-recovery / smoke-tools / smoke-backpressure / smoke-models 全绿。三处失败为改动前既有的环境与规格漂移，与本票无关：smoke-boot / smoke-approval 的子进程一节要求 Node ≥ 22.19（本机 22.14，ADR-0019 已登记同类）；smoke-mux-live / smoke-liveness 的空 body 出生请求未跟上 ADR-0021（`smoke-sessions` 现行断言「empty POST is refused (400)」即现行契约）。
- **issue 13**：登记处补注撤销指针（结论部分被 0022 整体取代）。
