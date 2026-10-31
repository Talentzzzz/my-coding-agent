# 10:ModelManager——Model 纯数据袋、fillModel、请求路径

Type: task
Status: resolved
Blocked by: 07

## Question

建 `ModelManager`(无状态单例或函数模块),把模型选择与请求构造改为数据流:

- `Model` 纯数据袋:种子只有 `{ name?, thinkingLevel? }`(客户端 ModelSelection
  原样);`fillModel(catalog, model)` 按名从 catalog 查 `ModelConfig` 行,把
  endpoint/apiKey/模型事实**原地补齐**进袋(对应现有 `applyRowToModel` 的
  「原地重算不换对象」语义);查不到名字即抛。
- `fillModel` **每请求重跑**(幂等),models.json 中途编辑不残留旧值。
- catalog 是全局只读共享态(启动时读一次,hub 持有;**不进**会话侧任何袋),
  仅作为 fillModel 的参数。
- 发请求:用补齐后的袋现造薄请求对象(运行局部变量,用完即弃),对接现有
  `packages/llm` 的 transport;`Model` 类与状态袋的重名处理:kernel 内靠类型
  推断绕开,必要时把 llm 请求对象改名为 `ResolvedModel`(唯一允许触碰
  vendored 命名的地方)。
- 密钥红线:apiKey 只进请求路径,不进任何事件、快照、REST 响应
  (`GET /api/models` 保持只报 `hasApiKey`)。
- 与 `recordSelection` 的关系:选择对比改为与账本派生值比较
  (`buildSessionContext` 已返回链上的 model/thinkingLevel),袋里不缓存
  recorded* 字段。`npm run check` + `smoke-models.ts` 通过。
