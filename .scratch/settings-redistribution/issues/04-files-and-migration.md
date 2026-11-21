# 04 - 磁盘文件形态：每持有者一份文件 + 读时迁移

Type: grilling
Status: resolved

## Question

拆分后是一份 `settings.json` 保留、各持有者按字段分片？还是每持有者自己的文件？旧
`settings.json` 的存量数据怎么办（本仓库惯例是「不迁移」，但这次丢的是用户真实偏好）？

## Answer

**每持有者一份文件 + 一次性读时迁移**（用户采纳推荐）：

| 文件 | 持有者 | 内容 |
| --- | --- | --- |
| `tools.json` | ToolManager | 默认工具集 `tools`、`modes` 表、`approval`、`bash` |
| `sessions.json` | SessionManager | `steeringMode`、`followUpMode` |
| `models.json` | ModelManager | 模型行 + `defaultModel` + `defaultModelSeeded` |
| `ui.json` | UI 持有者 | `appearance`、`hiddenDirectories`、`directoryNames` |
| `engine.json` | 编排层（Agent） | `retry` |
| `settings.json`（旧） | —— | 只作迁移源，此后被忽略 |

迁移规则：各持有者首次读取时，若**自己的文件尚不存在**且旧 `settings.json` 存在，则用现有的
规范化函数从旧文件捡走自己的簇、写自己的文件；此后旧文件被忽略——不迁移不删除，与 ADR-0019
对旧项目层的处理同形，但这次用户数据先被保住再被忽略。

细节见 [spec.md](../spec.md) §4。
