# 9 工作区折叠与分页的形态

Type: prototype
Status: open
Blocked by:

## Question

用户纠正了我"两态开关"的建议，要的是**分页 + 表头收起**（原话）：

> 一个工作区一开始只显示 5 个最近的会话，当用户点击工作区那一栏，就收起全部，只留一个工作区那一栏，
> 并且这 5 个底部有一个「展开其余会话」，点一下就再展开 5 个，直到都展示完。

**今天是半个机制，而且是单向的**（`packages/web/src/render/sidebar.ts`）：

- `COLLAPSED_COUNT = 4`（`:772`）——默认只有 **4** 条，不是用户说的 5；
- `collapsedRows`（`:658-670`）截断，底部那个「more」按钮（`:566-572`）只做一件事：
  `this.expanded.add(cwd)`——**`expanded` 从不删除，没有任何办法重新收起来**；
- 那个 Set 是**实例内的**：`ViewState`（`state.ts:197-229`）与 `AppearanceSettings`
  （`config.ts:42-67`，只有 theme / fontSize / sidebarWidth / contentWidth）里都**没有**它，关窗即忘；
- **表头根本没有接事件**：`div.workspace-head`（`sidebar.ts:318-359`）上 click / pointerdown / keydown
  **一个监听都没有**，连焦点都不可达；
- 而 CSS 里那个 hover 时把文件夹换成 chevron 的动效（`style.css:429-437`）**早就在假装那里可以点**
  ——一个**从没接线的承诺**，而且没有任何 `[aria-expanded]` / 旋转态可供挂靠；
- 参考实现**是双向**的（`.scratch/window-rework/research/ui-spec.md:120`：「展开其余 {n} 个会话」展开
  后变「收起」）。

**没定的三处**——原型要把它们摆出来让用户看，别在文字里猜：

1. **表头点一下回到哪儿**：从"收起"再点，是回到"5 条"，还是回到**上次展开到的那一页**？
2. **全部展开之后那个按钮变成什么**：消失、变成「收起」，还是「收起其余」？
3. **收起的状态记不记得**：记的话跟 `appearance` 走。**不能用 localStorage**——桌面外壳每次启动挑新
   端口，origin 一变 localStorage 就死；这是 04 号对参考实现的**刻意分歧**。

原型照惯例自包含、可双击打开、浅深两套、放进 `prototype/`，**照真窗口的构图做**（左栏 34px 表头 +
32px 行、meta/caption 档），这样用户读的是真读感。形态定了之后落地归一张 `task` 票。

**注意**：落地时左栏的重画门控要跟着改——`main.ts:708` 的签名字符串
`${rows.version}|${followed ?? ""}|${directory}|${pickedWorkspace}|${collapsed ? 1 : 0}|${channel}`
里**没有**收展状态的话，收起/展开**根本不会重画**。还有 `pickedWorkspace`（`main.ts:81`）驱动的
「当前」标记（`sidebar.ts:347-352`）要与收起态共存。
