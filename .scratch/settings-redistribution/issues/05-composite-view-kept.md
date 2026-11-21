# 05 - resolveSettings 组合视图的命运：保留

Type: grilling
Status: resolved

## Question

ADR-0019 的核心成果是「这个会话此刻处于什么配置」的唯一答案 `resolveSettings`。拆分后：
(a) 保留——只换输入来源；(b) 按消费者拆散，不再有组合视图。

## Answer

**(a) 保留组合视图**（用户采纳推荐）：

- `resolveSettings` 仍是闸门、prompt、请求构建与快照共同的唯一答案；变的只是输入来源——
  工具半（默认集、modes、approval 基线）从 ToolManager 来，模型半（行目录、默认 ref）从
  ModelManager 来。签名从「整份 GlobalSettings」改为「两个窄输入」。
- 拆掉它会让每条消费链重新长出自己的回落规则——那正是 ADR-0019 消灭过的东西。
- 原来 `Settings.global` 原样透传的零散读取（bash、retry、队列模式）改为消费者直接读各自的
  持有者——它们本来就是跨会话常量，不属于组合视图。

细节见 [spec.md](../spec.md) §6。
