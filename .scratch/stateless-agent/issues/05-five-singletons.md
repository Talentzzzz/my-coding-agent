# 05:五个无状态单例的分工与单向星形依赖

Type: grilling
Status: resolved

## Question

无状态单例分几个?各自职责、收什么状态、依赖方向是什么?为什么需要编排者?

## Answer

**5 个**:

| # | 单例 | 职责 | 方法收的状态 | 依赖 |
|---|---|---|---|---|
| 1 | SessionManager | 账本一切:读文件、重放建索引、追加 entry、branch/leaf、buildSessionContext、compaction 三步、rename、标题派生 | 每请求重放出的 SessionState(瞬态)或文件路径 | 无 |
| 2 | SettingsManager | 设置一切:读两份 json、合并、declared 写回规则、modes 表、getApprovals | SettingsState(hub 按工作区缓存,共享引用) | 无 |
| 3 | ModelManager | 模型一切:fillModel 按名补齐、createModel 配置→请求对象、清单查询 | (catalog, Model),均为参数 | 无 |
| 4 | ToolManager | 工具一切:全量定义注册表(全局只读)、fillTools、按 activeToolNames 装配 | (注册表, ToolState, settings.modes) | 无 |
| 5 | Agent | 编排:prompt/steer/followUp/abort/respondApproval、补齐链调度、buildRunContext、recordSelection、重试、事件 emit | (SessionRuntime, 请求参数) | 调 1–4 |

**依赖是单向星形**:1–4 平级互不依赖,只被 5 调;无构造注入,平级靠 import。

**Agent 为什么是编排**:跨域顺序(记录选择→补齐模型→取上下文→装配工具→
审批默认值→拼提示词→跑 loop→收尾写回)不属于任何单一域,1–4 是名词、Agent
是动词;跨域不变式(如「每次移动恰好记录一条 selection entry」)只能住在调度方。
hub 不做编排:hub 只懂协议,业务流程进 core,分层不穿。

佐证:今天的 `Agent` 类里 `prepareRequest` 干的就是这条链——重构是把域专业部分
搬给 1–4,搬完剩下的骨架就是编排。

**状态的三级持有**:全局(catalog、工具定义注册表,只读)/ 每工作区
(SettingsState,hub 缓存共享引用)/ 每会话(SessionRuntime,唯一跨栈内存态);
每请求的 SessionState 重放与派生上下文现建现弃。

**事件分发**:订阅表在 hub/mux(现有 `mux.ts` subscriptions),不单列第六个
单例;Agent 产生事件、经 hub 的订阅表扇出。
