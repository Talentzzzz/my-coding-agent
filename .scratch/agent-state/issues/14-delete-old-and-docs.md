# 14：删旧类型与死代码，文档收账

Type: task
Status: open
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
