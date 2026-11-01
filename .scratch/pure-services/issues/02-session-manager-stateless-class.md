# 02:SessionManager 去壳——删 private s,类保留为首参收袋的服务

Type: task
Status: open
Blocked by: 01

## Question

`packages/core/src/session/session-manager.ts`:类保留(票 01 的契约:Spring 式无
状态服务),但删除 `private s` 与三个 per-session 静态工厂(`create` /
`fillSession` / `inMemorySessionState` 的类形态):

- 每个方法改**首参收 `SessionState`**(一行转发到既有的同名文件级函数族,它们已经
  是这个形状);从 `sm.appendMessage(msg)` 变 `sm.appendMessage(state, msg)`。
- 类内部新增**按 id 键控的 fill-at-open 缓存**与 `stateOf(id)`:id 第一次被碰到时
  `fillSession` 重放入缓存,之后复用同一引用;缓存可从磁盘重建(ADR-0006 规则)。
  失效时机(close / fork / rename / 分支移动)在此票一并定——缓存失效错一次就是
  双路径分叉。
- 调用方迁移:core 内部与 smokes 里持有 `SessionManager` 实例的调用点,改为
  「`stateOf(id)` 取袋 + 首参传袋」;`Agent.sessionManager` 属性本票不动(06 票拆),
  但 Agent 内部调用改为显式传袋,为 06 铺路。
- 不变量红线:文件序最后一条 rename 赢(ADR-0002)、fillSession 重放结果与
  逐 entry 追加等价、未知 entry kind 原样带过——smoke-sessions 全绿是验收线。

完成后 `npm run check` + `smoke-sessions.ts`。
