# Wayfinder map:无属性服务重构

## Destination

packages/core 的五个单例(Agent 编排、SessionManager、SettingsManager、ModelManager、
ToolManager)全部成为「无属性服务」:构造只收服务依赖,方法收会话 id 与请求自己的
参数,需要的数据谁用到谁向属主 Manager 现取——**不传、不养任何聚合袋**。旧的
`AgentConfig` 混合袋、`SessionManager` 的 `private s`、各薄壳门面的私有字段全部消失;
`SessionManager` 保留类壳(无状态服务,构造注入)。hub/server 适配后 REST 面与 mux
帧一字不改;`npm run check` 与 smoke 全套绿、桌面手测通过。

## Notes

- 本 effort 把**执行**纳入地图(用户明确,同前作 stateless-agent 的模式):票是构建
  切片,目的地是落地的代码。
- **形状已敲定(2026-11-01 设计对话)**,要点:
  - 形状二——公开方法收 `(sessionId, 请求自己的参数)`,方法体里每样数据在**用到它的
    那一行**向属主 Manager 现取,拿到的只是局部变量,作为参数传给下一步;内部辅助方法
    收显式参数,不收 id、不收袋。没有聚合类型,Manager 之间从不互相「补充」一个共享
    对象。
  - `SessionManager` 保留类壳但删 `private s`:类是 Spring 式无状态服务,可构造注入;
    它内部持有按 id 键控、可从磁盘重建的 fill-at-open 缓存(承接前作票 16 裁决:否决
    每请求全文重放)。缓存**藏在自己内部**、不被传递,这是它与大对象的分界。
  - 活的一半(队列、activeRun、订阅集合)不能从磁盘现建,居一个按 id 键控的**窄**登记
    处,只装「进行中且磁盘上没有」的东西(票 03 定归属与命名,候选 OpenSession,
    不得与 `SessionRuntime` 的「live half」既有术语打架)。
  - `modelState` 整个消失:选择随消息到达(`ModelSelection`),没带就从账本
    `getRecordedSettings` 派生,`fillModel` 现算。
  - hooks / transport / systemPrompt 构建函数留作 Agent 构造注入(进程级不可变配置)。
- 前作 `.scratch/stateless-agent/`(18 票全 resolved)是既成事实:ADR-0006、
  `SessionState` 首参函数族、`SessionRuntime`、结束重启审批都已在库。本 effort 只拆
  它**有意留下**的门面(票 08/09/16 的裁决)与 Agent 仍持的属性;票 01 的 ADR 正式
  重开 ADR-0006 的「薄壳门面」一条。
- 每票开工前:读 `docs/architecture.md` 对应章节与 `AGENTS.md` `## 术语`;完成后跑
  `npm run check` 与相关 smoke。文档平移(AGENTS.md 词条、architecture.md 持有模型
  一节)随对应票走,08 票总校。
- 约定:文档中文、源码注释英文;tab 缩进、双引号、相对 import 带 `.ts` 后缀;窗口
  UI 只读设计 token。

## Decisions so far

<!-- the index: one line per closed ticket, enough to judge relevance, then zoom the link for the detail the ticket holds -->

- [01 ADR-0007 服务无属性化](issues/01-adr-0007.md):[ADR-0007](../../docs/adr/0007-services-drop-instance-state.md) 落库,正式重开 ADR-0006 落地序列的「薄壳门面」条款(票 08/09/16 的私有状态袋裁决);六条形状契约入文——无聚合袋、类壳保留为无状态服务、Manager 内部键控缓存不被传递、活的一半居窄登记处(归属与命名留 03 票)、modelState 消失、进程级不可变配置构造注入。ADR-0006 加取代者指针(部分重开),README 清单表更新。
- [02 SessionManager 去壳](issues/02-session-manager-stateless-class.md):`private s` 与三个 per-session 静态工厂删除,类保留为首参收 `SessionState` 的无状态服务;`stateOf(id)` fill-at-open 缓存入类,失效只定 remove 丢 id、forkFrom 注册新 state 两处,未落盘会话不入缓存(归 hub 的 pending 表,窄登记处仍归 03 票);Agent 显式传袋、hub/工厂/smoke 全量迁移,smoke-sessions 增缓存三条,全套绿。

## Not yet specified

- 冷读者路径:一个本进程**没有**打开过的会话,它的 snapshot / usage 在新形状下从哪
  进来(Repository 直接答,还是必须先过打开链路)——等 02/03 的答案落地再切票。
- subagent 收窄注册表(read/glob/grep、审批关闭)在新形状里的位置——等 05 的
  ToolState 归属结论。
- 重放性能实测:Manager 内部键控缓存的阈值在哪,哪个字段先需要升级(设计承诺不变:
  缓存必须可从磁盘重建)。承接前作雾区。
- 同会话并发请求下「缓存读取 + 追加」的原子性:claim 机制如何覆盖新的取数路径。
  承接前作雾区。

## Out of scope

- 队列落盘(零袋 / C 路线)与大状态袋缓存(A 路线):前作已裁决,不重开。
- wire 协议变化:REST 端点、mux 帧一字不改;窗口客户端预期**零改动**(除非 08 票
  验证暴露问题,届时回图切票)。
- 插件与 MCP 机制:仍然不在范围内。
