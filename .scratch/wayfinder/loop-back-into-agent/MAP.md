---
label: wayfinder:map
title: loop 第六次搬家——并回 Agent（loop 就是编排）
created: 2026-11-13
tracker: local-markdown（票在 tickets/ 下，blocking 用正文 Blocked-by: 行）
---

# Map：loop 第六次搬家

## Destination

**loop 就是编排，所以它写在编排层里。** 删掉 `loop-manager.ts`：14 个成员成为 `Agent` 的私有方法，
文件级机件搬到 `agent.ts` 末尾，`loopOptions` 那只 25 字段的袋、19 动词的回调面、`CompactOptions`
的 Pick 链、`check-loop-boundary` 守卫**一并作废**——它们是为「loop 与编排层不是一件事」这条假
边界付的税，边界撤了税就该退。终点 = 被接受的新 ADR-0024（取代 0022 + 0023）+ 落地代码
（`npm run check` 全绿、smoke 与基线同色）+ 前六份 ADR 收账 + 五份实况文档同步。

## Notes

- **Tracker**：本地 markdown。map 即本文件；票在 `tickets/NNN-*.md`。认领 = 票正文 `Assignee:`；
  blocking 用正文 `Blocked-by:` 行。
- **判据（用户 2026-11-13 钉死）**：**loop 本质上是编排**。0022/0023 划的不是两层的边界，是同一层
  内部的边界；为此付出的成本（袋、白名单、闭包、守卫）从第一行起就买不到东西。这条 0008/0014
  时代不存在——那时争论的是「文件太大」，不是「这本来就是一件事」。
- **决策前必读**：`docs/adr/0008`（第一次并回）、`0012`/`0013`/`0014`（抽出去又删掉）、`0022`/
  `0023`（对象回来 + 回调面）。**0022 与 0023 是本图要推翻的裁决**，ADR-0024 必须正面回应 0023 的
  「零 Manager 可见性」判据：承认它成立，但指出它买到的东西不值它的税。
- **已拍板（2026-11-13，两轮问答）**：① 全并——对象与文件一起消失，`agent.ts` ≈ 2820 行（实测）；
  ② 规模问题不再用搬文件治，真要拆拆的是 `Agent` 这个类，另开图；③ 恢复机器跟机件进 `agent.ts`
  并仍导出，`index.ts` 改指 `./agent.ts`；④ 成员按调用顺序排、机件聚在文件末尾；⑤ 守卫删除并记账。
- **验收标准**：`npm run check` 全绿（守卫删除后剩 4 条）+ smoke 与基线同色（`smoke-tools` /
  `smoke-desktop-observability` 是干净 HEAD 上既有的红）。
- **只出票，不执行**（用户 2026-11-13 明确）：本图交付的是六张可独立执行的票；认领即执行，
  落地与验证在票 004 / 005 里。ADR 与旧 ADR 收账一张（003），实况文档一张（006）。

## Decisions so far

- （2026-11-13 目的地钉死，与本图同时记录，无票）两轮问答五项拍板：全并 / 不再用搬文件治规模 /
  恢复机器进 `agent.ts` 仍导出 / 按调用顺序排 + 机件聚末尾 / 删守卫并记账。判据一句话：**loop 是
  编排，边界是假的**。
- [机械搬家切法与动词落地口径](tickets/001-cut-and-verbs.md)（closed 2026-11-13）：14 个成员原样成为
  `Agent` 私有方法（名字不变）；19 动词里**只有 8 个留成方法**（`contextEntries` / `modelChoice` /
  `activeTools` / `recordSelection` / `executeTool` / `rewriteContext` / `decideBeforeTool` /
  `decideAfterTool`），其余直调（`this.sessionManager.x` / `approvalsOf` / `publishState` /
  `this.settingsManager.x`），`modelCatalog` 复用既有公开方法；`run` 收 `RunInput`（`state`/`bag`/
  `start` 三件值，无依赖面）。
- [类型与导出的新家](tickets/002-types-and-exports.md)（closed 2026-11-13）：七个接缝类型整组删除——
  `HookMap` 已是结构化声明，改用 `HookEvent<…>` / `HookResult<…>`，「同步点」这件事消失；
  `RunInput` / `RunStart` / `ActiveTools` / `ToolChain` 住 `agent.ts`；`index.ts` 的恢复机器
  re-export 改指 `./agent.ts`。
- [立 ADR-0024 并收账](tickets/003-adr.md)（closed 2026-11-13）：`docs/adr/0024-loop-is-orchestration.md`
  已接受（判据一句话 + 三问正面回答 + 六条决定，130 行）；0008/0012/0013/0014/0022/0023 各加一
  clause 指针，`docs/adr/README.md` 追加 0024 行并改 0022/0023/0014 三个尾句。实况文档同步归票 006。
- [落地：把 loop 并回 Agent](tickets/004-landing.md)（closed 2026-11-14）：`loop-manager.ts`（1886 行）
  删除，14 个成员成为 `Agent` 私有方法、机件接到 `agent.ts` 末尾（恢复机器仍导出，`index.ts` 改指
  `./agent.ts`）；终态实测 2928 行（类 1795 + 机件段约 915）。
- [收尾验证](tickets/005-verify.md)（closed 2026-11-14）：五节全过——check 四条全绿、残留 grep 零命中、
  形状四件事全过（CRLF 无损）；smoke 与基线同色，两个基线红（`smoke-tools` /
  `smoke-desktop-observability`）经 detach 到 `c667b9f` 取证逐字同处同错；行数记账写回票 004 与
  ADR-0024 后果。剩余：票 006（实况文档）。
- [实况文档同步](tickets/006-living-docs.md)（closed 2026-11-14）：五份全改——AGENTS.md（布局行并
  `agent.ts`、engine 词条重写为 `Agent.run` 私有方法、retry 词条）、CONTEXT.md（删 LoopManager /
  loopOptions / 回调白名单三条，run bag 改经 `Agent.recordSelection`，新增 RunInput）、README.md
  （开头一句话交代五次往返，能力清单 `Agent.run`）、architecture.md（八处按票落位，retry 接缝段
  一处票外实况命中由判据 grep 兜住）、notes.md（追记补一句）；判据 grep 剩余命中全在历史追记、
  ADR 指针与 `_Avoid_` 表，实况零残留。六张票全部关闭，本图收尾。

## Not yet specified

- 无。落地时冒出来的偏差由票 004 记账（沿用 0023「后果」末条的口径）。

## Out of scope

- **不再用搬文件治规模。** 若 `agent.ts` 再次显得太大，另开一张图，口径是「一个类一件事」（拆
  `Agent` 这个类，不是切文件）——拆类会立刻退回「运行对象」，那必须是另一场辩论。
- 不动 `session/fanout.ts`、`session/ledger.ts`、`Agent` 的状态表与 hold/订阅语义。
- 不动 ADR-0016 的工具实例表、ADR-0017 的 server 消费边界、ADR-0019 的「一次运行读一次盘」。
- 审批语义（ADR-0006 §5）只搬不改；abort / settle / close 不进运行机械。
- 不重开与 pi-ai 上游的对照（ADR-0008）。
