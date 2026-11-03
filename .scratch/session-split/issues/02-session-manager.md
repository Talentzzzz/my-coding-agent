# 02 - SessionManager 两文件重写：JSON schema 与读侧

Type: task
Status: resolved
Blocked by: [01 - 全仓 entry kind 触点清单](01-touchpoints.md)

## Question

两文件格式在 `packages/core/src/session/session-manager.ts`（及 session/ 目录近邻文件）的落地：

- `<id>.json` 的确切 schema（header 字段、title、model 的 name/modelId、thinkingLevel、activeTools、approval）与**原子重写**实现（temp + rename）。
- 读侧 `fillSession` 合并两文件：JSON 给身份与配置当前值，JSONL 重放出 entry 树与派生态；`CURRENT_SESSION_VERSION = 5` 的判定落在哪份文件、配对残缺（缺一边）算什么。
- 旧 v≤4 文件的删除触点（见 map「Not yet specified」第一条，落地时钉死）。
- 类型联合缩到六种 kind；`tool_result_view` 与 `applyToolResultViews` 删除；`rename` / `model_change` / `thinking_level_change` / `tool_config` 的 entry 类型与重放分支删除。
- `dangling.ts` 与审批恢复机器在两文件合并读之下是否仍成立（map「Not yet specified」第二条，需要则毕业新票）。

## Answer

全部落地，`npm run check` + session/sessions/tools/api/projection/sidebar/stream/approval 系 smoke 全绿。

**`.json` schema（`SessionMeta`，v5）**：`version`、`id`、`timestamp`（创建时刻）、`workDir`、`parentSession?`（指源的 **`.jsonl`** 路径，与 v4 语义一致）为身份五字段；`title?`、`model? {name, modelId}`、`thinkingLevel?`、`activeTools?`、`approval?` 为当前值，**缺席 = 从未选择**（读侧靠这个区分「选了 off」和「没选过」）。写侧四个新方法 `setTitle` / `setModel` / `setThinkingLevel` / `setToolConfig`（替代四个 append 方法）：先改内存 meta，`fileCreated` 时才整体原子重写（同目录 temp 文件 + `renameSync` 覆盖），值没变不重写。

**JSON 何时诞生（钉死，回答票 03 问题三）**：沿用既有 gate——首条 user/assistant 消息时两文件**同时**写出：先 `.jsonl`（`wx` 全量写），后 `.json`（**commit marker**：`.json` 的存在 = 会话存在）。出生半途而废留下的单边文件由扫描清掉。没说过话的会话连 `.json` 都不落盘，meta 变更只留内存、随出生写出。

**版本判定与配对残缺（钉死）**：`version` 判定落在 `.json`（`readMetaFile`：id/timestamp/workDir 字段齐 + `version === 5`，否则视为「不是本构建的会话」）。配对以 stem 为单位，`.json` 是权威侧：只有 `.json` 没 `.jsonl`、只有 `.jsonl` 没 `.json`、版本不对、`.jsonl` 空而 `.json` 在——一律**删除两边**（`pruneSessionFiles`）。

**删除触点（钉死，回答 map 待定第一条）**：两处——①store 扫描 `settleSessionFiles()`（listing / `findMostRecentSession` 共用，扫到即删）；②`fillSession()`（打开时删了再 throw）。新 smoke 用例（smoke-sessions「a pair this build cannot open is deleted, not kept」）覆盖 v4 文件、孤儿 `.json`、错版本对、打开时删四种。

**类型联合缩到六种**：`message`、`compaction`、`clear_tool_result`、`trim_tool_call_arg`、`leaf`、`usage`。删除：五个 entry 类型、`modelChangeName`、`LEGACY_ENTRY_KINDS`（`prune`/`argtrim` 只存在于 v≤4 文件，随之消失）、`JsonlEntry`/`isSessionHeader`/`readSessionHeader` 一组、`hasMessageEntry`（v5 下落盘即有消息）、`context/tool-result-views.ts` 整个文件、`contextEntriesFromPath` 的 views 层。`SessionHeader` 更名 `SessionMeta`（它不再是文件第一行）。

**读侧合并**：`fillSession` 读 `.json`（身份 + 当前值）+ `.jsonl`（entry 树），`buildIndex` 照旧。`getRecordedSettings`/`getSessionContextSettings` 读 meta，assistant message 仅作为 model 的弱兜底保留；`getRecordedToolConfig` = `s.meta` 两个字段；`getTitle` = `meta.title ?? deriveTitle(branch)`；`getHeader` 返回 `s.meta`（恒非空）。listing 拆两半：`buildSessionInfo` 收 `(absJson, absJsonl, meta)`，身份/标题从 meta、消息统计从 JSONL 扫描（派生标题兜底的 parent 表照旧在该扫描里建）；`findSessionFilePathById` 改扫 `.json`（更便宜）。fork 复制分支 entries + 新写 meta（新 id、目标 workDir、`parentSession` 指源 `.jsonl`，**title/model/level/toolConfig 现值随拷**）；`remove` 删两个文件。

**dangling 与审批恢复（回答 map 待定第二条）：仍成立，无需新票**。`danglingApprovalsOf` 与恢复机器只消费 `buildContextEntries` 的 message entries，而这条路径（branch walk → compaction/trim/clear 三层视图）在两文件合并读下逐字节等价；smoke-approval 系全绿佐证。

**branch 语义变化的落地（票 01 连带 #2）**：`applyBranchSelection` 与 `emitBranchToolConfig` 删除，`branchTo` 不再发 `config_changed`（模型/档位/工具选择已是会话级值，移 leaf 不改它们）；`recordSelection` 改写 meta、不再发 `entry_appended`。smoke-session 的 branch-tool_config 用例重写为「选择是会话的，不是分支的」，smoke-sessions 的对应断言同步改。

**对票 03 的提前消化**：写点适配（agent.ts / hub.ts）为保编译在本票内一并完成，票 03 的三个问题实际已拍板——时机 = 即时写内存 + 落盘则原子重写（不做脏标记合并写）；失败语义 = 抛给调用方（与 append 时代一致，不新增降级）；gate 如上。票 03 收账时只需核对剩余量。
