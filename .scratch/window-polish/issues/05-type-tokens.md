# 05 排版 token 化：收掉散值

Type: task
Status: open
Blocked by: 01, 04

## Question

把 `packages/web/src/style.css` 里的字号散值收成一组**新的 `--dsw-*` 名字**，并让应用级设置的
"字号"驱动整棵树。

要做的：

1. 按 04 拍下的阶，在 `tokens.css` 新增一组（前缀 `--dsw-*`，例如 `--dsw-font-size-body` /
   `-title` / `-meta` / `-caption` / `-code`），**每个都带行高**——字号与行高是一个决定，分开写
   就是同一个错误犯两次。
2. 把 `style.css` 里所有 `font-size: 10px | 10.5px | 11px | 11.5px | 12px | 12.5px | 13px | 14px`
   的散值逐个换成 token。**逐处判断它属于哪一档**，不要把 11.5 一律当 12：参考实现的会话行标题是
   14/20、次要行是 12，状态行的技术读数是另一档。
3. 应用级设置里的"字号"按 04 的结论驱动整棵树（要么只动正文，要么一个 delta 缩放全部）。
4. `npm run check` 要绿——token 审计会拒绝"引用了却没定义"的 `--dsw-*` 名字，也会在
   `style.css` 里出现字面颜色时报错。

**答案里给一张对照表**：改前的字面值 → 改后的 token 名 → 落在界面的哪一处。
