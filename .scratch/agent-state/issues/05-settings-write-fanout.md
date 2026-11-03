# 05：设置写入扇出——一次修改改到哪些袋

Type: grilling
Status: open
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
