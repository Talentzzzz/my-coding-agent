# Map：ToolManager——一张 Map 持有全部 Tool，Agent 全量改道

Label: wayfinder:map
Status: open

## Destination

`ToolRegistry` 删除，换成 `ToolManager`：一个 `Map<name, Tool>` 持有**全部实例 Tool**（填充尽量懒加载），
构造注入成为 `Agent` 的属性。不同会话用不同工具，但一律经 `ToolManager` 取 Map 里的 Tool 调用——
连引擎的执行路径也改道 Manager，不只是目录查询。

终点：代码落地、`npm run check` 与 smoke 全套按基线对跑零新红、`AGENTS.md` / `docs/architecture.md`
与实况一致、ADR 收账、`ToolRegistry` 及其旧名词全仓清零。

## Notes

**2026-11-06 绘图会话拍板（本图不再重开，票只许细化与执行，不许推翻）**

1. **一张 Map**：所有会话共用同一张 `Map<name, Tool>`，持有全部实例 Tool；不同 session 用不同工具，
   但都通过 `ToolManager`，Manager 内部拿 Map 里的 Tool 调用。Map 填充尽量做成**懒加载**（"如果可以的话"）。
2. **执行也改道 Manager**：Q2 明确选了「执行也改道」，不是只收目录查询。
3. **行为红线不设限**：Q3「你想怎么做就怎么做」——允许改 `Tool` 类型、`execute` 签名、smoke 断言与既有
   语义，由执行者按最合理的方式裁决；代价与偏离照实记进票 Answer 与 ADR。
4. **图里带执行票**：这是对「wayfinder 默认只出决策」的显式 override（写在 Notes 里）。执行骑在图上走，
   定案后 graduate 成 `task` 票；**执行票仍一票一会话**。

**动手前必读**：`docs/architecture.md` 的工具契约节与职责段、`AGENTS.md` 的术语表
（service / tool / assembly / workDirAbsPath / event）、`docs/adr/0006` 的 B 路线、`0007` 决定 1/2/6、
`0011` 决定 1/2 与被放弃选项、`0015` 决定 2/3/7、`docs/adr/README.md` 的编号规则。

**第一处硬冲突（02 号票解决，其他票别绕过去）**：`Tool` 闭包绑定工作目录
（`tools/manager.ts:33-41` 的 `ToolDefinition` 注释、`tools/read.ts:30-40`），而 `workDirAbsPath`
是**按会话**的（`agent.ts:1299` 从 `state.session.sessionSetting.workDirAbsPath` 现取、AGENTS.md 词条）。
一张进程常驻的实例 Map 只能绑一个目录；不解决它，别的会话会读写到别人的目录。
**02 号票已 resolved（2026-11-06）：形状定案、别的票按票内 §2/§4 落地，不再重开裁决**
（[02 - 一张 Map 里的实例 Tool 如何承载按会话的 workDirAbsPath](issues/02-one-map-and-per-session-workdir.md)）。

**名字已被占用且含义相反**：ADR-0007 决定 1 把 `ToolManager` 列为五个「无属性单例」之一，
`.scratch/stateless-agent/issues/11` 的 Answer 把 `tools/manager.ts` 称作「ToolManager 的无状态面」。
本图复用这个名字给一个持有 Map 的服务，06 号票定处置（含术语表怎么改）。

**今天已经成立、别重复做**：`agent.ts:133` 的 `AgentConfig.tools: ToolRegistry` → `:211`
`private readonly tools` → `:229` `this.tools = config.tools`；构造注入与「Agent 的属性」不是本次新增。
`fanout.ts:27` 的 `SessionServices.tools` 是同一只目录。

**引擎真正读的是 `Context.tools`**（ADR-0015 定为必填 wire 字段）：`agent.ts:1288` 每请求 `active()` 现建、
`:1849` `toToolDeclaration` 削薄声明、`:2091` `executionMode`、`:2272` `find`、`:2402` `execute`、
`:1534` 压缩摘要 `tools: []`、`:2020` 恢复机器 `recoverPendingToolCalls`、`:2376` `runToolCall`。
这是**执行票落地前**的读法；03 号票已定案 (a)——字段保留为声明载体、上述执行读点全量改道 Manager，
见下方 Decisions so far 第三条。

**波及面（绘图会话已核）**：`session/tool-config.ts` 四个函数、`session-factory.ts` 三个构造点
（`:142` / `:285` / `:349`，后者是 `openAgent` 传 `options.tools` 的那行；`:344` 是函数声明）、
`core/index.ts` 出口、`scripts/smoke-tools.ts`、
`scripts/smoke-session.ts`（`:1264` 新对象断言、`:1281` register 身份断言、`:1018` output-backstop 自建 registry）、
`AGENTS.md` 词条、`docs/architecture.md` 工具契约节、ADR 0006/0007/0011/0015。
`packages/server` / `desktop` / `web` 源码零 `ToolRegistry` 引用，只消费快照里的字符串数组。

**惯例**：文档中文、源码注释英文；tab 缩进、双引号、分号；相对 import 带 `.ts`；不用 `any`；
改源码用编辑器工具，绝不走 shell 文本往返（ANSI 代码页会毁 UTF-8）；不跑 `npm install`
（依赖解析走 `node scripts/install-deps.ts .`）。
**每票收账**跑 `npm run check`；验收口径以 01 号票记下的改动前基线为准
（沿用 `.scratch/context-tool-unification/` 04 号票的同机对跑做法）。

## Decisions so far

- **01 · 验收基线（resolved）**：改动前 `10b3d8e` 实测——`npm run check` 绿
  （`tokens ok: 137 defined, 111 referenced`）；28 条 smoke 稳态 **26 绿 / 2 既有红**
  （`smoke-api` 缺服务器、`smoke-liveness` 本机时序 1943/1898 ms 落在 1650 ms 预算外）；
  `smoke-api` 起固定 8080 服务器后 `api ok`；`smoke-approval` 首轮红判定为偶发（复跑 2/2 绿），
  不计入既有红。日志与环境在 `smoke-runs/baseline/env.txt` 等**本机产物**（不入提交，按 01 号票
  票内命令复跑），可复跑脚本 [`smoke-runs/run-all.sh`](smoke-runs/run-all.sh) 已入库；
  逐条结论见 [`issues/01-baseline-check-and-smokes.md`](issues/01-baseline-check-and-smokes.md#answer)。
  **每张执行票按同一口径对跑，判据「零新红」而不是「全绿」**；随机 id / 端口 / 毫秒数的归因也在票里。

- **02 · 一张 Map 如何承载按会话的 workDirAbsPath（resolved）**：[02 - 一张 Map 里的实例 Tool 如何承载按会话的 workDirAbsPath](issues/02-one-map-and-per-session-workdir.md) —— **(a)** `Tool` 目录无关，`ToolRunContext` 作 `execute` 的必填实参、由本轮栈上局部携带；一张 Map 首次访问建满六个、内置条目与 Map 对象都不可替换，bash 超时仍由 `runContext` 每请求现读。票内逐条否掉 (b)/(c)/(d)（含两个在飞会话竞态）、列全 §4 改动面与 §5 决定记录；03 / 05 的阻塞随本票解除。

- **03 · 执行改道后 `Context.tools` 的命运（resolved）**：[03 - 执行改道后 Context.tools 的命运](issues/03-context-tools-after-execution-reroute.md) —— **(a)** `Context.tools` 保留为必填 `Tool[]` **声明载体**（元素是 Map 里的实例引用、按活跃名单取子集），线协议与 `llm/` 零改动；引擎全部执行查找改 `manager.get(name)`、执行改 Manager 新增的入口，`toToolDeclaration` / `streamAssistantResponse` / 压缩摘要 `tools: []` 明确排除。**Manager owns 调用不 owns 实现**：`Tool.execute`（含 02 的 `run`）留在 `Tool` 上，Manager 内部 `get(name)` 后转发，成为**生产代码**唯一调用点；校验 / shim / 闸门 / 事件 / 定稿仍归引擎。票内 §3 逐条点名八个调用点、§5 七条决定记录；否 (b) 的决定性理由是 `Context.tools` 承载 per-request 活跃子集而 Map 装全部六个，删它要么把未启用工具发给模型、要么把 per-session 状态请回常驻服务。活跃名单由谁筛归 04（03 只按 02 §2.3 + (a) 记下「元素来自那一张 Map」这一形状后果，不替 04 选归属）；方法名/签名、smoke 与 ADR 收账分别归 05 / 06。

- **04 · 活跃集与审批的归属（resolved）**：[04 - 活跃集与审批的归属：Map 装全部还是只装活跃](issues/04-active-set-and-approval-ownership.md) —— **(a)** Manager 只答「存在什么 + 按名字取实例」（外加 03 的执行转发），Map 恒装全部实例且不可变；活跃集与审批仍是**账本派生的纯数据**，四函数留 `session/tool-config.ts`，`Agent` 把本轮名单收成栈上局部、显式穿过执行链判活（`Tool <name> not found` 仍归引擎），`SessionServices.tools` 换 `ToolManager` 但不带会话状态。两处读点加冷读第三处都从 Manager 的**全部名单**门读；`.json` / `.jsonl` / `tool_config` 格式一字不动。票内 §1 逐条否 (b)/(c)（含并发与会话切换换出两问）、§4 改动面、§5 十条决定记录；`names()` 等方法去留与 smoke 归 05、名字 / ADR / 文档归 06，本票不代答。

## Not yet specified

- **执行票怎么切**：等 02 / 03 / 04 / 05 / 06 定案后一次 graduate——`ToolManager` 类与懒加载、
  `Agent` / `SessionServices` / `session-factory` / `core/index.ts` 改线、引擎执行改道、smoke 改写、
  文档与 ADR 收账、全量验收。**02 / 03 / 04 已定案（形状与改动面见三票的 §2 / §4），05 / 06 仍待定；
  现在不预切，毕业时按 02 / 03 / 04 票的清单核，不重开裁决。**
- 压缩摘要 `tools: []` / `streamAssistantResponse` 明确排除改道，恢复机器与 `runToolCall`
  全量覆盖，八个调用点逐条结论见 03 号票 §3 —— 本块雾已由 03 清掉。
- 会话账本格式：04 定案 (a) —— 活跃集与审批仍由账本派生，`.json` / `.jsonl` 与 `tool_config`
  entry 一字不动；派生链与 Manager 之间只传名单数据（04 §2.5），
  `allTools` 仍是 Map 全名表 —— 本块雾已由 04 关掉。

## Out of scope

- 委派（子代理）、插件、MCP：`AGENTS.md:174-175` 的硬规则，且不得借「工具目录」把它们塞回来。
- `core/src/llm/` 折叠文件的 `@ts-nocheck` 转正：另开 effort（`context-tool-unification` 已列为 out of scope）。
- `packages/server` 的 REST 命令表与 mux 帧形状（ADR-0001）：本图只动 core 的工具域；03 号票已定案
  (a)，**不动 `Context` wire**，这条许可未启用。
- 桌面外壳与 web 窗口的工具清单渲染：只消费快照字符串数组，不认识 `Tool` 对象。
