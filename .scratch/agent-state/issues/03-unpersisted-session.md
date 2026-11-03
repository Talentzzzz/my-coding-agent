# 03：未落盘的会话——hub.pending 与 adopt 往哪放

Type: grilling
Status: resolved

## Question

「没说过话的会话不落盘」（`persistEntry` 的 `hasConversation` 闸门）现在靠两处持有：

1. `hub.pending: Map<id, Session>`（`packages/server/src/hub.ts:267`）——建出 id 到第一条消息之间，文件不存在，
   `has()` / `snapshotOf()` / `open()` 都先查这张表；
2. `ensureSession` 里的 `sessionManager.adopt(session)`（`session-factory.ts:266`）——把调用方的袋交给账本缓存，
   让 id 立刻答得出同一个对象。

`AgentState.session` 一旦能装未落盘的 `Session`（`persist: true` + `fileCreated: false` + `sessionFileAbsPath`
暂缺），这两处就都是第三份。

要定：

1. 未落盘的会话是否也算「打开」——即建出 id 那一刻就进 Map（哪怕没人看、磁盘上什么都没有）；
2. `pending` 删掉后，`has()` / `snapshotOf()` / `open()` 三条判据改成什么（现在是「先 pending 再盘」）；
3. `SessionManager.adopt` 是否随之删除；不删的话它给谁用；
4. 首条消息落盘后，`sessionFileAbsPath` 是补进同一个 `AgentState.session`，还是换一个新的（前者显然）。

➡️ 推荐：**建 id 即入表**（它本来就活在内存里，「不落盘」靠 `fileCreated` 而不是靠没人持有）；`pending` 与
`adopt` 一起删；`sessionFileAbsPath` 原地补齐。

## Answer

### 结论（一句话）

**建 id 即入表**——而且这不是一个取舍，是删掉 `pending` 之后**剩下的唯一一条**（第 1 节）；`pending`
与 `SessionManager.adopt` 一起删（第 5 节）；问题 4 的前提不成立——`sessionFileAbsPath` 在落盘会话上**从来没有缺过**
（第 6 节）；由此给 04 补一条驱逐判据、给 `hosts ⊆ 表` 配一条执行面（第 7 节）。

### 1. 为什么「建 id 即入表」不是选项，是剩下的那一个

四条事实串起来就锁死了：

1. `newSession()` 把 id 交出去（`hub.ts:526-532`），而客户端拿到一个新 id 的第一件事**不是 claim，是订阅**：
   `retain()` 恒发 `open`（`packages/web/src/client.ts:418`，ADR-0010）。
2. `open` 帧遇到这条还没订过的 id，第一件要问的就是 `this.hub.has(sessionId)`（`mux.ts:294`），假就是「未知的会话」，
   整条流当场 `error` + `end`。
3. 这一刻磁盘上什么都没有：`findSessionFilePathById` 扫的是每个会话目录里的 `.json`（`session-manager.ts:2018-2044`，
   命中的那一句是 `if (meta?.id === id)`），而未落盘的会话一个文件都没生（`persistEntry` 的 `hasConversation` 闸，
   `:1205-1223`）。
4. 所以「这个 id 存在」这件事，只能由内存里某张 id→袋 的 Map 回答。

今天这张 Map 是 `pending`（`hub.ts:267`）。01 号票定了 `agent.adopt(state)` 是进表的**唯一**入口，10 号票删掉
`SessionManager.states`。三条一起，能装这个袋的地方只剩一个：**Agent 那张表**。不入表，就得把 `pending` 换个名字
留下——想「推迟到 `open` 再入表」也不行：`open` 那一刻手里先得有那个袋，而这个袋无文件可 `fill`。

**顺带回答了「未落盘的算不算打开」**：算，但「打开」从此指**这个进程握着它**，不指「有人看」也不指「在跑」。
三件事互不换算，与 ADR-0001 的「订阅 / claim」是同一种互不换算。

### 2. 对 12 号票的修正：`hosts` 是表的子集，不是孪生

12 写着「`hosts` 留、`AgentState` 的存亡跟随 `hosts` 的增删，**两者同生同灭**」。这句在 03 之后不成立，而且必须
不成立：一个刚建出来的会话在表里、**没有** host（host 是 `claim` 造出来的，`hub.ts:424-446`），而它在被 claim 之前
必须已经可读（第 1 节）。正确的关系是 `hosts ⊆ 表`：

| 问题 | 谁回答 | 都不等于 |
|---|---|---|
| 这个进程握着它吗（id 有效、能读能改） | Agent 的表 | — |
| 有人在看吗 | `observers` | 握着 |
| 有人在用它／跑它吗 | `hosts` 的 claim 计数与在飞运行 | 握着 |

这件事有个更好的说法，也是给 ADR-0011 的：**表装的从来不是「有文件的」，是「丢了就没了的那一份」**。这条是
**重读** ADR-0007 §4 的用意，不是引它的原文——§4 写的是「只装『**进行中且**磁盘上没有』的东西」，而本图要放宽的
正是那个「且」：盘上有文件的会话也进表（它有队列与订阅），盘上什么都没有的会话也进表（它连 id 都只活在这里）。
ADR-0011 要按这个新判据重写 §4 那一句。按这条，fork 有文件却不入表（02 号票），新建的会话没文件却入表——两个
都不矛盾。`fileCreated === false` 的袋是这条判据**最纯粹**的样本：磁盘上连半份都没有。

**`hosts ⊆ 表` 需要一个执行面，否则它只是断言。** 拿到这个不变式的是一条方向相反的约束：**`evict` / `drop` 只在
`hosts` 里已经没有那个 id 之后才调**。因为 `has()` 从此不问 `hosts`，反过来删表时问一次是唯一能兑现它的地方；
而这个判据归 hub（`hosts` 在它手上），不归 Agent——与地图那句「Agent 提供 `evict` 并自己再判一次」并不冲突：Agent
再判它拿得到的那几条（在飞运行、`suspended`、`fileCreated`），hub 判它自己那几条（observers、claims、`hosts`）。
注意这两条闸的朝向是相反的，别写成一条：**有 host 不许删**、**没文件不许删**，剩下那条窄缝才是可清的。

三处跟着改的话：

- `entryOf` 的抛词（`agent.ts:1219-1223`）「`Session is not running: ${id}`」在 03 之后是假话（表里的会话可以没在跑）。
  改成 `Session is not open: ${id}`，**并且与 `hub.snapshotNow` 那句（`hub.ts:386`）刻意不同**：那句是关于 host 的，
  留着「not running」。08 号票那句「现在抛 `Session is not running`，语义不变」作废。
- **`observe` 的回调仍以 `hosts` 为准，不许看表**（`mux.ts:310-317`）。看着一个「表里有、没 host」的会话，在订阅
  眼里仍是「从未在跑」：`live` 不翻，`bind` 不绑，流不会因为一次驱逐被 `end`。若改成看表，`live` 第一次回调就翻成
  true，之后任何一次 host 消失（删会话、收摊）都会给一条从没跑过的流发 `end`。
- **对 01 的两处补白（不是推翻）**：① 01 §6 写「两处 `openSessions.delete` → `agent.evict(id)`」，但 01 §4 定的
  `evict` 是带判据的，而这两处是宿主收摊、判据已经由 `remove` 自己拒过一遍——所以它们用的是不带判据的
  `drop(id)`（本票 §4）。② 01 §4 的「不公开 getter、表的读点只有一个」指的是**不把 Map 露出去**；`has(id)` 与
  `drop(id)` 是两个有名字的操作，不是 getter，也不给任何人遍历或整表清空的能力（`clear()` 依旧不造）。

### 3. 三条判据的新形状

判据从**三分支**（hosted / pending / 盘）压成**两分支**（表 / 盘）：hosted ⇒ 表，`pending` 那一支并进表那一支。

```ts
// hub.ts
has(id: string): boolean {
	return this.agent.has(id) || SessionManager.findSessionFilePathById(id) !== undefined;
}

async snapshotOf(id: string): Promise<SessionSnapshot> {
	// Anything this process holds answers from the bag, live or not: a hosted session must not be
	// read from a file that lags its turn, and an open one has no file at all.
	if (this.agent.has(id)) return this.agent.snapshot(id);
	// The cold half is 02's `open(id)`: a throwaway bag, no registration, and the refusal for an id
	// that names nothing is its own.
	const state = this.sessions.open(id);
	return readSessionSnapshot(this.sessionOptions(state, state.workDirAbsPath));
}

private async open(id: string): Promise<HostedSession> {
	// The held state first, the store second: a session created a moment ago has no file to find.
	const state = this.agent.has(id) ? this.agent.agentState(id) : await this.adoptFromDisk(id);
	const workDirAbsPath = state.session.sessionSetting.workDirAbsPath;
	const host = new HostedSession(id, workDirAbsPath);
	this.hosts.set(id, host);
	// observers and announceHost are unchanged.
	return host;
}

/** The one road a disk-backed session enters the table: fill, assemble, adopt, then read back. */
private async adoptFromDisk(id: string): Promise<AgentState> {
	const session = this.sessions.open(id);
	const { state } = await assembleSession(this.sessionOptions(session, session.workDirAbsPath));
	this.agent.adopt(state);
	// `adopt` is first-come: the authority is the state the table holds, not the one just assembled.
	return this.agent.agentState(id);
}
```

四处要点：

- **`snapshotOf` 的 hosted 分支被「表」吸收**，用的就是今天 hosted 走的那条 `agent.snapshot`。这是一个行为变化：
  「打开但没 host」的会话不再重新装配一遍，而是读袋。方向是对的——02 §①「活会话永不走冷路」对**写**说的理由
  （整只快照写回会退回旧值）对**读**同样成立，只是读的后果轻：读到的是这个进程最后认为的那份，而不是磁盘上落后
  的那份。冷读从此只留给**这个进程不握**的会话，`readSessionSnapshot` 那句「a session this process is not running」
  在 14 号票里要跟着改——它现在覆盖的集合从「没在跑」缩成「不握」。**冷分支本身也随之变短**：定位 + `fillSession`
  + 「Unknown session」三步并成 02 定下的一句 `this.sessions.open(id)`，与 02 §8 给 10 的落点
  （`hub.ts:363-369` 改 `open`）是同一处，本票不再保留那套手写的定位与拒绝文本。
- **它依赖 08 把 `snapshot` 的入口换掉**：今天 `Agent.snapshot` 前两句是 `this.sessionManager.stateOf(id)` 与
  `this.entryOf(id)`（`agent.ts:1241-1242`），而 `entryOf` 没有 host 就抛。08 把这两处换成 `agentStateOf(id)` 之后，
  「表里有、没 host」的会话才读得出来。第 8 节落点表里 15 那行（`newSession()` 之后 `snapshotOf` 读得出）成立的
  前提就是它，落地顺序不能颠倒。
- **判据与读取在同一个同步块里**（上面 `has` → `agentState` 之间没有 `await`；`await` 只出现在另一支）。表能被删的
  时机只有 `evict` / `drop` / 进程收尾，全都由 hub 自己在事件循环的同一拍里发起，所以「同一个同步块」就是完备的。
- **`adopt` 之后读回来**：`adopt` 是先到先得（01 §4），并发下装配出来的那份可能被丢掉；拿表里那只，host 才不会跑在
  一个表里没有的对象上。`open` 本来就被 `opening` 表串行化，这一行是让它不再依赖那个前提。

**创建因此变成一次装配**（创建 = 打开，是「建 id 即入表」的直接后果）：

```ts
private async createUnpersisted(workDirAbsPath: string): Promise<string> {
	const bag = createSession(workDirAbsPath);
	const { state } = await assembleSession(this.sessionOptions(bag, workDirAbsPath));
	this.agent.adopt(state);
	return state.session.sessionId;
}
```

两个调用方（`hub.ts:528`、`:827`）都已经是 `async`，加 `await` 即可。代价照实记两条：① 创建从此要读一次设置与
模型行（都是进程内缓存 / 一次文件读）；② 它第一次有了失败模式——但那是**同一件事提前发生**：今天这次装配发生在
紧随其后的那次 `open` 里，只是那时 id 已经交出去了，失败落成一条失败的订阅而不是一次失败的创建。这个顺序更好。

### 4. `remove` / `rename` / `close`

**`remove`（`hub.ts:613-651`）**：第一句 `const held = this.pending.delete(sessionId)` 没有一一对应的替代品，因为
今天的「删」被拆成两半做：记忆里的那一半靠 `pending.delete`，表里的那一半靠 `openSessions.delete`。合成一句：

```ts
async remove(sessionId: string): Promise<void> {
	const held = this.agent.has(sessionId); // Held is the whole of an unpersisted session's existence.
	const onDisk = SessionManager.findSessionFilePathById(sessionId) !== undefined;
	const hosted = this.hosts.get(sessionId);
	if (hosted !== undefined) {
		// The refusals (claims / opening / submitting / approvals) are unchanged.
		const closing = (async () => {
			await this.agent.settle(sessionId);
			if (this.hosts.get(sessionId) === hosted) this.hosts.delete(sessionId);
			// observers / announceHost / close are unchanged.
			if (onDisk) await this.sessions.remove(sessionId);
			this.agent.drop(sessionId); // Was openSessions.delete, same position.
		})();
		// …
	} else {
		// A session created here and never spoken in: forgetting the held state is the whole removal,
		// and there is nothing on disk to delete. An id nobody ever heard of still goes to the store,
		// so its refusal stays the 404 it always was.
		if (onDisk || !held) await this.sessions.remove(sessionId);
		this.agent.drop(sessionId);
	}
	this.current = undefined;
}
```

**`drop(id)` 与 `evict(id)` 是两个动词，别合并**：`evict` 带判据（04），而删一个正在被看的会话是合法的、`evict` 会
拒绝；判据里现在还多了 `hosts` 那条，而 `remove` 删的**正是**有 host 的会话——两件事从此不可能共用一个动词。所以
`remove` 与两处宿主收摊用的是不带判据的 `drop`。12 里「或直接 `sessions.delete`，这两处是宿主收摊，不需要判据」就是
它——只是得有一个公开名字（01 §4 只写了 `evict`，这里补上）。

**`rename`（`hub.ts:580-588`）**：`isHosted` 那条旗子可以整个去掉——

```ts
async rename(sessionId: string, title: string): Promise<void> {
	// A held session writes through its own bag (02 §①); a cold one fills a throwaway. An id that names
	// nothing refuses inside `open`, which is the 404 it always was.
	const bag = this.agent.has(sessionId) ? this.agent.agentState(sessionId).session : this.sessions.open(sessionId);
	this.sessions.setTitle(bag, title);
}
```

副作用要写明：**未落盘的会话从此可以被命名**（今天 404，因为既不 hosted 也不在盘上）。标题只留内存、随出生写出
——`recordMeta` 对 `fileCreated === false` 的袋就是这么处理的（`session-manager.ts:1247-1250`）。侧边栏看不到这种
会话，所以没有客户端路径会走到；REST 上它从一个假的 404 变成一个真的 200，这是正确方向。

**`close()`（`hub.ts:660-670`）**：`this.pending.clear()` 删掉。`openSessions.clear()` 由 12 删（01 §6：`clear()` 不造
替代品，表随编排层对象一起消失）。

一条给 15 的连带项：`scripts/mount-session.ts:52-67` 现在是「`ensureSession` + 手建 host」，按 01 改成
「`assembleSession` + `agent.adopt`」之后，那只**内存设置袋**会被第 7 节那条判据天然保住——`createSession` 出来的袋
`fileCreated === false`，不进驱逐，于是「释放后重开」复用同一只袋；今天则是丢表重装配，重开读到的是磁盘设置。方向是
对的（一个没说过话的会话，它的设置不该在重开时被掉包），但依赖旧行为写断言的那几段 smoke 要跟着看。

### 5. `SessionManager.adopt` 删除

- **唯一调用点**：`session-factory.ts:266`（全树 grep 就这一处）。它服务的全部内容是 `stateOf` 的按 id 缓存
  （`session-manager.ts:1832-1850`）；10 号票删掉缓存，它就没有读者了。删，不留别名，也不留 deprecate。
- 一同删的还有两段文档：`:1373-1375`（「未落盘的袋只经 `adopt` 进来」）与 `:1839-1840`（「unless the bag was adopted」）。
  这两句在 10 之后描述的是不存在的机制。
- **一处容易被搬错的语义**：`SessionManager.adopt` 其实是「最后写赢」（`this.states.set(...)`），而 01 定的
  `Agent.adopt` 是「先到先得」。所以这不是把三行搬个家，是**换语义**——照着旧代码抄，就会拿到一个会覆盖在飞队列
  与订阅集合的 `adopt`，而 01 §4 的整段论证正是为了防这个。

### 6. `sessionFileAbsPath`：票面的前提不成立（更正）

票面说未落盘的会话是「`persist: true` + `fileCreated: false` + `sessionFileAbsPath` 暂缺」。**第三项错了**：
构造器 `newSession(s)`（`session-manager.ts:1126-1144`，与 hub 里那个同名方法是两回事）在袋**出生之前**就把路径写上
了（`:1141-1143`：`if (s.persist && dir !== null)`，而 `createSession` 永远给得出 `dir`）。精确地说：**凡
`createSession` 产出的袋**（也就是全部未落盘的会话）**都有路径**；路径会缺的只有 `inMemorySession` 那一支，见下。
所以：

- **问题 4 的两个选项都不适用**：没有「补进去」，也没有「换一个新的」。第一次消息落盘只翻一个布尔
  （`persistEntry` 的 `fileCreated = true`，`:1222`），袋是同一个对象，表里那份看见的就是它。「原地」是对的，但理由
  不是「显然」，而是栈上根本没有第二个可供替换的对象。
- 07 号票那个 `sessionFileAbsPath?` **保留可选**，它唯一服务的对象是 `inMemorySession`（`:1048-1062`：`persist: false`、
  `sessionDirAbsPath: null`）。别在 07 顺手「修」成必填。
- `pendingManager` 里那句 `existsSync(absFile)`（`hub.ts:845-856`）是 `fileCreated` 的**替身**，随 `pending` 一起死。
  它存在的理由不是袋不诚实，是 hub 手上只有袋、没人告诉它「出生发生了」——而 `fileCreated` 就在同一个袋上、由
  `persistEntry` 同步翻转。这个探针本来就是多余的，只是今天没有第二个理由去发现它。

### 7. 由此产生的三处必改

**对 04 号票（驱逐判据）**：判据分两半分居两处（第 2 节）——**hub 侧**：`observers` 空、`claims === 0`、
**`hosts` 里没有它**；**Agent 侧**（`evict` 里再判一次）：`live.activeRun === undefined`、`live.suspended === false`、
**`state.session.fileCreated === true`**。其中 observers / claims / activeRun / suspended 是 04 已有的两条与它的
「没在跑」；**`hosts` 与 `fileCreated` 是 03 加的两条**，朝向相反：`hosts` 那条兑现 `hosts ⊆ 表`（`has()` 不再问
`hosts` 之后，这是唯一能兑现它的地方），`fileCreated` 那条挡住「一清就等于删 id」。后一条的理由是一条无损/有损的
分界：

- 盘上有另一半的会话，驱逐是**无损**的——丢的是队列与 in-flight，重开从 `fillSession` 重建，这正是它能被驱逐的
  唯一理由。
- 没有另一半的会话，驱逐等于**删掉这个 id**：`has` 变假、`snapshotOf` 404、下一次 `open` 无处 `fill`
  （`sessions.open(id)` 抛 `Unknown session`）。而「无人看 + 无运行」恰好在它刚建出来、没人订、也没在跑时成立。
- 加上之后，它的寿命与今天的 `pending` 条目一样：随首次消息落盘（此后按常规判据驱逐），或随 `remove`／进程退出。

**对 07 / 08（`sessionSetting.model` 的读法）**：创建即装配，`sessionSetting.model` 在**第一条消息之前**就有值了。
所以它不能读作「用户记下的选择」（08 现在这么写），只能读作「在 force 的选择」；盘上的 `meta.model` 仍是记下的
那份。同理 `modelId` 必须可选：装配出来的 `ModelChoice` 只有 `name` + `thinkingLevel`。

**对 14（文档）**：`docs/architecture.md:233` 那句「而这段窗口由 `SessionHub` 手里那份 manager 承担（`pending` 表）」
整句失效 → 由 Agent 的表承担（建 id 即入表）；`:21` 的「活跃会话」要跟着改词（表的成员不再等于活跃，见第 2 节）；
`AGENTS.md` 的 `OpenSessions` 术语（01 已登记）；本票第 2 节的抛词与第 3 节的冷读定义两句。

### 8. 落点

| 下游票 | 从本票拿走的 |
|---|---|
| 04 | 判据分两半：hub 侧加 **`hosts` 里没有它**（第 2 节的执行面），Agent 侧加 **`fileCreated === true`**（无损/有损的分界与丢失面见 §7） |
| 07 | `sessionFileAbsPath?` 的可选性只服务 `inMemorySession`；`sessionSetting.model` 在创建时即有值、`modelId` 可选 |
| 08 | `entryOf` 抛词改 `Session is not open`；`assembleSession` 在创建时就被调用；`adopt` 用 01 的先到先得语义，别抄 `SessionManager.adopt` 的三行 |
| 10 | 删 `adopt`（唯一调用点 `session-factory.ts:266`）＋ `:1373-1375`、`:1839-1840` 两段文档 |
| 12 | `has` / `snapshotOf` / `open` / `remove` / `rename` 五段见 §3、§4；`hosts ⊆ 表`（不是同生同灭）＋它的执行面（删表只在 host 已删之后，§2）；`observe` 仍以 `hosts` 为准；新增 `agent.has(id)` 与 `agent.drop(id)` 两个公开面；`pending`／`pendingManager`／`createUnpersisted` 里那句 `pending.set` 整条删。另外 hub 里 4 处 `stateOf`（`:402` / `:558` / `:587` / `:692`）的换源按 10 / 02 §① 走，本票改的是它们的**取袋方式**（表里有就用袋），不是把它们机械换成 `open` |
| 14 | `docs/architecture.md:233`、`:21`、`AGENTS.md` 的 `OpenSessions`、`entryOf` 抛词、`snapshotOf`「在跑 / 不在跑」的二分 |
| 15 | 全量 smoke；建议补一节：`newSession()` 之后 `has` 为真、`snapshotOf` 读得出、`hosts` 里没有它、盘上无文件；`remove` 之后这几样一起翻假；`mount-session` 那只内存设置袋在「释放后重开」时不再被掉包（§4 末） |

### 9. 决定记录

| # | 决定 | 直接约束谁 |
|---|---|---|
| 1 | 建 id 即入表：创建 = `createSession` + `assembleSession` + `agent.adopt`，`createUnpersisted` 变 `async` | 08、12 |
| 2 | 表的含义是「这个进程握着它」；`hosts ⊆ 表`，`observers` 与 claim 各自独立 | 04、12 |
| 3 | `hosts ⊆ 表` 的执行面：删表只在 `hosts` 里已经没有它之后（hub 判），`has()` 不再问 `hosts` | 04、12 |
| 4 | 三条判据 = 表 / 盘两分支；`agent.has(id)` 是公开的布尔面，`agentState(id)` 是抛的那个；判与读在同一个同步块内 | 08、12 |
| 5 | `SessionManager.adopt` 删除；`Agent.adopt` 的语义取自 `OpenSessions.ensure`（先到先得），不是它的（最后写赢） | 08、10 |
| 6 | `remove` 用不带判据的 `agent.drop(id)`（对 01 §6「→ `evict`」的修正）；`evict` 只用于有判据的驱逐 | 04、12 |
| 7 | 驱逐判据加 `fileCreated === true`：没有另一半的会话一清就是删 id | 04、12 |
| 8 | `sessionFileAbsPath` 对 `createSession` 的袋从出生就在，问题 4 不该存在；`pendingManager` 的盘探针随 `pending` 死 | 07、12 |

**本票没有回答的**：未落盘会话的空闲上限（地图 `Not yet specified` 已登记「常驻内存的代价」）；`fork` 一个未落盘的
会话仍会抛（今天也抛：hosted 时拿到一条不存在的路径，非 hosted 时 `Unknown session`）——本票不改，只是它现在有了
一条更清楚的说法：**入表不等于有文件**；`entryOf` 抛词的最终措辞（暂定 `Session is not open`，08 落地时可调）。
