# Map：ToolManager——一张 Map 持有全部 Tool，Agent 全量改道

Label: wayfinder:map
Status: closed

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

**名字已被占用且含义相反（06 已 resolved，2026-11-06）**：ADR-0006/0007 决定 1 把
`ToolManager` 列为五个「无属性单例」之一，`.scratch/stateless-agent/issues/11` 的 Answer 把
`tools/manager.ts` 称作「ToolManager 的无状态面」。06 定案 **(b)**：名字沿用（定案 1 不改）、
新开 ADR-0016 记「重新引入持有实例表的工具服务」并写清「为什么明知 0007/0011 仍要反转」、
四份旧 ADR 头部加取代者指针 + 就地标 Superseded、正文原文保留、`AGENTS.md` / `architecture.md`
逐句改写、`docs/adr/README.md` 清单加行；文档收账归 graduate 后专门的 `task` 票。
见 [06 - ToolManager 名字冲突与 ADR / 文档处置](issues/06-name-collision-and-adr-disposition.md#answer)。

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

- **05 · `register()`、方法面与 smoke 断言（resolved）**：[05 - register()、懒加载与 smoke 断言的处置](issues/05-register-lazy-load-and-smoke-assertions.md) —— **(a)** `register()` 保留为 `map.set`，测试工具与六个内置同表、**随时可加、只加新名字、同名（含内置）抛错**，Map 对象与已有条目不可换（「表不可变」= 值不可变、键集可单调增长）；构造零参、首次访问一次填满六个零参工厂，`register()` 自己也是触发者且先 `ensureFilled()` 再判重。旧五法：`names()` / `register()` 留且签名不动；`build(name, run)` 删、由 `get(name)` 取代（`run` 整个删）；`activeNames(state)` / `active(state, run)` 删；**不留别名、不加批量便利门**；按 03 补执行入口 `execute(name, toolCallId, params, run, signal?, onUpdate?)`（`run` 必填、`get` 后转发），公开面收成四法。出口面删 `createToolRegistry` / `createTools` / `toolDefinitions` / `toolListFor` / `ToolDefinition(s)` 等「现建」链部件，留选择/填充那半；`smoke-tools.ts:733` 改读 `manager.names()`。smoke：`:1264`「每次新对象」翻成「恒为同一实例」（**恒等的是 `Context.tools` 的元素，数组仍每请求新建**）、`:1281` 改 `get("noop") === noop` + 判重，并补一条请求级新不变量「同一会话的两个请求取到同一个实例」（含跨会话那一半）；`exerciseOutputBackstop` 保留注册、`smoke-approval-recovery` 的假 tool 改 `manager.register()` 且恢复机器由宿主显式传 Manager + `run` + `activeNames`（只定边界，参数布局归执行票）；三处直调 `execute` 补 `run`、bash 上限从构造期改调用期。票内 §0 更正「`scripts/mount-session.ts` 导入工具出口」这一事实（它只导入 `assembleSession`，不传 `tools`），并把 04 §3 冷/热一致在冷读路径上的推论列为核对项；§1 逐条否 (b)（删不掉懒填充这次写却要摊进五处生产装配）/ (c)（与 02 §2.3 自相矛盾、隐藏时间耦合），§5 十二条决定记录。名字 / ADR / 文档归 06，执行票内部形状不预切。

- **06 · `ToolManager` 名字冲突与 ADR / 文档处置（resolved）**：[06 - ToolManager 名字冲突与 ADR / 文档处置](issues/06-name-collision-and-adr-disposition.md) —— **(b)**
  沿用定案 1 的名字（不改用户拍板），新开 **ADR-0016** 记「本构建重新引入持有实例表的工具服务」；
  `0006` / `0007` / `0011` / `0015` 头部各加一行 `取代者：[0016]`（0007 已有指向 0011 的那行原样保留、
  另起一行）、正文原文保留并共八处就地标 `Superseded`（照 0007 决定 3/4 的 0011 先例）；
  `AGENTS.md` / `architecture.md` 逐句改写、`docs/adr/README.md` 清单加 0016 一行。
  **新 ADR 必须写清「为什么明知 0007 / 0011 仍要反转」**：终点是用户定案的「一张常驻实例表 +
  全量改道」，代价是重新承担对象生命周期与失效归属，并由六条边界把代价圈在工具域
  （只装进程级行为 / 活跃与审批仍账本派生 / 每请求值仍随 `execute` 实参 / 单写者且只增键、
  在飞引用不变 / `Context.tools` 仍必填声明载体、0015 决定 2·3·7 不动 / 会话表与
  `adopt`·`evict`·`drop` 不动）。票内 §0 更正三处票面口径：**0011 决定 1 不动**（被反转的是决定 2
  的「不注入一张表」判据与*被放弃的选项*那一条）、**0015 决定 2/3/7 不动**（只有 *后果* 里
  「引擎用它（执行）」那句现状陈述失效，03 §5 #2）、**「没有插件注册表」仍成立必须保留**。
  §1 逐条否 (a)（改名买不到消除冲突的效果、且推翻定案 1）/(c)（违反
  `docs/adr/README.md:43-44`「只增不改」、切断 0007→0011→0014 等交叉引用）；§2 定名字与符号
  （类 `ToolManager`、工厂 `createToolManager()`、`ToolRegistry` / `createToolRegistry` / `Registry`
  三符号全删且不留别名；推荐类住 `tools/manager.ts`、`registry.ts` 删除，只定「不许第二份存在名单」
  这条边界）、0016 六节与八处标注位置；§3 把**文档收账归 graduate 后专门的 `task`「文档与 ADR
  收账」票**（照 `context-tool-unification` 03 号票范本，在代码票之后、全量验收票之前，
  0016 / 四行指针 / 清单行 / 逐句改写同一笔落地），并逐份点名：`README.md` **核对无命中、不动**、
  `docs/notes.md` 结论清单**不新增条目**（撞上旧形状才就地补注）；grep 清零按
  「当前实况归零 / ADR 历史正文与 `.scratch/` 决策票豁免」解释。本票零代码、零文档改动。

- **07 · `ToolManager` 落地（resolved）**：[07 - Tool 目录无关与 `ToolManager` 落地](issues/07-tool-manager-landing.md) ——
  02–06 的定案一次落成代码：`Tool.execute(toolCallId, params, run, signal?, onUpdate?)`（`run` 第三位必填、
  `ToolRunContext` 迁 `llm/types.ts` 并由 `tools/manager.ts` 转发）、`registry.ts` 删除、
  `ToolManager`（一张 `Map<string, Tool<any>>` + `names` / `get` / `execute` / `register`，零参工厂）、
  六个零参工厂改读 `run`、四函数收 `readonly string[] known`、装配收敛到**同一只**（`openAgent` 转交
  `assemble` 造的那只，hub 冷热两条路共用自己那只）、`Context.tools` 生产端按本轮名单 `map(get)`、
  `run` 由 `runEngine` 收成本轮局部穿到执行点。`check` 绿（137/111）、28 条 smoke **26 绿 / 2 既有红、
  零新红**、`smoke-tools.log` 逐字节相同；断言按 05 §3 改写并补「列表每请求新建、元素恒同一」五条。
  两条接缝留给 08 / 09（执行来源仍是 `prepared.tool`、`activeNames` 未进执行链）；三处与票面的偏差
  （`prepareToolCall` 不接 `run`、请求级身份改在执行点量、`smoke-approval-recovery` 只补 `run` 实参）
  记在票内 §6。

- **08 · 引擎执行全量改道 `ToolManager`（resolved）**：[08 - 引擎执行全量改道 ToolManager](issues/08-execution-reroute-to-manager.md) ——
  03 §3 的六个执行调用点全部改道：`executeToolCalls` / 两条批次路径 / `prepareToolCall` /
  `executePreparedToolCall` / `recoverPendingToolCalls`（导出，第 5 位新增 `manager`）/ 无人调用的
  `runToolCall`，`manager.execute(...)` 成为**生产代码唯一**的 `Tool.execute` 调用点
  （`agent.ts:2490` 调用 + `manager.ts:164` 转发），`PreparedToolCall.tool` 与
  `RunToolCallOptions.tools` 一并退场，`Context.tools` 只剩 `streamAssistantResponse` 一个读点。
  `check` 绿（137/111）、28 条 smoke 实跑 **25 绿 / 3 红**（第三条是 `smoke-desktop-observability`
  串行偶发、复跑 1/1 绿且日志与 after-07 逐字节相同）⇒ 对跑口径 **26 绿 / 2 既有红、零新红**、
  `smoke-tools.log` 逐字节相同。
  **已知中间态**：`get` 装全部六个，禁用工具此刻仍会被找到并执行；票面「验收第 4 条（`smoke-session`
  仍绿）」与之互斥，经用户裁决改为**断言钉住中间态**（`exerciseDeactivatedToolCall` 四条），09 翻回。
  `activeNames` 未进执行链（09 的两处落点已就位，见票内 §6）。

- **09 · 本轮名单进执行链（resolved）**：[09 - 本轮名单进执行链](issues/09-active-names-threading.md) ——
  04 §2.4 落成代码：`activeNames` 是 **`ReadonlySet<string>`**，`runEngine:1005` 与
  `prepareRequest:1275` 各派生一次，随 `AgentRequestUpdate.activeNames` 在请求边界换掉（`:1085`），
  与 Manager、`run` 一样显式穿过恢复机器（`recoverPendingToolCalls` 第 6 位）与两条批次路径。
  两处判活共用 `agent.ts:2021` 的 `activeTool(manager, activeNames, name)`（先 `activeNames.has` 再
  `manager.get`）：`prepareToolCall:2386` 落空仍回 `Tool <name> not found`（**仍只有这一处产出**）、
  `executeToolCalls:2174` 的 `executionMode` 判定同样先判活（禁用的 `bash` 不再把批次翻成 sequential）。
  `check` 绿（137/111）、28 条 smoke **25 绿 / 3 红**
  （第三条本机轮换：本轮 `smoke-mux-live`、上一轮 `smoke-approval`，各自单独复跑 1/1 绿）
  ⇒ 对跑口径 **26 绿 / 2 既有红、零新红**、
  `smoke-tools.log` 逐字节相同。断言：`exerciseDeactivatedToolCall` 按 08 §6 翻回 not-found 四条
  并补「重新启用即照跑」两条（钉住「拒绝来自名单而非 `get` 找不到」），新增
  `exerciseDeactivatedToolBatch` 钉住批次模式，`smoke-approval-recovery` 补三条（名单外的 grant
  不到闸门、不进工具代码）。**代码面到此收口**，只剩 10 的文档收账与 11 的全量验收。

- **10 · 文档与 ADR 收账（resolved）**：[10 - 文档与 ADR 收账](issues/10-docs-and-adr-closeout.md) ——
  `docs/adr/0016-tool-manager-instance-table.md` 落地（背景 / 同名反义 / 七条决定 / 「为什么明知
  0007·0011 仍要反转」/ 后果 / 不可逆性与代价 / 被取代的是什么 / 没有被取代的），四份旧 ADR 各加一行
  头部 `取代者`、正文零改写地就地标八处 `Superseded`（0006×2、0007×3、0011×2、0015×1；`git diff
  --numstat` 四份全 0 删行），`docs/adr/README.md` 清单 +1 行；`AGENTS.md` 改 `service` / `engine` /
  `tool` 三词条（`tool set` / `assembly` / `workDirAbsPath` / `布局` 核对后不动）、
  `docs/architecture.md` 十二处逐句改写（「没有插件注册表」保留）；`README.md` 与 `docs/notes.md`
  核对无命中、不动。`npm run check` 绿（137/111）；grep 清零面十二个词条文档面与源码面全 0
  （豁免：0012/0013 各 1 处、0016 自己 4 行、`.scratch/` 16 文件 69 处）。0016 状态行的验收数字待 11。
  **11 号票按全目录五符号口径重数 `.scratch/` 为 196 处**（同 16 文件，口径差见其 Answer §4）。

- **11 · 全量验收（resolved）**：[11 - 全量验收](issues/11-full-acceptance.md) —— 三套数字一次跑齐：
  `npm run check` 绿（`tokens ok: 137 defined, 111 referenced`）、`npm run build:web` 绿（25 模块，
  `dist/assets/index-DG-PbtuT.js` 116.90 kB）、28 条 smoke 实跑 **25 绿 / 3 红**（`smoke-api` 无服务器、
  `smoke-liveness` 时序、`smoke-approval` 偶发）⇒ 对跑口径 **26 绿 / 2 既有红、零新红**；逐份 diff 的不等项
  全部落在 01 §5 的随机量清单（`smoke-boot` 端口 / 临时 home / 会话 id、`smoke-api-with-server` 三个 UUID、
  `smoke-liveness` 毫秒）、07–09 已记的断言改写（`smoke-session` 31 行、`smoke-approval-recovery` 3 行）与
  两条既有红的同一条断言上。`smoke-api` 起固定 8080 服务器后 `api ok`（44 行，与基线只差 3 个 UUID / 4 行）。
  grep 清零面十二词条全 0（文档面与源码面各 0）；豁免面 `docs/adr` 7 处（0012/0013 各 1、0016 自己 4 行
  5 处）、`.scratch/` 16 文件 215 处（写完其 Answer 之后；之前 196）。0016 状态行按本票数字改写。
  **Destination 逐条达成，本图可关闭。**

## Not yet specified

**本图已走完（2026-11-07，11 号票收账）：02–06 定案、07–09 代码落地、10 文档收账、11 全量验收，
Destination 的六条（代码 / `check` / smoke / 两份文档 / ADR / `ToolRegistry` 清零）逐条成立，没有剩下的雾。**

历史留痕：切票理由（`tsconfig.json` 把 core、server 与 13 条脚本编在一次 `tsc` 里，删掉 `ToolRegistry` 的那
一笔必须同时改完这些编译面）与四块旧雾的归属（03 压缩摘要与传输面、04 会话账本格式、05 `register()` 与旧
五法、06 名字与文档处置）曾以「票号清单 + 为什么不再细分」写在这里，收口时删去（历史在 git），条文本身
始终在各票 §5，本图从不复述。

## Out of scope

- 委派（子代理）、插件、MCP：`AGENTS.md:174-175` 的硬规则，且不得借「工具目录」把它们塞回来。
- `core/src/llm/` 折叠文件的 `@ts-nocheck` 转正：另开 effort（`context-tool-unification` 已列为 out of scope）。
- `packages/server` 的 REST 命令表与 mux 帧形状（ADR-0001）：本图只动 core 的工具域；03 号票已定案
  (a)，**不动 `Context` wire**，这条许可未启用。
- 桌面外壳与 web 窗口的工具清单渲染：只消费快照字符串数组，不认识 `Tool` 对象。
