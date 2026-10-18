# Map · 第三轮测试反馈：分支入口 / 分支页 / 流式 / 小修（ui-fix-pass-2）

Label: wayfinder:map

## Destination

`优化/1.png`–`3.png` 的三条反馈在桌面窗口里全部落地——侧栏当前工作区换成不刺眼的标记、分支从助手回答发起且分支页读得懂、流式刷新顺滑起来——外加设置保存后不再显示「已保存」。终点是改动落地、`npm run check` 与相关 smoke 通过，并在窗口里逐图确认。

## Notes

- 反馈来源：`优化/1.png`（侧栏选中工作区阴影）、`优化/2.png`（分支页与分支图标）、`优化/3.png`（「模型已保存。」）。
- 域参考：`docs/architecture.md`、`AGENTS.md`、ADR-0001（mux）、ADR-0005（模式）。
- 前序：`.scratch/ui-fix-pass/` 是上一轮同来源的缺陷修复；本努力接着它，不重开已定的事。
- 参考树（只读）：`deepseek-harness-master/`（dsh）、`pi-main/`（pi）；流式对照见
  [research/streaming-reference.md](research/streaming-reference.md)。
- UI 只读设计 token（`packages/web/src/tokens.css`）；`npm run check` 拒绝引用却不存在的 `--dsw-*`。
- **本努力携带执行**：票据解决后直接改代码，不是纯决策图；每张按 `wayfinder:task` 走，一次一张。
- 图表阶段与用户敲定的（不再开票）：
  1. 侧栏当前工作区改成**纯填充**（与当前会话行同一套 `--dsw-bg-active`），去掉描边与投影。
  2. 分支**从助手回答发起**：最底部的助手消息不给分支按钮，从倒数第二条助手消息向上都给；按钮在
     助手脚注里（复制按钮右侧），点击 = 把 leaf 退回这条回答，下一条输入成为另一条走法。
  3. 分支图在画布里**水平 + 垂直居中**；摘要行仍钉在页面顶部。
  4. 模型/模式保存成功后**什么都不显示**，只保留失败的红字。
  5. 流式卡顿 A（一阵一阵）、B（滚动跳）、C（整窗发涩）都有；按「传输 → 渲染 → 贴底 → 合成」四层一起收。

## Decisions so far

- [01 · 流式平滑度对照：dsh / pi 怎么做](issues/01-streaming-reference.md)：已解决——dsh 只发瞬态 delta、客户端累加，完整消息只在 settlement；markdown 冻结尾部以外的块；跟尾时 `overflow-anchor:none`。pi 的渲染有 16ms 最小间隔。我们每个 delta 发整条消息（还带一份 partial）、每 delta 全量重算文本、每帧重建 markdown 尾块、pin 后立刻读 `scrollHeight`。详见 [research/streaming-reference.md](research/streaming-reference.md)。
- [02 · 分支页卡片与助手底部分支入口（原型）](issues/02-branch-design-prototype.md)：已解决——用户选 **C · 提问卡**（回答进 tooltip），图水平 + 垂直居中；fork 图标按纯图标落地，是否带文字用户还没回答。
- [03 · 分支入口与分支页落地](issues/03-branch-entry-and-page.md)：已落地并在真窗口验证——脚注 fork（最后一条回答不给、运行中禁用）、C 卡片、根卡「起点 · 轮 N」、图居中（实测偏移 0.0/0.0px）、选中后切走；顺带修掉 `.branch-chip` 长 label 换行和侧栏「暂无会话」残留。证据与截图在票据的 Answer 里。
- [04 · 流式传输瘦身：帧只带 delta](issues/04-streaming-transport.md)：已落地——`message_update` 只带
  `{ timestamp, kind, contentIndex, text }`，完整消息只在 start/end 与 baseline 的 `snapshot.partial`
  里；客户端追加而不是重拼。真 Chromium 量具（`research/measure-streaming.mjs`）：8k 字 / 2000 帧下，
  总字节 17.1 MiB → 316 KiB，最大帧 16.4 KiB → 0.2 KiB，parse 11.1 ms → 1.4 ms，CDP 任务时长
  94.7 ms → 3.6 ms。顺带量出「每帧重算文本」其实不贵（0.6 ms / 2000 帧），05 别拿它当理由。
- [06 · 侧栏当前工作区的标记 + 去掉保存成功的提示](issues/06-sidebar-and-save-note.md)：已落地——`--dsw-shadow-workspace-current` 与两份定义删除，当前工作区改成 `--dsw-bg-active` 纯填充（选择器带 `.workspace-head` 以压过 hover）；`settings.ts` 的模型/模式保存成功不再写 note，失败红字照旧。`npm run check`、`smoke-settings`、`smoke-modes`、`smoke-model-form` 全过。
- [05 · 流式渲染与贴底](issues/05-streaming-render-and-scroll.md)：已落地——markdown 尾块就地补写（元素身份保住、选区不再被冲掉）、`.pinned { overflow-anchor: none }`、`pin()` 只写不读 + scroll 读进 rAF、`OncePerFrame` 加 16ms 最小绘制间隔（120Hz 屏不再双倍画）、caret/marquee/spinner/pulse 的合成收口。真 Chromium 量具：Style 重算 500→1、主线程任务时长 −12~14%、长任务 0；诚实发现是长文本节点上 `appendData` 比重建更贵（patch 保留但「脚本重建会卡」这条理由被否掉），真正的大头是每帧 O(答案) 的尾块重解析（本轮不动）。见 `research/render-measure.json`。

## Not yet specified

（已清空 · 2026-10-18 用户逐项拍板，全部保持现状，不再开票）

- 旧手势（从 user 消息分叉、走法以助手回答起步）的卡片文案：保持回答预览（`shots/03-branch.png`），
  不换「↳ 接在『<提问>』之后」。
- 分支页「起点」卡只显示「轮 N」，不显示共享前缀长度。
- fork 图标保持纯图标，不带文字。


## Out of scope

- 长会话 transcript 的虚拟化 / 结构性增量渲染重写（上一轮 03 已用定点修复换掉，本轮的证据仍不支持重写）。
- 插件、MCP 机制（项目规则本就排除）。
- 流式帧的 ack / 重传 / 有序恢复（mux 的既有保证不在这轮动）。
