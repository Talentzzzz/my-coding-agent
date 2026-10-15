# 21 删掉刚派生的会话后，窗口给这个已经没了的会话补发一次 `open`

Type: task
Status: resolved
Blocked by:

## Question

19 号真窗口核验时撞出来的：**先派生一个会话、再马上把它删掉**，右栏底部会挂出一条红横幅

> 未知的会话：01a13f35-8923-7601-9484-1cacbae8fd70

横幅里的 id **就是那个刚被删掉的派生会话**，而左栏里它已经没了、源会话一切正常。也就是说窗口在
删掉它之后，又对着服务端喊了一次「我要订这个会话」，服务端照协议拒了（`mux.ts:295`
`failStream(sessionId, \`未知的会话：${sessionId}\`)`），拒信经 `onStreamError` 走到错误行
（`main.ts:650-654`）。三个入口本身都是好的（19 号全绿），红字是这条竞态白送给用户的噪音。

**最小复现**（`.scratch/window-polish/research/repro-19.ts`，全程真 UI、假传输、本机 Chromium，
三步）：

```bash
npm run build:web && node .scratch/window-polish/research/repro-19.ts
```

1. 发两句话跑出一轮会话，把源会话行改个名；
2. 源行右键 → **派生新会话**，等左栏出现 `源标题（1）`、`aria-current` 挪过去就动手，**不要等**；
3. 派生行右键 → **删除**。

删除后 `[step 2] 删除后横幅："未知的会话：<派生会话 id>"` 立刻出现。删完再点回源会话行、对着用户
消息右键，红字一直在（`repro-19-banner.png`）。19 号的核验脚本连跑三次三次命中
（`research/verify-19.ts` 的 `!! 错误横幅` 行）。

**来路**（一次等待不足的竞态，三处各自都对、合起来漏）：

- `main.ts:1179` 的 `forkSession` 由 `onForkSession`（`:441`）**不等待**地发起，
  它自己 `await openSession(created.sessionId)`；
- `openSession`（`:1042`）的次序是：`await api.read()` → `followed = id` → `apply(baseline)`
  （**`aria-current` 到这一步就变了**）→ `await refreshLists()` → **最后**才
  `mux.retain(snapshot.id, "pane")`（`:1076`）；
- 于是在 `aria-current` 挪过去、`refreshLists` 还没回来的那段窗口里，派生行**看起来已经就位**，
  用户可以立刻删它：`deleteSession`（`:1219`）走完 `api.deleteSession` 后调
  `mux.release(followed, "pane")`（`:1230`）——**那时这条订阅还不存在，release 是空操作**——
  然后把 `followed` 置空；
- 随后 `openSession` 的续段跑完 `refreshLists`，照样执行 `mux.retain(forkId, "pane")`，
  `writeOpen` 出去，服务端已经没有这个会话了。

本机 `开放` 的窗口里没人会故意这么干，但「派生完顺手删掉刚冒出来的那一条」是很自然的动作，而且
`aria-current` 已经指着它了——**窗口自己让这一步看起来是允许的**。

要拍板并落地的：

1. 修在哪一层。倾向**给 `openSession` 的尾巴加一道「这条会话还是窗口正在读的那条吗」的闸**
   （`mux.retain` 之前 `if (followed !== snapshot.id) return;`）——`followed` 本来就是「窗格开在
   哪条会话上」这一个事实，`deleteSession` 也已经在用它做判断，不加第二个事实源。核对
   `newSession` / 页面加载那条 `GET /api/sessions/current` 的路径有没有同一个窗口。
2. `mux.retain` 自己要不要再加一层「服务端说过它没了就别再 retain」的记性。倾向不要——
   19 号的教训是别在客户端再造一个「这个会话还在不在」的第二真相源；`session_gone`
   到达时释放引用（`main.ts:687-688` 现在只 `rows.remove`，**没有释放 mux 引用**）是不是才是
   该补的那一半，一并判。
3. 红横幅本身：一个用户没做错任何事的竞态，值不值得直接把 `未知的会话` 摆到脸上，还是这类
   「窗口自己要的东西没了」只该记日志。

不在本票范围：19 号那三个入口本身（全绿）。

## Answer

三个决定都落了，全部在 `packages/web/src/main.ts`，服务端与 `client.ts`（MuxClient）一字未动。

1. **修在 `openSession` 的尾巴**（采纳票面倾向）：`mux.retain` 之前加一道闸
   `if (followed !== snapshot.id) return;`。`followed` 本来就是「窗格开在哪条会话上」这一个事实，
   `deleteSession` 已经在用它做判断，不引入第二个真相源。核对过 `newSession` 与页面加载那条
   `GET /api/sessions/current`：两者与侧栏点击、fork 一样都走 `openSession`，一道闸全覆盖四个入口。
   这道闸同时拍掉同窗口里的另一半竞态——`await refreshLists()` 期间点去别的会话，旧 `openSession`
   续段也不再补发一条多余的 `open`。

2. **`mux.retain` 不加「服务端说过它没了」的记性**（采纳票面倾向）：那是在客户端再造一个
   「这个会话还在不在」的第二真相源，19 号的教训就是不这么做。真正该补的一半在 `session_gone`：
   到达时除了 `rows.remove`，还把正在读这条会话的窗格折回空态——把 `deleteSession` 的尾巴
   （release pane 引用、`followed` 置空、`initialState()` 折叠、reachable/models/settings 保留）
   提成 `foldFromDeleted(sessionId)`，两个门共用。删除窗口先折叠时帧迟到是空操作，帧先到时
   `deleteSession` 的尾巴是空操作，幂等。这一半顺带修掉一个此前没人撞的隐患：**别的窗口**删掉
   本窗格正在读的会话时，pane 引用会一直悬挂在一条服务端早已忘记的会话上，重连重放（`end` 帧
   恰好丢失的情形）会对已删会话再发一次 `open`——同样的红横幅，另一条来路。

3. **红横幅保留，不做消息字符串级的抑制**：竞态在源头（1+2）拍死，剩余的交错（retain 与删除
   同帧赛跑）里 `session_gone` 的折叠会把横幅连同整个状态一起清掉（`initialState()` 不带
   `error`），残留是瞬时的、自愈的。按「未知的会话」字面匹配降级成日志会造出第二个错误分类
   机制，不值。

**验证**：`npm run check` 绿；`npm run build:web` 后 `research/repro-19.ts` 连跑三次，五个采样点
横幅全程空串（修复前 step 2 必现「未知的会话：<派生 id>」）；`research/verify-19.ts` 24 条断言
全绿、错误横幅 0 次（修复前同脚本连跑三次三次命中 `!! 错误横幅`）。

## Comments

- code-review（两轴并行，2026-10-15）：**无硬性违反**。Spec 轴：三项决定全部落地，四个入口
  （侧栏点击 / newSession / fork / 页面加载）核实同走 `openSession`，`client.ts` 零改动；
  `session_gone` 折叠判为票面第 2 问的在范围内回答，非 scope creep。两轴各提一条「`session_gone`
  恰落在 `followed = snapshot.id` 与 baseline apply 之间」的残留竞态——核实为**不成立**：两者之间
  没有 `await`，同步块内 `session_gone` 无法插入（事件循环模型），真正的两个让位点
  （`api.read` / `refreshLists`）期间的折叠都由尾部闸接住；这条结论已写进闸注释。判断题一条
  已顺手收掉：闸注释的 `{@link deleteSession}` 更新为 `{@link foldFromDeleted}`。
  `foldFromDeleted` 的命名沿仓库「fold 回空态」既有行话，不改。
