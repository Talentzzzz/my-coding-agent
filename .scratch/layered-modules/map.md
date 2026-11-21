# Map: 五模块分层重构（app / trigger / case / domain / infra）

Label: wayfinder:map

## Destination

一份 spec（本目录 `spec.md`）：把本仓从 `packages/{core,server}` 重构为
**app / trigger / case / domain / infra** 五模块分层的完整决策记录与分步迁移方案——
任何后续 session 拿着它执行整个重构时，不再需要做任何决定。
本图只产 spec、不搬代码（执行是下一个 effort）。

## Notes

- 术语索引：`AGENTS.md` 的 `## 术语` 章节——service、engine、tool、session、settings、model、
  transport、hold、approval、assembly、AgentState 等全部沿用，搬迁不改名。
- 冲突规则：产出与某条 ADR 或 `docs/architecture.md` 矛盾时，显式引用编号摆出来，不静默覆盖
  （`docs/agents/domain.md`）。已知待修订：ADR-0006（systemPrompt 注入面）、ADR-0010（共享
  内核搬家）、ADR-0012（构造注入）、ADR-0016（ContextManager）、ADR-0023（hold 下沉）、
  ADR-0028（端口化对「不共享读写抽象」的字节级精确化，07）。
- HITL ticket 开工时按其 `Type:` 调 Skill：`grilling` + `domain-modeling`。
- 验收线：`npm run check` + 五个 smoke（tools / models / sessions / api / mux）全绿；重构零行为变化。
- 编码约定（tab、相对 import 带 `.ts`、无 any 等）见 `AGENTS.md ## 约定`，本图不复制。

## Decisions so far

- [目的地与总体映射](issues/01-destination-and-mapping.md): 图只产 spec 不搬代码；domain=core 全部、
  case=hub、trigger=其余、infra=存储实现、app=组合根；纯搬迁零行为变化。
- [物理布局与启动面](issues/02-physical-layout.md): `packages/` 五 workspace 机制不动；desktop→app；
  `domain/src/agent/` 套一层；app 无 CLI 只服务桌面端，浏览器 dev 留薄脚本。
- [case 与 trigger 的边界](issues/03-case-trigger-boundary.md): case=SessionHub 原样搬迁；app 是
  组合根；trigger→infra 仅限纯 fs 读。
- [端口化决策](issues/04-portization.md): 全部自有存储端口化、用户工作目录不端口化；hold 闸下沉
  infra；端口由消费方包声明，不设 ports 包。
- [domain 内部归属](issues/05-domain-internals.md): 散件各归其包；造 ContextManager 注入 Agent
  （ADR-0016 待修订）；check 脚本改造成依赖方向守卫。
- [ContextManager 的职责边界](issues/06-context-manager-boundary.md): 编排留引擎、算法半归
  ContextManager（构造零依赖、投影函数注入）；六文件逐个映射定案（trim/clear 拆决策半与施加半，
  施加半归 session）；**四子包互不依赖、共享词汇独占 agent 根 types.ts**；systemPrompt 注入点
  删除；ADR-0006/0010/0016 修订要点已记、落笔归 10。
- [端口方法集设计](issues/07-port-method-sets.md): 五端口定案——**SessionRepository** 一个端口
  11 方法（fill 编排归 infra、fork 走哑读、hasConversation 留 domain）；三个设置文件共用 **home
  JSON 文件族原语**（各簇声明、文件名与迁移编排留 manager）；**ToolResultsRepository 只写**；
  声明落消费包专用 **xxx-repository.ts**（显式修订 04 的 types.ts 措辞）；infra 按**存储域**三文件；
  **smoke 自己当组合根**（setSessionsDir 消亡）；hold 契约三条（UnknownSessionError domain 声明、
  infra 抛；fill 是可能删文件的读取）；ADR-0028 精确化入修订清单。
- [app 组合根的形状](issues/08-app-composition-root.md): `start(options)` 收 homes **路径**
  （settingsHome / modelsHome 补齐、**会话 store 随 settingsHome 派生**、MY_AGENT_SESSION env
  回退保留），不收 toolManager / sink；07 的遗留裁决——工厂与 HubOptions 的 homes 换**端口注入**，
  工厂活下来（managers 仍由它构造）、hub 原样换类型面、`AGENT_HOME` 出 domain 归 app；desktop
  包名动态 import、四个调用选项不变；dev 薄脚本 `packages/app/scripts/serve.ts` 收
  `--vite` / `--port` / `--workDir`（smoke-boot 子进程半改 spawn 它）、根 dev / start 委
  workspace；app 不装信号 handler、close 编排留 start、`shutdown.cjs` 不动。
- [迁移顺序与验收编排](issues/09-migration-order.md): 六步纯移动先行、翻面后置——骨架（tsconfig
  加法一次到位）→ core→domain（protocol.ts 解散随步）→ server 三分（依赖方向守卫诞生并取代
  facade 守卫、**boot 与 approval 两处 main.ts spawn 点都换 serve.ts**，08 漏了后者）→
  ContextManager（子包隔离规则激活）→ 端口化+组合根**一步翻面**（removeGate 保持模块级导出、
  migrateLegacyStore 随迁 infra、12 个 smoke 文件 13 处 setSessionsDir 调用改形）→ 终验 README
  全清单+文档收尾。基础门 = check + 四条自足 headline（tools/sessions/models/mux），smoke-api
  从步 3 入列；smoke 全留根 scripts/；守卫自写静态 import 扫描（不加 dependency-cruiser）；每步
  同步落笔该步已为真的 ADR 修订、大重写归步 6。

## Not yet specified

- 迁移每一步的具体文件清单——09 已定步序与每步的移动形状；文件级清单（哪些文件进哪步、
  精确的 import 重指面与包名/子路径导出表）归票 10 撰写 spec 时列全。
- 五个 workspace 的包名（`@my-agent/*`）与依赖声明清单、tsconfig / project references 调整——
  机械活，倾向并入 spec 撰写（10）时顺手定，若发现牵扯决策再升 ticket。

## Out of scope

- **执行重构本身**（搬代码）——目的地就是 spec，执行是 spec 走完后的下一个 effort。
- **desktop / web 客户端的内部改动**——desktop 只把服务器来源换到 app（依赖声明与 import
  指向、import 失败接 observability，08），外壳自身逻辑不动，web 不动。
- **llm 传输层的重写或再端口化**——`ChatTransport` 已是它的缝，llm 包原样搬进 domain。
- **委派（子代理）、插件、MCP** 等功能演进——AGENTS.md 规则明确第一版不做。
