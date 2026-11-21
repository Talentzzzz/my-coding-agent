// 组合根 @my-agent/app 的公开面（分层重构步 3 自 server/src/boot.ts 主半改造而来，spec §7 步 3）：
// start(options) 是服务器的唯一程序化入口，浏览器 dev 走 `scripts/serve.ts` 薄脚本，没有 CLI。
// homes 在本步仍是路径透传（HubOptions 同形），翻译成 infra 实现是步 5 的翻面；
// AGENT_HOME 的解析随之在步 5 迁入本包。
export { start, clientDirectory, type StartOptions, type BootedServer } from "./start.ts";
