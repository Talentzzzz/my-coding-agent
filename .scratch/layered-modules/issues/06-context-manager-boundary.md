# ContextManager 的职责边界

Type: grilling
Status: resolved

## Question

ContextManager 拥有什么、Agent 保留什么？

具体待定：

- 填充链各步——`system-prompt.ts`、`agents-md.ts`、`compaction.ts`、`spill.ts`、
  `trim-tool-call-args.ts`、`clear-tool-results.ts`——哪些成为 ContextManager 的方法，哪些仍是
  Agent 私有编排？
- 压缩阶梯（trim_tool_call_arg → clear_tool_result → 模型摘要）的**触发**与入口谁管：阶梯判断
  留在引擎里、步骤委托给 ContextManager，还是整个阶梯归它？
- ContextManager 构造收哪些依赖：SessionManager？settings 现读？ChatTransport？
  按 ADR-0006 的 service 形态（构造只收服务依赖）走多远？
- `context/` 包的 types.ts 放什么（agent 包约定每个子包有 manager + types.ts）？
- ADR-0016（loop 就是编排）的修订措辞：哪些句子要改，「引擎与填充链是 Agent 私有方法」怎么改写？

前置：[domain 内部归属](05-domain-internals.md)（已决：造 ContextManager）。

## Answer

- **总切法：编排留引擎，算法归 ContextManager。** 压缩阶梯的**编排半**留在 `Agent` 私有
  （ADR-0016 判据对引擎原样成立）：`compactFor` 的触发序列（`shouldCompact` 三连）、记账
  （`appendTrimToolCallArgs` / `appendClearToolResults` / `appendCompaction`）、发事件
  （`tool_call_args_trimmed` / `tool_results_cleared` / `compaction` / `compaction_failed`，
  经 ADR-0017 的 fanout 族）、abort 判定与 `summarize` 闭包（catalog 检查 +
  `unconfiguredStream` + `cacheRetention: "none"`）。**算法半**归 ContextManager：触发计算、
  候选选择、token 估算、摘要产出、prompt 装配、结果归档。「整个阶梯归它」被否——那要收
  SessionManager（破 ADR-0012「Manager 唯一消费者是编排层」）加一套事件出口（fanout 之外的
  第二只分发），是第二只小编排层。
- **Agent 保留清单**（编排半的全名目）：`compactFor`（触发序列 + 记账 + 发事件 + abort 判定）、
  `trimRecordedArgs` / `clearStaleToolResults`、`summarize` 闭包、`prepareRequest` 全序、
  `finalizeToolResult`（fanout 族不动）、`maybeCompact` 公开面（smoke 的演练口，原样）、
  `resolvedSettings` / `approvalsOf`、`rewriteContext` 与两个闸门。
- **六文件映射**：
  - `system-prompt.ts` + `agents-md.ts`：context 包实现细节，由
    **`ContextManager.buildRequestPrompt(workDirAbsPath, toolNames, approvalTools)`** 一次组合
    （内部先 `loadAgentsMd` 再 `buildSystemPrompt`）。`AgentConfig.systemPrompt` 注入点删除
    ——工厂无条件接线、无任何消费者覆盖过的死缝；`approvalToolsOf` 的映射仍由 Agent 在调用前做
    （settings 知识归 agent 根）。
  - `compaction.ts`：`compactionThresholdFor` / `shouldCompact` / `estimateTokens` /
    `compact(entries, project, model, summarize, signal)` 成为 ContextManager 方法；
    `prepareCompaction` / `findCutPoint` 包内私有；`Summarize` 回调仍由 Agent 提供
    （`compaction.ts` 本就管道不管，原样继承）。
  - `spill.ts`：`ContextManager.spillOversizedToolResult`（写边界调；`finalizeToolResult` 是
    fanout 族、`spill ?? bound` 的组合留 Agent）+ 包级 `archiveToolResult`（自 hooks.ts 搬入
    ——它是结果视图操作，不是 hook 分发接缝；hooks.ts 保留三接缝 + `boundToolContent`）；
    spill 原语收拢包内。落盘直写 `node:fs` 还是端口化，留给 07 裁决（04 已决：用户工作目录
    不端口化，`.my-agent/tool-results/` 在用户目录之下）。
  - `trim-tool-call-args.ts` / `clear-tool-results.ts`：各拆两半。**决策半**归 context
    （`trimmableToolArgEntryIds`、`clearableToolResultIds` 含缓存闸、`isCacheProbablyExpired`、
    `isClearedToolResult`、`REFETCHABLE_TOOLS`、`CACHE_EXPIRY_MS` / `KEPT_TOOL_RESULTS`）；
    **施加半**搬进 session 包内（`trimToolCallArgs`、`clearToolResult`、`ARG_KEEP_CHARS` /
    `ARG_TRIM_MARKER`）——记录的施加归账本视图（`buildContextEntries`），正是
    architecture.md「前两步是决定…buildContextEntries 施加它们」的口径。
- **构造零依赖**（ADR-0006 service 形态的空集）：无状态、一个实例服务所有会话，编排层构造时
  建（新世界由组合根注入）。方法收显式参数：entries / contextWindow / workDirAbsPath /
  signal / `Summarize` 回调 / `project` 投影函数。不要 ChatTransport（模型由调用方构造好传入）、
  不要 settings（阈值从 `model.contextWindow` 现算）、不要 SessionManager（记账不归它，见上）。
- **投影函数注入，不共享**：阶梯算法里只有压缩需要 entry→messages 投影（切点找 turn 起点、
  摘要组装、tokensBefore），候选选择只摸 `entry.message`。`sessionEntryToContextMessages`
  留在 session 包、`compact` 收它作 `project` 参数、由 Agent 递入（根→session 直取本来就
  合法）。context 包对本仓子包的 import **清零**。
- **子包互不依赖 + 根共享内核**：context / session / llm / tool 四子包**互不 import，哪怕
  单向**；被其他子包消费的定义搬进 agent 包根 `types.ts` **独占**（共享内核，根零入边）。
  - 收编自 llm：消息族（System / User / Assistant / ToolResult + 内容块 + `ToolCall` +
    `Usage` / `StopReason` / `JsonValue` 族）、`Tool` / `ToolResult` / `ToolResultContent`
    推导 / `ToolRunContext` / `ToolExecutionMode` / `ToolUpdateCallback` / `contentText`、
    Model 接口连带它引用的模型事实族（`Api` / `ThinkingLevel` / `ModelCost` 族 /
    `ModelInputLimits` / `CacheRetention`…）；留下的：传输机械（`Context` / `ChatTransport` /
    Stream·Provider·事件流族 / Model 类）。精确名单票 10 机械核对。
  - 收编自 session：SessionEntry 族（六种 kind 的判别联合 + base）。
  - 根自定义（无自然属主的政策词汇）：`ARG_TRIM_TOOLS` / `ARG_TRIM_THRESHOLD_CHARS` /
    `clearedToolResultText` / `describeToolCall`（session→tools 的边随之消失）。
  - 根允许保留对子包的 type-only 边（已知两条良性：`AgentEvent`→`AssistantMessageEvent`、
    `ToolRunContext`→`BashSettings`——今天已存在同形的 root↔tools 循环）。
  - 依赖守卫脚本（05 已决的 check 改造）加这条机械检查：子包只准 import 根 `types.ts`、
    node 内建与外部依赖。
- **`context/types.ts`**：只装包内公开类型——`CompactionPreparation` / `CompactionResult` /
  `SummarizeRequest` / `Summarize`（`SystemPromptInput` / `AgentsMdFile` 随注入点死亡降为
  包内）。`Context` 不动（留 llm）。物理形状照 02 的约定：`manager.ts` 是公开脸，六个实现
  文件保留为里子。
- **修订清单**（要点记于此，落笔归票 10）：
  1. **ADR-0016**：加取代者行——填充链与压缩的算法半出编排、归注入的 ContextManager；判据
     原样成立（引擎与压缩阶梯编排仍是 Agent 私有）；引用其决定 6 的「另一场独立辩论」条款
     ——本图 05/06 两票就是那场辩论，不是顺手搬文件。`agent.ts` 类注释
     （「引擎（run / runEngine）、按请求的填充链、压缩阶梯…是这个类自己的私有方法」）与
     AGENTS.md 的 engine 术语句同步改写。
  2. **ADR-0006 决定 6**：systemPrompt 构建函数退出注入面（被 ContextManager 吸收）；
     hooks / transport 两件不动。
  3. **ADR-0010**：「Context 与 Tool 住 llm/types.ts」修订——`Context` 留 llm，Tool 与消息
     词汇搬根共享内核。
  4. **分层 ADR（票 10 新增）**加一节：四子包互不依赖 + 共享内核 + 守卫规则。
  5. **AGENTS.md**：布局行（core→domain 的 context 包描述）、engine / compaction 术语句、
     新增 ContextManager 术语条目（算法半的持有者、构造零依赖、一个实例服务所有会话）。
  6. **architecture.md**：各 package 职责、循环 §107–114（「prompt builder 都在编排层身上」
     句）、压缩 §250–266 的文件引用、Hook §149 `archiveToolResult` 住址；根 `types.ts` 头
     注释更新（不再「只递类型」——它现在定义共享词汇与政策常量）。
