# 07：AgentState 与 Live——新增类型与构建链（不接线）

Type: task
Status: open
Blocked by: 01, 03

## Question

新增 `packages/core/src/session/agent-state.ts`，把类型与构建链立起来，**但不改任何调用方**（本票收账时
`npm run check` 必须是绿的，旧路径继续跑）。

```ts
export interface AgentState {
	readonly listeners: Set<SessionListener>;
	readonly eventListeners: Set<SessionEventListener>;
	readonly setting: SettingsState;
	readonly session: Session;
	readonly live: Live;
}

export interface Live {
	steeringQueue: PendingMessageQueue;
	followUpQueue: PendingMessageQueue;
	activeRun?: ActiveRun;
	partial: Message | undefined;
	model?: Model;
	retrying: boolean;
	retryAttempt: number;
	suspended: boolean;
}
```

- **构建链**：`createAgentState(session, setting, live)`；调用顺序在 08 票里定死为 `fillSession` → `fillSettings`
  → `createLive`。先会话后设置，因为**会话记着自己选了哪个模型与思考模式**（`session.sessionSetting.model`），
  设置只提供兜底的默认行名与重试参数。
- **`Session` 的形状**（用户指定）：

  ```ts
  sessionId, sessionFileAbsPath?, sessionDirAbsPath, persist, fileCreated,
  jsonlEntries, sessionEntryMapById, leafId,
  sessionSetting: {
    workDirAbsPath,
    parentSessionId?,
    title?,
    model?: { name: string; modelId: string; thinkingLevel?: string },
    activeTools?, approval?,
  }
  ```

  这是把现在的 `meta`（version / id / timestamp / workDir / parentSession / title / model / thinkingLevel /
  activeTools / approval）与顶层的 `workDirAbsPath` 重新分组。**盘上 `.json` 形状不动**：`sessionSetting` 是
  内存分组，`writeMetaFile` / `fillSession` 是唯一的翻译点，`version` 不升、旧会话不删。
- `thinkingLevel` 收进 `model`（用户指定）：`fillSession` 读盘时合并，`writeMetaFile` 写盘时拆开。
- 导出从 `packages/core/src/index.ts` 加上；`OpenSessions` / `OpenSession` / `SessionRuntime` 的导出本票**先不动**
  （14 号票删）。
- 收账：`npm run check` 绿（新类型无调用方即为空转），`node scripts/smoke-sessions.ts` 不受影响。

## Answer
