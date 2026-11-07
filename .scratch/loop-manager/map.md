# LoopManager —— wayfinder 地图

## Destination

`Agent` 不再自己装引擎：新增 `LoopManager` 对象接管「一次运行」的全部代码（引擎、每轮填充链、
压缩、重试泵、工具闸门、事件 sink，连同 `base: ChatTransport` 与 `systemPrompt`），`Agent`
通过 `AgentConfig.loop` 构造注入、只留会话表/命令/审批/投影；`packages/core/src/agent.ts` 由
2916 行缩到 809 行，`npm run check` 与 core smoke 全绿，ADR-0012 与术语表同步落地。

## Notes

- 领域：本仓库自有代码（`packages/core`、`packages/server`、`scripts/`）。术语的家是 `AGENTS.md`。
- 用户在此次会话里逐题拍板（注入方式、宽边界、写 ADR-0012），**本 effort 携带执行**：与
  ADR-0008 那次不同，这次是「先拍板、再兑现」，五张票在同一个会话里走完。
- 这次是对 [ADR-0008](../docs/adr/0008-loop-merged-into-agent.md) 决定 1/2 的反向：那次的理由是
  「`Loop` 是个没有信息的对象——它被构造时，引擎的每一个问题都绕回 `Agent` 回答」。本次成立的
  前提是 **LoopManager 不回头问 Agent**：它自带六件依赖，事件与投影走 `session/fanout.ts` 的
  文件级函数，`AgentState` 由调用方递进来。这条写在 ADR-0012 里，也是「这次为什么不一样」。
- 验证：`npm run check` + `node scripts/smoke-*.ts`（core 相关，均不需要供应商密钥）。基线在
  改动前跑过一次，结论见 *验证* 一票。
- 搬迁用一次性切分脚本产出**字节一致**的切片，再以 Edit 收尾；脚本与原件只用于本次搬迁，
  已从工作区删除（不变量：`agent.ts` 的每一行都能在新文件里按区段对上）。

## Decisions so far

- [LoopManager 怎么进 Agent](issues/01-injection.md)：`AgentConfig` 必填 `loop: LoopManager`，由
  `createSessionAgent` 组装后传进来；`api` / `systemPrompt` / `hooks` 从 `AgentConfig` 移出，归
  `LoopManagerConfig`，`Agent.hooks` 就是 `loop.hooks`。
- [LoopManager 的边界与共享 fan-out 的归属](issues/02-boundary.md)：引擎 + 填充链 + 压缩 + 重试 +
  工具闸门 + 事件 sink 归 LoopManager；会话表、命令、审批账本、投影留 Agent；共享的 fan-out 抽成
  `session/fanout.ts` 的文件级函数；`abort`/`settle`/`close` 不搬。
- [代码落地](issues/03-extract.md)：新增 `loop-manager.ts`、`session/fanout.ts`、
  `session/events.ts`；`agent.ts` 2916 → 809 行；`finalizeToolResult` 随写入口进 fan-out。
- [ADR-0012 与文档](issues/04-adr.md)：ADR-0012 取代 ADR-0008 决定 1/2，`AGENTS.md` 的 engine 词条
  改指 `LoopManager.run` 并新增 LoopManager / fanout，`docs/architecture.md` 与 `README.md` 同步。
- [验证](issues/05-verify.md)：三份 tsc 与 token 审计全绿；14 个 core smoke 全绿；`smoke-approval`
  的失败在改动前即存在（子进程编排），`smoke-api` 需要外部服务器。

## Not yet specified

（无——边界与装配在拍板时定死，五张票都已兑现。）

## Out of scope

- 重新引入 `packages/loop` 包或任何 vendored 对照：LoopManager 是本仓库自己的文件，不跟上游。
- 子代理机制、插件、MCP：AGENTS.md 既有边界，本次不碰。
- `Agent` 的公开面改名/收敛（`prompt`/`steer`/`followUp`/`abort`/`settle` 仍是它的方法）：这次只搬
  运行期，不动命令面。
- 把 `settle`/`abort` 的等待逻辑做成一个对象：它们读的是状态上的槽位，不需要第二个住户。
