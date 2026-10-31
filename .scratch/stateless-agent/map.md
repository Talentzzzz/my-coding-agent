# Wayfinder map:无状态会话架构重构

## Destination

packages/core、server、loop 落地「无状态服务 + 纯数据状态」重构:五个无状态单例
(SessionManager / SettingsManager / ModelManager / ToolManager / Agent 编排),
每请求从磁盘重放会话(B 路线),内存只留 SessionRuntime(队列 + activeRun),
审批改为「结束重启」式(loop 带恢复机器)。旧的有状态会话类删除,`npm run check`
与 smoke 全套、桌面手测通过。

## Notes

- 本 effort 把**执行**纳入地图(用户明确要求「执行到代码上」):票是构建切片,
  不止于决策,目的地是落地的代码。
- 设计已在 2026-10-31 的设计长对话中敲定,沉淀为已解决票 01–06;实现票以它们为规格。
- 与 `docs/architecture.md` 现状(每会话一个 Agent/SessionManager 实例、审批在内存
  挂起)**有意冲突**,由票 07 的 ADR 正式重开并落档。
- 每票开工前:读 `docs/architecture.md` 对应章节与 `AGENTS.md` `## 术语`;
  完成后跑 `npm run check` 与相关 smoke(smoke-tools / smoke-models /
  smoke-sessions / smoke-api / smoke-mux)。
- 约定:文档中文、源码注释英文;tab 缩进、双引号、相对 import 带 `.ts` 后缀;
  窗口 UI 只读设计 token。
- 新术语(SessionRuntime、补齐/fill、种子、悬空 tool call)由票 07 的 ADR 定义。

## Decisions so far

- [01 无状态服务 + 纯数据状态](issues/01-stateless-services.md):会话状态住纯数据袋,操作是平级的无状态单例;会话状态活得比任何调用栈长,必须按会话键控持有。
- [02 B 路线:每请求重放](issues/02-route-b-replay.md):账本/设置/模型/工具每请求从磁盘与配置重建;内存只留跨栈信箱(SessionRuntime)。
- [03 审批改为结束重启](issues/03-approval-restart.md):审批到达前本轮运行结束、tool call 悬空;loop 的恢复机器按 toolCallId 配对答案续跑。
- [04 种子→补齐生命周期](issues/04-seed-and-fill.md):前端只传名字(sessionId/modeName/modelName),幂等补齐函数现建其余一切;打开会话与恢复会话是同一条链。
- [05 五单例分工](issues/05-five-singletons.md):SessionManager/SettingsManager/ModelManager/ToolManager 平级互不依赖,Agent 做编排;依赖是单向星形。
- [06 toolResultViews 落 entry](issues/06-tool-result-entry.md):shown 半边持久化为 entry,双份视图从账本补齐,恢复语义闭合。
- [07 ADR——无状态会话架构与重启式审批](issues/07-adr.md):已落 `docs/adr/0006-stateless-session-architecture.md`,正式重开现状决定并声明不触碰 0001/0003/0005。
- [08 SessionManager 无状态化](issues/08-session-manager-stateless.md):`SessionState` 纯数据接口 + 全操作首参收状态的文件级函数 + `fillSession` 重放入口落地;`SessionManager` 收成一行委托的薄壳门面,调用方零改动,票 13/14/16 迁移。
- [09 SettingsManager 无状态化](issues/09-settings-manager-stateless.md):`SettingsState` 纯数据接口(每工作区一份,hub 缓存共享引用)+ 全操作首参收状态的文件级函数 + `fillSettings` 补齐入口;`SettingsManager` 同收薄壳门面,调用方零改动,票 14/16 迁移。
- [10 ModelManager 无状态化](issues/10-model-manager.md):`ModelState` 纯数据袋(种子 = 客户端 ModelSelection 原样)+ `fillModel(catalog, bag)` 每请求原地补齐(查不到名字即抛,编排层接)+ `resolvedModel` 现造薄请求对象;`Agent` 的 `recordSelection` 改读账本派生值,recorded* 缓存字段删除;catalog 仍是 hub 持有的 `ModelSource`,只作 fillModel 参数。

## Not yet specified

- 重放性能实测:每请求 O(全文) 重放的阈值在哪,哪个字段先升级回内存缓存(设计承诺不变:缓存必须可从磁盘重建)。
- 同会话并发请求下「重放 + 追加」的原子性:现有 claim 机制如何覆盖新写路径。
- subagent 收窄注册表(read/glob/grep、审批关闭)在新装配链里的位置。
- 审批等待期的窗口状态语义:流停、状态行归零、「恢复中」展示——可能需要 prototype 票。
- compaction 三步与重放链路的交互:trim_tool_call_arg / clear_tool_result 施加于重放的哪个阶段。

## Out of scope

- 队列落盘(零袋 / C 路线):已裁决——桌面单进程不需要外部状态存储,重建 AgentScope 式 state store 无收益。
- 大状态袋缓存(A 路线):与 B 路线二选一已定;缓存升级仅在雾中「性能实测」触发时以新票进图。
