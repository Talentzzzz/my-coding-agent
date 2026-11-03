# 票 01：SessionHeader 与 11 种 entry kind 的全仓触点清单

调查日期：2026-11-03。一手来源为仓库源码（packages/core、packages/server、packages/web、scripts；`pi-main/` 是 vendored 上游参考树，不参与本仓构建，仅在文末注明一处）。行号以当前工作区为准。

去向四档：
- **消失**：类型、读写逻辑、测试一起删。
- **改道 JSON**：值迁 `<id>.json` 当前值，写点改为 JSON 原子重写，读点改为读 JSON。
- **原样保留（JSONL）**：留在 `<id>.jsonl` entry 流，读写不动（或仅随文件装配微调）。
- **待定**：拆分本身引入的新决策，留给票 02–05。

---

## SessionHeader（session-manager.ts:47-62）

| 触点 | 文件:行 | 写/读 | 去向 |
|---|---|---|---|
| 类型定义与 `JsonlEntry` union、`isSessionHeader` | session-manager.ts:47,260,273-275 | — | 改道 JSON（类型随字段进 JSON；union 与判别函数消失） |
| 构造 header（新会话） | session-manager.ts:1193-1212 `newSession` | 写（占 `jsonlEntries[0]`，首条消息过 gate 时随全量写出 persistEntry:1254-1262） | 改道 JSON（写入 `<id>.json`） |
| 构造 header（fork） | session-manager.ts:1921-1930 `forkFrom` | 写（`writeFileSync` 第一行 + parentSession=源文件路径） | 改道 JSON（fork 复制/新建两文件，map 拍板⑥） |
| 全量读文件时拒绝无 header 的文件 | session-manager.ts:652-655 `loadJsonlEntries` | 读 | 改道 JSON（校验移到 JSON 侧） |
| 读第一行 header（有界读 + 超限拒绝） | session-manager.ts:587-592,671-714 `readSessionHeader`/`parseSessionHeaderLine` | 读 | 消失（不再有「第一行」；改为读 `.json`） |
| 发现用 header 读取（best-effort） | session-manager.ts:716-723 `readSessionHeaderForDiscovery` | 读 | 改道 JSON |
| 旧 `cwd` 字段兼容 | session-manager.ts:725-731 `getSessionHeaderWorkDir` | 读 | 消失（不考虑兼容） |
| workDir 匹配 | session-manager.ts:733-735 `sessionWorkDirMatches` | 读 | 改道 JSON（逻辑保留，数据源换） |
| 最近会话发现 | session-manager.ts:738-761 `findMostRecentSession`（748 读 header 过滤 workDir；754 `hasMessageEntry` 过滤空会话） | 读 | 改道 JSON（workDir 读 `.json`；`hasMessageEntry` 仍需 JSONL） |
| listing：id/workDir/parentSession/created | session-manager.ts:814-907 `buildSessionInfo`（854-858 header 必须第一行；883 header.timestamp 作 modified 兜底；893-896） | 读 | 改道 JSON（见「连带」#4：listing 拆两半） |
| 重放进 state | session-manager.ts:1156-1179 `fillSession`（1164-1170） | 读 | 改道 JSON（id/workDir 从 `.json` 读） |
| 快照 header 读取 | session-manager.ts:1789-1791 `getHeader` → snapshot.ts:70,75,90 | 读 | 改道 JSON（snapshot.createdAt、snapshot.parentSession 数据源换，wire 字段不变） |
| 目录列表分组 | session-manager.ts:1959-1984 `listDirectories`（1974-1976） | 读 | 改道 JSON |
| 单行查找 | session-manager.ts:1996-2010 `findSessionRowById`（2005 读父 header）；2020-2043 `findSessionFilePathById`（2035 逐文件读 header 匹配 id） | 读 | 改道 JSON（id 匹配改为读 `.json`，比读 JSONL 第一行更便宜） |
| 派生 wire 字段 | session-manager.ts:2100-2108 `toSessionRef`（createdAt）；protocol.ts:22-51 `SessionRef`/`SessionRow`；protocol.ts:230-231,276 `SessionSnapshot.createdAt/parentSession` | 读 | 改道 JSON（wire 形状不变） |
| web 渲染 | render/sidebar.ts:625-626（row.createdAt 分组日期）；sidebar.ts:928,942-943（fork 树 title 继承） | 读 | 原样（web 只见 wire 字段，不触文件） |
| smoke fixture | smoke-session.ts:2296（手写 `version: 4` header fixture）；smoke-tools.ts:493,880（`CURRENT_SESSION_VERSION` fixture） | 写（测试） | 改道 JSON（fixture 需重写为 `.json`；version 升 5 后写死 4 的 fixture 必改） |

## message（session-manager.ts:71-74）→ **原样保留（JSONL）**

| 触点 | 文件:行 | 写/读 |
|---|---|---|
| append | session-manager.ts:1397-1407 `appendMessage` | 写 |
| Agent 写入（唯一汇聚点） | agent.ts:2746-2760 `Agent.appendMessage`（finalizeToolResult 在写边界）；调用方：用户消息 2297-2307 `startPromptedRun`、deny 结果 2296-2305、队列 drain 2635-2644 `drainTranscribed`、engine `message_end` 2667-2673 `dispatchEvent` | 写 |
| 落盘 gate | session-manager.ts:1236-1241 `hasConversation`（首条 user/assistant 才建文件） | 读 |
| 空会话过滤 | session-manager.ts:768-778 `hasMessageEntry`（findMostRecentSession 用） | 读 |
| model 兜底 | session-manager.ts:470-476 `getSessionContextSettings`（assistant message.model 作 wire-id 兜底）；1744-1748 `getRecordedSettings` | 读 |
| 请求构建 | session-manager.ts:492-505 `sessionEntryToContextMessages`；1723-1728 `buildSessionContext` | 读 |
| 树/分支 | session-manager.ts:1314 `subtreeDescription`、1620 `isCard`、1648-1650 `nearestPrompt`、1780-1787 `getContextMessageEntryIds` | 读 |
| 审批悬空派生 | dangling.ts:20-42 `danglingApprovalsOf`（toolCall/toolResult 按 branch view 配对） | 读 |
| usage 汇总 | snapshot.ts:101-106 `entryUsage`（assistant usage）；131-140 `branchContextTokens` | 读 |
| stamp 下限 | agent.ts:2565-2573 `nextStamp` | 读 |
| server 事件 | mux.ts:416,481-489 `pushEntry`→`entry` 帧；hub.ts:399-404 `timestampOf`（仅 message entry 有时间戳）；projection.ts:186-195（message entry 推 modified/title） | 读 |
| web 渲染 | state.ts:750-930（snapshot.messages 重放；864-873 `compactionSummaryOf` 识别摘要；921 assistant usage）；rows/transcript 全部 | 读 |
| smoke | smoke-stream.ts:139-147（monkey-patch appendMessage）、smoke-approval-recovery.ts:219-220、smoke-session.ts:2277,2296-2300、smoke-tools.ts 多处、smoke-sessions.ts 多处 | 写/读（测试） |

## thinking_level_change（session-manager.ts:76-79）→ **改道 JSON**

| 触点 | 文件:行 | 写/读 | 去向备注 |
|---|---|---|---|
| append | session-manager.ts:1409-1419 `appendThinkingLevelChange` | 写 | 改道 JSON（写 `.json` 的 thinkingLevel 当前值） |
| 请求前记录 | agent.ts:1870-1874 `recordSelection`（与 branch 记录不同才写）+ emit `entry_appended` | 写 | 改道 JSON（改为「值不同则重写 JSON」；`entry_appended` 不再为此 kind 发） |
| branch 恢复 | agent.ts:1891-1898 `applyBranchSelection`（经 getRecordedSettings） | 读 | **待定**：迁 JSON 后 leaf 移动不再改变 thinkingLevel（现在是 branch 上的 entry）；语义变化见「连带」#2 |
| 重放读 | session-manager.ts:466（getSessionContextSettings）、1740（getRecordedSettings:1737-1752） | 读 | 改道 JSON |
| open 时恢复 | session-factory.ts:148-150（getRecordedSettings 决定开场 row/level） | 读 | 改道 JSON |
| smoke | smoke-session.ts:671（注释）、1899（levelsOf 计数断言） | 测试 | 改道 JSON（断言改查 JSON） |

## model_change（session-manager.ts:90-94，modelChangeName:97-99）→ **改道 JSON**

| 触点 | 文件:行 | 写/读 | 去向备注 |
|---|---|---|---|
| append | session-manager.ts:1421-1432 `appendModelChange` | 写 | 改道 JSON（model.name+modelId 当前值） |
| 请求前记录 | agent.ts:1863-1869 `recordSelection` + emit | 写 | 改道 JSON |
| branch 恢复 | agent.ts:1891-1898 `applyBranchSelection` | 读 | **待定**（同 thinking_level_change 的 branch 语义） |
| 旧 `provider` 字段兼容 | session-manager.ts:96-99 `modelChangeName`、467-472 | 读 | 消失（不考虑兼容） |
| 重放读 | session-manager.ts:467-470、1741-1743 | 读 | 改道 JSON |
| open 时恢复 row | session-factory.ts:370-373 `recordedRefOf`、148-150 | 读 | 改道 JSON |
| 树计数注释 | agent.ts:2752（model_change 算 child count 的注释） | — | 措辞随 kind 消失微调 |
| smoke | smoke-tools.ts:388（appendModelChange + getBranchTip）、smoke-session.ts:671,1848-1858 | 测试 | 改道 JSON |

## compaction（session-manager.ts:101-109）→ **原样保留（JSONL）**

| 触点 | 文件:行 | 写/读 |
|---|---|---|
| append | session-manager.ts:1502-1523 `appendCompaction`（firstKeptEntryId 自指规则 1517） | 写 |
| Agent 压缩流 | agent.ts:2418-2497 `compactFor`（2478 append；2488-2495 emit `compaction`；2469 emit `compaction_failed`）；context/compaction.ts:38-114（决策，74-78 读上一 checkpoint） | 写/读 |
| checkpoint 应用 | session-manager.ts:531-552 `contextEntriesFrom`；523-528 `contextEntriesFromPath` | 读 |
| summary → user message | session-manager.ts:506-518 `sessionEntryToContextMessages`；messages.ts:12-36（前缀/后缀标签 + `compactionSummaryOf`） | 读 |
| title 排除 | session-manager.ts:2137-2140 `deriveTitle`（摘要不算用户发言） | 读 |
| usage 汇总 | snapshot.ts:107 `entryUsage`（compaction.usage 计入） | 读 |
| 事件派生 | agent.ts:222-236（`compaction`/`compaction_failed` 事件）→ web state.ts:652,662（渲染 notice） | 读 |
| smoke | smoke-session.ts:744-796（entry 计数）、1777-1794；smoke-sessions.ts:921；smoke-tools.ts:355,817 | 测试 |

## clear_tool_result（session-manager.ts:119-125）→ **原样保留（JSONL）**

| 触点 | 文件:行 | 写/读 |
|---|---|---|
| append | session-manager.ts:1532-1543 `appendClearToolResults` | 写 |
| Agent 清除流 | agent.ts:2532-2553 `clearStaleToolResults`（2544 append；2546-2551 emit `tool_results_cleared`） | 写 |
| 视图应用 | session-manager.ts:554-568 `clearedEntryIds`/`applyClears`（contextEntriesFromPath:526） | 读 |
| 事件 | agent.ts:237-252（事件类型）→ web state.ts:664（notice） | 读 |
| legacy 名映射 | session-manager.ts:601-604 `LEGACY_ENTRY_KINDS`（`prune`→本 kind） | 读 |
| smoke | smoke-tools.ts:996-1002（只写一条）、smoke-sessions.ts:892 | 测试 |

## trim_tool_call_arg（session-manager.ts:135-141）→ **原样保留（JSONL）**

| 触点 | 文件:行 | 写/读 |
|---|---|---|
| append | session-manager.ts:1552-1563 `appendTrimToolCallArgs` | 写 |
| Agent 裁剪流 | agent.ts:2509-2523 `trimRecordedArgs`（2514 append；2516-2521 emit `tool_call_args_trimmed`） | 写 |
| 视图应用 | session-manager.ts:570-584 `trimmedEntryIds`/`applyTrims`（contextEntriesFromPath:525） | 读 |
| 事件 | agent.ts:253-269 → web state.ts:674 | 读 |
| legacy 名映射 | session-manager.ts:601-604（`argtrim`→本 kind） | 读 |
| smoke | smoke-tools.ts:289,1026-1056 | 测试 |

## tool_result_view（session-manager.ts:155-161）→ **消失**

| 触点 | 文件:行 | 写/读 |
|---|---|---|
| 类型定义 | session-manager.ts:143-161（含「legacy read-only」注释）；union 成员 238；index.ts:175 导出 | — |
| 重放应用 | context/tool-result-views.ts:26-38 `applyToolResultViews`（整个文件即为此 kind 存在）；session-manager.ts:26 import、525 调用、151 注释 | 读 |
| 写点 | 无（本构建不写；唯一「写」是 smoke 手写 legacy fixture） | — |
| smoke | smoke-sessions.ts:833-930（legacy 重放整段，含 appendFileSync 手写 entry）、smoke-session.ts:960（反向断言：不写） | 测试 |

删除面：类型 + union 成员 + index 导出 + `context/tool-result-views.ts` 全文件 + `contextEntriesFromPath` 的一层包裹 + smoke-sessions.ts:833-930 整段。

## tool_config（session-manager.ts:173-179）→ **改道 JSON**

| 触点 | 文件:行 | 写/读 | 去向备注 |
|---|---|---|---|
| append | session-manager.ts:1442-1453 `appendToolConfig` | 写 | 改道 JSON（activeTools + approval 当前值） |
| 工具收窄 | agent.ts:2103-2117 `setActiveTools`（2114 append） | 写 | 改道 JSON |
| 审批补丁 | agent.ts:2173-2190 `applyConfig`（2181 append，整张 map） | 写 | 改道 JSON |
| 审批复权记录 | agent.ts:2248-2252 `respondApproval`（grant 记 approval=false） | 写 | 改道 JSON |
| 读（branch 派生） | session-manager.ts:1762-1771 `getRecordedToolConfig`；tool-config.ts:58-66 `toolStateOf`、79-100 `toolConfigFollowsGlobal`、109-121 `followsGlobalOf`；agent.ts:126-129 注释、1293、2092-2094 `emitBranchToolConfig` | 读 | 改道 JSON；**branch 语义变化见「连带」#2** |
| wire | protocol.ts:247（注释）；snapshot.activeTools/approvals/toolsFollowGlobal/approvalsFollowGlobal（snapshot.ts 经 input） | 读 | wire 不变 |
| web 模式匹配 | main.ts:1042-1075 `currentModeName`（snapshot 的 tools/approvals 对 preset 值匹配）、1081-1109 `applyMode`；render/settings.ts:108；state.ts:718-719（config_changed 应用） | 读 | 原样（消费 snapshot，不触 entry） |
| smoke | smoke-tools.ts:649-695（getRecordedToolConfig 与 snapshot 对齐、重开恢复）、smoke-session.ts:1947,2122-2270（branch 落到目标分支的 tool_config）、smoke-sessions.ts:363-430 | 测试 | 改道 JSON；branch 用例语义需重审 |

## leaf（session-manager.ts:190-194）→ **原样保留（JSONL）**

| 触点 | 文件:行 | 写/读 |
|---|---|---|
| append（不推进 leaf） | session-manager.ts:1341-1352 `appendLeafRecord`；调用方 branch:1828-1833、resetLeaf:1836-1840 | 写 |
| 重放定位 | session-manager.ts:1221-1232 `buildIndex`（leafId 恢复规则） | 读 |
| child 计数注释 | agent.ts:2751-2753（leaf 算作 child） | 读 |
| smoke | smoke-session.ts:2260（末条是 leaf）、2286-2310（fixture-no-leaf 无 leaf 记录的重放）、smoke-tools.ts:412（branch tip 落在 leaf record） | 测试 |

## rename（session-manager.ts:205-209）→ **改道 JSON**

| 触点 | 文件:行 | 写/读 | 去向备注 |
|---|---|---|---|
| append | session-manager.ts:1463-1473 `appendRename`（title 已在端点缩短） | 写 | 改道 JSON（title 当前值；ADR-0002 文件序语义被取代，map 已注明） |
| server 端点 | hub.ts:579-587 `rename`（stateOf + appendRename）；controllers/sessions.ts:562（shortenTitle 后调 hub.rename） | 写 | 改道 JSON |
| live title | session-manager.ts:1807-1813 `getTitle`（**file order** last-wins，非 branch） | 读 | 改道 JSON（「last-wins」语义由 JSON 快照天然满足） |
| listing title | session-manager.ts:838-844,863,899 `buildSessionInfo`（renamedTitle file-order） | 读 | 改道 JSON |
| projection | projection.ts:183,194（branch_changed / user message 落地后 getTitle 推 row） | 读 | 原样（getTitle 内部换数据源） |
| smoke | smoke-sessions.ts:329、smoke-api.ts:401-410（201 + 名称回读）、smoke-projection.ts:175-201 | 测试 | 原样（走 API/row，不触文件形态） |

## usage（session-manager.ts:222-229）→ **原样保留（JSONL）**

| 触点 | 文件:行 | 写/读 | 备注 |
|---|---|---|---|
| append | session-manager.ts:1482-1494 `appendUsage` | 写（**全仓生产代码无调用方**） | 见「意外依赖」#1 |
| 读 | snapshot.ts:107 `entryUsage`（`compaction || usage` 一并取 usage） | 读 | 保留 |
| smoke | smoke-sessions.ts:491 的 "usage" 是 SessionSnapshot 字段清单，非 entry kind | — | — |

---

## 连带与意外依赖

1. **`usage` 是当前只读不写的 kind**：`appendUsage` 在 packages/core/server/web/scripts 无任何调用；唯一调用在 vendored `pi-main/packages/coding-agent/src/core/cache-warmer.ts:342`（上游参考树，非本仓构建）。票 02–05 划分时可考虑：保留 kind 与读点（snapshot.entryUsage 已兼容 `compaction.usage`），writer 是否补上是独立决定，不属于本拆分。
2. **`tool_config`/`thinking_level_change`/`model_change` 迁 JSON 改变 branch 语义**：今天这三个值都活在 branch 上——`branchTo`（agent.ts:2054-2076）移动 leaf 后靠 `applyBranchSelection` + `emitBranchToolConfig` 从目标分支的 entry 重放恢复模型与工具选择；`getRecordedToolConfig`/`getRecordedSettings` 都明说「reads the branch, not the file」（session-manager.ts:1758-1760）。迁 JSON 后这些值变成会话级当前值，leaf 移动不再切换它们；smoke-session.ts:2122-2270「branch 落到目标分支的 tool_config」整段用例的语义要重写。这是 map「只存当前值」拍板的直接后果，值得在票 02/05 里显式写明。
3. **header 迁 JSON 让发现路径变便宜且简化**：`findSessionFilePathById`（2020-2043）、`findMostRecentSession`（738-761）、`listDirectories`（1959-1984）今天靠「读 JSONL 第一行」做便宜发现；改读小得多的 `<id>.json` 后逻辑不变、成本更低。`MAX_SESSION_HEADER_BYTES`（592）、`SESSION_HEADER_READ_BUFFER_SIZE`（587）、旧 `cwd` 兼容（725-731）整组消失。
4. **listing 必须拆两半**：`buildSessionInfo`（814-907）一份扫描同时产出 header 字段（→JSON）与 messageCount/firstMessage/allMessagesText/modified（→仍需 JSONL）。map 拍板⑥「listing 元数据从 JSON 读，消息统计才碰 JSONL」落地时即是把这个函数拆开；`messageCount > 0` 过滤（1016）与 `hasMessageEntry`（768-778）留在 JSONL 侧。
5. **首条消息 gate 决定 `.json` 何时诞生**：`persistEntry`（1251-1267）今天「第一条 user/assistant 消息才创建文件并全量写出（含 header）」。两文件世界里 `<id>.json` 是否同样等首条消息才落盘（还是创建即写）、以及「只有 `.json` 没有 `.jsonl`」的残缺判定，map 已列为票 02 待钉项——本清单确认 gate 逻辑只此一处，改起来面很小。
6. **`entry_appended` 的 kind 集合自动收窄**：`AgentSessionEvent.entry_appended` 的 `kind: SessionEntry["type"]`（agent.ts:269）；四种迁 JSON + 一种删除后，该字段类型自动只剩六种，mux.ts:416 与 web state.ts:722（swallow）不受影响。projection.ts:188-189 用 `sessionEntryMapById.get(entryId)` 并要求 `type === "message"`——entry 表仍在 JSONL 侧，不受影响。
7. **fork 与 unknown-kind 透传**：`forkFrom` 过滤 header 后按 branch 复制 entries（1909-1910），unknown kind 原样携带（smoke-tools.ts:480-516 exerciseFileFormat 断言）。拆分后 fork 改复制两个文件（拍板⑥），unknown-kind 透传语义保留在 JSONL 侧不变。
8. **web 侧精确边界（校准 map 第三条待定项）**：web 不触任何 entry kind 与文件形态，只消费 wire——`SessionSnapshot`（createdAt/title/parentSession/usage/activeTools/approvals/messages/messageEntryIds/branchPoints/leafId）与事件（compaction、compaction_failed、tool_results_cleared、tool_call_args_trimmed、config_changed、entry 帧）。受拆分影响的 web 面仅两处数据源：snapshot.createdAt/parentSession（改从 JSON 来，wire 不变，web 零改动）与 config_changed 语义（若 branch 不再改 tool_config，web state.ts:718-719 的应用逻辑不变，只是触发频率变化）。票 05 的实际工作量远小于预期：主要是 smoke（sidebar/transcript/api 断言走 wire，基本不动）与文档。
9. **smoke fixture 的版本写死**：smoke-session.ts:2296 手写 `version: 4` header；升 5 后必改。smoke-tools.ts:493,880 用 `CURRENT_SESSION_VERSION` 常量，随升版自动跟随，但「header 在第一行」的文件形态断言需改为两文件形态。
10. **票 02–05 陈述核对**：未发现票面事实错误。补充一点：map Notes 第 3 条说 `tool_result_view`「本构建已不写」——属实（写点为零，仅 smoke 手写 legacy fixture 验证读路径）。
