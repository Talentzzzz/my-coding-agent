# Map · 测试反馈的 UI 缺陷修复（ui-fix-pass）

Label: wayfinder:map

## Destination

七项测试反馈（`优化/1.png` … `优化/7.png`）在桌面窗口里全部修好，连同「默认模型换成 deepseek-flash、模型设置字段改名」。终点是改动落地、`npm run check` 与相关 smoke 通过，并在窗口里逐图对照确认。

## Notes

- 域参考：`docs/architecture.md`、`AGENTS.md`、[ADR-0005](../../docs/adr/0005-modes-are-a-tool-config-choice.md)。
- 前序：`.scratch/ui-revamp/`（02 模型管理、03 模式系统、05 思考块、06 消息元信息）是这批缺陷的来源，本努力是对它们的修正。
- 截图：`优化/1.png` … `优化/7.png`，编号与用户报的七条一一对应。
- UI 只读设计 token（`packages/web/src/tokens.css`）；`npm run check` 会拒绝引用却不存在的 `--dsw-*`。
- **本努力携带执行**：票据解决后直接改代码，不是纯决策图。每张票据按 `wayfinder:task` 走，一次一张。
- 图表阶段已与用户敲定的四条（不再开票）：
  1. 「默认」模式保留 ADR-0005（不存储、是全局默认的活视图），只把交互统一成可点开编辑。
  2. 输入框左下角只留模式座位：删掉齿轮**和**整个会话级设置面板，会话的工具/审批只由模式决定。
  3. 流式卡顿走定点修复（delta 合并到帧、每帧只碰尾部、去掉强制布局），不做虚拟化重写。
  4. 默认模型由**客户端**内置常量提供，模型列表为空时用现有 `PUT /api/models` 种入；用户删除后不再种回；apiKey 留空由用户填。

## Decisions so far

<!-- 一张票据一行 -->

- [01 · 脚注复制按钮、行首三角、思考灰底、用时列对齐](issues/01-meta-chevron-reasoning-runtime.md)：已落地——复制按钮在自身规则里归零为纯图标（hover 才出 `--dsw-bg-hover` 与更亮字色）；三角常显、open 只转 90°；思考展开体并入工具输出的同一块灰面板（背景/圆角/内边距/滚动策略，含滚动条）；用时行改用 `margin-block`，inline 方向继续由 `.transcript > *` 居中。无新增 token。
- [02 · 输入框左下角只留模式座位；「默认」模式改成可编辑](issues/02-composer-and-default-mode.md)：已落地——齿轮与整个会话级面板删除（`followed` 保留，它是全窗口的当前会话）；模式座位是 bar 左端唯一控件；「默认」卡头部可点、展开 `modeFormCard`，名称只读，保存写全局 `tools`/`approval` 且串行化，不回写 `modes`；工具行 gap 8px、行高/下拉 30px。`npm run check`、重写的 `smoke-modes`、真 Chromium 的 `verify-02.ts` 全过。
- [03 · 正文流式渲染卡顿](issues/03-streaming-jank.md)：已落地——`frame.ts` 的 `OncePerFrame` 把 delta 合并到帧；`transcript.render` 按 `drawnItems` 引用差只画变化项，轮事实（末答案/开轮 user/最后 user）只在形状变化时重算，`placeAll` 只在形状变化时跑，`renderDeferred` 开头即发布轮索引（code-review 抓到的中途接入流式会话丢脚注/计时）；runtime 行只在不在末位时移动、文本按秒去重，`follow()` 换成不读 `scrollHeight` 的 `pin()`；折叠头只在思考文本变化时切。同一段内容的浏览器脚本时间不随会话长度增长（210→800 条：93–119 → 108–122ms，旧路径 175 → 284–299ms），jank-harness 长短比 4.67x → 0.92–1.11x，smoke 的属性写入 20000 → 1。`npm run check`、`smoke-transcript`、`smoke-frame`、`verify-03.ts`（210/800）全过。

## Not yet specified

- 老会话的「自定义」态（工具集不匹配任何模式）在失去手动编辑入口后的体验：02 只保证它照常显示
  「自定义」、选一个模式即可回到预设；是否要再给一句提示或「按模式归一」仍待定。

## Out of scope

- 长会话 transcript 虚拟化 / 结构性增量渲染重写（03 走定点修复，重写没有证据支持）。
- 插件、MCP 机制（项目规则本就排除）。
