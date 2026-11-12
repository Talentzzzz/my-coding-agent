---
label: wayfinder:map
title: loop 第五次搬家——LoopManager 只认函数（Manager 全面回调化）
created: 2026-11-12
tracker: local-markdown（票在 tickets/ 下，blocking 用正文 Blocked-by: 行）
---

# Map：loop 第五次搬家

## Destination

**LoopManager 只认函数**：`LoopOptions` 上除三件每次调用的值（`state` / `bag` / `start`）、传输
`api` 与既有两条白名单（`bagOf` / `emit`）外**只剩回调**——三只 Manager
（`SessionManager` / `SettingManager` / `ToolManager`）与 `hooks` 对 loop 完全不可见；
`servicesOf` 组装点消除（`publishState` / `approvalsOf` 包成 Agent 传入的回调，fanout 文件不动）。
终点 = 被接受的新 ADR 0023（取代 0022）+ 落地代码（`agent.ts` 提供回调实现、`npm run check` 与
smoke 全绿、基线同色口径）+ `check-loop-boundary.ts` 守卫升级把新规则机器化。

## Notes

- **Tracker**：本地 markdown。map 即本文件；票是 `tickets/NNN-*.md`。认领 = 把票正文的
  `Assignee:` 写上自己的名字，未指派的 open 票即未认领。blocking 用正文 `Blocked-by:` 行，
  值为票文件名（不含扩展名）。
- **决策前必读**：`docs/architecture.md` 对应小节；ADR 0007、0012、0013、0014、0016、0019、
  0022。**0022 是本图要推翻的裁决**（2026-11-11 立同日落地），新 ADR 必须正面回应它的判据
  （白名单 vs 六件依赖、文件分区的价值），把转向理由写进正文，而不是绕开它。
- **用户目标**：依赖方向纯度——loop 层零 Manager 可见性。上一张图的「白名单回调」原则推到
  极致：loop 需要的每样东西都以函数到达，谁提供、从哪来，是 Agent 的事。
- **已拍板（2026-11-12，grilling 两轮，见 Decisions so far）**：① 禁令边界 = 三只 Manager +
  hooks 一并回调化 + `servicesOf` 组装点消除；② 回调粒度 = 语义操作分组（乙案），逐点镜像
  否决；③ ToolManager 实例表例外保留（ADR-0016 不动），loop 经 `executeTool` 回调拿执行；
  ④ 新 ADR-0023 取代 0022，落地进图（执行 override）；⑤ 守卫升级机器化新规则。
- **回调草案** 16 动词见票 002，逐项答辩定稿；`CONTEXT.md` 术语随票 002/003 同步。
- **验收标准**：`npm run check` 全绿 + smoke 与基线同色（`smoke-tools` /
  `smoke-desktop-observability` 在干净 HEAD 上同红的既有口径）；恢复机器保持导出
  （`smoke-approval-recovery` 直接驱动，ADR-0006 §5）。
- **执行 override**：落地（票 004）与守卫（票 005）纳入本图，沿用上一张图「决策与落地同日」
  的先例（0012、0014、0022 都是当天落地）。

## Decisions so far

- （2026-11-12 目的地钉死，与本图同时记录，无票）五项拍板：① 禁令面 = 三只 Manager +
  hooks 整个对象回调化 + `servicesOf` 现凑点消除（`publishState`/`approvalsOf` 包成 Agent
  回调，fanout 文件本身不动）；② 回调粒度走**语义操作分组**——按「loop 需要什么操作」定动词，
  Agent 实现内部自己去摸 Manager；逐点镜像被否决（只是把直调换成间调，袋上背 25 个函数更难读）；
  ③ ADR-0016 的 ToolManager 实例表例外**保留**，消掉的只是 loop 对它的可见性（工具执行变
  `executeTool` 回调，Agent 内部经 ToolManager）；④ 立 **ADR-0023 取代 0022**，正文正面回应
  0022 判据并记录转向理由；落地纳入本图；⑤ `check-loop-boundary.ts` **扩规则**：loop-manager.ts
  禁 import 三只 Manager 与 hooks 所在模块，防止下次搬家回潮。
- [盘点 loop 对 Manager/hooks 的全部触点](tickets/001-touchpoint-inventory.md)（closed 2026-11-12）：
  六件依赖 87 触点 / 67 行（sessionManager 27、tools 27、settings 19、hooks 12）；`servicesOf`
  消费点 5 处；16 动词草案覆盖约 82%，草案外 6 类形状（`modelChoiceOf` / `declaredTools` /
  追加链 / `api.stream` / `systemPrompt` / 组装机制行）已记为票 002 答辩输入；`Tool.execute`
  生产唯一入口在 L1693。盘点正文见 research/001-touchpoint-inventory.md。
- [回调白名单答辩与 LoopOptions 接口定稿](tickets/002-callback-whitelist.md)（closed 2026-11-12）：
  定稿 **19 动词 + emit**（读 8 / 写 6 / 执行 1 / 接缝 3 / 窗口 1）；5+6 合并为 `recordSelection`
  且 **`bagOf` 退出白名单**（唯一触点 L629 被收编，loop 不再自开袋）；`activeTools` 扩为
  `{ names, declared }`；新增 `modelChoice` / `appendMessage`；否决族回调与 `publishView` 两合并案；
  `CompactOptions` 改 pick 8 个回调/值字段；hooks 拆三个显式回调（`apply` 门面留 Agent 侧）；
  001 全部触点 100% 着落。定稿接口见 research/002-callback-whitelist.md；`CONTEXT.md` 三词条已同步。
## Not yet specified

- ADR-0023 的「后果 / 尚未决定」节、0022 等旧 ADR 头部指针、实况文档
  （AGENTS.md / architecture.md / README.md）同步——票 003/004 处理。
- 类型驻地口径（`Session`/`SessionEntry`/`ToolRunContext`/`ToolUpdateCallback` 的 import 面
  如何过「禁 Manager 模块」守卫）——票 005 与落地（004）一并定。

## Out of scope

- fanout 文件与其参数形状不动（组装点挪到 Agent 即可）。
- 不动 ADR-0019「一次运行读一次盘」的 bag 语义；不动 ADR-0007 无属性服务形态；不动 ADR-0017
  的 server 消费边界与 `check-server-facade`。
- 恢复机器的审批语义（ADR-0006 §5）只搬不改；abort / settle / close 仍不进 loop。
- 不动 ADR-0016 的 ToolManager 实例表本身（只挡 loop 的可见性）。
- 不重开与 pi-ai 上游的对照（ADR-0008）。
