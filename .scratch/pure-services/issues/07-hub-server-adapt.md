# 07:hub/server 适配——hub 只持单例,REST 处理器以 id 调用

Type: task
Status: open
Blocked by: 06

## Question

`packages/server`:hub 删除 per-session 的 Agent 实例簿与会话对象簿,只持五个
单例 + 一个共享 `Agent`;所有 REST 处理器改为以 URL 里的 sessionId 调用 Agent
的新签名方法。

- `createRoutes()` 与 `Router` 不解释任何新 URL;mux 帧与订阅表一字不改
  (ADR-0001 红线)。命令在被施加时作答的语义不变。
- claim 语义保持:改变会话的请求与在飞运行各在其长度内持 claim;订阅不拿 claim。
  取数路径变为「Manager 现取」后,复核 claim 覆盖点没有漏(接 08 后雾区的
  原子性问题,此处只保证不倒退)。
- 宽限计时、快照、审批端点(`POST /api/sessions/{id}/approvals/{toolCallId}`)
  的行为照旧,只是取数方式变了。
- desktop 外壳(`bootServer` 调用点)与 `session-factory.ts` 的残骸清理:
  不再需要的装配函数删除。

完成后 `npm run check` + `smoke-api.ts` / `smoke-mux.ts` / `smoke-mux-live.ts`
/ `smoke-boot.ts` / `smoke-backpressure.ts`。
