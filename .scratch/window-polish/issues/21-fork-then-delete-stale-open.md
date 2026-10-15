# 21 删掉刚派生的会话后，窗口给这个已经没了的会话补发一次 `open`

Type: task
Status: open
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
