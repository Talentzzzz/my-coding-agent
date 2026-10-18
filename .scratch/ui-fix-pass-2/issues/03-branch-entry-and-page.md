# 03 · 分支入口与分支页落地

Type: task
Status: resolved
Blocked by: 02

## Question

把 02 原型选中的设计落进真窗口：

1. **助手脚注的分支按钮**：助手回答的脚注行（`transcript.ts` 的 `.turn-foot`）在复制按钮右侧加一个
   fork 图标按钮，`title` 写明「从这条回答开始分支」；点击走 `POST /api/sessions/{id}/branch`
   （`descend: false`）把 leaf 退回这条回答，并把焦点交给输入框。规则：**最底部的助手消息不给**（它就是
   leaf，从它分支等于继续说话），从倒数第二条助手消息向上都给。
2. **分支页卡片**：按 02 的答案改 `BranchView` 的卡片内容与高度；若需要新的标签（提问/回答），改
   `BranchOption` 的线上字段与 `subtreeDescription`，客户端只读协议。
3. **分支页居中**：`.graph-viewport` 内让整棵树水平 + 垂直居中（图比画布小时也居中），摘要行仍钉在
   页面顶部；「适应」同样回到居中。
4. **「起点」卡**：从会话标题改成首个分叉点所在的那条消息（角色感知），没有分叉点时保持现在的空页提示。

验收：`npm run check` 通过；`smoke-transcript` / `smoke-sessions` 不回归；在窗口里用一条真分支会话
（`2026-10-17T06-10-42…` 这类）确认：最底部回答没有 fork、上面的回答有、点它后输入框成为新分支、
分支页居中且卡片按原型可读、点另一条能切过去。

## Answer

实现（全部在工作区，未提交）：

- **脚注入口** `packages/web/src/render/transcript.ts`：复制按钮右侧一个 `.turn-copy` + `icon("fork")`，
  `aria-label` / `title` 是「从这条回答开始分支」；`RoundIndex.lastAssistant` 让最后一条回答不给按钮，
  运行中 `disabled` 且 `title` 改成「这一轮还在写，等它结束再分支」。点击把这条回答的 `forkEntryId`
  交给 `onBranch`，`main.ts` 走 `branch(entryId, false)`，成功后 `composer.focus()`。
- **协议** `packages/core/src/session/session-manager.ts`：`BranchOption.answer`（该走法子树里第一段助手
  正文，跳过只有工具调用的消息）、`BranchPoint.prompt`（分叉点处或之上那条 user 消息）、
  `BranchPoint.answer`（分叉点自己的助手正文）、`SubtreeDescription.answer`；`subtreeDescription` 的
  记忆化没动。
- **客户端模型** `packages/web/src/state.ts`：`BranchWay.answer/question`、`BranchTree.rootAnswer/rootTurn`；
  `buildBranchTree` 的卡片标签 = 提问（user 起步的走法用自身 label，assistant 起步的借分叉点的 prompt，
  和根卡重复时回退到回答预览），`rootLabel` = 首个分叉点的 prompt（空则会话标题）。
- **分支页** `packages/web/src/render/branch-view.ts`：卡片按 C 画（label 是提问，`title` 是提问 + 回答
  去重后的两段，meta 是短 id / 轮次；根卡 meta 是「起点 · 轮 N」）；`applyZoom` 重写成
  「sizer 至少视口大小，`layerX/layerY = (sizer - scaled) / 2`」，图小居中、图大留 `PAD`，滚动锚点按
  `layerX/layerY` 算；`scrollHome` 的代码没变，注释跟着更新。
- **顺带修掉的两处**（都是真窗口里看见的）：
  - `.branch-chip` 的长 label 把「当前分支」和 id 挤成竖排：静态部分 `nowrap` + `flex: none`，只有
    label 可以缩（`style.css`）。
  - 侧栏首帧的「暂无会话」在分组到达后不撤：`sidebar.ts` 的 `ensureHeading` 清掉这条阶段提示，
    `scripts/smoke-sidebar.ts` 第 6 节加了「空 → 有」的断言守着。
- **量具** `scripts/cdp.ts`：真 Chromium + DevTools 协议（启动 headless、`Emulation` 定视口、`Runtime`
  取值、`Page.captureScreenshot` 截图、`Input.dispatchMouseEvent` 真按压）。没有新依赖；04/05 接着用。

## 验证

```
npm run check                        # 通过，tokens ok: 137 defined, 111 referenced
node scripts/smoke-transcript.ts     # 通过（第 6 节：fork 数量/最后一条隐藏/点击带 entry/运行中禁用）
node scripts/smoke-branch.ts         # 通过
node scripts/smoke-sidebar.ts        # 通过（新增「暂无会话」撤掉）
node scripts/smoke-sessions.ts / -tools / -settings / -modes / -model-form   # 通过
```

真窗口：临时 agent home 放一份用户会话（`2026-10-17T06-10-42…jsonl`）的副本，服务端 `--session` 直接
落到它，Chrome 158 headless @ 1280×820：

```
node .scratch/verify-branch-window.mjs
```

（脚本只写副本，用户的会话文件没被碰；截图在 `shots/`。）

- 对话页：13 条助手回答，带脚注的 4 条，可分支的 3 条（第 6、7、12 条）——最后一条没有按钮。截图
  `03-chat-fork.png`。
- 点第 12 条回答的 fork：transcript 收到 12 条，那条回答成了最后一条、脚注留着、按钮收起，焦点在输入框；
  入口 id 仍是 `0ae942a`（它本来就是这条走法的入口，回退到同一走法上不该变）。截图 `03-after-fork.png`。
- 分支页：画布 995×677，图 580×144，与画布中心偏移 **0.0 / 0.0px**；卡片是「帮我看一下都有哪些文档」
  （起点 · 轮 3）/「## 文档清单 …」（0ae942a · 轮 3 · 当前）/「你好」（39dd15b · 轮 4），tooltip 带提问
  +回答。截图 `03-branch.png`。
- 真按压 39dd15b 卡：工具行变成「已选中 39dd15b 你好（轮 4）」，按钮「切到这一条并回到对话」（主色）；
  再按按钮回到对话页，11 条回答，入口 `39dd15b`「你好」。截图 `03-branch-selected.png`、`03-switched.png`。

## 留给下一眼的

- **旧手势的卡片文案**：assistant 起步的走法没有自己的提问，回退成回答预览（`## 文档清单 …`）。可读，
  但不像 C 的「提问卡」；要不要换成「↳ 接在『<提问>』之后」之类的文案，等用户看过 `03-branch.png` 定。
- fork 图标是纯图标，用户还没确认要不要带文字。
- 中间步骤（只有工具调用、没有正文的回答）没有脚注，所以也没有 fork——按地图「默认不给」落地，真窗口里
  没觉得缺入口。
