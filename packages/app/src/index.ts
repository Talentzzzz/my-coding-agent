// 组合根 @my-agent/app 的公开面（分层重构步 3 自 server/src/boot.ts 主半改造而来，spec §7 步 3）：
// start(options) 是服务器的唯一程序化入口，浏览器 dev 走 `scripts/serve.ts` 薄脚本，没有 CLI。
// homes 在步 5 翻面：本包是唯一把 home 路径翻译成 infra 实现的地方（spec §5.1）；
// AGENT_HOME / APP_NAME 的解析自 domain 迁入本包（spec §2.3）。
export { start, clientDirectory, type StartOptions, type BootedServer } from "./start.ts";
export { AGENT_HOME, APP_NAME } from "./agent-home.ts";
