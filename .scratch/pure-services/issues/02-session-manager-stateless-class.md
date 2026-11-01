# 02:SessionManager 去壳——删 private s,类保留为首参收袋的服务

Type: task
Status: resolved
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

## Answer

落成 commit `b998354`(17 个文件)。Question 列的四条全部落地:

- **首参收袋**:类里每个方法改 `(s: SessionState, …)` 一行转发到同名文件级函数;
  六个此前只存在于类上的读取方法(`isPersisted`/`getAbsCwd`/`getAbsSessionDir`/
  `usesDefaultSessionDir`/`getSessionId`/`getAbsSessionFile`)在文件级补齐,其中
  有真实调用者的两个(`getSessionId`/`getAbsSessionFile`)进 core 导出面,其余四个
  不导出。三个 per-session 静态工厂(`create`/`open`/`inMemory`)删除,调用方直走
  `createSessionState`/`fillSession`/`inMemorySessionState`。
- **缓存与失效(票面要求在此票一并定)**:`stateOf(id)` fill-at-open、按 id 键控、
  随时可从磁盘重建。失效只定两处:`remove` 丢 id(文件没了,缓存会复活已删会话)、
  `forkFrom` 注册 fork 自己的新 state(下一个 `stateOf` 必须答同一个袋);其余一律
  不失效——追加/改名/分支移动都原地改缓存袋,host 收摊前先 settle,袋与文件相等。
  未落盘的会话**不入缓存**(没有文件可填),由 hub 的 `pending` 表改装持有
  (ADR-0007 §4 的窄登记处,归属与命名仍归票 03)。因为碰缓存,`forkFrom` 与
  `remove` 改为实例方法;`list`/`findSessionFilePathById` 等纯发现保持静态。
- **调用方迁移**:Agent 保持 `sessionManager` 属性(票 06 拆),新增 `sessionState`
  袋并公开,内部全部调用改显式传袋;`OpenAgentOptions` 收 `sessionState`,
  `sessionManager` 改可选(缺省一套一服务,`assemble` 里解析一次、subagent 工具与
  会话共用);hub 的 `pending` 表改装 `SessionState`,`open` 走 `stateOf`,`rename`
  未 hosted 路径走缓存取袋(改名必须落在下一个 open 会答的同一个对象上),
  `fork`/`remove` 走服务;冷读 `snapshotOf` 保持临时 `fillSession`——读不落缓存,
  不钉住没人运行的会话的全文。smoke 全量迁到取袋+传袋。
- **不变量红线**:`smoke-sessions.ts` 全绿,新增缓存三条(stateOf 复用同一引用、
  写穿缓存落盘、无文件 id 拒答),既有三条(最后一条 rename 赢、重放等价、未知
  kind 原样带过)原样通过。`npm run check` 绿,smoke 全套(session/tools/
  approval*/projection/stream/api/mux 等)跑绿。

过程中抓到一个真回归:`smoke-stream.ts` 的持久化破坏补丁钉在共享服务实例上——
服务一个 hub 一套(原先每会话一套),补丁不卸下就泄漏给后续会话。改为段内安装、
段末恢复;这也实证了「缓存失效错一次就是双路径分叉」的相反面:写路径单袋化之后,
唯一的分叉源是跨段的猴子补丁。
