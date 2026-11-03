# 04 - server 连带：listing、fork、删除与 protocol

Type: task
Status: resolved
Blocked by: [02 - SessionManager 两文件重写](02-session-manager.md)

## Question

`packages/server` 与 `packages/core/src/protocol.ts` 的连带改造：

- SessionInfo / listing：元数据（title、workDir、时间戳、parentSession）从 JSON 读，消息统计才开 JSONL；目录扫描按两文件配对。
- fork：复制两个文件，`parentSession` 指源文件路径。
- 删除会话：两个文件一起删。
- tool_config / approvals 路由落 JSON 快照；`config_changed` 等事件的连带。

## Answer

核对收账：四条 bullet 全部已在票 02/03 落地，本票零代码改动。

**SessionInfo / listing（票 02 落地，本票核对）**：`settleSessionFiles(absDir)` 按 stem 配对两文件、残缺/错版本/空流即 `pruneSessionFiles` 删两边，返回的配对带 meta；`buildSessionInfo(absJson, absJsonl, meta)` 拆两半——身份与标题从 meta（id、workDir、parentSession、created、`meta.title ?? 派生标题`），消息统计（messageCount、firstMessage、allMessagesText、modified）才扫 JSONL，派生标题兜底的 parent 表在既有那趟行扫描里顺路建（`titleOfBranch` 走 leaf 回溯，与活会话 `getBranch` 同路径）；`listSessionsFromDir` 消费配对结果并发（10 并发上限）加载。`findSessionRowById` 单行查找 = 先 `findSessionFilePathById`（只扫 `.json`，meta.id 匹配回 `.jsonl` 路径）再 `buildSessionInfo`，fork 父链路在单行场景单独解析。

**fork（票 02 落地）**：`forkFrom` 复制分支 entries 写新 `.jsonl`（`wx` 全量），再写新 `.json`（`wx`）——meta 带新 id、目标 workDir、`parentSession` 指**源 `.jsonl` 路径**，title/model/thinkingLevel/activeTools/approval 五个现值随拷；源只读。fork 后 `fillSession` 重建状态入缓存。

**删除（票 02 落地）**：`remove(id)` 删两个文件（`.jsonl` + `.json`）并从缓存摘掉该 id；未知 id 抛错（hub 转 404）。残缺配对的删除另有 `pruneSessionFiles` 两处触发点（扫描 + `fillSession`），归票 02。

**tool_config / approvals 路由（票 03 收账范围，本票核对）**：REST 面 `PUT /api/sessions/:id/tools`、`POST /api/sessions/:id/approvals/:toolCallId` 形状不变；agent 侧 `setActiveTools` / `applyConfig` / `respondApproval` 三处写点全走 `sessionManager.setToolConfig`（JSON 快照原子重写），随后 `emitConfigChanged` 照发 `config_changed`（只带变化字段）；`hub.rename` → `setTitle`，路由注释已同步「rewrite the snapshot」。`packages/core/src/protocol.ts` 无 entry kind 残留：`SessionRef.createdAt` / `SessionSnapshot.parentSession` 注释已是 JSON 语义，wire 字段不变，web 零改动（票 05 待做）。

**验证**：`npm run check` 绿；smoke-sessions / smoke-session / smoke-branch / smoke-projection / smoke-tools / smoke-approval-endpoint / smoke-api（临时 HOME 起服的完整 REST + mux 往返）全绿。
