# 11 落地工作区分页 + 表头收起（09 号拍板的形态）

Type: task
Status: open
Blocked by:

## Question

09 号原型已在用户面前拍板三处形态（见该票的 Answer），本票把形态落进真的左栏
（`packages/web/src/render/sidebar.ts`）。用户原话的行为今天已经是半个机制、单向的：默认 4 条、
「more」只加不收、表头没接事件、状态关窗即忘。

**拍板的三处（照 09 号，不再议）：**

1. 默认**5 条**（今天的 `COLLAPSED_COUNT = 4` 要改）；「展开其余 N 个会话」点一次 +5。
2. 点工作区表头收起全部、只留表头；从收起点表头展开，回到**上次展开到的那一页**
   （页码记在收展状态里，收起时保存）。
3. 全部展开之后按钮变**「收起」**：点了回到 5 条、**不动**页码记忆；只在会话数超过 5 的工作区出现。
4. 收展状态**跟 appearance 走**（`SettingsManager` 合并的那两份 `settings.json`），**不用
   localStorage**——桌面外壳每次启动挑新端口，origin 一变它就死。appearance 的真实
   序列化→恢复路径在本票里要真验一遍（原型里的「记住」只是内存模拟，09 号已声明这条没验到）。

**落地时要跟着改的（09 号票里记的，动手前重读一遍）：**

- **`main.ts:708` 的重画签名** `${rows.version}|${followed ?? ""}|${directory}|${pickedWorkspace}|${collapsed ? 1 : 0}|${channel}`
  要把收展状态带上——签名里没有它，收起 / 展开根本不会重画；
- **`pickedWorkspace`（`main.ts:81`）驱动的「当前」标记**（`sidebar.ts:347-352`）要与收起态共存：
  收起的工作区照样可能是当前；
- 展开计数照真实现**按会话走**（`collapsedRows()`：根 + 它的派生算一个，派生不占别的会话的名额、
  正在看的那位永远在场）——原型为看得清按行数演示，落地不许照抄行数版；
- 表头从 `div` 变真按钮：`[aria-expanded]`、收起时 chevron 常显并转向右（`style.css:429-437` 那个
  hover 假承诺由此兑现）、键盘可达。

**验收**：`npm run check` 全绿；`scripts/smoke-sidebar.ts`（或它演化后的名字）盖住三个拍板行为——
+5 翻页、表头收起只剩表头、收起重开回「上次那一页」；appearance 那条用真 `SettingsManager` 驱一遍
（写 → 重读 → 状态还在）。参考形态以
[`prototype/09-workspace-paging.html`](../../../prototype/09-workspace-paging.html) 为准（浅深两套都看）。
