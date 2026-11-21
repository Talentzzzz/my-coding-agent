# 0031：context 并入 session、prompt 拆为独立叶子包——ContextManager 类解散

日期：2026-11-21 · 状态：已接受，**已落地**（`npm run check` 四棒绿——含六模块 R1 与三子包 R2 的
新守卫面；smoke-tools / smoke-sessions / smoke-boot 全绿；零行为变化，唯一消失的间接层是压缩的
`project` 投影注入参数）
取代：[0006](0006-services-drop-instance-state.md)（部分，2026-11-21——修订节「ContextManager 是
无属性服务的新例」整条退场，见该 ADR 的取代者注记）、
[0016](0016-loop-is-orchestration.md)（部分，2026-11-21——取代者注记里「算法半归注入的
`ContextManager`」的属主半；**编排半归 `Agent` 私有方法**的判据原样成立且更简单——引擎与压缩
阶梯直调 session 包的模块级函数）、
[0030](0030-five-module-layering.md)（部分，2026-11-21——决定 5 的「domain 四子包互不依赖」改为
三子包 + 一片叶子库；R2 随之收窄，R1 多出两条边，见该 ADR 的取代者注记）、
分层重构 spec §3（`.scratch/layered-modules/spec.md`）的「决策半归 context、施加半搬 session 包」
两半拆分与「agents-md 不搬出 context」——决策半与施加半今天同住 session 包，AGENTS.md 收集随
端口化迁 infra（历史 spec 是记录，不再改写）

## 背景

分层重构把压缩与填充的算法半放进了一个专门的 `context/` 子包，配一只注入的 `ContextManager`
（ADR-0006 修订、ADR-0016 的判据）。三个力量让这个形状开始硌手：

1. **决策半与施加半分居两包**。哪些条目该压（候选选择）住 `context/`，压完长什么样
   （`trimToolCallArgs` / `clearToolResult`）住 `session/view.ts`，两者共享的政策常量挤在根
   `types.ts`。拆开的唯一理由是 R2 的跨包禁 import——两个半从来不互相调用，中间隔着账本里的压缩
   记录说话；为一条记录格式养出两个包、一个注入缝（`project` 参数）与一个桶文件包装函数，税太重。
2. **包名与内容错位**。`context/` 里住着 system prompt 拼装、AGENTS.md 收集、超大结果归档——
   它的主语是「一次请求装什么」，压缩只是守门员；而 AGENTS.md 收集与压缩算法毫无关系，纯粹是
   当年没处放。R3 还要为它的 `node:fs` 单独开一条路径豁免。
3. **类壳只剩转发**。`ContextManager` 的五个方法全是模块级函数的薄转发，唯一自己组合的
   `buildRequestPrompt` 也是两行。ADR-0006 的类壳纪律值得保，但保的是一个有内容的壳。

## 决定

1. **`context/` 子包解散，六个实现文件并入 `session/`**：`compaction.ts`、
   `trim-tool-call-args.ts`、`clear-tool-results.ts`、`spill.ts`、`tool-results-repository.ts`、
   `types.ts`（压缩算法的四件公开类型）。决策半与施加半同住一个包——它们本就经账本里的记录
   说话，如今连住址也在一起。`project` 投影参数随之删除：`compaction.ts` 直接 import 同包的
   `sessionEntryToContextMessages`，桶文件上的 `prepareCompaction` 包装函数退成直出（单参形状
   不变，smoke 不受影响）。
2. **`ContextManager` 类解散**：`manager.ts` 删除，编排层直调模块级函数
   （`compact` / `compactionThresholdFor` / `shouldCompact` / `estimateTokens` /
   `spillOversizedToolResult`）。工厂不再构造它，`AgentConfig` 不再收它。
3. **system prompt 拼装与项目指示收集拆为独立叶子包 `@my-agent/prompt`**：`system-prompt.ts` +
   `agents-md.ts` 的纯文本半（`AgentsMdFile` 类型、`formatAgentsMd`、`buildSystemPrompt`）+
   一个公开门面 `buildRequestPrompt(instructions, workDirAbsPath, toolNames, approvalTools)`——
   收集与拼装两步在包内一次组合，调用方一行拿到完整 system prompt。包对本仓**零依赖**
   （只认 node 内建），是 domain 与 infra 之下的一片叶子。
4. **AGENTS.md 收集端口化**：`@my-agent/prompt` 自带端口声明 `agents-md-repository.ts`
   （`AgentsMdRepository.collect(workDirAbsPath)`，session-repository.ts 的同形先例——端口住
   消费方包内），infra 的 `AgentsMdStore` 实现（原 `loadAgentsMd` 的触盘半：向上遍历、读文件、
   单文件大小上限），组合根构造注入，经 hub → 工厂 → `AgentConfig.agentsMdRepository` 一路
   递到调用点。**端口全必填**，与五个存储端口同列。这同时推翻 ADR-0030 §4.5 不端口化清单里的
   「AGENTS.md/CLAUDE.md 收集」条款——fs 从此只住 infra，R3 的路径豁免删除。
5. **分层守卫改写**：R1 升为六模块——`domain → { prompt }`、`infra → { domain, prompt }`、
   `prompt → 零本仓依赖`；R2 子包清单 `["context","llm","session","tool"]` →
   `["llm","session","tool"]`；R3 删 agents-md 豁免。prompt 不是第六个**层**——它没有实现
   domain 的端口，也不被 case/trigger 认识（case 经 domain 桶的转出口拿
   `AgentsMdRepository` 类型），它是 domain 之下的一片叶子库。

## 被取代的是什么

- **0006 修订节的「ContextManager 是无属性服务的新例」**：整条退场。无属性服务的形态判据
  （构造零依赖、方法收显式参数）由四个 Manager 与 session 包的模块级函数继续示范；类壳保留
  的纪律不再为一个只剩转发的壳服役。
- **0016 取代者注记的属主半**：「填充链与压缩的算法半归注入的 `ContextManager`」——算法半
  现在是 session 包的模块级函数，没有持有者。**编排半判据原样成立**：触发序列
  （`compactFor`）、记账（`appendTrimToolCallArgs` / `appendClearToolResults` / `appendCompaction`）
  与发事件仍是 `Agent` 的私有方法，且「编排与算法」的边界不再需要一条注入缝来说明。
- **0030 决定 5 的「四子包」**：domain 的子包从四个减为三个（llm / session / tool）；R1 的
  「domain → 零本仓依赖」精确为「domain → 只认 prompt 这一片叶子」。端口面加一份声明：
  `AgentsMdRepository` 住 `@my-agent/prompt`（消费方包内原则不变），infra 实现、组合根注入。
- **分层重构 spec §3 的两半拆分**：决策半归 context、施加半搬 session、agents-md 不搬出
  context——三条全部反转。spec 是历史记录，不改写；本文是现状的唯一事实。

## 没有被取代的

- **ADR-0016 的编排判据**：引擎与压缩阶梯的编排半（全序、记账、发事件）仍是 `Agent` 的私有
  方法；「loop 就是编排」一字不动。
- **ADR-0013 的袋语义、账本六种 entry、压缩的三级阶梯语义**：触发阈值（窗口 − 33k）、最便宜
  先行、记录式压缩（`appendXxx` 写记录、`buildContextEntries` 施加）——行为零变化。
- **ADR-0030 的端口纪律**：端口住消费方包内、infra 实现、组合根注入、端口全必填——新端口
  `AgentsMdRepository` 是同一条纪律的第六份实例，不是新形状。
- **`ToolResultsRepository` 的住址**：随文件搬进 `session/tool-results-repository.ts`，声明者
  （消费方）不变，infra 实现与桶出口不变。
- **ADR-0006 的其余部分**：四个 Manager 的无属性服务形态、两个常驻表例外——全部不动。

## 后果

- domain 多了一条本仓依赖边（`domain → prompt`），换来的是：压缩的两个半同居一包、R2 少一个
  子包、R3 少一条路径豁免、`project` 注入缝与桶包装函数消失、`ContextManager` 的五个转发方法
  消失。**domain 造不出 infra**的纪律没有松动——prompt 包同样造不出，它的端口全必填。
- 构造编排层的调用方（hub、`openAgent`、全部 smoke）多递一个 `agentsMdRepository`。这是
  端口全必填的直接代价，与 `toolResultsRepository` 当年的落地同形。
- system prompt 的拼装知识（身份段、AGENTS.md 预算）从此住在一个对本仓零依赖的包里——它是
  全仓最容易被复用、也最不需要耦合进 agent core 的一块。

## 不可逆性与代价

回退意味着重建 `context/` 子包、恢复 R2 四子包与 R3 豁免、重新引入 `project` 注入缝与
`ContextManager` 类——机械但面广；这不是本 ADR 想保留的退路。真正的代价是每次给编排层加端口
的三处同步（工厂、hub、组合根）；换来的是构造时的必填清单就是这台机器全部触盘点的机器可查清单。
