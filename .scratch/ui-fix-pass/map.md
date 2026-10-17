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

## Not yet specified

- 流式修复后 `.transcript` 的批处理形状：是否把 `Drain` 的帧预算复用到流式帧上，取决于 03 的实测结果。
- 删掉会话级面板后，服务端 `PUT /tools` 与 `PATCH /config` 是否仍然需要：`PUT /tools` 仍被模式选择使用，`PATCH /config` 的审批半边是否还有调用方，取决于 02 的落地结果。
- 老会话的「自定义」态（工具集不匹配任何模式）在失去手动编辑入口后的体验：可能只需一句提示，也可能要一次“按模式归一”。

## Out of scope

- 长会话 transcript 虚拟化 / 结构性增量渲染重写（03 走定点修复，重写没有证据支持）。
- 插件、MCP 机制（项目规则本就排除）。
