# 03 - openSession 重写与页面加载：导航单源化

Type: task
Status: resolved
Blocked by: [01 - 服务端 open 幂等](01-server-mux.md)、[02 - 客户端 pending-open 状态机](02-client-pending-open.md)

## Question

`packages/web/src/main.ts` 的 `openSession()` 重写为单源：删掉 REST 读（`api.read`），改为 `series → retain(pane) → 等 pending-open settle → 作废检查 → apply(deferred)`。页面加载路径（`GET /api/sessions/current` 落地的那条）同步改走 mux。ADR-0010 验收边 1–4 是本票的判据。

## 要点

- **旧画面的保持语义原样**：读失败/超时 → `unreachable(error)` → 旧对话留在屏上（今天注释里的承诺换帧的说法重写）；连点两行 → `openSeries` 判定点移到基线帧到达时，不匹配整帧丢弃（不画、不报错），被作废的流靠引用计数收尾。
- **顺序注释重写**：`openSession` 现有四条 load-bearing 注释（pane 先翻、读先宣告、deferred 画、retain 先于列表）逐条对照新路径重写——语义大多保留（先变活再刷列表的理由不变），但"the channel's own baseline will replace it within a moment"这句双源结构的话必须消失。
- **`api.read` / `api.current` 窗口侧调用点删除**：`packages/web/src/api.ts` 里这两个方法随消费者一起删（REST 端点本身保留，ADR 已定）；先全仓搜索确认没有第三处调用。
- **页面加载**：等通道 live 后 open current 会话；`GET /api/sessions/current` 的"上次活跃会话"记忆仍走启动参数/存储（ADR 未决事项，本票不动它的来源）。
- **`refreshLists` 顺序**：retain（现在是 settle）先于列表刷新的理由原样保留，不重排。

## 收账

- `npm run check` + `npm run build:web` 绿；`smoke-projection` 绿。
- 手动验收：ADR-0010 验收边 1–4 逐条过（1 无 REST 请求可用网络面板；2 切走再切回 partial 立即可见；3 连点不串台；4 不存在会话报错且旧画面保留）。
- Answer 节记录：新 `openSession` 的最终形状、验收边逐条结果。

## Answer

**`openSession` 只剩一条路：`retain` 就是导航，基线帧就是第一笔。**（`packages/web/src/main.ts`、`packages/web/src/api.ts`、`packages/web/src/client.ts`）

### 新形状

```ts
async function openSession(sessionId: string): Promise<void> {
	// 上一次导航的目标，如果它没落地：这里是它唯一被松开的时刻
	if (opening !== undefined && opening !== followed && opening !== sessionId) mux.release(opening, "pane");
	const series = (openSeries += 1);
	opening = sessionId;
	setPane("chat");
	showLoading(series, true);
	let snapshot: SessionSnapshot;
	try {
		snapshot = await mux.retain(sessionId, "pane", series);   // open 帧 + 等基线
	} catch (error) {
		showLoading(series, false);
		if (series !== openSeries) return;   // 被作废的那次：不报错
		unreachable(error);                  // 错误条，旧对话留在屏上
		return;
	}
	showLoading(series, false);
	if (series !== openSeries) return;       // 迟到的基线：整帧丢弃，不画不报
	reachable();
	if (followed !== undefined && followed !== snapshot.id) mux.release(followed, "pane");
	followed = snapshot.id;
	chosen = {}; absPickedDirectory = "";
	apply(reduce(state, { type: "baseline", session: snapshot }), { deferred: true });
	void refreshLists().catch(report);       // 位置与理由原样
}
```

四件事跟票面有出入，都是落地时撞出来的，逐条记：

1. **`opening` 这一格是新长出来的**（票面没提）。引用是 per-session + per-source 的，所以连点同一行时两次导航共用**一个** pane 引用；被作废的那次若 "顺手 release 自己的"，就会把正等着画的那次掏空（页面变哑巴）。于是松手这件事挪到**下一次导航的开头**：目标不是 `followed` 也不是这次要开的会话时，旧的引用才走。副作用是好的——失败/超时留下的引用最多一个，而不是每次失败攒一个。这也顺带满足 ADR "超时不主动撤订阅"（撤的动作晚一个手势，那时迟到的大帧早已落地或被丢弃）。
2. **页面加载反过来排**：`mux.start()` 从最后挪到最前，`await channelLive` 夹在 `api.currentSession()` 与 `openSession()` 之间。旧的"最后启动、好让 pane 的订阅先记账"的理由随双源一起作废；现在通道必须先活着，因为落地本身就是一帧。`channelLive` 是只 resolve 一次的 promise（`onChannel("live")` 触发），重启/重连不再影响它。**通道起不来 = 落地不发生**，屏幕上留欢迎态 + 既有的连接错误条（ADR 表第三行的代价，接受）。
3. **`api.read` 删了，`api.currentSession` 留着**。票面写的是 "`api.read` / `api.current` 两个方法随消费者一起删"，但 `current` 的唯一消费者是页面加载的"我该开哪个会话"，而那正是票面第 16 行要求原样保留的来源（ADR 未决事项）。删了就没有来源了，所以只删 `read`；`api.ts` 的类注释补了一句说明"读不是窗口的事"。
4. **`settled()` 换成 `runEnded(runSeen, …)`**（02 号票留给 03 的那条，实测确认是 bug 不是疑点）。`retain(target,"send")` 现在真的发 `open`，服务的重发基线在 prompt 被接受**之前**取快照——实测帧序（`.scratch/mux-only-open/send-baseline.ts`）：

   ```
   27ms  baseline submitting=false     ← pane 的 retain
   172ms baseline submitting=false     ← send 的 retain（打开这一瞬）
   172ms status   submitting=false     ← 同一刻还有一条 status，也是 false
   172ms status   submitting=true      ← run 真正开始
   740ms status   submitting=false     ← run 结束
   ```

   旧规则在 172ms 就把 send 引用放掉了。后果不是"无碍"：窗口发起的 run，用户切走时 pane 引用一走、send 引用已经没了 → `cancel` 卸掉这条流 → run 的结局和失败（`announce` 只发给在看的人）这一窗口再也收不到。ADR-0006 §5 的"跑完的帧还有人读"正是这条。
   修法：`submitting: true` 记一笔"这个会话的 run 我见过它开跑"，只有见过开跑的 `submitting: false` 才算结局（`Set.delete` 的返回值就是答案）。`releaseSend()` 把"松引用"和"清标记"绑成一件事，四条出口（结局、run 被拒、流结束、prompt 没被接受）全走它。
   对照实验：把 `runEnded` 临时改回旧语义重跑验收，`窗口走开之后那条流仍被观察着` 直接 `isWatched=false` 失败；换回来通过。所以这一条是有区分力的，不是顺手加的防御。

连带的注释重写：`openSeries` / `openWaits`（原 `openReads`）/ 加载提示 / `reachable()` 的措辞全部从"读/请求"改成"导航/帧"；"the channel's own baseline will replace it within a moment" 那句双源结构的话已消失。`mux.retain` 加了两条 overload（带 `series` 必得 `Promise<SessionSnapshot>`，不带的返回 `undefined`），让窗口那句 `await` 不必再处理半路 `undefined`——纯类型，运行时零改动。

### 验收边逐条（真服务器 + 真 Chromium，非手点）

票面写的是"手动验收"，本机没有手点的余量，于是写成脚本：`MY_AGENT_HOME=$(mktemp -d) node .scratch/mux-only-open/accept.ts`（`bootServer` + 脚本化 transport + `scripts/cdp.ts` 的真 Chromium，页面吃的是 `packages/web/dist`）。结果全绿：

| 边 | 断言 | 结果 |
|---|---|---|
| 1 | 两次切换之间 `GET /api/sessions/*` 计数为 0（`Network.requestWillBeSent` 抓的） | ✅ 切换期间只有 `GET /api/directories` ×2 |
| 2 | 切走正在跑的会话再切回，partial 已在屏上（< 1.5s，实测几十毫秒），尾标记未到，之后画面继续长 | ✅ |
| 3 | 连点两行三轮：最终画面是最后一击、无错误条 | ✅ 3/3 |
| 4 | 删掉会话文件后点它的行：错误条「未知的会话：…」，旧对话字数不变 | ✅ 前 196 字 / 后 196 字 |
| 附 | 窗口自己发一条（输入框 + 回车）拿到回答；窗口发起的长 run 走开后 `hub.isWatched` 仍为真、跑完才松开 | ✅ |

**边 1 的一句实话**：`/api/directories` 还在。它不属于"打开会话"，是 `refreshLists` 的列表修复（票面明确要求位置与理由原样保留），而且通道 live 时 `rows.loadFrom` 本来就会拒收。所以 ADR 那句"全过程不产生任何 REST 请求"字面不成立，成立的是"不产生任何**会话** REST 请求"。若要字面成立，得让 `openSession` 在 `channel === "live"` 时跳过 `refreshLists`——不建议在本票顺手做：`newSession()` 依赖它给"新目录里的第一条会话"建出侧边栏分组。留给 04 在 `docs/architecture.md` 里把这句话写准。

### 验证

- `npm run check` 绿；`npm run build:web` 绿。
- 全量 smoke：`smoke-projection`、`smoke-mux`、`smoke-mux-client`、`smoke-mux-live`、`smoke-boot`、`smoke-replay`、`smoke-liveness`、`smoke-backpressure`、`smoke-approval{,-endpoint,-queue,-recovery}`、`smoke-session(s)`、`smoke-stream`、`smoke-tools`、`smoke-transcript`、`smoke-sidebar`、`smoke-frame`、`smoke-branch`、`smoke-modes`、`smoke-model(s)`、`smoke-model-form`、`smoke-settings`、`smoke-default-model`、`smoke-desktop-close`、`smoke-desktop-observability` 全绿。
- `smoke-api` 需要先起服务器（`MY_AGENT_URL`），本机没起，未跑（与 01 号票一致）。
- **`smoke-mux-live` 在本机是 flaky**：它把心跳压到 60 ms、看门狗 3×60 = 180 ms，机器一忙就 "读超时" 判死连接。同一份脚本连跑三次，`client.ts` 用 HEAD 版也照样 2/3 失败；失败项是"订阅不存在的会话在帧上被拒绝/那条流被结束"那对，与本票无关。归 04 时若要动它，方向是把 60 ms 放宽或让看门狗只认心跳帧。

### 留给 04

- `docs/architecture.md` 三节（谁拥有一个会话 / wire / API）里"打开一个会话是 GET"的说法；以及边 1 的措辞（见上）。
- `docs/adr/README.md` 的清单行、ADR-0010 的状态从"尚未落地"改"已落地"。
- 本票那个真浏览器验收脚本（`.scratch/mux-only-open/accept.ts`）要不要升成 `scripts/smoke-window.ts`：它现在覆盖的正是"窗口面没有任何 smoke"的那块空地，而 04 的记账里也只有服务端/client 的 smoke。
