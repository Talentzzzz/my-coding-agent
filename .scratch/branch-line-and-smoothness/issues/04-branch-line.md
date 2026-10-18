# 04 · 分支页主链：没有分支时画一条 user 消息的横线

Type: task
Status: resolved
Blocked by: 03

## Question

用户第四轮：**没有分支时打开分支页什么都没有**。他要的是：一条横线，串起主链上的一连串 user 消息
（a b c d），点中 b、回到对话、再发一条消息 —— 新走法就从 b 之后长出来。

现状：`state.ts` 的 `buildBranchTree` 在 `branchPoints.length === 0` 时**直接返回 undefined**，
`branch-view.ts` 的 `paint()` 于是在空态里写一段「去右键分支吧」的话。

要定的是树的新形状，并且要让**有分支时**的页面接得上：如果只在「无分支」时画主链，第一次分出
第二条走法之后主链就消失了，等于修完立刻又坏一次。

## Answer

**树换了形状：页面画的是「这条线」，不是「分支点」。**

`state.ts`：

- `BranchWay` 从 `children: BranchWay[]` 变成 **`next?: BranchWay`（线上后一句）+ `branches: BranchWay[]`
  （从这里离开的走法）**，并多一个 `landing: "tip" | "here"`。两个字段而不是一个孩子表，因为它们对
  「按下去做什么」的意思相反：线上的卡是**退回到这一句**（再说话就从这儿长第二条），离开线的卡是
  **跟到它自己的尽头**。
- `BranchTree` 从 `ways/rootLabel/rootAnswer/rootTurn` 变成 `trunk/currentId/points/options/line`；
  `line` 就是「线上这几条 entry」的集合，画实心用的。
- `buildBranchTree()` **不再在 `branchPoints.length === 0` 时返回 undefined**：它先按 `snapshot.messages`
  把**主链上的 user 消息**串成一条线（`messageEntryIds` 给每句一个 entry），再把每个分支点的**非活跃
  option** 挂到「这个点之前最近的那张线卡」的 `branches` 上。活跃 option 本来就是线的一部分（它在链上），
  不再单独出现 —— 所以「有分支」和「没分支」是同一张图的两个实例，第一次分叉之后主链不会消失。
- `findWay()` 沿 `next` 与 `branches` 走。

`main.ts` 的 `onSwitch(entryId, landing)` → `branch(entryId, landing === "tip")`：`here` 走
`descend = false`（退回 leaf，并把焦点交回输入框），`tip` 走 `descend = true`。这条路径本来就是「user
消息右键 → 从此分支」用的那条，没有新命令。

只有**一句 user 消息都没有**的会话仍然返回 undefined，空态文案改成说这件事：「还没有你的消息，所以
还没有一条线可看」。

验证（真窗口，`research/shoot-branch.mjs`）：

- `shots/01-line.png` —— 一个从没分叉过的会话（`写一段长回答`）：四张卡 `8bc8885 轮 1 → 46e8ad4 轮 2 →
  2050c1e 轮 3 → 3db2ac4 轮 4（当前）`，一条横线。
- `shots/06-selected.png` —— 点第二张：卡片戴「已选中」、dot 变大、头部变成
  「已选中 46e8ad4 再写一段很长的回答（轮 2）」、按钮变成主色**「从这里继续」**。
- `shots/04-forked.png` —— 一个真分叉过的会话：线上两张卡，第二条走法挂在下面对着拐下去。
- `scripts/smoke-branch.ts` 重写成新形状（一条线一张卡、走法在下行、两种 landing、运行中被拒的只有移动）。
