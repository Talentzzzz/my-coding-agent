# 08:SessionManager 无状态化——SessionState 每请求重放

Type: task
Status: resolved
Blocked by: 07

## Question

把 `packages/core/src/session/session-manager.ts`(约 2100 行)从「每会话一个
有状态实例」改造为无状态单例 + 纯数据状态:

- 拆出 `SessionState` 纯数据接口:`{ sessionId, absSessionFile?, absSessionDir,
  absCwd, persist, fileCreated, jsonlEntries, sessionEntryMapById, leafId }`
  (字段以现有 `session-manager.ts:1086-1102` 的私有字段为准)。
- `SessionState` 是**每请求瞬态**:由重放函数从文件现建(现 `loadJsonlEntries`
  + `buildIndex` + header 读取的组合),请求结束即弃;追加写入即时落盘。
- 全部方法改首参收状态:`appendEntry`、`branch`、`getBranchPoints`、
  `buildSessionContext`、`persistEntry`、`rename`、标题派生、compaction 相关。
  逻辑零改动,`this.x` → `s.x`。已有先例:`buildSessionContext(map, leafId)`
  本来就是文件级函数(约 :597)。
- 现有的 `loadSessionFile` / `loadEntries` / `buildIndex` 组合收拢为一个
  「重放」入口(即 fillSession),供 Agent 编排层每请求调用。
- 本票**只动** `packages/core/src/session/`,不改调用方(session-factory /
  hub 在票 13/14/16 适配);`npm run check` 通过、`smoke-sessions.ts` 通过
  (可能需要为新的无状态调用形态补 smoke 适配)。

不变式红线(搬移时不得破坏):appendEntry 顺手 buildIndex;branch 移 leaf 且
树不随 leaf 变形(anchor 语义);rename 文件序最后一条赢;compaction 每步一条
entry、文件保留全文。

## Answer

已落地,`npm run check` 与全套 smoke(smoke-sessions / smoke-tools / smoke-models / smoke-api / smoke-mux)通过。

- `SessionState` 纯数据接口按原私有字段拆出(`sessionId / absSessionFile? / absSessionDir / absCwd / persist / fileCreated / jsonlEntries / sessionEntryMapById / leafId`),`SessionEntryMapById` 一并导出。
- 全部操作改为首参收 `s: SessionState` 的文件级函数,逻辑零改动(`this.x` → `s.x`):写侧(`persistEntry`、`appendMessage`…`appendTrimToolCallArgs`、`appendRename`、`appendCompaction`)、遍历(`getBranchPoints`、`buildContextEntries`、`buildSessionContext`、`getRecordedSettings`、`getRecordedToolConfig`、`getTitle`…)、分支(`branch`、`resetLeaf`)。原有的 map 级私有 `buildContextEntries(map, leafId)` / `buildSessionContext(map, leafId)` 收拢进新的状态级导出函数。
- `loadSessionFile / loadEntries / buildIndex` 收拢为重放入口 **`fillSession(absFilePath)`**;另备 `createSessionState` / `inMemorySessionState` 两个建态函数,`forkFrom` 末尾也走 `fillSession`。
- `SessionManager` 收成薄壳门面:全部 34 个实例方法 + 静态方法签名不变、一行委托,调用方(session-factory / hub / agent / subagent / snapshot / tool-config)零改动,留给票 13/14/16 迁移。
- 无状态调用形态补进 `smoke-sessions.ts`(建态→追加→重放→分支→与门面对账一段);core 的 `index.ts` 导出新的无状态面。

## Comments

- 双轴 code-review(Standards/Spec)通过:Spec 七点全部符合、门面签名逐一核对无遗漏;Standards 仅一处文档措辞矛盾(createSessionState "Nothing is written here" vs 实际会 mkdir 目录),已修正。其余为判断类意见(三处状态字面量构造、导出面较宽——均为过渡形态的有意为之,门面类 doc 已声明迁移意图)。
