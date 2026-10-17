# 09 context 进度条加粗

Type: task
Status: resolved
Label: feature

## Question

状态行（`statusbar.ts` + `style.css`）里的 context 占用进度条太细，加粗一档。遵守 token 规矩：高度值进 `tokens.css`。

## Answer

`.status-meter` 的高度从字面 `3px` 提到新 token `--dsw-status-meter-h: 5px`（`tokens.css` 明暗共用一节，注释记录了为什么一档落在 5px 而不是 4px：1px 的一步在 caption 字号旁不可见，5px 仍低于它不该竞争的 6–8px chrome 条）。`style.css` 只换了这一行声明，`statusbar.ts` 无需动——粗细是样式的事，量具照旧。`npm run check` 绿（token 审计 137 定义 / 110 引用）。
