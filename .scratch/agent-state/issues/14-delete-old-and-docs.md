# 14：删旧类型与死代码，文档收账

Type: task
Status: resolved
Blocked by: 06, 10, 11, 12, 13

## Question

四层旧结构清零，文档与实况对齐。

- 删 `packages/core/src/session/open-session.ts`（`OpenSessions` / `OpenSession` / `createOpenSession` /
  `OpenSessionSeed`）；删 `session-runtime.ts`（`SessionRuntime` / `createSessionRuntime`）；
  `RunScope` 与 `retryMaxAttempts` 已由 09 号票删除，此处只清残留引用。
- `packages/core/src/index.ts` 的导出：去 `OpenSessions` / `createOpenSession` / `OpenSession` /
  `SessionRuntime`，加 `AgentState` / `Live` / `createAgentState`。
- `session-factory.ts`：`ensureSession` / `createSessionAgent` / `openAgent` 三个入口的注释与参数按新链路重写
  （`SessionServices` 只留 `sessionManager`，或直接消失）。
- 全仓 grep 清零：`OpenSessions`、`OpenSession`、`openSessions`、`SessionRuntime`、`RunScope`、`stateOf`、
  `adopt`、`retryMaxAttempts`（保留 `docs/adr/0006`、`0007`、`0008` 里的历史叙述，它们标了 Superseded）。
- ADR-0011 状态行由「尚未落地」改为已落地；`docs/adr/README.md` 清单行补「已落地」。
- `docs/architecture.md` 五处与最终代码逐句核对（06 号票写的可能是「计划时」的措辞）。
- `AGENTS.md` 术语表逐条核一遍：`service`、`AgentState`、`assembly`、`claim`、`workDirAbsPath`（现在从
  `sessionSetting` 取，路径描述要改）、`mode`、`fork`。
- 收账：`npm run check` 绿 + `npm run build:web` 绿。

## Answer

### 结论（一句话）

`open-session.ts` 与 `session-runtime.ts` 整文件删除（`ActiveRun` 是唯一的活口，随 `Live` 并入
`agent-state.ts`，index.ts 的导出跟着搬家）；全仓代码 grep 清零，剩余命中全在 ADR 的历史叙述里；
ADR-0011 状态行与 README 清单行翻转为「已落地」；architecture.md 逐句核到 ADR-0011 之后的现实
（core / server 职责、装配与设置、闸门例外、谁拥有一个会话、ASCII 图五处），AGENTS.md 术语表七条
逐条核过、`OpenSessions` 词条换成 `AgentState`；`check` 与 `build:web` 绿，五条 smoke 复跑全绿。
附带把 11 号票的 Status 字段补成 resolved（Answer 早已写完，状态漏翻）。

### 落地形状

- **删除**：`session/open-session.ts`（`OpenSessions` / `OpenSession` / `createOpenSession` /
  `OpenSessionSeed`）与 `session/session-runtime.ts`（`SessionRuntime` / `createSessionRuntime`）。
  `ActiveRun` 仍被 `Live.activeRun` 与 index.ts 导出需要，原样搬进 `agent-state.ts`（含 doc）——
  它本来就该住在状态的形状旁边；`agent.ts` 只以对象字面量赋值 `live.activeRun`，不需要改。
- **index.ts**：三行合成一行 `createAgentState / createLive / ActiveRun / AgentState / Live`，
  `SessionRuntime` 与 `OpenSessions` 两行整行删除。「加 AgentState / Live / createAgentState」
  在早前票里已就位，本票只补 `ActiveRun` 的新家。
- **session-factory.ts 零改动**：三个入口（`assembleSession`（原 `ensureSession`，票 07 已改名）/
  `createSessionAgent` / `openAgent`）的注释与参数在落地票里已按新链路重写（`SessionAgentServices`
  只剩 `sessionManager` + `models` + `tools?` + `api?`），核对无误。
- **grep 清零与豁免裁定**：代码（packages/ scripts/）、AGENTS.md、README、architecture.md、
  docs/agents/ 全部零命中。保留的历史叙述共三组，票面只豁免了 0006/0007/0008，另两组按同一
  理由扩免：**0011** 是记录本次删除的 ADR，它的 `OpenSessions` / `RunScope` / `SessionManager.adopt`
  提及全是「被删的是什么」的叙述本体；**0003** 的两处 `RunScope.writtenAhead` 在带日期的
  「修订」小节里，叙述的是当时被替换掉的机制（其 2026-11-03 修订自己写明该机制已删）——改写
  它们等于篡改修订史。0006/0008 的状态行未动（票面只要求保留叙述）；0007 已自带指向 0011 的
  「取代者」行。
- **architecture.md**：不止票面说的五处——第 19/21 段（core / server 职责）、「装配与设置」
  （Agent 构造收什么、工厂代码块、`SettingsManager` 段落改写为 `fillSettings` + `AgentState.setting`）、
  闸门例外（`RunScope.suspended` → `live.suspended`）、「谁拥有一个会话」（hub 段 + ASCII 图
  `OpenSession` → `AgentState`）——凡提到登记处 / 条目 / `stateOf` 的句子全部对齐到
  「状态表在编排层手里、`adopt` 进 `evict`/`drop` 出、workDir 从 `sessionSetting` 取」。
- **AGENTS.md 术语表**：`service`（设置不再是 Manager：函数族 + 每会话一只袋）、`engine`
  （`entry.runtime.activeRun` → `state.live.activeRun`）、`settings`（`fillSettings` 每次现读一份
  快照）、`assembly`（assembleSession 装配出 AgentState，openAgent == assemble + create + adopt）、
  `workDirAbsPath`（改从 `session.sessionSetting.workDirAbsPath` 取）、`AgentState`（新词条，替换
  `OpenSessions`）七处重写；`claim` / `mode` / `fork` 逐条对过代码，原文照准。`docs/agents/domain.md`
  的术语索引 `OpenSessions` → `AgentState` 联动改名。

### 验证

- `npm run check` 绿（core / server / web tsc + token 审计）；`npm run build:web` 绿。
- smoke-session / smoke-settings / smoke-liveness / smoke-mux / smoke-approval-recovery 全绿
  （覆盖装配链、状态表、mux 生命周期、审批恢复四条被本票间接碰到的路）。

### code-review 记录

两轴跑完：Spec 轴零缺失、零实质错误（唯一发现即上述豁免裁定，已记档）；Standards 轴零硬违规、
三处 judgement call 均不动——`createAgentState(session, setting, live)` 的三参形状是链的收拢点
（doc 已写明顺序不是自由的）、`AgentState.setting` 单数名是 glossary 钉死的术语、domain.md
「一句话」的说法与词条变长是既有模式。
