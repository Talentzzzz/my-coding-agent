# 05 · 思考块改成工具块样式

Type: task
Status: resolved
Blocked by: 01

## Question

按确认的原型改造 transcript 里的思考块：

- 与 bash / read 工具块同构：同容器、同头部行（标题「思考」+ 展开箭头），去掉小灯泡图标。
- 折叠态：头部一行内展示思考文本，持续横向滚动（marquee）。
- 展开态：正文区完整展示思考文本，行为与 bash 块一致。
- 流式输出与 marquee 的共存策略（见 map「Not yet specified」）。

## Answer

已按原型落地（`packages/web/src/render/transcript.ts` + `style.css`）：

1. **同容器、同头部行**：思考行改用 `<details class="tool reasoning">`，与工具卡共用全部容器与头部样式——同一枚悬停显现、展开驻留并旋转 90° 的 chevron，`.tool-name` 座位放「思考」，`.tool-path` 座位放折叠摘要。小灯泡图标与 2px 分隔点随之移除（`think` 图标从 `dom.ts` 一并删除，已无引用）。
2. **折叠态 · 流式中（marquee）**：思考仍在到达时（`thinking.running`），头部不再省略号截断，而是整段文本横向滚动——`.reasoning-marquee` 轨道携带两份文本，`translateX(-50%)` 无缝循环，两端 5% 渐隐 mask 让文字进出而不是被切断；循环时长按实测宽度解算（约 50px/s，下限 12s），长段落与短段落同速滑行。
3. **折叠态 · 结束后（定格首句）**：流结束即停滚，`.tool-path` 静态摘要定格思考文本的第一句（沿用既有 `firstLineOf`）——即 01 已确认的「滚动只在流式输出期间，结束后定格第一句」。
4. **流式与 marquee 的共存策略**（map「Not yet specified」的决议）：轨道携带**迄今全部思考文本**，但重写节流至 2s 一次。逐 token 重写既要在每帧复制整串文本，又要为解算时长每帧强制 layout——而滚动行的内容本身在移动，两秒的滞后不可见；节流后 delta 帧两样都不付。循环时长按实测宽度解算（约 50px/s，下限 12s），长段落与短段落同速滑行（原型定死 26s，对任意长的思考文本不可用）。
5. **展开态**：正文仍是 Markdown prose（不是 mono 输出），字号降到 meta 档（原型 12.5px 的 token 近似），缩进对齐 `.tool-output` 的同一行首（22px，即 chevron 12px + gap 10px），去掉原左边框，读作头行的延续而非第二栏；展开时头行的摘要与 marquee 整体 `visibility: hidden`（原型 `.trow.open` 规则），正文即全文，不两处同说一遍。

code-review（standards / spec 两轴）：mask 的字面色 `#000` 违反「style.css 零字面颜色」，已入 `tokens.css`（`--dsw-mask-ink`，同 `--dsw-scrim` 的先例）；展开隐藏与正文字号两处原型偏差已按上修；「思考折叠文本是否应非等宽」一项经核对原型不成立——`.rowhead` 对全部子元素统一 `font-family: var(--mono)`，思考摘要与工具参数同质感。验证：`npm run check` 通过（web tsc + token 审计）。marquee 动画受全局 `prefers-reduced-motion` 约束（style.css 既有规则一并覆盖）。
