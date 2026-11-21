// @my-agent/prompt 的公开面（2026-11-21 自 domain 的 context 包拆出，ADR-0031）：发给模型的指令
// 文本——system prompt 拼装与项目指示收集。叶子库：对本仓零依赖（node 内建之外只认自己的端口
// 声明），触盘经 AgentsMdRepository、infra 实现、组合根注入。
export { type AgentsMdFile, formatAgentsMd } from "./agents-md.ts";
export { type AgentsMdRepository } from "./agents-md-repository.ts";
export { buildRequestPrompt } from "./build-request-prompt.ts";
export { type SystemPromptInput, buildSystemPrompt } from "./system-prompt.ts";
