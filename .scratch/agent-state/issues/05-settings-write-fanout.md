# 05：设置写入扇出——一次修改改到哪些袋

Type: grilling
Status: resolved
Blocked by: 01

## Question

`SettingsManager.states`（`packages/core/src/settings-manager.ts:423`）删掉后，`stateOf(dir)` 每次都是一次
`fillSettings(dir, home)`。于是**同一个目录的两个活会话拿到两个 `SettingsState` 对象**（现在是同一个引用）。

设置面板的一次修改走 `applySettings(entry.settings, patch)`（`agent.ts:2115`），只改发起命令那个会话的袋；
另一个活着的会话读到旧值——而它可能正在跑，也可能刚被切走、还没被驱逐。

三条路：

- **(a) 只改自己**：其余袋在下一次 open 时 refill。单窗口下多数时候够了；正在跑的会话读到旧值是可接受的
  （`Live` 优先，见地图 Notes）。
- **(b) hub 写盘后按目录扇出**：把新值同步给该目录所有 `AgentState.setting`。要一张「目录 → 会话」的反查表，
  正是这次要删的那类表。
- **(c) 表留在 hub**（按目录一份），`AgentState.setting` 指向它——等于把 `SettingsManager` 的缓存搬了个地方，
  与「`SettingsManager` 去掉 state」的拍板相冲突。

另需定：**会话级设置**（`sessionSetting.activeTools` / `approval`）与**目录级设置**（`modes` / `retry` /
`approval` 默认）现在同读一个袋，去 state 之后这条边界是否变化——我倾向不变（袋还是那个袋，只是不再共享）。

➡️ 推荐 **(a)**，并在文档里写死一句话：**设置是打开时读到的一份快照；一次写入只作用于当前会话，其余会话下次
打开时看到。** (b) 顺带否决，理由是它要把刚删掉的反查表请回来。

## Answer

### 结论（一句话）

票面推荐照批：**(a) 只改自己**。要写死的那句话照票面原文：**设置是打开时读到的一份快照；一次写入只作用于当前
会话，其余会话下次打开时看到。** (b) 否决——目录 → 会话反查表正是这次要删的那类表；(c) 与 (b) 同罪，只是搬了
个地方。会话级与目录级设置的边界**不变**。

### 1. 行为差异只有一条，且方向是「变少」

今天（缓存还在，`settings-manager.ts:423`）同目录的两个活会话拿同一个袋引用，`applySettings`（`agent.ts:2115`）
原地改，另一个会话**立即**看到。去 state 之后，每次 open 一份新袋，另一个会话读到旧值——直到它被驱逐、下次
open 时 refill。没有别的东西变：

- 写盘照旧（`applySettings` 本来就收袋、写回值所在的文件），磁盘真相是共享的，快照不是；
- 正在跑的会话读旧值，与地图 Notes 的 `Live` 规则同调——运行中的一切本来就读 Live，设置袋对它不是承诺；
- 客户端不感知：它看到的还是自己会话的快照与 `config_changed`，扇出从来不是窗口依赖的语义，是缓存的副产品。

### 2. 边界不变：两半还是分居两处

会话级（`sessionSetting.activeTools` / `approval`，记在快照字段）与目录级（`modes` / `retry` / 默认
`approval`，记在袋里）的关系照旧：袋还是那个袋，只是**每个会话一份**、不再共享。`tool-config.ts` 的合并顺序
（袋在下、快照字段在上）不因此动一行。

### 3. 落点

| 下游票 | 从本票拿走的 |
|---|---|
| 11 | `fillSettings` 每次一份新袋；在 `applySettings` 的注释里写「其余会话下次打开时看到」 |
| 14 | architecture.md 把那句话写死（本票不写——文档不许跑在代码前面，04 补二的教训） |
| 06 / ADR | 快照语义一句进 ADR：袋是打开时读到的一份快照，不是目录的常驻视图 |
| 15 | smoke 建议补一节：同目录两个会话，一边 `applySettings`，另一边的袋不变、重开后看到新值 |

