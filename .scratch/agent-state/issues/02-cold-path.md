# 02：冷路径——没被打开的会话怎么读、怎么改

Type: grilling
Status: open

## Question

`SessionManager.states`（`packages/core/src/session/session-manager.ts:1377`）删掉之后，**没被打开的会话**
如何读写。现存的冷路径调用点：

| 位置 | 做什么 | 性质 |
| --- | --- | --- |
| `hub.ts:402` | 按 entryId 找 entry（分支跳转） | 读 |
| `hub.ts:558` | 分叉时取源文件路径 | 读 |
| `hub.ts:563` | `forkFrom` | **写**（落一对新文件） |
| `hub.ts:587` | `setTitle`（侧边栏重命名） | **写** |
| `hub.ts:636` / `:648` | `remove` | **写**（删文件） |
| `projection.ts:180` | 活会话的标题/时间戳 | 读（可改从 AgentState 读） |
| `session-factory.ts:187` | `readSessionSnapshot` | 读（本来就自己 fill） |
| `findSessionFilePathById` | 扫目录 | 本来不缓存 |

两条路：

- **(a) `SessionManager.open(id): Session`**：fill 一份、**不缓存**、调用方用完就丢；冷写就是「fill → 改 →
  persist」。并发安全靠现有的 claim（同一个会话一次只有一个改变它的请求），必须在文档里写明这条前提。
- **(b) 调用方自己 `fillSession(path)`**：`SessionManager` 只留纯函数，不收 id。hub 要知道路径解析规则。

另需定：`forkFrom` 造出来的新会话要不要顺手进 AgentState（现在是 `states` 自动收，下一次 `stateOf` 拿到同一份），
还是等它自己的 open（那就会 fill 两次、读到刚写好的文件）。

➡️ 推荐 **(a)** + fork 的新会话**等自己的 open**（少一条「写入即入表」的隐式路径，代价是一次重复 fill）。
