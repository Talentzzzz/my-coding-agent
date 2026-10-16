# 06 工作区右键菜单：新建会话 / 重命名 / 删除

Type: task
Status: resolved
Label: feature
Resolution: 2026-10-17

## Question

给侧边栏工作区分组标题（`sidebar.ts` 的 `workspace-head`）加 `contextmenu` 菜单（复用 `openMenuAt()`，与会话行菜单同路），三项按已定决策：

1. **新建会话**——在**被右键的那个工作区**里新建（现在新建会话只会落在「当前」工作区；这要求新建动作能指定 cwd，客户端把 cwd 传给服务端）。
2. **重命名**——直接改本地文件夹名；该工作区下所有会话记录里的 cwd 跟随更新为新路径。需要服务端新端点（按 AGENTS.md 形状：控制器一个方法 + `createRoutes()` 一条记录）。注意 Windows 上重命名被占用目录会失败，失败要作为错误回报给客户端。
3. **删除**——仅从列表移除，不碰磁盘。会话文件保留在原地；列表如何表达「隐藏的工作区」需要想清楚（候选：设置里记一个隐藏清单，或删除时把该工作区下会话标记归档——实现时定，倾向最便宜的那个）。

验收：右键哪个工作区就在哪新建；重命名后侧边栏分组与旧会话都跟着新路径走；删除后该分组消失但磁盘文件原样。

## Answer

### 1. 三条验收各自落在哪

**右键哪个工作区就在哪新建**：表头的 `contextmenu` 开一张三项菜单（`openMenuAt()`，与会话行菜单同一条路），「新建会话」把 `cwd` 一起交给 `onNewSession(cwd)`；`main.ts` 先把它折进 `pickedWorkspace` 再走既有的 `newSession(cwd)` —— `POST /api/sessions` 早就收 `cwd`，所以这条只差把「被右键的那个」传下去。

**重命名后分组与旧会话一起走**：`POST /api/workspaces/rename`，一个操作两半，顺序是刻意的——先 `rename()` 用户自己的文件夹（失败得最早，且失败时 store 一个字没动），再搬 agent home 下按路径命名的会话目录，最后只重写每个文件 header 那一行的 `cwd` 与 `parentSession`，header 之后的行按字节原样写回（不认识的 entry kind 因此能活下来）。客户端只负责把新名字拼成一个绝对路径：输入的是**一段**，目录是分组自己的，分隔符从原路径里取。设置里两个按路径命名的字段跟着走：`appearance.workspaces` 的键就地重新挂名，嵌在被改名目录里的工作区条目被忘掉；`hiddenWorkspaces` 刻意不动。

**删除后分组消失、磁盘原样**：`POST /api/workspaces/hide` 只往 `hiddenWorkspaces` 里加一条路径，会话文件与文件夹一个字都不动。

### 2. 「哪些工作区在列表里」只有一条规则

code-review 的 Spec 轴抓出这条验收**当时是坏的**：`deleteWorkspace` 拿服务端给的过滤后清单去 `rows.loadFrom(...)`，而 `loadFrom` 在通道 live 时明确拒收（那是行表的单写者规则），于是侧边栏继续从 `rows.groups()` 重建，分组根本不消失；更糟的是**通道概览（连接时那份基线）压根没过滤**，所以刷新一次被删掉的分组就自己长回来。原实现只在 REST 那一侧过滤，正是「同一个规则写两遍就会打架」的实例。

修法是把它收成一个家：`SessionHub.listsWorkspace(cwd)`。REST 列表（`workspaces()` / `listing()`）与通道两条入路（`MuxServer.overview()` 的基线、`onRow` 的每一行）都问它，所以两边永远说同一件事，也不会出现「某个会话一变动，删掉的分组自己回来」。搁置/取回不改变任何一行，因此没有 `session_row` 能承载它：新增 `SessionListener.onWorkspaceListingChanged`，boot 把它接给 `mux.broadcastSessions()` —— **重发一份概览**（客户端本来就会用最新的 `sessions` 帧整表替换），而不是发明第二种消息。

### 3. 删除的回头路（本次新定）

原票面没定，实现里也没有：隐藏清单在窗口里是单向的（设置面板按上一会话的决定不做这个控件）。按本次决定补上**「在该目录新建会话即取消隐藏」**：`SessionController.create` 建完会话后调 `restoreWorkspace(root)`，把那一路径从清单里去掉并通知同一间 listener。这样「仅从列表移除」是完整的——文件没动，回来用它就重新出现在列表里——而不需要给面板加第二个门。

### 4. code-review 抓到并当场修掉的东西

- **删除不生效**（见 2）——验收第 3 条。
- **重命名的字节比较**：`rewriteHeaderPaths` 用 `resolvePath(cwd) === from` 判断 header 该不该改，而 header 里是建会话时的拼法、`from` 是请求里的拼法；Windows 上 `C:\Work` 与 `c:\work` 是同一个目录，那一行就会被跳过，rename 照样回 200，那条会话永远留在旧路径上。改成与邻座一致的 `fileKey` 比较。
- **`text-dialog.ts` 的 Escape 泄漏**：Escape 只 `closeTextDialog()`、从不 settle，`askForText` 的 promise 一直悬着直到窗口结束（把卡片顶掉那条路同病）。现在卡片把「元素 + 它唯一的出口 `finish`」一起登记，Escape 与被顶掉都走同一个 `finish(undefined)`；`closeTextDialog` 收回模块内部。
- **`style.css` 里的字面颜色**：`.text-dialog-overlay` 抄了 `.settings-overlay` 的 `rgb(0 0 0 / 32%)`，而 AGENTS.md 说这是 bug。提成 `tokens.css` 的 `--dsw-scrim`（一个值覆盖两套主题），两个遮罩都改用它。
- **`docs/architecture.md` 的端点表**：补上 `/api/workspaces/rename` 与 `/api/workspaces/hide` 两行，并在表下的段落里写明「被搁置的工作区」这条过滤规则与概览重发。

### 5. 量具

- `smoke-sessions.ts` 新节「a workspace can be renamed and put aside」：状态码矩阵（400 同目录 / 404 未知 / 409 目标被占、父目录缺失、有活会话、store 目录被占）、文件夹真的搬了、header 跟着走、隐藏后列表少一组而文件与 transcript 原样、空清单是一条「选择」、以及本次新加的**新建会话即取消隐藏**。它用 `settingsHome: <临时目录>`，不写开发者自己的 `settings.json`。
- `smoke-mux-live.ts` 新节「被搁置的工作区离开概览，回来时也回到概览」：真服务器 + 真 WebSocket + 生产的 `MuxClient`，把帧喂进生产的 `SessionRows`，断言搁置后**概览重发**且行表里不再有该分组的任何一行、REST 列表说同一件事，再在该目录建会话后分组与 REST 列表一起回来。**这一节在改动前是红的**（那时没有概览重发这一帧）。
- `smoke-sidebar.ts`：第 18 节（表头右键菜单：三项、新建会话带的是右键那个 cwd、卡片打开时输入框里是当前文件夹名、提交的是原路径+新名字、名字没变与带分隔符/`..` 都不发请求）、第 19 节（重命名后表头就地重新挂名，旧 wrapper 连同表头一起摘掉）、**第 20 节（Escape 与被顶掉都必须给出答案）**。
- `scripts/dom-shim.ts`：`document` 原先的 `addEventListener` 是空实现，于是 `menu.ts` 与 `text-dialog.ts` 的每一条 `document` 路在量具里都不可达——第 20 节能量到东西的前提就是把这个补上（`document` 与 `window` 现在共用同一个 `listenerBag()`）。
- `npm run check`、`smoke-tools`、`smoke-sessions`、`smoke-sidebar`、`smoke-mux`、`smoke-mux-live`、`smoke-mux-client`、`smoke-projection`、`smoke-liveness`、`smoke-backpressure`、`smoke-settings`、`smoke-transcript`、`smoke-branch`、`smoke-session`、`smoke-models`、`smoke-approval`、`smoke-approval-endpoint`、`smoke-replay` 全绿（`smoke-api` 需要跑着的服务器，未跑）。

### 6. 记在账上、这次没动的（判断题级）

- **Windows 路径比较这条规则被手写了四遍**：`hub.samePath`、`sessions.pathKey/underPath`、`session-manager.fileKey/isInside`，跨三个 package。本次按决定只修验收与硬违规，去重留作后续（收进 core 的 `paths.ts` 是一处自然的家）。
- `session-manager.ts` 里新增的 ~140 行 header 重写（`repathWorkspace` / `rewriteHeaderPaths` / `sessionFilesIn` / `isInside`）与「transcripts 住在哪」挤在同一个文件：命名与注释已经按那个方向写，抽出去是下一刀。
- 一个动作三个词：菜单说「删除」、端点叫 `hideWorkspace`、设置里叫 `hiddenWorkspaces`，`onDeleteWorkspace` 又是第四个。理由都写在各自注释里了，但用词本身仍值得统一。
- 服务端 4xx 正文中英混用：本票新增的两条（同目录 / 目录被占）与 `hub.ts` 的活跃会话拒绝是**给人看的中文**，而同一控制器其余 20 条是英文的协议错误。留着的原因是前一类会原样进错误条给人读。
- 设置面板没有「已隐藏的工作区」清单：有 3 的回头路之后它不再是必需品，但「删了以后想不起来删过什么」仍然只能靠手改 `settings.json`。
- `SessionHub.listsWorkspace` 里有一行「没有 root 就一律算在列表里」。那不是生产状态（`HubOptions` 要求 `cwd`），是给 `scripts/smoke-approval.ts` 第一段那个**被 `docs/notes.md` §一定住不许修**的 `new SessionHub({ workspaceRoot: root })` 留的：过滤这一动作本身要求读 root 的设置，而那个 hub 根本没有 root。定住的那条构造因此仍然成立（它自己挂会话、不问工作区任何事）。

### 7. 没做

- 真窗口目视（`npm run desktop:dev`）：三条路都走通了量具，但没有在真窗口里点过；尤其「重命名后侧边栏只剩一组」是靠第 19 节量的。
- `docs/architecture.md` / `AGENTS.md` 的术语表没有「被搁置的工作区」词条——表下的那段说明是这次补的，词条留到有人需要时。
