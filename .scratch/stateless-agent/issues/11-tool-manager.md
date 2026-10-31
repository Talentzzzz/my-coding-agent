# 11:ToolManager——注册表全局只读、fillTools、装配

Type: task
Status: resolved
Blocked by: 07

## Question

建 `ToolManager`,把工具集与审批配置改为数据流:

- 全量工具定义注册表:全局只读,启动时构建(现 `createToolRegistry` 的定义
  部分);`Workspace` 不再驻留注册表——它退化为从会话 header 的 cwd 现造的
  值对象,每请求现建。
- `ToolState` 纯数据:`{ activeToolNames, approvalOverride }`(对应
  `tool_config` entry 记录的内容)。
- `fillTools(modeName?, settings.modes)`:查不到模式名即抛;`modeName` 缺省
  或「默认」→ 全局默认活视图(全量工具 + 全局审批),不读任何存储的模式条目
  (AGENTS.md:内置默认模式不存储)。补齐产物是真理,`modeName` 是种子。
- 按活跃名单装配运行上下文的工具列表(定义查表 + Workspace 值对象注入)。
- subagent 的收窄注册表(read/glob/grep、审批关闭)在新链路下的落点——若
  一票内说不清,记入地图雾区(「subagent 收窄注册表」)再拆票。
- `npm run check` + `smoke-tools.ts` 通过。

## Answer

已落 `packages/core/src/tools/manager.ts`(ToolManager 的无状态面)+ 改写
`registry.ts`(退为持有 ToolState 的每会话薄壳),subagent 收窄在一票内说清、
无需雾区:

- 定义注册表 `ToolDefinitions` 全局只读、`toolDefinitions()` 惰性单例(启动
  构建一次)。定义是工厂 `(run: ToolRunContext) => AgentTool`——`AgentTool`
  闭包绑定 workspace,持它的注册表就是持 workspace,所以六个内建在
  `active(run)`/`build(name, run)` 时才对 run 现造;`ToolRunContext` 携带
  workspace 与 bash 超时(后者随每请求装配读自 settings,替代原先 per-call
  读 manager 的活性)。vendored loop 的 `execute` 签名不动。
- `ToolState = { activeToolNames, approvalOverride? }`,与 `tool_config`
  entry 一一对应;registry 持有并暴露 `toolState()`/`setApprovalOverride()`,
  agent 的 `approvalOverride` 字段删除,审批合并在 `Agent.getApprovals()`
  读点完成。
- `fillTools(modeName, { modes, globalTools, known })`:未知模式名即抛;缺省
  或「默认」→ 全局默认活视图(known 收窄后的 `globalTools`,
  approvalOverride 保持 undefined 以保活视图语义——复制全局审批会把视图
  冻结在 fill 时刻,故 context 不收 globalApproval);具名模式取整份
  tools+approval。调用点:装配与分支移动的 fallback 经
  `globalDefaultToolState()`(tool-config.ts),`applyRecordedToolConfig`
  改为把 recorded ?? fallback 两个半边整体应用到 registry。
- 运行上下文装配 = `toolListFor(definitions, state, run, local)` 纯函数:
  定义按名单查表现造 + 会话本地工具(SubAgent 对、测试工具)按活跃名单追加。
- subagent 落点:`subagentToolState()`(read/glob/grep + 全审批 false)经
  `openAgent` 新选项 `toolState` 传入——一条 ToolState 描述子会话的全部
  loadout,审批关闭由 override 而非内存 settings 承担;子会话不再自建
  registry。
- 验证:`npm run check`、`smoke-tools.ts`、`smoke-models.ts`、`smoke-api.ts`、
  `smoke-mux.ts` 全过;`smoke-session.ts` 的 27 个失败为基线已有(与改动前
  逐条 diff 一致),归票 13/14/15 的编排与 loop 范围。
