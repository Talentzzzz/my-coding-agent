# 0029：UI 设置迁往客户端存储——`UiSettingsManager` 退场，外壳桥接持久化

日期：2026-11-20 · 状态：已接受，已落地
取代：[0028](0028-settings-ownership-per-manager.md) 归属表中的 **UI 行**（`appearance`、
`hiddenDirectories`、`directoryNames` 归 `UiSettingsManager`、住 `ui.json`）；0028 的其余四行
（工具、会话、模型、引擎）原样保留——变的只是其中一簇换了一个所有者

它满足 `docs/adr/README.md` 的三条：改回去要重建 `ui-settings.ts` 与它的持有者、把 UI 三字段
接回 `GlobalSettings` / `SettingsPatch` / `GlobalSettingsSnapshot` 与 server 的设置路由；下一
个人读 `packages/web/src/ui-settings.ts` 会问「为什么 UI 设置不在服务端跟其他设置住在一起」，
而这一次答案是**故意的**——这簇字段从头到尾只被窗口消费，服务端持有它们从来只是「恰好那里有
一个能落盘的地方」。放弃的是「所有设置一个家」的整齐，换来的是**数据住在其唯一读者的身边**。

## 背景

0028 把 UI 簇从 `settings.json` 拆出来给了 `UiSettingsManager` 与 `ui.json`。那一步解决了归属
问题（不再合租），但没有回答一个更根本的问题：**这簇数据的消费者是谁？**

答案是：只有窗口。外观（主题、字号、两个宽度、目录翻页）、隐藏目录、目录改名——服务端读它们
只为了两件事：把窗口自己的决定原样递回去（settings 快照），以及替窗口过滤目录列表。数据出生在
窗口的控件里，唯一的意义在窗口的绘制里，却住在服务端的文件里，每次变更走一次网络往返、每次
启动走一次读取。中间人是纯粹的邮差。

当初归服务端有一条真实的技术理由：桌面外壳每次启动都换端口（`main.cjs` 的 `port: 0`），而
`localStorage` 按 origin（含端口）隔离——存在那里的偏好在窗口换个端口重开的那一刻就被忘掉。
这条理由挡住的是「存进浏览器 origin 存储」这一种前端存储，不是「前端自己持久化」这件事本身。

## 决定

1. **UI 设置是客户端的设置。** `appearance`、`hiddenDirectories`、`directoryNames` 三簇字段
   迁往 `packages/web/src/ui-settings.ts`：类型、`DEFAULT_APPEARANCE`、三个 RANGE 常量与
   `clamp*` 规范化器随簇搬走。core 侧整个 `ui-settings.ts` 退场（类、patch、规范化器、迁移），
   `ui.json` 不再有写者——按本仓库对退场文件的惯例，盘上的旧文件不删除、不迁移；里面的偏好
   随之重置为默认，是一次明说的放弃，换来的是所有权再无歧义。

2. **存储是双路适配器，不是裸 `localStorage`。** `loadUiSettings` / `saveUiSettings` 是仅有的
   两个读写口：
   - **桌面外壳**：`window.desktop.readUiSettings` / `writeUiSettings`（preload 经
     `contextBridge` 暴露，仅这两个 handler，没有 IPC 透传）。主进程把整份对象原子写进 Electron
     userData 下的 `ui-settings.json`——与 `workdir.txt` 同一个目录，同为「外壳自己的事实」，
     服务器与 agent home 从不读它。这就是当初归服务端那条技术理由的正面回答：偏好持久化的
     责任从「服务器恰好有个家」移交给「外壳本来就有 userData」。
   - **浏览器**：回落 origin 作用域的 `localStorage`（键 `my-agent.ui-settings`）。浏览器的
     地址是用户自己敲的，稳定；坏掉的存储回落默认，不挡窗口起来。
   写入形状是**整份对象**的读-改-写；补丁合并（appearance 嵌套合并、隐藏列表整体替换、
   名字按键合并）在适配器之上，与 0028 的写路径语义同构。

3. **服务端对目录列表不再过滤。** `hiddenDirectories` 是窗口的视图决定，`SessionHub.listsDirectory`
   与 mux 的 `listed` 过滤退场——`GET /api/directories`、通道 overview 与 REST 列表返回机器的
   全部目录，由客户端在 `visibleGroups()` 一处按自己的列表过滤。两个目录命令随之退场：
   `POST /api/directories/rename` 与 `POST /api/directories/hide`（改名与隐藏都成了客户端本地
   动作），`SessionListener.onDirectoryListingChanged` 与 hub 的整表重发（`publishResync`）
   一并退场——不再有「目录进出列表」这种服务端可广播的事。「在搁置的目录里新建会话把它领回」
   改在客户端的出生路径上做（`unhideDirectory`），语义不变：会话文件与文件夹从未被碰过。

4. **wire 与 REST 面收窄。** `GlobalSettingsSnapshot` 与 `SettingsPatch` / `GlobalSettings`
   去掉 UI 三字段；`PATCH /api/settings` 不再接受它们（服务端对这些字段从不拒绝未知键，收窄后
   它们只是不再被读）。设置面板的外观页改读本窗口的 `uiSettings`，面板签名随之多出
   `appearance` 一个输入。`Agent` 的 `uiSettings` 持有者、`hiddenDirectories()` 转发、
   `applySettings` / `settings()` 的 UI 半退场——四个持有者的归属表由 0028 的五改为四，
   `check-server-facade` 的禁名单随类名退场同步收窄。

## 后果

换来的：

- 数据住在唯一读者的身边：UI 变更零网络往返、立即生效；启动装载不经过服务器，服务器下线的
  窗口照常戴上自己的主题与字号。
- `UiSettingsManager`、`ui.json`、两个目录端点与整表重发退场；core 的设置持有者从五个减到
  四个，每个的字段全部有服务端意义上的消费者。
- 「桌面外壳换端口丢偏好」的死结由外壳自己的 userData 解开，不再需要服务端代管。

背上的：

- 偏好不再跨设备/跨存储后端共享：一台机器上的浏览器 tab 与桌面窗口各持一份（浏览器那份按
  origin）；`ui.json` 里已有的偏好一次性放弃。
- 隐藏目录不再即时跨窗口一致：另一个窗口要等自己的下一次装载才看到同一条隐藏——单用户产品里
  这是可接受的服务降级，换掉的是「服务端持有谁也画不出来的状态」那笔更贵的账。
- localStorage 分支与外壳桥是同一份设置的两种持久化，各自由各自的环境保证 origin 或 userData
  的稳定性；适配器是这两条路的唯一汇合点，动其中一条先读 `ui-settings.ts` 的头注。

## 没有被取代的

0028 的其余决定逐条成立：四个持有者的归属表、读时迁移（其余四簇）、门面按簇路由、组合视图
（`resolveSettings`）。0028 归属表的 UI 行由本 ADR 的「客户端自己的存储」一行取代——它是归属
表的第五行第一次离开服务端，而不是持有者之间又一次搬家。
