---
label: wayfinder:map
title: loop 第四次搬迁——从 Agent 抽回 LoopManager（白名单回调形状）
created: 2026-11-11
tracker: local-markdown（票在 tickets/ 下，blocking 用正文 Blocked-by: 行）
---

# Map：loop 第四次搬迁

## Destination

把一次运行的机械（引擎、填充链、压缩阶梯、重试泵、两个工具闸门、事件 sink、收尾，即
ADR-0014 决定 1 的 18 个私有方法 + 文件级机械）从 `Agent` 抽回 `LoopManager`。形状已由用户拍板：
**白名单回调**（事件分发、审批闸门这类编排层语义经 Agent 传入的函数，其余 loop 自己拿）+
单个 `loopOptions` 运行参数袋。终点 = 被接受的新 ADR 0022（取代 0014）+ 落地代码
（`agent.ts` 完成分区、`npm run check` 与 smoke 全绿）。

## Notes

- **Tracker**：本地 markdown。map 即本文件；票是 `tickets/NNN-*.md`。认领 = 把票正文的
  `Assignee:` 写上自己的名字，未指派的 open 票即未认领。blocking 用正文 `Blocked-by:` 行，
  值为票文件名（不含扩展名）。
- **决策前必读**：`docs/architecture.md` 对应小节；ADR 0007、0008、0012、0013、0014、0017、
  0019、0021。**0014 是上一轮对同一批代码的裁决**（「一天之内第三次搬」就发生在 2026-11-04），
  新 ADR 必须正面回应它的判据，而不是绕开它。
- **用户目标**：结构模块清晰——读 loop 只看一个文件。这是这次搬迁的正当理由；0008 批评的
  「没有信息的对象」指的是转发形状，不是分区本身。
- **验收标准**：`npm run check` 全绿 + smoke 全套同色；恢复机器保持导出
  （`smoke-approval-recovery` 直接驱动，ADR-0006 §5）。
- **执行 override**：本 effort 把落地纳入 map（票 004、005），遵循仓库「决策与落地同日」的
  先例（0012、0014 都是当天落地）。

## Decisions so far

- [盘点 run 一族代码的现状](tickets/001-run-inventory.md)（closed 2026-11-11）：run 一族 ≈1805 行占
  agent.ts 61%；编排层语义访问点 7 类 12 处（白名单候选面窄，emit sink 是现成回调样本）；loop 可自答
  6 类 ≈25 处恰好是 0012 六件依赖的形状；旧 loop-manager.ts 从未入库（511fc09 一次性三部曲），
  替代证据是 `.scratch/loop-manager/` 设计文档；smoke 经 `@my-agent/core` 包出口取恢复机器，抽取必须保住。

- （2026-11-11 目的地钉死，与本图同时记录，无票）形状四条拍板：① ADR + 落地都在范围内；
  ② 依赖方向 = 丙（白名单回调，每个回调都要能答「为什么必须绕回 Agent」）；
  ③ 0014 清单全搬，文件级机械跟着搬，恢复机器保持导出；④ 参数 = 单个 `loopOptions`
  运行参数袋（0013 已验证参数化不违反 ADR-0007）。

- [白名单答辩：回调清单与 loopOptions 字段](tickets/002-callback-whitelist.md)（closed 2026-11-11）：
  白名单定稿两项——`bagOf(id)`（唯一摸会话表处，`live.unwritten` 只在表上）与 `emit`
  （dispatchEvent 整体收编，用户拍板：落盘/清队列/投影的组合政策是编排层与窗口契约）；审批闸门
  确认已是回调形状、零改动；publishState×5 / approvalsOf / setSuspended / live 槽位答辩淘汰，
  loop 自答。loopOptions = {state, bag, start} + 六件依赖（进袋、零字段 LoopManager）+ 两条回调；
  票面「模型/abort/闸门/transport/thinkingLevel 必有」被盘点推翻——全是运行局部量。定下的词落进
  根目录新建的 `CONTEXT.md`。

- [起草并接受 ADR-0022](tickets/003-adr-0022.md)（closed 2026-11-11）：四问四拍板（全取推荐答案），
  正文落 `docs/adr/0022-loop-manager-whitelist-callbacks.md`。取代 0014 全部决定 + 部分取代 0008
  （决定 1/2 再次作废），复活 0012 的文件分区（不含六字段构造注入）与 0013 的零字段/参数化结论；
  正面回答 0014 判据三层（价值是文件地址不是持有、跨边界的是白名单不是六个字段、0008 批评的是
  转发形状不是分区）。判据节写全白名单逐项答辩与 11 字段 `loopOptions`（回调**平铺**）。出口决定：
  `index.ts` **不恢复** `LoopManager` / `LoopManagerConfig` 导出，恢复机器两函数仍从包入口导出
  （票 004 改 re-export 源）。0014「没有被取代的」整节继承。`docs/adr/README.md` 加 0022 行、
  0014 / 0008 / 0012 / 0013 头部加指针，取代者均不回退。实况文档本票不同步，留票 004。

- [按 ADR-0022 落地](tickets/004-landing.md)（closed 2026-11-12）：`loop-manager.ts`（1940 行）落成——
  决定 1 清单的 17 个方法 + 文件级机械整体迁入，零字段、零构造参数，方法体一字不改（机械改动只有
  `this.六件` → loopOptions 解构、`this.bag` → `bagOf`、`this.services` → `servicesOf` 现凑）；
  压缩入口 `compact` 复用袋字段 + `CompactOptions`，模型计算四行搬进 loop。`agent.ts` 收缩到 1172 行
  （会话表、读面、命令、审批账本、投影 + 事件契约），三入口组袋调 loop。**偏差**：`dispatchEvent`
  按决定 4 的白名单答辩留在编排层（`loopOptions.emit` 的实现侧），迁入 loop 的是 17 个方法——记进
  ADR 后果节。「尚未决定」第 1 件择定：`index.ts` re-export 源直指 `./loop-manager.ts`；
  第 2 件已定：行数账补进 ADR（2947 → 1172 + 1940，run 一族 ≈2020）。`npm run check` 全绿；
  smoke 与基线同色（`smoke-tools` / `smoke-desktop-observability` 在干净 HEAD 上同样红，stash 验证）。
  `AGENTS.md` / `docs/architecture.md` / `README.md` 实况同步完成。

## Not yet specified

- ~~`loopOptions` 的字段清单与回调的确切接口签名~~——票 002 钉死字段，票 003 的 ADR 判据节
  钉死完整 TS 接口与**平铺**（不套 `callbacks` 子袋）。
- ~~`index.ts` 要不要恢复 `LoopManager` 出口~~——ADR-0022「出口决定」：不恢复；`LoopManagerConfig`
  在零字段形状里不存在。包入口的恢复机器两函数出口保持，源路径由票 004 定（两条等价做法列在
  ADR「尚未决定」）。
- ~~`session/fanout.ts` 的分工是否随搬迁微调~~——ADR-0022 决定 7：不微调，参数形状不动；
  retry 事件绕过 dispatchEvent 直调 fanout 的现状也不动。
- ~~落地后 `agent.ts` 的行数账，以及「the engine」小节标注随文件迁移后的形态~~——票 004 已补进
  ADR-0022「后果」节；实况文档（AGENTS.md / architecture.md / README.md）随票 004 改指 0022。

## Out of scope

- 不动 ADR-0019「一次运行读一次盘」的 bag 语义；不动 ADR-0007 无属性服务形态；
  不动 ADR-0017 的 server 消费边界与 `check-server-facade`。
- 恢复机器的审批语义（ADR-0006 §5）只搬不改。
- 不重开与 pi-ai 上游的对照（ADR-0008）。
- 不动 `abort` / `settle` / `close`（0012 决定 6 的理由继续成立：它们是审批账本与端到端
  等待的事，搬进去要让 loop 认识审批语义）。
