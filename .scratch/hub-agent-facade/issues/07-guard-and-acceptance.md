# 07 守卫落地与全量验收

Type: task
Status: closed
Blocked by: 03, 05, 06

## Question

按 03 的决议落地机械守卫；跑 `npm run check`、`npm run build:web` 与全部 smoke（smoke-tools、
smoke-models、smoke-sessions、smoke-api、smoke-mux、smoke-approval、smoke-session、
smoke-projection），与改动前逐条同色、零新红。smoke 里对 `agentState()` /
`sessionManager` 的直读断言按 fog 里对应的对应关系改写。

## Answer

已落地。守卫脚本、断言改写、公开面收口三件一起；`npm run check` 与 `npm run build:web` 绿，
八条验收 smoke 与改动前逐条同色（详见「验收」）。

### 机械守卫（按票 03 的裁定，逐条对齐）

`scripts/check-server-facade.ts`，`npm run check` 在 check-tokens 之后追加一步。范围仅
`packages/server/src/**/*.ts`，扫描前剥掉注释（防将来解释守卫的文档注释误报）；导入禁十名、
成员访问禁 `.agentState(` / `.sessionManager` / `.settings`（方法调用形态 `.settings(` 与
`.settingsHome` 一类靠 `\b` 与负向预查排除，当前 server 源码零误报实测）。报错按票面格式，
简体中文带 `file:line`。正反两侧都验过：干净树上 `server facade ok`；埋了五处违例的临时
fixture 逐条报出、exit 1（fixture 已删）。

### smoke 断言改写（按雾条目与票 01 的映射）

- **三处 `sessionFileAbsPath` 直读改 `fileAbsPathOf(id)`**：smoke-session:962、smoke-tools:690、
  smoke-sessions:217——票 01 窄读表的原配。
- **smoke-projection 的 `leafId` 直读改 `agent.snapshot(source).leafId`**：`SessionSnapshot` 本来
  就带 `leafId`，`snapshot` 是既有公开面（同步、held-only），无需新方法。
- **两处状态对象身份断言改私有表 probe**：smoke-sessions 的 `entryOf` 从收 hub 改为收 `Agent`
  （九个调用点跟改），`bagOf` 播种缝改经 `entryOf` 取袋；smoke-approval:473 的
  「the state the table holds is the one the session was mounted with」就地 probe。身份是编排层
  私有表的事，门面只给纯数据，probe 是这些断言唯一诚实的读法（smoke-sessions 原有条目注释里的
  去向即此）。smoke-sessions:896 的 try/catch 拒答断言（原读 `agentState` 抛错）改行为断言
  `!agent.has(id)`。
- **smoke-projection 的 `resetLeaf` 改经新本地 probe `heldBagOf`**：test-only 手术，门面没理由
  拼这个方法，袋子从私有表 probe 取。

### sessionManager 缝口：保留（雾条目的另一半答案）

`getEntries` / `getRecordedSettings` / `appendMessage` 播种 / smoke-stream 的写补丁（sabotage）
读的都是袋子本身，票 01 的窄读清单本来就不含它们的对应物——这正是票 02/03 裁定 scripts 保留
Manager 访问的缝。`Agent.sessionManager` 字段因此保持公开，文档改写为缝口径（生产调用者没有
这条路，门面转发一切）。

### 公开面收口（票 04 的顺延）

- **`agentState()`：公开 `@deprecated` → `private`**。core 内部 `this.agentState` 调用不变；
  改写后 scripts 侧零消费者（唯一残留是守卫自己的禁名单字符串）。`has` / `AgentConfig.sessionManager`
  / `sessionManager` 字段三处引用它的文档同步改写。
- **`fileAbsPathOf` 留**：本次改写给它三个消费者；文档里「A fork names the source by this path」
  的旧说法按票 05 的指认改掉（fork 的源解析在门面内部）。
- **`workDirOf` 删**：全仓零消费者（hub 改造后它的唯一用途蒸发，票 05 连带标记在此收口）。
  对票 01 窄读清单的偏离，由票 05「两者去留随票 07」的授权落定，票 08 的 ADR 记这一句。

### 验收

- `npm run check`（tsc ×2 + tokens + **新守卫**）绿；`npm run build:web` 绿。
- 基线（改动前）与验收各跑八条：smoke-tools / smoke-models / smoke-sessions / smoke-session /
  smoke-projection / smoke-api / smoke-mux 稳定绿；**smoke-approval 两侧同色**——预存在闪失
  「the model's closing answer is in the transcript」（第一节，wire 层偶发非 JSON 下行，票 04
  已在未改基线上复现）基线三次一过、验收三次一过，基线侧另复现一次 segfault。零新红。
- 加跑十四条 hub 相关 smoke（approval-endpoint / approval-recovery / approval-queue / stream /
  boot / settings / modes / mux-client / mux-live / liveness / backpressure / branch / replay /
  default-model）全 PASS。

