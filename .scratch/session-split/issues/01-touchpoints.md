# 01 - 全仓 entry kind 触点清单

Type: research
Status: resolved

## Question

`SessionHeader` 与 11 种 `SessionEntry` kind（`message`、`thinking_level_change`、`model_change`、`compaction`、`clear_tool_result`、`trim_tool_call_arg`、`tool_result_view`、`tool_config`、`leaf`、`rename`、`usage`）在 core、server、web、scripts 的**全部**写点与读点：谁写、谁重放、谁派生事件 / API 字段 / 渲染分支。

拆分后（六种留 JSONL、`thinking_level_change` + `model_change` + `tool_config` + `rename` 迁 JSON 当前值、`tool_result_view` 删、header 进 JSON）每个触点的去向：**消失、改道 JSON、或原样**。

产出写进本 effort 的 `research/touchpoints.md`，作为票 02–05 的划分依据；答案落到本票的 Answer 与 map 的 Decisions so far。

## Answer

全仓触点清单已落 `research/touchpoints.md`（按 kind 分节，每触点标 文件:行 / 写读 / 去向）。量级结论：触点高度集中在 core 的 session-manager.ts（类型 + append 方法 + 重放/分支/listing，约 40 处）与 agent.ts（写入编排 + 事件派生，约 25 处）；server 只有 5 个真触点（hub.rename 写 rename、forkFrom、timestampOf、fillSession 冷读、projection 的 message-entry 推送），web 为 **零文件触点**——它只消费 SessionSnapshot 与事件帧，受影响的仅 snapshot.createdAt/parentSession 的数据源（wire 不变，web 代码零改动）。scripts 的触点集中在 smoke-session/sessions/tools 三个文件的 fixture 与断言。

各 kind 去向：`message`、`compaction`、`clear_tool_result`、`trim_tool_call_arg`、`leaf` 原样留 JSONL；`thinking_level_change`、`model_change`、`tool_config`、`rename` 迁 JSON 当前值（`rename` 的 file-order last-wins 语义由 JSON 快照天然满足）；`tool_result_view` 彻底消失（类型 + `context/tool-result-views.ts` 全文件 + smoke-sessions.ts:833-930 整段）；SessionHeader 改道 JSON，`JsonlEntry`/`isSessionHeader`/`readSessionHeader` 一组（含 `MAX_SESSION_HEADER_BYTES`、旧 `cwd` 兼容）随之消失。

值得注意的连带（详见清单「连带与意外依赖」节）：

1. **`usage` 是只读不写的 kind**——`appendUsage` 在生产代码零调用（唯一调用在 vendored `pi-main/` 参考树），读点仅 snapshot.ts:107。保留与否是独立决定，不属于本拆分。
2. **三种状态 entry 迁 JSON 改变 branch 语义**：今天 `branchTo` 依赖「模型/思考档/工具选择由目标分支的 entry 重放恢复」（`applyBranchSelection`、`emitBranchToolConfig`，两个 get* 方法都明说 reads the branch）；迁 JSON 后 leaf 移动不再切换这些值，smoke-session.ts:2122-2270 的 branch-tool_config 用例语义需重写。
3. **listing 必须拆两半**：`buildSessionInfo` 一份扫描同时产 header 字段与消息统计，拍板⑥落地时即拆此函数；首条消息 gate（persistEntry）决定 `.json` 何时诞生，归票 02。
4. **票 02–05 未发现事实性错误**；一处校准：map「Not yet specified」的 web 侧边界比预期窄得多，见清单第 8 条。
