# 04 终验:全套绿 + 清零断言

Type: task
Status: open
Blocked by: 03

## Question

终点站验收:确认目的地达成,图可以收口。

清单:

- `npm run check` 绿(core/server/web tsc + token 审计,无 llm 棒);
- smoke 全套绿:smoke-tools、smoke-models、smoke-sessions、smoke-api、smoke-mux,以及
  approval/queue/recovery/session/boot 等库内其余 smoke(与上一张绿基线比,零新红);
- `npm run build:web` 绿;
- 清零断言:`AgentContext`、`AgentTool`、`LlmContext`、`@my-agent/llm`、`packages/llm`
  在源码、脚本、配置里 grep 清零(文档只许 ADR 历史叙述豁免);
- 行为零变化抽查:挑一条 smoke 的输出与改动前基线对照(diff 为空);
- 全部通过后:在本 map 的 Decisions so far 逐票补行,图收口,交接执行完毕的仓库状态。

任何一条红:按 map 的 Not yet specified 约定登记升级,不顺手改行为。
