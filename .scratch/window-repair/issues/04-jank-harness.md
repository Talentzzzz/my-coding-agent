# 4 修好卡顿量具，并给「切换会话」一条端到端测量

Type: task
Status: open
Blocked by:

## Question

`.scratch/window-rework/research/jank-harness.ts`（656 行，`064e34d` 加的）**今天跑不起来**：

    $ FRAMES=200 node .scratch/window-rework/research/jank-harness.ts
    TypeError: this.list.contains is not a function
        at Sidebar.ensureHeading (packages/web/src/render/sidebar.ts:312:18)
    [exit code: 1]

`FakeNode` shim 实现了 `prepend` / `replaceChildren` / `insertBefore` / `classList.contains`，**没有
`Node.contains`**；而 `sidebar.ts:312` 用它，那一行来自 `482673a`——比量具产出数字的 `064e34d`
**更新**。所以自 `482673a` 起这把尺子就废了，H6 之后的所有结论都是**读代码读出来的，从没测过**。

两件事：

1. **让量具重新跑起来。** 大概率就是一个 `contains`，但缺失的**全部** DOM 面要一次补齐——`411475f`、
   `ce1a589`、`077a7f4`、`55b207d`、`482673a` 都在 `064e34d` 之后动过 sidebar / transcript，别只补到
   能跑，要补到**量具测的东西和今天的产品代码对得上**。
2. **给"切换会话"补一条场景。** 现在**没有任何量具驱动 `openSession` 端到端**，所以"切换会话会卡一下"
   的墙钟时间从来没被拆开过：两次 HTTP 往返、快照重放（`itemsFromSnapshot`）、每条消息的
   `renderMarkdown` 各占多少，全是未知。**05 号要照这条测量动手。**

诚实限度照抄老票：shim 量出来的**绝对毫秒不是真实帧时间**，可靠的信号是**同一把尺子下短 vs 长的比值**。
Node 版本也变了（老数字出自 22.22.2，本机 24.15.0），所以**老数字不能直接比**——要么同版本重跑，要么
只比比值。
