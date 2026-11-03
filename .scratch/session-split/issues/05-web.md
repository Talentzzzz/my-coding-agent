# 05 - web 连带清点与修复

Type: task
Status: resolved
Blocked by: [04 - server 连带](04-server-fork-listing.md)

## Question

`packages/web` 对齐新 API：依赖 entry kind 的渲染与 state 分支（`transcript.ts`、`sidebar.ts`、`state.ts`、`main.ts`）逐一核对，改道的改道、消失的删掉；窗口行为无回归。精确边界以票 01 的触点清单为准。

## Answer

核对完成，与票 01 第 8 条的校准一致：**web 渲染与 state 分支零代码改动**（四条注释的措辞除外），窗口行为无回归。

**逐文件核对（按票 01 清单）**：

- `state.ts`：事件分支只落在存留的六种 kind 派生的事件上——`compaction` / `compaction_failed` / `tool_results_cleared` / `tool_call_args_trimmed`（notice 渲染）与 `config_changed`（快照原位补丁，state.ts:711-721 应用逻辑不变）；`entry_appended` 本就按值吞掉（state.ts:722）。四种迁 JSON + 一种删除的 kind 在此无分支可改。branch 不再切换选择的连带只是 `config_changed` 触发频率下降，应用逻辑不需要动。
- `transcript.ts`：`item.kind` 是 web 自己的 `message`/`tools` 联合，不触 entry kind；消息树、fork 卡、usage 行全走 snapshot 的 wire 字段。零改动。
- `sidebar.ts`：`row.session.createdAt`（分组日期、fork 树排序）与 title 继承只读 wire 字段，数据源换到 `.json` 对它不可见。零改动。
- `main.ts`：`currentModeName` / `applyMode` 按值匹配 snapshot 的 `activeTools`/`approvals`（ADR-0005），不看 entry。零改动。

**改动面（仅注释措辞，四处）**：`tool_config` 作为 entry kind 已消失，注释里「one `tool_config` snapshot」「land as one `tool_config` snapshot in the transcript」（已不实——值写进 `.json` 快照、由 `config_changed` 宣告，不再有 entry 落进 transcript）、「a replayed tool_config」三处（main.ts）与「the session's own `tool_config`」（settings.ts）改为「the session's `.json` snapshot」/「one recorded choice」/「the session's recorded set」的既有措辞，与 core（`tools/manager.ts`、`session-manager.ts` 的 setToolConfig 注释）一致。

**验证**：`npm run check` 绿（含 web 自己的 tsconfig 与 token 审计）；smoke-transcript / sidebar / frame / replay（窗口面）+ session / sessions / branch / modes / projection / stream / tools + smoke-api（临时 HOME 起服的完整 REST + mux 往返）全绿。
