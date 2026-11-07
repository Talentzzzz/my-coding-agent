# Map：hub 只认 Agent

Label: `wayfinder:map`

## Destination

server 包（`hub.ts`、controllers、`projection.ts`）不再 import、不再持有、不再转递任何 Manager
（`SessionManager` / `SettingManager` / `ToolManager`）：`Agent` 成为进程里 Manager 的唯一消费者，
hub 及以下只通过 Agent 的公开方法操作会话。构造由 `createSessionAgent()` 吸收（收 homes + api，
自己造三个 Manager），Agent 公开面新增三类方法（会话生命周期含 cold 路径、窄状态读、设置与模型
目录）。收账包括一条新 ADR 与 AGENTS.md 术语表修订，`npm run check` 与全部 smoke 保持绿。

## Notes

- 动手前先读 `docs/architecture.md` 对应小节；术语见 AGENTS.md「service / engine / assembly /
  AgentState」各条——本次改动会修订其中「hub 协调五个服务」的叙述（ADR-0007 §6）。
- 技能：每个 grilling ticket 调 `grilling` + `domain-modeling`；决策由用户本人作答，不代答。
- 形态底线（已定，不再重开）：
  - Q1 目的地边界 = 整个 server 包不知道 Manager（不是只改 hub.ts 一个文件）。
  - Q2 Agent 公开面三类方法都进：① 会话生命周期（含 cold snapshot / fork / remove / setTitle 的
    held-cold 两路统一）② 窄状态读（`workDirOf` / `timestampOf` / `fileAbsPathOf` /
    `isSubmitting` 一类，替代 `agentState().session.*` 直读）③ 设置与模型目录（`modelCatalog` /
    `replaceModels` / `hiddenDirectories` / `applySettings`），方法保持无状态、现读现写。
  - Q3 构造 = `createSessionAgent()` 吸收：收 `{ settingsHome, modelsHome, api }`，自己造三个
    Manager；HubOptions 缩成 `{ workDirAbsPath, sessionId, settingsHome, modelsHome, api }`；
    smoke 的注入接缝（in-memory settings、scripted transport）迁到新构造口，不丢失。
  - Q4 出一条新 ADR（修订 ADR-0007 §6 的 hub 叙述），AGENTS.md 术语表同步。
- 本仓库约定：改完跑 `npm run check` + 对应 smoke；文档中文、注释英文；编辑器工具改文件。

## Decisions so far

<!-- the index: one line per closed ticket, enough to judge relevance, then zoom the link for the detail -->

- [01 Agent 公开面清单与签名](issues/01-agent-facade-surface.md)：三类 19 个新方法定名定签（① 生命周期
  七个 held/cold 统一、② 窄读五个 held-only 纯数据、③ 设置四名 + `settings()` 转发）；扫描类静态方法
  由 Agent 转发、`hub.tools` 删、`sessionOptions` 对进 Agent 私有；cold 契约 per-method doc；
  `open(options)` 本票不动，留票 04。
- [02 createSessionAgent 吸收构造](issues/02-create-session-agent-construction.md)：工厂签名
  `{settingsHome?, modelsHome?, api?, settings?, tools?}`（后两 test-only 缝），SessionAgentServices 退役，
  AgentConfig 构造器不动、一条构造路；HubOptions 收五字段、boot 零改动；hub 级 smoke 改临时 homes +
  throwaway SettingManager 播种；`Agent.sessionManager`/`.settings` 字段本票保持公开（smoke 消费，票 04 一并看）。
- [03 机械守卫](issues/03-mechanical-guard.md)：check 脚本扫描（裁定 A；B 因 core/server 同 tsconfig
  不可行、C 会烂）。范围仅 `packages/server/src`：导入禁十名（含 `OpenAgentOptions`/`AgentState`/`Session`
  ——纯数据裁定的机器化）；成员访问禁 `.agentState(` / `.sessionManager` / `.settings`（排除方法调用形态，
  `.tools` 不进名单）。新 `scripts/check-server-facade.ts`，`npm run check` 追加一步，中文报错带 file:line。
- [04 core 实施](issues/04-core-agent-facade-and-construction.md)：门面三类 + 构造吸收落地（189b5a0）；
  check 全绿所迫，hub/controllers/projection 的机械迁移一并完成——票 05/06 收缩为注释改写。
  四处偏离记录在票：pins 保留（票 02 清单漏了 boot 的 `--model`）、增补窄读 `messageRoleOf`、
  `Agent.settings` 字段改名私有 `settingsManager` 让位门面方法、`agentState()` 加 `@deprecated`
  收口随票 07。
- [05 hub 重写](issues/05-hub-rewrite.md)：hub.ts 注释按新形态改写并引用 ADR-0017（新号，票 08
  必须占用）；「the store」措辞清零、fork 文档的「Only `close` moves the table」残留重写。
  票外偏离：摘除零读者死字段 `HostedSession.workDirAbsPath`（fork 源路径解析已进门面），
  连带 `workDirOf` / `fileAbsPathOf` 零消费者、去留随票 07。
- [06 controllers 与 projection 迁移](issues/06-controllers-projection-migration.md)：机械迁移随票 04
  落地，本票做剩下的注释改写——controllers 的「hub already owns」/「thin call onto the session the
  hub holds」/「the store」各处与 projection 的「appended through the hub」/「store」口径改为
  orchestrator + 门面（ADR-0017），顺手修 restoreDirectory 缩进残缺行与 projection 的 EOF 换行；
  按票 03 禁名单口径核对 server 侧为零。零行为变更。

## Not yet specified

- assembly / `openAgent()` 公开面是否跟着收：AgentState 不出 core 之后，`assembleSession` 的产物
  与返回类型怎么看——票 01 已定下 server 需要的面（create/adoptFromDisk 返回 id），问得尖了：票 04。
- 既有 smoke 对 `agentState()` / `sessionManager` 的直读断言如何逐条改写（smoke-sessions、
  smoke-projection、smoke-approval、smoke-session、smoke-tools 各有触点）——方法清单已有（票 01），
  逐条改写落在票 03（guard）与票 07（验收）。

## Out of scope

- 传输层不动：REST 命令面与 mux 的形状照旧（ADR-0001），端点与帧类型零改动。
- ADR-0016 的 ToolManager 实例表形态不动，变的只是它的消费入口（改为 Agent 经 `ToolManager`
  转发，hub 不再持表）。
- SessionManager / SettingManager 的内部形态不动（无状态门面、每读现取）。
- 委派 / 插件 / MCP 照旧不做（AGENTS.md 规则）。
