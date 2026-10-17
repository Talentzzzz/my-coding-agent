# 08 输入框按钮布局

Type: task
Status: resolved
Label: feature

## Question

输入框（`composer.ts` 的 `composer-bar`）按已定决策重排：

- **左下角**：会话设置齿轮（现在骑在右侧 seat 里，挪到 bar 左端）。
- **右下角**从左到右：模型下拉、思考档位下拉、发送按钮（两个下拉都保留；队列计数、停止按钮的位置不变）。

验收：左下角齿轮打开会话设置；右下角依次是 模型 → 思考 → 发送。

## Answer

照票面钉死的决策重排了 `composer-bar`，改动只有两处：

- `packages/web/src/composer.ts`：齿轮（`composer-gear`）从 `composer-seat` 里挪出来，作为 bar 的第一个子元素（左端）；seat 只留两个下拉，`bar.append(sessionSettings, seat, this.queue, this.stop, this.send)`。队列计数、停止按钮、发送按钮的相对顺序一个字没动；齿轮的回调仍是 `onOpenSessionSettings`，两条下拉的事件接线未变。
- `packages/web/src/style.css`：零声明改动，只更新 seat 与 gear 两处注释（标注 08）。布局靠既有规则自洽：`.composer-seat` 的 `margin-left: auto` 把 seat 及其后的 queue/stop/send 钉在右端，齿轮自然落在左端，间距由 bar 的 `gap: 8px` 接管（原先在 seat 内是 4px，属移位的自然结果）。

**目视做了**：照票 05 的路子，`launch.mjs --load <夹具> --screenshot --theme <dark|light>`，夹具内联真 `tokens.css`/`style.css`、按 composer.ts 新形状手写标记（含可见的「已排队 2 条」与 hidden 的停止按钮），明暗两色各一张——左端齿轮、右端 模型 → 思考 → 排队 → 发送，与验收一致。夹具与截图在系统临时目录（`%TEMP%\dsh-ticket08\`），不入仓库。

**验证**：`npm run check` 绿（tsc 四包 + token 审计 136/109）；smoke-tools / smoke-models / smoke-sessions / smoke-mux 全绿。**smoke-api 红**（`FAIL: Error: the mux connection failed`），但在 stash 掉本次改动后的干净树上同样红、8080 无监听——既有问题，与这票的纯客户端改动无关，未追。

code-review 两个轴都放行：Standards 无硬违规（三条注释层面的 nit，其中 style.css 注释折行与相邻 2205 行处的既有风格一致，未改）；Spec 无缺失、无 scope creep，两条验收满足。
