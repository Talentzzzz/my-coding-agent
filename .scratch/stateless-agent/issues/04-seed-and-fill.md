# 04:种子→补齐(seed→fill)生命周期,幂等纯函数

Type: grilling
Status: resolved

## Question

前端请求携带的只有名字级别的信息,完整状态怎么来?打开会话与恢复会话
如何保证不漂移?

## Answer

**每个子状态都是「种子 → 补齐」两段式**,补齐函数是幂等纯函数、每请求可重跑:

| 状态 | 种子(前端/请求带来) | 补齐函数做什么 |
|---|---|---|
| SessionState | `{id}`(新会话则更空) | 重放 JSONL 文件灌 entries、建索引、得 leafId;新会话标 `fileCreated:false`;从 header 拿 cwd |
| SettingsState | 工作区根路径 | 读全局+项目两份 json,算 `declared`(字段来源),合并视图 |
| Model | `{name, thinkingLevel}` | 从 catalog 查那一行,抄入 endpoint/apiKey/模型事实 |
| ToolState | `modeName` | 查 `settings.modes` 补 `{activeToolNames, approvalOverride}`;「默认」模式=全局默认活视图 |

要点:
- **打开会话与恢复会话是同一条补齐链**——架构文档「resumed 与 live 不漂移」
  保证的结构化实现。进程重启后重跑补齐链即可,累积字段归零。
- **补齐态 vs 累积态**的边界:前者可从磁盘/配置重算,后者(队列、activeRun)
  只活在 SessionRuntime。
- **种子不是真理**:`modeName` 补齐后即失效,实际配置以 `tool_config` entry
  为准,模式座位按值匹配(ADR-0005 不变);`modelName` 随每条消息重写。
- 补齐产物**回写**进各自的数据袋(原地补齐,如 `fillModel(catalog, m)`),
  因为每请求重跑所以永不过期——等价于缓存,但无失效问题。
