# 22 空态里的模型位读作「（已丢失）」

Type: task
Status: open
Blocked by:

## Question

19 号核验时在截图 `research/v19-a5-deleted.png` 上看到的：**删掉正在读的那条会话之后**，窗口按
08 号定的规矩回到空态（hero），可输入框右下那个模型位写着

> 齿轮 `（已丢失）` ▾

名字是空的，只剩「（已丢失）」四个字——**没有任何模型丢失**，是这里根本没有会话，也就没有选过
任何模型。同一时刻头部副标题写「连接中…」，那是空态的正常文案，不是这一条要管的。

**来路**（`packages/web/src`）：

- `main.ts:806-813` 的 `selectionForSend()`：`const model = chosen.model ?? snapshot?.model ?? "";`
  ——空态下 `snapshot` 与 `chosen.model` 都为空，于是 `model` 就是**空串**；
- `composer.ts:154-157`：空串不在 `selection.models` 里，所以补一行
  `option(selection.model, \`${selection.model}（已丢失）\`)`，而它的另一半是
  `selection.models.length === 0 ? "未配置模型" : …`——**空串既不是"有模型但丢了"，也不等于
  "一个模型都没配"，两个分支都没接住它**。

换句话说这是个边界：`model === ""` 是「还没轮到选」这个第三态，被塞进了「选过、但那一行没了」
这一支。

要拍板并落地的：

1. 空态（`snapshot === undefined`）这一位该读什么——「未配置模型」/「选择模型」/别的，还是干脆
   收起不显示。参考实现与本窗口空态其它文案（「想做点什么？」）的调子要对齐。
2. 判定条件怎么改：是 `selectionForSend()` 在空态返回一个明确的「未选」标记，还是
   `composer.ts` 把 `selection.model === ""` 单独分一支——哪一种都不会再让空串走进「已丢失」。
3. 顺手核对同一分支在别处有没有同样被误喂的第三态（`render/settings.ts:457` 的
   `${current}（已丢失）` 是同一个写法，但那边 `current` 是配置里的真值，应当不受影响——
   核一下即止）。

不在本票范围：21 号（删除后给已删会话补发 `open` 的红横幅），两条来路不同、互不覆盖。
