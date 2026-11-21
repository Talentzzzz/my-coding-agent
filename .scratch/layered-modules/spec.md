# spec：五模块分层重构（app / trigger / case / domain / infra）

来源：[map.md](map.md) 与 01–09 号票（全部 resolved）；本文是 10 号票的交付物，把全部决策汇成
执行者不再需要做任何决定的完整记录。

性质约束（贯穿全程，01）：**纯结构搬迁、零行为变化**——REST 面、mux 帧、会话文件格式、
生产 home 布局、smoke 输出全部不变；验收 = `npm run check` + smoke 全绿。唯一的显式边界
（08 按冲突规则摆明）：**测试缝的形状**按 07 的「`setSessionsDir` 消亡」裁决变化，会话 store
派生规则（§5.2）是其替代；生产面零变化。

冲突规则（map Notes）：本文与某条 ADR 或 `docs/architecture.md` 矛盾之处，一律显式引用编号
写进 §8 的修订清单，不静默覆盖。已知待修订：ADR-0006、0010、0012、0016、0023、0028。
术语全部沿用 `AGENTS.md ## 术语`，**搬迁不改名**；本文新造的名字只出现在机械定案处（守卫
脚本名、`StartOptions`、五个端口接口名），各自给了理由。

---

## 1. 目标结构

### 1.1 五模块一句话职责（03/05 定案）

| 模块 | 一句话职责 |
| --- | --- |
| **domain** | 无头 agent 本体：编排层 `Agent`（引擎、会话表、命令、审批、投影）、四子包（context / llm / session / tool）、managers——对存储只认自己声明的端口。 |
| **case** | 会话应用层：`SessionHub` 原样搬迁（订阅表、baseline 交付、行折算、birth / fork / rename / remove、close），是 trigger 与 web 共用的类型网关（协议信封）。 |
| **trigger** | 传输面：REST 路由与控制器、mux / wire / frames、静态文件——domain 盲（域词汇一律经 case 到手），对 infra 至多纯 fs 读。 |
| **infra** | 存储实现：实现 domain 声明的全部端口（会话文件对、home JSON 文件族、tool-results 归档），hold 闸住在这里。 |
| **app** | 组合根：把 home 路径翻译成 infra 实现、注入给 domain、构造 case 与 trigger、`start(options)` 启动与 `close` 编排。 |

desktop（Electron 外壳）与 web（浏览器客户端）保持独立包不变；desktop 只把服务器来源换到
`@my-agent/app`，web 不动（map Out of scope）。

### 1.2 目录树（02 定案 + 文件级清单）

```
packages/
  app/                     # 组合根
    package.json           #   @my-agent/app
    scripts/serve.ts       #   浏览器 dev 薄脚本（仓库工具，不是产品 CLI）
    src/
      index.ts             #   导出 start / StartOptions / BootedServer / AGENT_HOME
      start.ts             #   boot.ts 的主半改造：构造 infra → 注入 domain → 组装 case/trigger
      agent-home.ts        #   AGENT_HOME 解析（MY_AGENT_HOME ?? ~/.my-agent）自 domain 迁入
  trigger/
    package.json           #   @my-agent/trigger
    src/
      index.ts
      http.ts              # ← server/src/http.ts
      frames.ts  mux.ts  wire.ts
      controllers/         #   routes.ts  sessions.ts（SessionListener 类型住 controllers 旁，08）
      http/                #   errors.ts  routing.ts  static.ts  websocket.ts
  case/
    package.json           #   @my-agent/case
    src/
      index.ts             #   导出 SessionHub
      hub.ts               # ← server/src/hub.ts 原样（换类型面见 §5.3）
      protocol.ts          #   协议信封 + 客户端/触发面共用的域词汇网关（§2.4）
  domain/
    package.json           #   @my-agent/domain
    src/
      index.ts             #   公开出口（照 core 的 index.ts 平移，见 §7 步 2）
      agent/
        agent.ts           # ← core/src/agent.ts（编排层整体，ADR-0016/0017 形态不动）
        types.ts           #   共享内核（§2.3）
        paths.ts           #   resolvePath / normalizePath 自 session/paths.ts 迁入根（§2.5）
        context/           #   manager.ts + system-prompt.ts + agents-md.ts + compaction.ts
                           #   + spill.ts + trim-tool-call-args.ts + clear-tool-results.ts
                           #   + tool-results-repository.ts（端口声明，07）
        llm/               #   api/ model.ts types.ts utils/ index.ts
                           #   + model-repository.ts（端口声明，07）
                           #   + model-manager.ts（自 core 根迁入，05）
        session/           #   session-manager.ts ledger.ts snapshot.ts events.ts agent-state.ts
                           #   dangling.ts messages.ts queues.ts unknown-session.ts
                           #   + session-repository.ts（端口声明，07）
                           #   + session-defaults-repository.ts（端口声明，07）
                           #   + session-factory.ts（自 core 根迁入：createSessionAgent / openAgent）
        tool/              #   manager.ts bash.ts diff.ts edit.ts glob.ts grep.ts read.ts write.ts
                           #   truncate.ts types.ts index.ts workdir.ts shell.ts（自 core 根迁入，05）
                           #   + tool-defaults-repository.ts（端口声明，07）
        settings.ts        #   resolveSettings 组合（自 core 根迁入 agent 根，05）
        hooks.ts           #   三接缝 + boundToolContent（archiveToolResult 迁往 context，06）
  infra/
    package.json           #   @my-agent/infra
    src/
      index.ts             #   组合根的导出面
      session-store.ts     #   会话文件对全家（11 方法 + hold 闸 + removeGate 测试缝
                           #   + migrateLegacyStore 随迁 + 文件对路径规则，07/09）
      home-json.ts         #   home JSON 文件族原语（一个实现满足三个同形声明，07）
      tool-results.ts      #   归档只写实现（07）
  web/                     # 不动（除 import 重指，§7 步 2）
  desktop/                 # 依赖声明换 @my-agent/app，main.cjs import 换包名（§5.4）
```

要点（02）：**domain 套一层** `src/agent/`——按「domain 模块下有一个 agent 包」的字面形状，
给未来第二个包留位；五包仍是 npm workspace，`install-deps`、`npm run check`、tsconfig 机制
全部不动；**app 无 CLI**，入口是程序化 `start(options)`，浏览器 dev 靠薄脚本。

### 1.3 模块依赖图（05 定案，静态守卫规则同源）

```
                ┌──────────────────────────────┐
                │ app（组合根，→ 全部）          │
                └──┬────────┬─────────┬───────┬─┘
                   ▼        ▼         ▼       ▼
              trigger    case     infra   domain
                │  ╲      │  ╲       │       ▲
                │   ╲─────┘   ╲──────┘       │
                ▼                            │
              case ──────────────────────────┘
              infra ──────────────────────────┘
              domain → 零本仓依赖（只认 node 内建、外部依赖与自己的端口声明）
```

- 允许的边：`app → {domain, infra, case, trigger}`；`trigger → {case, infra(仅纯 fs 读)}`；
  `case → domain`；`infra → domain`。
- 禁止的边：`domain → 任何本仓包`；`trigger → domain`（域词汇经 case 的 protocol 网关，§2.4）；
  `case → infra / trigger`；一切反向边。
- `desktop` / `web` 不进守卫扫描面（05/09），维持现状：desktop → app，web → case（type-only，
  §7 步 2）。
- **trigger→infra 是允许而非必须的边**（本票对 05/09 规则集的机械细化）：今天的纯 fs 读
  （`static.ts` 服务 `web/dist`、目录 stat）由 trigger 直接用 `node:fs` 完成，不产生对 infra 的
  import；trigger 的依赖声明因此只有 case（§1.4）。规则集字面不动——守卫管「禁止的方向」，
  允许的方向可以暂时无人走。若未来 trigger 要复用 infra 的读原语，加依赖声明即可，不违反本
  spec。

### 1.4 包名与依赖声明清单

五个新 workspace 全部 `private: true`、`"type": "module"`、`main`/`types` 指 `./src/index.ts`
（沿用 core/server 的形状）：

| 包 | 依赖（workspace） | 第三方依赖 |
| --- | --- | --- |
| `@my-agent/domain` | 无本仓依赖 | `@anthropic-ai/sdk` 0.124.0、`partial-json` 0.1.7、`typebox` ^1.3.27（core 的三件随迁） |
| `@my-agent/infra` | `@my-agent/domain` | 无（`node:fs` 一族） |
| `@my-agent/case` | `@my-agent/domain` | 无 |
| `@my-agent/trigger` | `@my-agent/case` | devDependencies：`@types/node`、`vite` ^7.1.0（自 server 随 http.ts 迁入，08） |
| `@my-agent/app` | `@my-agent/domain`、`@my-agent/infra`、`@my-agent/case`、`@my-agent/trigger` | devDependencies：`@types/node` |

既有包的改动：

| 包 | 改动 |
| --- | --- |
| `@my-agent/desktop` | 依赖 `@my-agent/server` → `@my-agent/app`（今天声明而未 import，改声明让动态 import 走正门，08） |
| `@my-agent/web` | 依赖 `@my-agent/core` → `@my-agent/case`（type-only：11 个文件的 wire 类型 import 全走 `@my-agent/case/protocol`，§7 步 2） |
| `@my-agent/core` / `@my-agent/server` | 随步 2 / 步 3 退役（workspace 成员、package.json、tsconfig、install-deps 表同步撤） |

子路径导出表（package.json `exports`）：

| 包 | 导出 |
| --- | --- |
| `@my-agent/domain` | `"."` → `./src/index.ts`；`"./tool"` → `./src/agent/tool/index.ts`（沿用 core 的 `"./tools"` 子路径；目录随 02 改名单数，零消费者的导出名跟随新目录名——本票机械定案） |
| `@my-agent/case` | `"."` → `./src/index.ts`；`"./protocol"` → `./src/protocol.ts`（信封 + 网关） |
| `@my-agent/trigger` / `@my-agent/infra` / `@my-agent/app` | 仅 `"."` |

### 1.5 tsconfig / workspace / install-deps 调整（09：骨架步一次到位，旧名随步撤）

- 根 `package.json` `workspaces`：步 1 追加五包；步 2 删 `packages/core`；步 3 删
  `packages/server`。终态：`packages/{app,trigger,case,domain,infra,web,desktop}`。
- 根 `tsconfig.json` `paths`：步 1 一次写全七条——`@my-agent/{app,trigger,case,infra}` 指
  各 `src/index.ts`（stub）、`@my-agent/domain` 指 `./packages/domain/src/index.ts`（stub）、
  `@my-agent/case/protocol` 指 `./packages/case/src/protocol.ts`、`@my-agent/domain/tool` 指
  `./packages/domain/src/agent/tool/index.ts`（stub 即指向未来地址，stub 让 typecheck 立即可过）；
  步 2 删 core 的三条旧 paths；步 3 无 paths 可删（server 从无别名——desktop 与 scripts 一直用
  相对路径 import 它）。
- 根 `tsconfig.json` `include`：步 1 追加五个 `packages/*/src/**/*.ts` glob；步 2 删 core glob、
  步 3 删 server glob。终态 include：五包 glob + 今天那份 scripts 子集（全留根 `scripts/`，
  09）。
- `packages/*/tsconfig.json`（五新包）：`extends ../../tsconfig.base.json` +
  `include: ["src/**/*.ts"]`，与 core 的现形一致。server 今天那份 `include: ["../core/src/**/*.ts"]`
  的跨包写法不复制——跨包解析由根 paths 承担；且 `npm run check` 只跑根项目与 web 项目，
  包级 tsconfig 本就不在 check 链上。
- `packages/web/tsconfig.json`：`paths` 的 `@my-agent/core/protocol` 换
  `@my-agent/case/protocol`（步 2）；`types: ["node"]` 及其注释保留（信封引用的域词汇仍触及
  node 类型），注释里的 `@my-agent/core` 提法随重指改 `@my-agent/domain`。include 的 smoke
  清单不动。
- `scripts/install-deps.ts` 的硬编码 workspace 表：步 1 追加五包；步 2 删 `packages/core`；
  步 3 删 `packages/server`（0010 决定 1 撤过 llm 一行的同款机制）。

---

## 2. domain 内部

### 2.1 散件归属（05 定案，照抄 + 住址）

| 散件 | 新家 |
| --- | --- |
| `model-manager.ts` | **llm 包**（models.json 行 → `Model` 的构造链都在 llm） |
| `settings.ts`（resolveSettings 组合） | **agent 根**（横跨 tool/session/model 三簇） |
| `hooks.ts` | **agent 根**（编排的接缝）；`archiveToolResult` 迁往 **context 包**（06：它是结果视图操作，不是 hook 分发接缝） |
| `workdir.ts` + `shell.ts` | **tool 包**（工具路径解析与平台 shell 启动） |
| `session-factory.ts`（createSessionAgent / openAgent） | **agent 根**（构造编排层的工厂，显式名保留） |
| 行类型（SessionRef / SessionRow / SessionRowPatch） | **session 包**（与 snapshot 同属会话事实，case 只现算不养类型） |
| 根 `types.ts` | **agent/types.ts**（共享内核，§2.3） |
| `protocol.ts` | **解散**，映射表见 §2.4 |

### 2.2 子包隔离规则（06 定案）

context / llm / session / tool 四子包**互不 import，哪怕单向**；被其他子包消费的定义搬进
agent 根 `types.ts` **独占**（共享内核）；根允许保留对子包的 type-only 边（已知两条良性：
`AgentEvent`→`AssistantMessageEvent`、`ToolRunContext`→`BashSettings`——今天已存在同形的
root↔tools 循环）。子包只准 import 根 `types.ts`、node 内建与外部依赖——守卫的机械检查同款
（§6 R2）。

### 2.3 根 `types.ts` 共享内核收编名单（06 定案 + 本票机械核对）

判据（06）：凡被 llm 之外的子包或 agent 根消费的定义进根；仅传输机械自用的留 llm。核对
`llm/types.ts` 全部导出后的精确名单：

**自 llm/types.ts 收编进根**：

- 消息族：`TextContent` / `ThinkingContent` / `ImageContent` / `ToolCall` 内容块、
  `NestedToolCallRecord` / `NestedToolCalls`（被 `AssistantMessage` 引用，跟随进根）、
  `SystemMessage` / `UserMessage` / `AssistantMessage` / `ToolResultMessage` / `Message`。
- 词汇：`Usage` / `StopReason` / `JsonValue` / `JsonObject` / `JsonRepresentation` 及其辅助
  （`IsAny` / `IsJsonCompatible` 一族，跟随 `JsonRepresentation`）。
- 工具：`Tool` / `ToolResult` / `ToolUpdateCallback` / `ToolExecutionMode` / `ToolRunContext` /
  `ConstrainedSamplingConfig`（`Tool.constrainedSampling` 字段的类型）/ `contentText`
  （自 llm/utils/text.ts，值函数——根已有值先例：`DEFAULT_*` 常量）。
- 模型事实族：`Api` / `KnownApi` / `ThinkingLevel` / `CacheRetention` / `ModelPromptCache` /
  `ModelCostRates` / `ModelCostTier` / `ModelCost` / `ModelImageResizeOptions` /
  `ModelImageInputLimits` / `ModelInputLimits`。
- 根自定义（无自然属主的政策词汇，06）：`ARG_TRIM_TOOLS` / `ARG_TRIM_THRESHOLD_CHARS` /
  `clearedToolResultText`（值与函数，自 context 两文件收拢）/ `describeToolCall`
  （自 tools/index.ts——它与 session/dangling.ts 的消费边是 session→tools 边消失的那条，机械
  核对确认）。

**留 llm（传输机械）**：`Context` / `ChatTransport` / `TelemetryContext` /
`AssistantMessageEventStream` / `AssistantMessageEvent`（根经既有的 type-only 边引用）/
`ImageApi` / `ClassifierApi` 及 Known 族（被 `ImageModel` / `ClassifierModel` 引用）/ `ToolChoice`
/ `Transport` / `ProviderEnv` / `ProviderHeaders` / `FetchFunction` / `ProviderResponse` /
`ProviderRequestOptions` / `StreamOptions` / `ProviderStreamOptions` / `ApiOptionsMap` /
`ApiStreamOptions` / `SimpleStreamOptions` / `StreamFunction` / `AnthropicMessagesCompat` /
`ModelTypeMap` / `ModelType` / `AnyModel` / `ImageModel` / `ClassifierModel`；`Model` **类**留
`llm/model.ts`（根 types.ts 里引用它的 `ProviderRequestOptions<TModel = Model<Api>>` 一族随
`StreamOptions` 留 llm，不产生新的根→llm 边）。

**自 session 收编进根**：`SessionEntry` 族判别联合 + `SessionEntryBase` 与六种 kind 接口 +
`SessionEntryMapById`（ledger.ts）——context 包的压缩算法要摸 entry 而不得 import session。

**自 core/src/types.ts 原地留守 agent/types.ts 的**：`QueueMode` / `AgentEvent` /
`AgentRequestUpdate` / `ToolCallAnswer` / `RunRecoveryOptions` / `ToolCallOutcome` /
`RetrySettings` / `DEFAULT_MODE_NAME` / `DEFAULT_GLOBAL_SETTINGS` / `GlobalSettings` /
`SettingsPatch` / `stringListOrUndefined` / re-export（`BashSettings` / `ModeSettings` 自
tool 包）。**离开 domain 的**：`AGENT_HOME`（→ app，步 5）、`settingsPath` / `modelsPath`
（随端口翻面消亡——文件名 join 进 infra 的 home-json 实现，§4.2）、`APP_NAME`（→ app，
跟随 AGENT_HOME）。

**自 session/paths.ts 拆解**（本票机械核对后的分派）：

- `resolvePath` / `normalizePath`（+ 私有 `normalizeWindowsShellPath`）→ **agent 根
  types.ts**：session 包与 agent 根都消费（session-manager 的文件键、袋构造的 workDir 解析），
  子包只准 import 根 types.ts，所以只能进 types.ts。`AGENT_HOME` 迁走后这两个函数是 types.ts
  里仅存的路径语义。
- `sessionPath` / `sessionMetaPath` / `sessionJsonlPath` → **infra session-store.ts**（文件对
  命名规则是存储布局知识；`scripts/smoke-approval.ts` 对 `sessionMetaPath` 的 import 重指
  `@my-agent/infra`——scripts 豁免守卫，合法）。
- `sessionsDir` / `setSessionsDir` → **消亡**（步 5，端口注入取代）。

### 2.4 protocol.ts 解散映射（05 定案方向 + 本票机械定案）

`core/src/protocol.ts` 的每个导出的新家。机械事实：信封类型在 core 内的消费者只有
protocol.ts 与 index.ts 的 re-export，域内零消费——信封可以离开 domain。

| 现导出 | 新家 |
| --- | --- |
| `ServerMessage` / `StreamFrame` / `ConnectionFrame` / `ServerFrame` / `ClientFrame` / `ConnectionItem` / `StreamId` / `StreamFailure` | **case `src/protocol.ts`**（信封本体） |
| `SessionRef` / `SessionRow` / `SessionRowPatch` / `DirectoryGroup` | session 包（05 明文） |
| `SessionSnapshot` / `UsageTotals` / `EMPTY_USAGE` / `addUsage` / `PendingApproval` / `QueuedPrompt` / `PromptBehavior` | session 包（snapshot.ts / queues.ts 的词汇） |
| `ModelOption` / `ModelInput` / `ModelSelection` | llm 包（model-manager 生产 `ModelOption`，coerce / applyModelSelection 消费后两者） |
| `DiffLine` / `FileDiff` | tool 包（diff.ts 词汇） |
| `ConfigPatch` / `GlobalSettingsSnapshot` / `APPROVAL_TOOLS` | agent 根 types.ts（与 `SettingsPatch` / `GlobalSettings` 同住；`APPROVAL_TOOLS` 是 06 的「根自定义政策词汇」同类） |
| 纯 re-export（`Message` / `AgentSessionEvent` / `MessageDelta` / `BranchOption` / `BranchPoint` / `BashSettings` / `ModeSettings` / `QueueMode`） | 各自属主原址（llm / agent 根 / session 包 / tool 包） |

**信封住 case 的裁决**（本票定案，显式记录理由）：05 的「其余 re-export 回归各包」没有给
信封指派属主，而 05/09 的守卫规则集（trigger→{case,infra}、case→domain）意味着
**trigger 不能直接 import domain**——frames.ts（trigger）今天就要信封与 `UnknownSessionError`；
所以信封必须住在 trigger 可达的最近一层 = case。case 在此 role 下是 trigger 与 web 共用的
**类型网关**：`case/src/protocol.ts` 声明信封 + re-export 上表所有客户端与触发面需要的域
词汇（含 `UnknownSessionError` class——`http/errors.ts` 的 404 映射要 instanceof）。web 的
import 面因此保持**单一来源**（今天 `@my-agent/core/protocol`，新世界
`@my-agent/case/protocol`，11 条 import 语句一次重指）。备选「信封留 domain」被否：它使
trigger→domain 成为必须的边，直接违反 05/09 的规则集；备选「信封步 3 随 frames 搬」被否：
09 把 protocol 解散钉在步 2，且 web 要重指两次。

09 步 2 的时序因此成立：case 在步 1 已是 stub workspace，步 2 落信封时 case 只是
`src/protocol.ts` + package.json exports，hub 本体步 3 才到。

### 2.5 ContextManager 以外的 domain 形状不变项

- `Agent` 编排层（引擎、会话表、fanout、装配）整体进 domain 的 `agent.ts`，保持今天的全貌
  （ADR-0016/0013/0017 形态），只是改为构造注入（03）。
- llm 传输层原样搬进 domain，`@ts-nocheck` 原样保留（map Out of scope：不重写、不再端口化；
  `ChatTransport` 已是它的缝）。
- 四子包的**目录名变化**仅一处：`tools/` → `tool/`（02 的树字面）；其余三个目录名原样。

---

## 3. ContextManager 设计（06 定案全文收录）

**总切法：编排留引擎，算法归 ContextManager。**

- **Agent 保留（编排半）**：`compactFor`（触发序列 + 记账 `appendTrimToolCallArgs` /
  `appendClearToolResults` / `appendCompaction` + 发事件 `tool_call_args_trimmed` /
  `tool_results_cleared` / `compaction` / `compaction_failed`，经 ADR-0017 的 fanout 族 +
  abort 判定与 `summarize` 闭包（catalog 检查 + `unconfiguredStream` + `cacheRetention: "none"`））、
  `trimRecordedArgs` / `clearStaleToolResults`、`prepareRequest` 全序、`finalizeToolResult`
  （fanout 族不动，`spill ?? bound` 的组合留 Agent）、`maybeCompact` 公开面（smoke 演练口，
  原样）、`resolvedSettings` / `approvalsOf`、`rewriteContext` 与两个闸门。
- **ContextManager 收（算法半）**：触发计算、候选选择、token 估算、摘要产出、prompt 装配、
  结果归档。「整个阶梯归它」被否——那要收 SessionManager（破 ADR-0012「Manager 唯一消费者是
  编排层」）加一套 fanout 之外的第二只分发，是第二只小编排层。

**六文件映射**：

| 文件 | 去向 |
| --- | --- |
| `system-prompt.ts` + `agents-md.ts` | context 包实现细节，由 **`ContextManager.buildRequestPrompt(workDirAbsPath, toolNames, approvalTools)`** 一次组合（内部先 `loadAgentsMd` 再 `buildSystemPrompt`）。`AgentConfig.systemPrompt` 注入点**删除**（工厂无条件接线、无任何消费者覆盖过的死缝）；`approvalToolsOf` 的映射仍由 Agent 在调用前做（settings 知识归 agent 根） |
| `compaction.ts` | `compactionThresholdFor` / `shouldCompact` / `estimateTokens` / `compact(entries, project, model, summarize, signal)` 成为 ContextManager 方法；`prepareCompaction` / `findCutPoint` 包内私有；`Summarize` 回调仍由 Agent 提供 |
| `spill.ts` | `ContextManager.spillOversizedToolResult`（写边界调）+ 包级 `archiveToolResult`（自 hooks.ts 搬入）；spill 原语收拢包内；落盘经 ToolResultsRepository 端口（§4.3），`spillPathFor` 留包内（relPath 是模型可见视图文案的一部分） |
| `trim-tool-call-args.ts` / `clear-tool-results.ts` | 各拆两半：**决策半**归 context（`trimmableToolArgEntryIds`、`clearableToolResultIds` 含缓存闸、`isCacheProbablyExpired`、`isClearedToolResult`、`REFETCHABLE_TOOLS`、`CACHE_EXPIRY_MS` / `KEPT_TOOL_RESULTS`）；**施加半**搬进 session 包（`trimToolCallArgs`、`clearToolResult`、`ARG_KEEP_CHARS` / `ARG_TRIM_MARKER`）——记录的施加归账本视图（`buildContextEntries`） |

**构造零依赖**（ADR-0006 service 形态的空集）：无状态、一个实例服务所有会话，由工厂构造
（新世界由组合根注入工厂）。方法收显式参数：entries / contextWindow / workDirAbsPath /
signal / `Summarize` 回调 / `project` 投影函数。**不要** ChatTransport（模型由调用方构造好
传入）、不要 settings（阈值从 `model.contextWindow` 现算）、不要 SessionManager（记账不归它）。

**投影函数注入**：`sessionEntryToContextMessages` 留 session 包，`compact` 收它作 `project`
参数、由 Agent 递入（根→session 直取合法）。context 包对本仓子包的 import 清零。

**`context/types.ts`**：只装包内公开类型——`CompactionPreparation` / `CompactionResult` /
`SummarizeRequest` / `Summarize`（`SystemPromptInput` / `AgentsMdFile` 随注入点死亡降为包内）。
`Context` 不动（留 llm）。物理形状照 02：`manager.ts` 是公开脸，六个实现文件保留为里子。

---

## 4. 端口清单（07 定案 + 本票机械核对）

原则：**端口面 = 触盘动词；袋子上的树操作不进端口**。端口由**消费方包**声明（04，经 07
细化为消费方包内专用 `xxx-repository.ts`——04 原文的「types.ts 里声明」作废，两原则
「消费方声明、不设 ports 包」不变）；infra 逐存储域一个实现文件、import domain 的类型。
**不设独立 ports 包。**

### 4.1 SessionRepository（会话文件对，一个端口读写不分）

声明：`domain/src/agent/session/session-repository.ts`。唯一消费者是 Agent 编排。方法面
11 个（07 名字暂定 → 本票机械核对，给出今天的对应物）：

| # | 端口方法 | 今天的实现（session-manager.ts / paths.ts） |
| --- | --- | --- |
| 1 | `locate(id): string \| undefined` | static `findSessionFilePathById`——id → `.jsonl` 路径，一次 stat |
| 2 | `isDeleting(id): boolean` | `isClosing`——ADR-0023 否决式删除那一拍，读作「不存在」（`isDeletingSession` 门面的支撑，是 domain 可观察语义，不是闸簿记） |
| 3 | `fill(absJsonl): { meta, entries }` | 文件级 `fillSession`——配对检查 + 版本拒绝 + prune 的编排归 infra（文件层卫生，与 hold 闸同类）；撞闸、复活守卫、打不开都以 `UnknownSessionError` 拒绝 |
| 4 | `readSnapshot(absJsonl): SessionMeta` | fill 内部的快照读半（不 prune）——今天无独立函数，端口化时独立成法（fork 源半、`recordedOnDisk`） |
| 5 | `loadEntries(absJsonl): SessionEntry[]` | fill 内部的账本整读半（同上独立成法；fill 内部也用它） |
| 6 | `createPair(absJsonl, entries, meta): void` | `newSession` 的写半 + `forkFrom` 的写目标半共用：两文件 `wx`、快照最后写（提交标记） |
| 7 | `appendEntry(absJsonl, entry): void` | 文件级 `persistEntry`——单行追加 |
| 8 | `writeSnapshot(absJsonl, meta): void` | `flushMeta` 的 temp+rename 整体重写半 |
| 9 | `remove(id): Promise<void>` | `SessionManager.remove`——两步 rm，闸罩全程 |
| 10 | `scanPairs(): Promise<{ absJsonl, meta }[]>` | static `list` / `listDirectories` 的 settle 冷半：readdir + 配对 + prune + 空流检测 |
| 11 | `scanLedger(absJsonl, visit): Promise<void>` | static `list` / `findSessionRowById` / `hasSessionsFor` 的发现半流式行泵：infra 泵行 + JSON.parse，派生（messageCount / 文本 / parentOf / leafId）留 domain 回调，内存特征与今天一致 |

两项子裁决（07）：fork 走**哑读**（今天 fork 不 prune，复用 fill 是行为变化——用
`readSnapshot` + `loadEntries` 拼，不走 `fill`）；`hasConversation` 闸（第一条消息才诞生）
**留 domain**——对话知识，domain 判断后调 `createPair`。

同步/异步划分保今天：袋式写路径同步（引擎轮次中同步 `appendMessage`），发现半与 `remove`
异步——`hasSessionsFor` 随 `scanPairs` 异步化，REST 面不变。

**hold 契约三条**（写进接口文档）：

1. **原子性**：每个触碰文件对的方法对该文件对原子；闸、closing、复活守卫是实现内部细节；
   跨方法无事务（与今天一致）。
2. **错误语义**：`UnknownSessionError` 类型声明归 domain session 包（消费方词汇），infra
   抛出（infra→domain import 合法）。撞闸、复活守卫失败、fill 打不开、remove 未知 id——全部
   读作「没有这个会话」。
3. **fill 的副作用**：fill 是一次可能删除文件的读取——打不开的配对先 prune 再抛；编排层接受
   这个事实但不依赖其细节。

`remove` 的两步 rm 顺序（先 `.json` 后 `.jsonl`）不进契约正文——契约只承诺「返回时文件对已
不存在；中间态的一切读答『不存在』」。

### 4.2 三个设置文件端口——home JSON 文件族原语

接口形状（三簇同形，结构化类型让 infra 一个实现满足三个声明）：

```ts
interface XxxDefaultsRepository {
	read(file: string): Record<string, unknown> | undefined; // undefined = 不存在
	write(file: string, layer: Record<string, unknown>): void;
}
```

`file` 是**文件名**（`"tools.json"` / `"models.json"` / `"sessions.json"`，以及 legacy 迁移源
`"settings.json"`、退场持有者的 `"engine.json"`）——文件名与迁移编排留 manager（簇知识），
infra 的 home-json 实现负责 join home + temp+rename 落盘。今天的内联副本被端口替换：
`tools/manager.ts` 的 `readLayer` / `writeLayer`（:450/:481）、`model-manager.ts` 的
`readDisk` / `writeDisk` / `readLegacySettings`（:243/:267/:287）、`session-manager.ts` 的
`readJsonLayer` / `writeSessionsLayer` / `sessionsPathOf`。**迁移编排留 manager**：「什么时候
迁移、捡哪些键、补不补默认、engine.json 优先」（`migrateSessionDefaultsOnce` 等）原样留在各
manager 的 load / toolState 分支，经同一端口跨文件现读；infra 不懂「settings.json 是 legacy」。
语义窄端口（`readLegacyLayer` 一类）被否——models 还要 engine.json，接口特设化。

| 声明文件 | 接口名 | 文件 |
| --- | --- | --- |
| `domain/src/agent/session/session-defaults-repository.ts` | `SessionDefaultsRepository` | `sessions.json` |
| `domain/src/agent/llm/model-repository.ts` | `ModelRepository` | `models.json` |
| `domain/src/agent/tool/tool-defaults-repository.ts` | `ToolDefaultsRepository` | `tools.json` |

规范化 / 合并函数（`viewOf` / `approvalOr` / `bashOr` / `modesOr` / `queueModeOr` / `retryOr` /
`mergeLayers`）仍各簇内联、一行不共享——ADR-0028 的精确化见 §8。

### 4.3 ToolResultsRepository（tool-results 归档）——只写

声明：`domain/src/agent/context/tool-results-repository.ts`。方法面就一个：

```ts
writeIfAbsent(absPath: string, text: string): boolean // 不存在才写 + mkdir，失败 false 回落硬截断
```

今天的对应物：`context/spill.ts` 的 `writeSpillFile`（:65，含 mkdir + wx 语义）。
**读不进端口**（今天没有任何代码读归档——模型用 read 工具，用户工作目录 04 已决不端口化）；
**清理不发明**（今天不存在这套逻辑，零行为变化约束下不做，将来要做先改 07 票）。
`spillPathFor` / `spillText` / `spillView` / `SPILL_*` 留 context 包。实例由编排层持有（构造
注入），经参数表递给 `spillOversizedToolResult` 与 `archiveToolResult`（06 的 ContextManager
零依赖约束）。

### 4.4 infra 实现划分（按存储域，不按端口）

| 文件 | 内容 |
| --- | --- |
| `infra/src/session-store.ts` | 会话文件对全家：11 方法实现 + hold 闸（`enterHold` / `leaveHold` / `holding` 的搬移）+ `removeGate` 测试缝随迁并**保持模块级导出**（今天 `setRemoveGate` 就是模块级 session-manager.ts:850，消费者只有 smoke-sessions 与 smoke-api，不给 app 构造面添测试参数，09）+ **`migrateLegacyStore` 随迁**（旧 session 目录布局 → 扁平 store 的迁移——store 今天已扁平、嵌套布局是 legacy 且今天就懒迁移，搬家不是发明新布局）+ 文件对路径规则（`sessionPath` / `sessionMetaPath` / `sessionJsonlPath`，§2.3） |
| `infra/src/home-json.ts` | 一个实现满足三个同形声明；构造收 home；`modelsHome` ≠ `settingsHome` 时组合根各造一份 |
| `infra/src/tool-results.ts` | 归档只写实现（收 absPath，无 home 概念） |
| `infra/src/index.ts` | 组合根的导出面（三实现 + 构造 options） |

### 4.5 不端口化清单（04 定案）

用户工作目录的固有本地事实直接 `node:fs`：AGENTS.md/CLAUDE.md 收集、六个工具的文件读写与
shell 执行、路径解析（workdir.ts）。llm 的供应商 HTTP 同样不端口化。这些换 mysql 也不变。

---

## 5. app 组合根与启动面（08 定案全文收录 + 机械定案）

### 5.1 `start(options)` 的 options 面

```ts
export interface StartOptions {
	workDirAbsPath: string;      // 必填
	host?: string;               // 默认 127.0.0.1
	port?: number;               // 默认 8080；0 = 向操作系统要空闲端口
	sessionId?: string;          // 回退 MY_AGENT_SESSION env（smoke-boot 的钉住用例）
	settingsHome?: string;       // 缺省走 AGENT_HOME 解析
	modelsHome?: string;         // 缺省跟 settingsHome
	chatTransport?: ChatTransport;
	mux?: WireOptions;           // 透传（smoke-mux-live / smoke-liveness 的毫秒预算）
	vite?: boolean;
}
export interface BootedServer { /* 名字不改（搬迁不改名）：url, port, workDirAbsPath,
	sessionHub, muxServer, httpServerHandle, close(): Promise<void> */ }
export async function start(options: StartOptions): Promise<BootedServer>;
```

类型名 `BootOptions` → `StartOptions`、`bootServer` → `start`：本票机械定案——08 的全文都
以 `start(options)` 指称这个入口（「smoke 起 server 的走 `app.start(options)` 的覆盖面」），
CLI 面死亡后 `bootServer` 的 boot 语义不再有对象；`BootedServer` 与全部字段名显式保留。

homes 是**路径**不是端口——app 是唯一把 home 翻译成 infra 实现的地方：

| home | 翻译 |
| --- | --- |
| `settingsHome` | session-store 指 `<settingsHome>/sessions`；home-json 第一份；tool-results 实现收 absPath、无 home 概念 |
| `modelsHome`（缺省跟 settingsHome） | home-json 第二份（ModelManager 用） |

**会话 store 跟随 settingsHome 派生**：`setSessionsDir` 消亡后不再有独立的 store 缝——今天
「settingsHome 与 storeRoot 两条缝」合一；生产从不传 homes，server 级 smoke 从此一个 home
指全隔离。默认 home 的解析（`MY_AGENT_HOME ?? ~/.my-agent`）搬进 app（`src/agent-home.ts`）；
smoke-boot 进程内半的隔离法（env 先设、动态 import 后行）原样可用。

`createSessionAgent` 的 `toolManager` / `sink` **不上浮**：sink 归 hub 自己（构造工厂时递入
自己的分发表，今天即如此），toolManager 是 domain 级 smoke 的缝。smoke-boot 子进程半的
`--session` 钉住经 `sessionId` + `MY_AGENT_SESSION` env 保留。

### 5.2 工厂与 HubOptions 翻面（07 遗留裁决 + 08）

`createSessionAgent` **活下来**（managers 仍由它构造——ADR-0012 的「工厂吸收 manager 构造」
保留，原料从 homes 改为端口；修订措辞归 §8）：

```ts
export interface CreateSessionAgentOptions {
	sessionRepository: SessionRepository;        // 必填
	modelRepository: ModelRepository;            // 必填
	toolDefaultsRepository: ToolDefaultsRepository; // 必填
	toolResultsRepository: ToolResultsRepository;   // 必填
	chatTransport?: ChatTransport;
	toolManager?: ToolManager;                   // test-only 缝不动
	sink?: SessionSink;                          // test-only 缝不动
}
```

存储端口全必填——domain 造不出 infra，「缺省真实 home」不再是 domain 的知识；ToolResultsRepository
没有缺席态，写边界的兜底归档永远有处可去。managers 的构造改收端口：`SessionManager` 收
sessionRepository + SessionDefaultsRepository（会话簇设置随会话簇归它，ADR-0028）、
`ModelManager` 收 ModelRepository、`createToolManager` 收 ToolDefaultsRepository。ContextManager
由工厂构造并注入 Agent（§3，`AgentConfig.systemPrompt` 注入点删除）。`openAgent` 随工厂换面
（ports + session bag 不变）。

`HubOptions` 的存储/传输字段换端口透传（settingsHome / modelsHome 字段删除），hub 保留工厂
调用与 sink 组装——「case = SessionHub 原样搬迁」（03）以换类型面的方式成立：

```ts
export interface HubOptions {
	workDirAbsPath: string;
	sessionId?: string;
	sessionRepository: SessionRepository;
	modelRepository: ModelRepository;
	toolDefaultsRepository: ToolDefaultsRepository;
	toolResultsRepository: ToolResultsRepository;
	chatTransport?: ChatTransport;
}
```

### 5.3 close / shutdown

`close()` 编排（mux → hub → http 顺序）留在 `start`（它构造这些对象），`BootedServer.close`
语义不变。**app 不装任何信号 handler**：SIGINT/SIGTERM 从垂死的 main.ts 搬进 dev 薄脚本；
desktop 的 `shutdown.cjs`（before-quit 拦截、5 秒预算）原样，`smoke-desktop-close` 继续拿假件
驱动它。

### 5.4 desktop 对接

- `packages/desktop/package.json`：依赖 `@my-agent/server` → `@my-agent/app`。
- `main.cjs` 保持动态 import（CJS 壳 + TypeScript 类型剥离），目标从
  `packages/server/src/boot.ts` 文件路径换成包名 `await import("@my-agent/app")`；调用
  `start({ workDirAbsPath, host: "127.0.0.1", port: 0, vite })`——四个选项一字不变；「必须从
  仓库跑」的 existsSync 检查换成 import 失败的 catch，由 observability 的既有上报路径接住。
- `launch.mjs` / `shutdown.cjs` / `observability.cjs` 一概不动。

### 5.5 浏览器 dev 薄脚本

`packages/app/scripts/serve.ts`（镜像 desktop 自己养 launch.mjs 的先例；仓库工具，不是产品
CLI）：动态 import app 调 `start({ workDirAbsPath, port, vite })`、装 SIGINT/SIGTERM、打印
URL。**只收 `--vite` / `--port` / `--workDir` 三个 flag**——smoke-boot 与 smoke-approval 的
子进程半 spawn 它、同 flags（`--host` / `--session` / `--help` 随 main.ts 的 CLI 死；两处
smoke 都因 `--port 0` 不合用而早已用真端口，不变）。根脚本 `"dev"` / `"start"` 委 workspace：

```json
// 根 package.json
"dev": "npm run dev --workspace=@my-agent/app",
"start": "npm run start --workspace=@my-agent/app",
// app package.json
"dev": "node scripts/serve.ts --vite",
"start": "node scripts/serve.ts"
```

### 5.6 随层落位（08 的机械表 + 步 3 执行）

- `muxUpgrade` / `sessionListeners` → trigger（`SessionListener` 类型住 controllers 旁）；
  `MUX_PATH` 同行。
- `WEB_DIR` / `CLIENT_DIR` 解析 → app（`start` 算好 clientDir 递给 trigger 的 `createServer`）；
  vite devDep 随 http.ts 落 trigger。
- server 包退役：workspace 成员、package.json、包级 tsconfig、install-deps 行（§1.5）。

---

## 6. 依赖方向守卫（05/09 定案 + 本票命名）

**名字：`scripts/check-layering.ts`**（本票机械定案——它守的是五模块分层契约整体：方向、
成员禁令、子包隔离、domain 禁 fs；`check-server-facade.ts` 的命名模式「check-<不变量>.ts」
沿用）。实现：**自写静态 import 扫描**（沿用 facade 守卫的 `importStatements` 正则先例，
import 说明符 → 包名映射判方向；**不加 dependency-cruiser**——不加新的运行时依赖）。
`scripts/` 豁免（facade 守卫先例原文）。`npm run check` 的追加一棒随步 3 接上，旧守卫同步
退役。

规则随步激活（09）：

| 规则 | 激活步 | 内容 |
| --- | --- | --- |
| R1 依赖方向 | 步 3 | trigger→{case,infra}、case→domain、infra→domain、domain→零本仓依赖、app→全部；违规即失败 |
| R1b 成员禁令 | 步 3 | facade 守卫的 bannedMembers 面迁移继续扫 case+trigger：`.agentState(` / `.sessionManager` / `.settings`（排除方法调用）/ `.hold(` / `.release(` / `.holdsOf(` / `.heldSessionIds(` / `.holds` 等 ADR-0012/0023 族 |
| R2 子包隔离 | 步 4 | `domain/src/agent/` 的四子包只准 import 根 `types.ts`、node 内建与外部依赖；互不 import |
| R3 domain 禁 fs | 步 5 | domain 禁 `node:fs` import；**例外：tool/ 包**（用户工作目录事实，04——六工具的文件读写与 shell；`node:child_process` 同属该例外） |

---

## 7. 分步迁移方案（09 定案 + 文件级清单）

总形状：**六步，纯移动先行、翻面后置，每步一个绿状态**。「先立 infra 端口实现并行于旧路径」
被否（长期双轨）；「原地改造完再搬」被否（同段代码审两遍、搬两次，守卫拖到最后一步）。
每步绿状态 = `npm run check` + 基础门 smoke：

> **基础门（每步）**：`npm run check` + `smoke-tools` / `smoke-sessions` / `smoke-models` /
> `smoke-mux`（四条自足 headline）；`smoke-api` 从步 3 起入列。

### 步 1：骨架

新增（全部 stub）：

- `packages/{app,trigger,case,domain,infra}/package.json`（§1.4 的名字与依赖，此时依赖可先
  不写全、步 2/3 随实 import 补；exports 按终态写）。
- `packages/{app,trigger,case,domain,infra}/tsconfig.json`（§1.5 形状）。
- `packages/{app,trigger,case,domain,infra}/src/index.ts`（空 stub 导出）。
- 根 `package.json` workspaces 追加五包；`scripts/install-deps.ts` 表追加五包。
- 根 `tsconfig.json`：paths 追加七条（§1.5，全指未来地址）、include 追加五个 glob。

本步不改任何既有文件的行为。验收：`npm run check`（stub 让 typecheck 立即可过）+ 基础门。

### 步 2：core → domain（改名 + 套层 + protocol 解散，一步落地）

**移动**：`git mv packages/core packages/domain`；`src/*.ts` 散件与子目录按 §1.2 / §2.1 套进
`src/agent/`（`tools/` 改名 `tool/`）；`package.json` name 改 `@my-agent/domain`、exports 按
§1.4。

**protocol.ts 解散**：按 §2.4 映射表逐类型搬家；`case/src/protocol.ts` 落信封与网关 re-export
（case 的 package.json exports 加 `"./protocol"`）。

**import 重指面（本步最大的机械面）**：

| 面 | 数量 | 重指 |
| --- | --- | --- |
| server 源码 | 7 文件：5 文件 import `@my-agent/core`（boot / frames / http errors / controllers sessions / hub）+ 3 文件 import `@my-agent/core/protocol`（frames / mux / wire，frames 两者兼有） | 前者 → `@my-agent/domain`；后者 → `@my-agent/case/protocol`；server package.json 依赖加 `@my-agent/case`（过渡态，步 3 随包消亡） |
| web | 11 文件 11 条 `@my-agent/core/protocol` import（main.ts / state.ts / api.ts / composer.ts / client.ts / default-model.ts / rows.ts / render/{diff,settings,sidebar,statusbar}.ts）+ 3 处注释提法（main.ts:61/691、render/settings.ts:16） | import → `@my-agent/case/protocol`；package.json 依赖 `@my-agent/core` → `@my-agent/case`；web tsconfig paths 同步 |
| scripts | 31 个文件：29 条 `@my-agent/core` import + 8 条 `@my-agent/core/protocol` import（含 wire/client.ts） | → `@my-agent/domain` / `@my-agent/case/protocol` |
| 根 tsconfig | 删 core 三条 paths、删 core include glob | 加 domain/case 的终态 paths |
| install-deps | 删 `packages/core` 行 | |

desktop 不动（boot.ts 还在 server）。验收附加：`smoke-projection`、`smoke-default-model`
（protocol 信封与 coerceModelConfig 重指的直接消费者）+ 基础门。

### 步 3：server 三分

**移动**：

- `server/src/hub.ts` → `case/src/hub.ts`（含 SessionSubscription / GlobalSubscription /
  SubscriptionSink / HubOptions）；`case/src/index.ts` 导出 `SessionHub`。
- `server/src/{controllers/{routes,sessions}.ts, http.ts, http/{errors,routing,static,websocket}.ts,
  frames.ts, mux.ts, wire.ts}` → `trigger/src/`；boot.ts 的 `muxUpgrade` / `sessionListeners`
  随迁 trigger（§5.6）。
- `server/src/boot.ts` 主半 → `app/src/start.ts`（`bootServer`→`start`、`BootOptions`→
  `StartOptions`、`BootedServer` 名字不改；`WEB_DIR`/`CLIENT_DIR` 解析随迁 app）；`server/src/main.ts`
  的 CLI **死**；`app/src/index.ts` 导出 start 一族。
- 新建 `app/scripts/serve.ts`（§5.5）。
- desktop：package.json 依赖换 `@my-agent/app`；`main.cjs` import 目标换包名 + 失败接
  observability（§5.4）。
- server 包退役：workspace 成员、package.json、包级 tsconfig、install-deps 行。
- 根 `package.json` scripts 的 dev/start 委 workspace（§5.5）。

**两个子进程 spawn 点都换指 serve.ts**（09 补上 08 漏的一处）：`smoke-boot`（:232-234）与
`smoke-approval`（:738-746）——同 flags、`MY_AGENT_HOME` env 承接、SIGTERM 落定改由脚本自己的
handler 承接。

**scripts 的相对 import 重指面**：13 个文件 41 处 `../packages/server/src/...`（smoke-api、
smoke-approval、smoke-boot、smoke-approval-endpoint、smoke-backpressure、smoke-sessions、
smoke-liveness、smoke-mux-live、smoke-mux、smoke-projection、smoke-stream、smoke-subscribe、
mount-session）——hub/mount → `@my-agent/case`；mux/wire/controllers/http/frames/routing →
`@my-agent/trigger`；bootServer → `@my-agent/app` 的 start。

**守卫在本步诞生**：`scripts/check-server-facade.ts` 退役（扫描对象随 server 解散消失），
`scripts/check-layering.ts` 接进 `npm run check`（§6 R1/R1b；`scripts/` 豁免）。

验收附加（09 全单）：`smoke-api`（入列）、`smoke-boot`、`smoke-approval`、`smoke-mux-live`、
`smoke-liveness`、`smoke-backpressure`、`smoke-stream`、`smoke-subscribe`、`smoke-mux-client`、
`smoke-desktop-close`、`smoke-desktop-observability` + 基础门。

### 步 4：ContextManager（06 全量，纯 domain 内部）

按 §3 执行：总切法、六文件映射、根 types.ts 共享内核收编（§2.3 精确名单）、构造零依赖、
投影函数注入、`AgentConfig.systemPrompt` 注入点删除（session-factory.ts 的接线同步改）；
守卫加 **R2 子包隔离规则**。ADR-0006 / 0010 / 0016 的修订按 §8 清单在本步落笔（01 的不欠账）。

验收附加：`smoke-session`（压缩与流式全链；smoke-tools 在基础门已覆盖 spill/trim 主链；
`smoke-replay` 经查不触移动面，剔除）+ 基础门。

### 步 5：端口化 + 组合根翻面（07+08 全量，一步翻完）

耦合点就在 options 面，拆端口族只会让同一批调用点改三遍，不拆——一步翻完：

- **五端口声明落消费包**（§4.1–4.3 的三个 repository 文件 + §2.3 的 paths 拆解）。
- **infra 三文件**（§4.4；session-store 全家含 `migrateLegacyStore` 随迁、`removeGate` 保持
  模块级导出；home-json 一实现满足三声明；tool-results 只写）。
- **hold 闸下沉**：闸簿记（`holds` 表、`enterHold` / `leaveHold` / `holding`）自
  session-manager.ts 迁 session-store.ts；端口方法各自原子（ADR-0023 修订 §8）。
- **faces 翻面**：`CreateSessionAgentOptions` / `OpenAgentOptions` / `HubOptions` 端口必填
  （§5.2）；managers 构造收端口；`AGENT_HOME` / `APP_NAME` / `settingsPath` / `modelsPath`
  出 domain 归 app（§2.3）；domain 从此不知道「真实的 home」。
- **`setSessionsDir` 消亡**；spill / archive 走 ToolResultsRepository。
- **守卫激活 R3**（domain 禁 fs，tool/ 例外）。
- **ADR-0012 / 0023 / 0028 修订与新增分层 ADR（ADR-0030）落笔**（§8）。

**12 个 smoke 文件、13 处 `setSessionsDir` 调用改形**（本票机械核对清单；smoke-approval 占
两处）：

| 类别 | 文件 | 改形 |
| --- | --- | --- |
| 起 server 的（`bootServer` 覆盖面） | smoke-api（:407）、smoke-approval（:157 进程内半）、smoke-liveness（:63）、smoke-mux-live（:23） | 改传 `settingsHome`（store 派生规则替代 storeRoot） |
| domain / case 级（自造 infra 实现指临时目录） | smoke-approval-endpoint（:25）、smoke-approval-queue（:33）、smoke-approval-recovery（:43）、smoke-projection（:29）、smoke-session（:47）、smoke-subscribe（:100）、smoke-tools（:54） | 直接构造 infra 实现（临时目录）注入 HubOptions / openAgent / manager 构造 |
| 两类并存 | smoke-approval（:705 子进程环境半：`join(restartHome, "sessions")`）、smoke-sessions（:41，同文件兼有 bootServer 与 openAgent 两半） | 前者改 `settingsHome: restartHome`（store 派生给出同一布局）；后者 boot 半改 settingsHome、openAgent 半注端口 |

`createSessionAgent` 的 smoke 调用点仅 smoke-sessions 一处（机械核对确认）。验收附加（09
全单）：`smoke-approval-endpoint` / `smoke-approval-queue` / `smoke-approval-recovery`、
`smoke-model-manager`、`smoke-model-settings`、`smoke-session-settings`、`smoke-tool-settings`、
`smoke-settings`、`smoke-projection` + 基础门 + smoke-api。

### 步 6：终验与文档收尾（本步不改代码）

- README「验证一次构建」全清单（含 smoke-api 的活服务器流程与 MY_AGENT_HOME 临时目录保护）。
- AGENTS.md（布局节、engine / compaction / hold / service / assembly / transport 术语句、
  ContextManager 新条目）、architecture.md（§8 的重写点全量）、CONTEXT.md（§8）。
- 验收：`npm run check` + **全部** smoke（README 清单逐条）。

---

## 8. ADR 修订清单（票面第二交付物）

落笔时机按 09：步 4 落 ADR-0006/0010/0016；步 5 落 ADR-0012/0023/0028 与新增 ADR-0030；
步 6 落 README / AGENTS.md / architecture.md / CONTEXT.md 大重写。

### 8.1 新增 ADR-0030（分层）：五模块、依赖倒置、端口归消费方声明、hold 下沉

要点（新增 ADR 要写的决定，按 docs/adr/README.md 三门槛展开）：

1. **五模块分层**：domain / case / trigger / infra / app 的职责表（§1.1）与依赖图（§1.3）；
   静态守卫 `check-layering.ts` 是不变量的机器（ADR-0012 的先例：界线由守卫背书，不由
   review）。
2. **依赖倒置**：domain 对存储只认自己声明的端口，infra 实现、app 注入；用户工作目录的
   本地事实不端口化（04 的边界线）；llm 的供应商 HTTP 不端口化（`ChatTransport` 已是缝）。
3. **端口归消费方声明**：消费方包内专用 `xxx-repository.ts`、不设 ports 包（04 定原则、
   07 细化落点——引用 04 原文措辞的显式修订）。
4. **hold 下沉 infra**：ADR-0023 的「server 与编排层不感知」升级成「domain 也不感知」；
   端口方法各自原子，hold 契约三条进 SessionRepository 接口文档（§4.1）。
5. **一节：domain 四子包互不依赖 + 根 types.ts 共享内核 + 守卫规则**（06 修订清单第 4 条
   指定归这条 ADR）。
6. **落点**：case 兼作协议信封与类型网关（§2.4 的裁决与理由——trigger 域盲）。

### 8.2 修订 ADR-0012（createSessionAgent 自造 manager → 组合根注入）

- 决定 3「构造吸收」修订：工厂活下来、仍吸收 manager 构造（ADR-0012 的诚实构造保留），
  但**原料从 homes 换成注入的端口**（§5.2 的 options 面）——存储端口全必填，「缺省真实
  home」不再是 domain 的知识；各设置持有者的构造收窄端口而非 home 路径。
- 「homes 与 api 透传」的叙述随之改写；`AGENT_HOME` 常量出 domain 归 app（今天决定 3 的
  默认 home 语义由组合根承担）。
- 头部加取代者指针指向 ADR-0030；「被取代的是什么 / 没有被取代的」两节按惯例对照
  （公开面三类方法、窄读一族、守卫思想全部不动）。

### 8.3 修订 ADR-0016（填充链归 ContextManager）

- 加取代者行（指向 ADR-0030 + 本图 05/06 两票）：**填充链与压缩的算法半出编排、归注入的
  ContextManager**（§3 的清单）；判据原样成立——引擎与压缩阶梯的**编排半**仍是 `Agent`
  私有方法（ADR-0016 的判据对引擎不变，变的只是算法有了属主）。
- 引用其决定 6 的「另一场独立辩论」条款：本图 05/06 两票就是那场辩论（不是顺手搬文件——
  06 的职责边界票 + 05 的归属票合起来构成它）。
- `agent.ts` 类注释（「引擎（run / runEngine）、按请求的填充链、压缩阶梯…是这个类自己的
  私有方法」）与 AGENTS.md 的 engine 术语句同步改写（步 6）。

### 8.4 修订 ADR-0023（hold 迁往 infra）

- 决定 1/2 的簿记住址再迁一程：holds 表自 SessionManager 迁 infra 的 session-store 实现
  （`Map<fileKey, { holds, closing? }>` 原样）；Manager 的进闸出闸变成端口方法的原子性承诺；
  「core 的 Agent 不再有 hold/release 动词」原样成立且更深——domain 连闸的存在都不知道，
  只见 `UnknownSessionError` 与撞闸拒绝的语义。
- 「换成事务型存储的那天这张表跟着消失」的论断原样成立（表随实现走）。
- `removeGate` 测试缝随迁 infra、保持模块级导出（消费者 smoke-sessions / smoke-api 重指）。
- 头部取代者指针 + 检查矩阵更新（`check-server-facade` 的 bannedMembers 由 check-layering
  R1b 承接）。

### 8.5 修订 ADR-0006（决定 6：systemPrompt 注入点删除）

- 决定 6 的三件进程级构造注入（hooks / transport / systemPrompt）删一件：systemPrompt 构建
  函数退出注入面、被 ContextManager 吸收（§3；`AgentConfig.systemPrompt` 死缝——工厂无条件
  接线、无任何消费者覆盖过）。hooks / transport 两件不动。
- 同 ADR 新增一条正面记录：ContextManager 是无属性服务的**新例**——构造零依赖（空集）、
  一个实例服务所有会话、方法收显式参数。

### 8.6 修订 ADR-0010（共享内核搬家）

- 「`Context` 与 `Tool` 住在 `llm/types.ts`」修订：`Context` 留 llm（传输机械）；`Tool` 与
  消息词汇搬 agent 根 types.ts 共享内核（§2.3 名单）；「core 顶层只转发名字」的出口改由
  domain index 承担。
- 「传输层看得见 execute 但不调用它」的注释住址随 `Tool` 搬家同步改写。
- 其余（零行为、`@ts-nocheck`、决定 6 的分界）不动。

### 8.7 修订 ADR-0028（端口化对「不共享读写抽象」的字节级精确化）

- 「存储后端抽象退场、每个持有者直接读写自己的文件、不共享抽象」加一条精确化说明（07
  点名）：端口化后三个设置持有者**共享的是字节级文件 I/O 原语**（infra home-json 的
  read/write——temp+rename、缺文件语义、坏 JSON 拒绝）；**规范化与合并函数**（`viewOf` /
  `approvalOr` / `bashOr` / `modesOr` / `queueModeOr` / `retryOr` / `mergeLayers`）与**迁移
  编排**仍各簇内联、一行不共享——「不共享抽象」防的是重新长出合租房东，字节原语是它下面
  一层的机械，不是抽象。
- 「内联副本的已知分歧」一节原样有效（空文件裁定、mergeLayers 的 undefined 分歧随实现走）。

### 8.8 `docs/architecture.md` 重写点列表（步 6 全量落笔）

1. 各 package 职责节：core/server 两节改写为五模块职责（§1.1），加依赖图。
2. 循环 §107–114：「prompt builder 都在编排层身上」句改写（ContextManager 吸收 prompt 装配）。
3. 压缩 §250–266 的文件引用（六文件新住址：context 包 manager + session 包施加半）。
4. Hook §149 的 `archiveToolResult` 住址（hooks.ts → context 包）。
5. 根 types.ts 头注释更新：不再「只递类型」——它现在定义共享词汇与政策常量（06）。
6. 新增：分层与端口一节（五模块、端口表 §4、组合根 §5、hold 下沉）；transport 一节的包名
   （server → case/trigger）；装配一节的工厂签名（homes → 端口）。
7. 全文 `packages/core` / `packages/server` 的路径提法按 §1.2 目录树改指。

### 8.9 `AGENTS.md` 重写点列表（步 6）

1. 头部与布局节：四包树改五包树（§1.2）、check 命令一棒（check-server-facade →
   check-layering）、smoke 清单不变。
2. 术语句改写：**engine**（填充链算法半归 ContextManager 的编排半措辞）、**compaction**
   （算法半/施加半的新住址）、**hold**（住址 infra、domain 不感知）、**service**（消费边界
   句——createSessionAgent 收端口注入）、**assembly**（工厂 options 面与 `AGENT_HOME` 出
   domain）、**transport**（server 包 → case/trigger；信封住 case）、**settings**（三簇持有者
   构造收端口）。
3. 新增术语条目：**ContextManager**（算法半的持有者、构造零依赖、一个实例服务所有会话）；
   **端口 / port**（消费方声明、infra 实现、hold 契约）。
4. 规则节：「加一个端点 = 控制器上一个方法 + createRoutes() 一条记录」的包名改 trigger；
   守卫描述句更新。

### 8.10 `CONTEXT.md` 重写点列表（步 6）

1. 新增词条：**ContextManager**（算法半持有者；_Avoid_: prompt builder、压缩管理器）、
   **端口（repository）**（消费方声明的存储接口；_Avoid_: ports 包、storage layer）、
   **组合根（app / start）**（home → infra 翻译的唯一地点；_Avoid_: boot、CLI）。
2. 现有词条校订：**Agent（编排层）**的描述补「算法半委托注入的 ContextManager」一句；
   **run bag** 不动（无变化）；若词条里出现 agent.ts 私有方法的枚举，随 §8.3 的措辞同步。

---

## 9. 验收线与不变量

- 每步绿状态：`npm run check` + 基础门（§7 头）+ 该步附加清单；终步 README 全清单。
- 零行为变化贯穿全程：REST 面、mux 帧、会话文件格式（快照 + JSONL、版本 6）、生产 home
  布局、`BootedServer` 返回面、desktop 四个调用选项、`shutdown.cjs` 行为。
- 显式边界（唯一的形状变化，08 摆明）：测试缝——`setSessionsDir` / `sessionsDir` /
  `setRemoveGate`（迁 infra 后重指）/ `settingsPath` / `modelsPath` 消亡或改址，端口注入与
  store 派生规则替代；smoke 的播种方式随之改形（§7 步 5 的 13 处表）。
- 搬迁不改名：`SessionHub` / `BootedServer` / `SessionManager` / 全部 Manager 与公开方法名
  原样；改名的只有本票定案的四处（§5.1 的 `StartOptions` 与 `start`、§6 的
  `check-layering.ts`、§1.4 的 `./tool` 导出名），外加 02 已定的 `tool/` 目录改名。
