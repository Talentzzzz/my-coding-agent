# 07：AgentState 与 Live——新增类型与构建链（不接线）

Type: task
Status: resolved
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

### 结论（一句话）

票面四件事全部落地：`packages/core/src/session/agent-state.ts` 立起了 `AgentState` / `Live` / `createLive` /
`createAgentState`，`Session` 在内存里重新分组为 `sessionSetting`（thinkingLevel 收进 model），盘上 `.json`
形状一字未动，`npm run check` 与 `smoke-sessions` / `smoke-tools` / `smoke-models` 全绿——旧路径照跑，
调用方一处未接线（08 的活）。

### 落地形状

- **agent-state.ts**（新，全部从 `packages/core/src/index.ts` 导出；`OpenSessions` / `OpenSession` /
  `SessionRuntime` 的导出本票未动，按票面留给 14）：
  - `AgentState` 与 `Live` 逐字段照票面的形状；`Live` 的字段可变（运行期原地写），`AgentState` 的五条
    readonly。`createAgentState(session, setting, live)` 把三份已填好的半边装成一袋，订阅集从这里建空。
  - **`createLive(setting)` 也归了本票**：构建链的第三步 `fillSession → fillSettings → createLive` 里前两步
    已存在（`session-manager.ts` / `settings-manager.ts`），缺的只有 live 的构造——队列模式取自
    `getSteeringMode` / `getFollowUpMode`，与 `createSessionRuntime` 同一句话。接线（谁调这条链）仍归 08，
    本票零调用方。
- **`Session` 重新分组**（`session-manager.ts`）：`meta` 与顶层 `workDirAbsPath` 撤掉，换成
  `sessionSetting: SessionSetting`（新接口）。**票面形状的两处偏差，各有硬理由**：
  1. **`timestamp` 留在内存顶层**（票面形状没有它）：盘上 `.json` 带着创建时刻，而文件名把它
     `[:.] → -` 地篡改过，从名字恢复是有损的；丢了它，每次快照重写都会把会话的创建时间改掉。
  2. **`model` 的三个字段全部可选**（票面写 `name: string; modelId: string`，03 只把 `modelId` 放开）：
     盘上合法地存在「记了 thinkingLevel、没记 model 行」的会话（`recordSelection` 在目录查不到行时就写出
     这种状态），内存必须无损装下它，`name` 因此也得可选。拆开时只有 `name` 与 `modelId` 双双在场才写
     `model` 行（`recordedModelOf`），对盘上一切合法状态无损。
  - **`version` 不留内存**：`readMetaFile` 对任何非本构建版本直接抛，能进内存的 `version` 恒为常量，
    `metaOf` 写盘时现取 `CURRENT_SESSION_VERSION`。**`parentSessionId` 沿用票面定的名字，值仍是盘上
    `parentSession` 的那份——源 `.jsonl` 的绝对路径**（名字来自状态形状，值随盘，旧会话原样读）。
- **唯一的两个翻译点**：`sessionSettingOf`（fillSession 读盘合并）与 `metaOf`（`writeMetaFile` 写盘拆开、
  `getMeta` 按同一形状作答）。`getMeta` 从「回 `s.meta` 引用」变成「现造一份」——snapshot 与 smoke 只读，
  无行为变化，顺带消灭了别名。`recordMeta` 的四个回调改作用于 `sessionSetting`；`forkFrom` 读写的是盘上
  扁平 meta，一行未动。

### 「不改任何调用方」的一处例外

hub.ts 有四行是**机械路径修正**（`state.workDirAbsPath` → `state.sessionSetting.workDirAbsPath`，
`:361` / `:371` / `:564` / `:695`）：分组删掉了顶层字段，而票面自己的收账（`npm run check` 绿）在保留这四行
旧路径时不可达。没有任何接线混进来——`ensureSession`、装配、登记处全部原样。

### 验证

- `npm run check` 绿；`smoke-sessions` / `smoke-tools` / `smoke-models` / `smoke-mux` 全绿（`smoke-api`
  在本机环境连不上 mux，与改动无关——stash 后在干净 master 上同样失败）。
- 另加一份一次性核对（`.scratch/agent-state/level-roundtrip.mjs`）：旧盘上「只有 thinkingLevel」的会话
  读入为 `model: { thinkingLevel }`、`getMeta` 原样回出扁平形状、改档重写后盘上仍是 `thinkingLevel` 单独
  一字段且身份字段未动、fork 的 `parentSession` 经 `parentSessionId` 往返无损。唯一差异是重写时键序按
  `metaOf` 的规范序排（原来追加的键在文件尾），语义与字段集合不变。

### code-review 记录

两轴（Standards / Spec）均无硬违规。Standards 的几条 judgement call 归属：`agent-state.ts` 暂无调用方
与 `Live` / `SessionRuntime` 的字段重叠都是票面安排（07 不接线、08/14 换掉旧袋）；`parentSessionId` 的
名字与 `sessionSetting` 的命名沿票面/用户指定，JSDoc 已把「值是路径」写在定义处。
