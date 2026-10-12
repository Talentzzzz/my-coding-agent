# 概况通道与内容分道

Type: grilling
Status: open
Blocked by: 05

## Question

DSH 的性质是："**没人引用的会话，内容根本不发**……但**概况照常更新**：侧边栏那一行还是会变成'运行中'、标题时间会动。概况走的是另一条很轻的目录投影通道，与逐条内容分开。"

本仓库今天**两样都没有**，而且第二样比想象中更坏——不是慢，是**没有这个数据**：

- 侧边栏那一行**根本没有"运行中"这个状态**：`packages/web/src/render/sidebar.ts:180-183` 只渲染 `title` + `relativeTime(session.createdAt)`。
- `SessionRef` 只有 `id / cwd / createdAt / title / parentId`（`packages/core/src/protocol.ts:11-15`）。真正表示最后活动的 `info.modified` 在服务端**算了**（`packages/core/src/session/session-manager.ts:688-701`，排序用它，`:739`）却**没有上线**。
- 于是"会话 A 在后台跑完一轮而你在看 B"时，**那一行永远不变**——不是 1 秒也不是 1 小时；连手动 `refreshLists()` 都改不了它的文本（`render/sidebar.ts:70-80` 的 signature 只含 id/parentId/title）。
- 客户端全局无 `setInterval`，列表刷新只发生在 `openSession`、`follow`、启动三处（`packages/web/src/main.ts:365,386,547`）。**一轮运行结束永远不会刷新侧边栏。**

要钉死的是：

1. **概况携带什么字段**。至少：是否在跑（是否 `submitting`）、最后活动时间（`modified` 要不要上线）、标题（今天从第一条有文本的用户消息推导，活会话与列表一视同仁）。还有别的吗？
2. **分道的粒度**。**研究票 01 查实 DSH 分的是三条逻辑流，不是两条**（`../research/dsh-portability.md` §3）：每会话一条 `session.follow` journal（内容）、全 Host 一条 `session.control` 快照流（投影值，`title` 走这条）、以及全 Host 一条 `$events` 转发事件流——而 **`running` 既不在前两条上，它走 `$events`**。三者同在一条 WebSocket 上按 `streamId` 分道，**不是同一条流上的两类帧**。

   这对本仓库是个直接的反问：今天 `submitting` 只在流的 `onChange` 快照里（`packages/server/src/stream-registry.ts:220-228`），而 `title` / `modified` 在会话 header 里。本仓库要不要照三条分？还是两条就够（内容 + 概况），把"通知"并进概况？票 05 定了信封之后本票才能定。**取舍的判据**：概况必须能在"没有订阅任何内容"时照常更新，否则后台会话那一行又会冻住——而 `running` 属于概况还是通知，决定了后台会话能不能显示"运行中"。
3. **谁维护投影**。今天列表是"请求时读目录"（`SessionHub.snapshotOf` 的冷读路径 + `SessionManager` 的列表扫描）。要不要像 DSH 那样有一个内存投影 store？还是每次变更时从目录重读（代价：N 个会话 × 每次事件一次文件扫描）？
4. **概况的推送时机**。会话事件里已经有 `entry_appended`、`config_changed`、`queue_update` 等（`packages/core/src/protocol.ts`），哪些该触发概况更新？`submitting` 只在 `onChange` 快照里（`stream-registry.ts:220-228`），没有人在看的时候它谁都不发——这正是要解决的问题。
5. **侧边栏排序**。今天同工作区内按 `modified` 排序、工作区分组按 `createdAt`（`session-manager.ts:739,1611-1613`）。概况上线之后，这一行会不会在用户眼前跳动（正在看的会话因为收到一条消息而跳到顶部）？如果会，UX 上怎么处理。

## Answer

<!-- 解决时在下面追加。 -->
