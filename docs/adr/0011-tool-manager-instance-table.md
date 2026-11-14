# 0011：工具回到一张常驻实例表——`ToolManager` 持有全部 `Tool`，引擎经它执行

日期：2026-11-06 · 状态：已接受，**已落地**（07–09 号票；2026-11-07 全量验收，见
[11 号票](../../.scratch/tool-manager-refactor/issues/11-full-acceptance.md)：`npm run check` 与 `build:web` 绿
（`tokens ok: 137 defined, 111 referenced`），28 条 smoke 与改动前逐条同色、零新红——`smoke-approval` 两边都
以首轮偶发红、复跑绿收场，`smoke-api` 要一只在跑的服务器（起了就 `api ok`），`smoke-liveness` 的时序断言在
本机改动前后同为红；五个旧符号与旧说法在 `packages/`、`scripts/`、`AGENTS.md`、`architecture.md`、
`README.md` 里归零）
取代：[0005](0005-stateless-session-architecture.md)（部分——决定 1 里 `ToolManager` 那一项，以及决定 3
的 B 路线里「工具不驻留内存」那一半）、[0006](0006-services-drop-instance-state.md)（部分——决定 1、
决定 2 的「无状态服务」半、决定 6 的「不可变」前提，三处都只在工具域不再成立）、
[0013](0013-table-holds-live-half-only.md)（部分——「会话状态表不注入、私有」判据的**通用性**：判据对
会话表仍然成立，但它不再是一条通用判据——工具表正是注入的，见下文）、[0010](0010-llm-folded-into-core.md)（部分——*后果* 里「`prepareRequest` 建它
（`tools` 就是活跃的可执行集合）、引擎用它」这句现状陈述）
取代者：[0012](0012-agent-facade.md)（部分，2026-11-07——决定 7 的「hub 冷热两条路共用
**自己那只**」那一半：表仍全进程只装配一只、单写者与只增键不动，但它由
`createSessionAgent()` 造、住编排层手里，hub 不再持表；决定 1–6 与表的形态一字不动）

设计过程见 `.scratch/tool-manager-refactor/`（形状在 2026-11-06 的绘图会话里定案，02–06 号票是裁决、
07–11 号票是执行，逐条不得推翻）。

## 背景

本 ADR 之前的形状是这样：工具是**目录无关**的反面——每个 `Tool` 由工厂闭包着一个工作目录造出来，
`(run) => createReadTool(run.workDirAbsPath)`；`tools/registry.ts` 的 `ToolRegistry` 是一份**定义**的目录
（`toolDefinitions()` 里六个工厂加 `register` 进来的工具），`active(state, run)` 在每个请求里用随请求来的
`ToolRunContext` 现建一份可执行集合，`build(name, run)` 现取一个实例。这份形状是 [ADR-0005](0005-stateless-session-architecture.md)
的 B 路线与 [ADR-0006](0006-services-drop-instance-state.md) 的直接后果：

- **不驻留内存**（0005 决定 3）。工具与账本、设置、模型一起被列进「每请求从磁盘与配置重放」那一族，
  派生物「现建现传，**不进任何袋**」。
- **无属性服务**（0006 决定 1/2）。五个单例的公开方法收 `(id, 请求自己的参数)`，每样数据在用到它的那一行
  向属主现取；没有实例字段可藏状态。
- **进程级配置不可变**（0006 决定 6）。留在构造函数上的东西是「进程生命周期内不可变的配置」，所以一个
  构造注入的目录不会在运行中变形。
- **不注入一张表**（会话表的判据；现由 [0013](0013-table-holds-live-half-only.md) 持有，本文反转的只是
  它的通用性）。「注入一张表等于给表的写者与删者各留第二个」，所以活登记处只由属主
  自己持有，`AgentConfig` 上不带 `Map`。

这套形状买到的正是它明说的东西：没有任何一处需要回答「表什么时候失效」。代价是 `Tool` 与目录绑在一起，
于是一个进程里每个会话都得自己造六个实例，`Context.tools` 只能是一份**现建**的可执行集合——引擎想执行
一个工具，只能拿手上那份集合里的对象，不能问「这个名字的实现在哪」。

2026-11-06 的绘图会话把终点定成相反的形状（`.scratch/tool-manager-refactor/map.md` 的 Notes §1–§3）：
**一张常驻的 `Map<name, Tool>` 持有全部实例**（填充尽量懒），不同会话用不同工具，但一律经 `ToolManager`
取表里的 `Tool` 调用——**连引擎的执行路径也改道它**，不只是目录查询。

### 同名反义：`ToolManager` 这个词指谁

`ToolManager` 在本仓库的历史文字里已经有过一个**相反**的含义：[0005](0005-stateless-session-architecture.md)
决定 1 与 [0006](0006-services-drop-instance-state.md) 决定 1 都把它列进「五个无状态单例」，
`.scratch/stateless-agent/issues/11` 的 Answer 则把 `tools/manager.ts` 称作「ToolManager 的无状态面」。
本 ADR 之后，它指**持一张常驻实例表的工具服务**。反转之前源码里并没有这个符号（`tools/registry.ts`
住的是 `ToolRegistry`），所以这次是**复用一个只在历史文字里活着的名字**，不是两个现存符号撞车——但读者
一旦在两份 ADR 里读到同一个词、两个含义，就必须知道哪一个说的是今天：凡在 ADR 历史正文、`.scratch/`
决策票、以及本 ADR 引用旧决定时出现的旧含义，都按**历史叙述**读，它们不描述当前代码。

## 决定

1. **一张实例表，`ToolManager`**。`packages/core/src/tools/manager.ts` 的 `ToolManager` 持一张
   `Map<string, Tool>` 装**全部**实例，零参工厂 `createToolManager()` 造它；`tools/registry.ts` 删除，
   `ToolRegistry` / `createToolRegistry` / 私有 `Registry` 三个符号全删、**不留别名**。
2. **`Tool` 目录无关**。六个内置都由零参工厂造出（`() => createReadTool()`），`execute` 的第三个实参是
   本轮的 `ToolRunContext`（`workDirAbsPath` + bash 超时）——每请求的值走实参，不走闭包，所以**一个实例
   服务所有会话**。`ToolRunContext` 的权威定义搬进 `llm/types.ts`（紧挨着 `Tool`），由 `tools/manager.ts`
   转发出口，既有 import 路径不变。
3. **公开面四法**：`names` / `get` / `execute` / `register`。`execute(name, toolCallId, params, run,
   signal?, onUpdate?)` 内部 `get` 后转发，**不判活、不校验**——一个走到这里的未知名字是上游的 bug，它抛
   错，而不是合成第二条模型看得见的结果。`register()` 是**测试接缝**：只加新名字，同名（含内置）抛错，
   Map 对象与已有条目永不替换——「表不可变」在这里的意思是**值不可变、键集可单调增长**。填充是懒的：
   首次访问一次填满六个（一次填满而不是按名字造，否则表旁边就得有第二份名字清单）。
4. **引擎全量改道**。`manager.execute(...)` 是**生产代码唯一**调 `Tool.execute` 的地方；引擎不再夹带实例
   （`PreparedToolCall.tool` 之类全部退场），执行、恢复机器、两条批次路径都收同一个 Manager。判活仍归
   引擎：一次请求派生一个 `ReadonlySet<string>` 的**活跃名单**，由 `activeTool(manager, activeNames, name)`
   先问名单、再问表，`Tool <name> not found` 仍只由引擎在 `prepareToolCall` 一处产出。
5. **`Context.tools` 仍是必填的声明载体**。它的元素是**表里的实例引用**，按本轮名单取子集，数组每请求
   新建；`toToolDeclaration` 削薄、`streamAssistantResponse` 发送、压缩摘要那次 `tools: []` 都不改道
   ——传输层读的仍是声明，引擎执行的仍是实例，只是两者现在指向同一张表。
6. **活跃名单与审批仍是账本派生的纯数据**。`toolStateOf` / `approvalToolsOf` 等四函数留
   `session/tool-config.ts`，收一个 `known`（表的名字），`.json` / `.jsonl` / `tool_config` 的格式一字
   不动。名单随请求边界换手、显式穿过恢复机器与两条批次路径，**不进表**。
7. **装配照旧是构造注入**。`AgentConfig.tools: ToolManager`、`SessionServices.tools` 换类型，`Agent` 上
   仍是一个 `private readonly tools`；进程里只装配一只（hub 冷热两条路共用自己那只，`openAgent` 转交
   `assemble` 造的那只）。

   **（2026-11-07 Superseded，[0012](0012-agent-facade.md)：仅「hub 自己那只」那一半——表由
   `createSessionAgent()` 造、住编排层手里，hub 的冷热两条路经编排层到达同一只表，hub 不再持任何表；
   「进程里只装配一只」与表的形态不变。）**

## 为什么明知 0006 / 会话表一线仍要反转

这一节是这份 ADR 存在的理由，也是它唯一回答不了别处的问题。

1. **终点是用户定案，不是架构推理的结果。** `.scratch/tool-manager-refactor/map.md` 的 Notes §1–§3 拍板
   「一张常驻 `Map<name, Tool>` 持有全部实例 + 引擎全量改道 Manager」，并写明「本图不再重开，票只许细化
   与执行，不许推翻」。这是反转的**唯一**动因。它不说明 [0006](0006-services-drop-instance-state.md)
   当初错了：那次要拆的是聚合袋——「谁都可以往里塞，没有人对它的失效负责」——而这次请回来的正是同一类
   东西，所以代价必须照实背，不能包装成一次纠错。
2. **代价照实背：对象生命周期与失效归属。** 0006 拆聚合袋、随后会话一线收「唯一的门」并删两个键控缓存
   （现状见 [0013](0013-table-holds-live-half-only.md)），都是为
   了让「表什么时候失效」这个问题不存在。本 ADR 在工具域把它请回来，就必须自己回答四个问题：
   - **谁建表。** `ToolManager` 自己建：首次访问时一次填满六个零参工厂（`ensureFilled`），构造函数不建，
     所以「装配了一个会话却从没跑过工具」不付这六个实例的钱。
   - **谁写。** 只有 Manager 自己写。`register()` 是唯一入口，只加新名字，同名（含内置）抛错；没有
     `unregister`、没有 replace、没有第二张表。
   - **什么时候失效。** 永不。条目不可换、名字只增、`names()` 读的就是 Map 自己的键——没有副本，也就没有
     需要失效的东西。这条不变式是这次反转的全部安全来源：一旦有人开始覆盖条目或删键，0006 防的那
     件事立刻回来。
   - **一次在飞的运行看哪一份。** 它在 `prepareRequest` 那一刻取到的实例引用。新注册的名字只对**下一次**
     读取可见；已经在飞的那次运行用完它拿到的那份，不会中途换人。
3. **六条边界把代价圈在工具域。** 表里只装进程级行为，不装 per-session 状态，不按 id 键控，没有冷/热两
   份、没有驱逐判据；活跃与审批仍从账本派生；每请求的值仍随 `execute` 实参走；单写者且只增键；`Context.tools`
   仍是必填声明载体；会话表与 `adopt` / `evict` / `drop` 一字不动。逐条写在*没有被取代的*。
4. **明确不是什么。** 不是插件注册表（`AGENTS.md` 的硬规则不动，这份表也不做扩展点）；不是按会话键控的
   缓存（表不认 id，也没有 id 可以键控）；不是第二份会话状态；不是把 `Tool` 拆回两个类型
   （[ADR-0010](0010-llm-folded-into-core.md) 决定 2 仍成立）；`register()` 仍是测试接缝，不是生产入口。
5. **理由只写在这里。** `AGENTS.md` 的 `tool` / `service` 词条、`docs/architecture.md` 的工具契约节、
   `docs/notes.md` 都只链到本 ADR，不复述上面任何一条（`docs/adr/README.md`：ADR 是理由唯一的家）。

## 后果

换来的：

- **`Tool` 与工作目录解耦。** 「一个工具闭包着一个目录」不再成立，所以一个进程可以被一张表服务：实例数
  是六个（加注册进来的），不随会话数增长。
- **每次请求只剩「选择」要算。** `activeNames` 从账本派生一次，`Context.tools` 是它在表上的投影；两次
  请求之间唯一会变的是名单，表本身不动。
- **执行只有一扇门。** 引擎不再需要把一个实例从准备阶段夹带到执行阶段：它持有名字、本轮名单与 Manager，
  执行时现取。恢复机器与两条批次路径收的是同一组实参，没有第三条取实例的路。
- **「存在什么」只有一个答案。** `manager.names()` 就是键集本身，不是并排维护的第二份清单；`known` 在
  四个派发函数里是同一次读取。

背上的：

- **对象生命周期重新存在。** 六个实例活到进程结束——这是白拿的常量成本，代价是「什么时候失效」这个问题
  从一个不存在的概念变回一条必须由不变式守住的话（见上，永不，靠只增键）。
- **一个工具上的可变状态从此是进程级 bug。** 同一只 Manager 跨请求、跨会话共享同一批实例；从前
  「每个会话一份」会把这类 bug 关在一个会话里，现在它会漏到所有会话。六个内置都是无状态的纯函数式实现，
  这正是它们能被共享的前提。
- **测试之间共享内置实例。** 每个 smoke 自建一只 Manager 没关系，但同一只 Manager 上注册的测试工具会
  被同一次运行的所有请求看见——断言「每次新对象」这类写法反了过来：现在恒等的是**元素**（表的实例），
  每请求新建的是**数组**。
- **`Tool.execute` 多了一个必填实参。** 六个工厂、三处直调、恢复机器与两条批次路径的签名都跟着改了；
  `ToolRunContext` 从 `tools/manager.ts` 搬到 `llm/types.ts`，出口靠一次 re-export 保持稳定。

## 不可逆性与代价

三条门槛逐条成立：

- **难逆转。** 回去要重开 `tools/registry.ts`、把六个工厂改回闭包目录、把 `Tool.execute` 的 `run` 拿掉、
  把 `Context.tools` 从「声明载体」改回「每请求现建的可执行集合」、把引擎的八个执行读点从 Manager 改回
  手上的实例，再改回 smoke 的断言。不止一处，而且是同一个形状的第二次反转。
- **没有上下文会让人困惑。** 0005 写「工具不驻留内存」，0006 写「Manager 没有实例字段」，会话一线写「不注入
  一张表」（判据现由 [0013](0013-table-holds-live-half-only.md) 持有）——而代码里有一张常驻的表和一个构造注入的工具服务。第一反应必然是
  「这不是退回去了吗」。这份 ADR 就是那个「没有，退回去的只有一条，其余全部还在」。
- **是真实取舍。** 放弃的是「工具对象每请求现建、不进任何袋」，以及「构造注入的东西不可变」这条前提在
  工具域的适用性；换来的是「一个工具不认目录，于是一个进程可以只有一张表」——而工具的实例与目录绑定，
  正是那个每个会话现建六个实例的根源。这笔交换的定价权在终点那边（见上），这里只把账记清楚。

## 被取代的是什么

逐条对照到决定号与句子：

- **[0005](0005-stateless-session-architecture.md) 决定 1 的工具那一项。** 那条把 `ToolManager` 列进「五个
  无状态单例」。今天它是工具域里**唯一持有实例**的服务，`Agent` 编排、`SessionManager`、`SettingManager`
  三个仍在 0005/0006 的形状里。
- **0005 决定 3 的 B 路线，工具那一半。** 原文「账本、设置、模型、**工具**不驻留内存；每请求的派生物
  （运行上下文）现建现传，**不进任何袋**」里，工具不再不驻留内存；「每请求的派生物现建现传」对
  `ToolRunContext` 仍成立。**账本那一域整段不动**：单写者、fill-at-open、冷读与重开同一条 `fillSession`、
  「打开会话 = 恢复会话」全部原样。
- **[0006](0006-services-drop-instance-state.md) 决定 1 的工具域。** 「五个单例公开方法收 `(id, 请求自己的
  参数)`、每样数据在用到它的那一行向属主现取、不养聚合袋」——`ToolManager` 现在持一个字段（那张表），
  其余四条不变。**聚合袋那一半仍然成立**：没有跨服务共享的袋子，表只归它自己。
- **0006 决定 2 的「Manager 是无状态服务」那半。** 「类壳保留、构造注入、可测性靠传内存袋单测」原样成立；
  不成立的是「无状态」这个词本身——工具服务的状态就是那张表。
- **0006 决定 6 的「不可变」前提。** 原文把 hooks、transport、systemPrompt 划为「进程生命周期内不可变的
  配置，留在构造函数上」，工具表是第四样构造注入的东西，但它**可单调增长**（`register()` 只增键），所以
  「不可变」这条前提在工具域不再成立。前三件本身一字不动。
- **「不注入一张表」的判据（现由 [0013](0013-table-holds-live-half-only.md) 为会话表持有）。**
  「**不**换成注入的表——注入一张表等于给表的写者与删者各留第二个」：这条判据对**会话状态表**仍然
  成立（会话表仍未注入、仍私有），但它不再是一条通用判据——工具表正是注入的，而它只有一个写者。`adopt`
  先到先得、表私有、`evict` / `drop` / `close` 的公开面一字不动。
- **「注入一张表」作为被放弃的选项那一条。** 它对会话状态表的判断
  仍有效；被取代的是它作为理由的**适用范围**——在工具域，`AgentConfig.tools` 就是一张注入的表，代价用
  「单写者 + 只增键」而不是「根本不给这张表存在的机会」来付。
- **[0010](0010-llm-folded-into-core.md) *后果* 里的一句现状陈述。** 「`prepareRequest` 建它（`tools` 就是
  **活跃的可执行集合**）、引擎用它」——今天 `prepareRequest` 建的仍是那一个 `Context`，但它的 `tools` 是
  **声明载体**（元素取自表、按本轮名单取子集），引擎执行时经 `ToolManager`，不读这个数组。

## 没有被取代的

先把一处并置风险说清：[0013](0013-table-holds-live-half-only.md) 为会话状态表保留「不注入、
私有」的判据与 0006 其余决定；本 ADR 在**工具域**反转的只是这条判据的通用性，两处不矛盾——会话表仍未注入
（0013），工具表是注入的（本文，代价用单写者 + 只增键付）。

明确不动、读者不该跟着本 ADR 一起重开的：

- **表里只装进程级行为。** 六个目录无关的 `Tool` 实例，加 `register()` 进来的测试工具：不装 per-session
  状态、不按 id 键控、没有冷/热两份、没有驱逐判据。它不是 0005 A 路线（每会话一个实例）的回归。
- **活跃名单与审批仍是账本派生的纯数据。** `toolStateOf` / `approvalToolsOf` 四函数留
  `session/tool-config.ts`，`.json` / `.jsonl` / `tool_config` 的格式一字不动（[ADR-0004](0004-modes-are-a-tool-config-choice.md)
  的模式仍是同一份数据）。
- **每请求的值仍随 `execute` 实参走。** `workDirAbsPath` 与 bash 超时是 `ToolRunContext`，由本轮栈上的
  局部携带——B 路线「现建现传、不进任何袋」对**每请求值**仍成立；被反转的只是「`Tool` 对象不驻留内存」。
- **单写者且只增键，在飞引用不变。** 只有 Manager 写表；`register()` 只加新名字、同名（含内置）抛错、
  条目与 Map 对象不可换；一次在飞的运行握着它在 `prepareRequest` 取到的实例引用，新名字只对下一次读取
  可见。这正是「不注入一张表」要防的第二个写者/删者，工具表以单写者 + 只增键不重演它。
- **`Context.tools` 仍是必填的声明载体，0010 决定 2·3·7 全部成立。** 元素是表里的实例引用、按活跃名单
  取子集，数组每请求新建；`toToolDeclaration` / `streamAssistantResponse` / 压缩摘要 `tools: []` 不归本
  ADR 管。单一 `Tool`、`tools` 必填、传输层看得见 `execute` 但不调用，三条都要原样保留。
- **会话表与 `adopt` / `evict` / `drop` 不动。** `Map<id, AgentState>`、七条驱逐判据、冷读 `open(id)`、
  `SettingManager` 门面、hooks / approval / queue / claim / 按会话的 `workDirAbsPath` 全部原样；`Agent`
  仍是无属性编排层（除既有的 `tools` 字段）。[ADR-0001](0001-transport-websocket-mux.md) 的 wire 与
  [ADR-0008](0008-session-two-file-format.md) 的两文件格式也一字未动。
