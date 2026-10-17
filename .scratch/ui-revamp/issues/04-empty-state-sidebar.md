# 04 · 空状态与侧栏文案

Type: task
Status: resolved
Blocked by: 01

## Question

按确认的原型：空会话页去掉「描述要改的地方…」整段说明，只留图标 + 「想做点什么?」；侧栏「新建会话」按钮文案改为「新会话」。

## Answer

已落地，三处改动：

- `packages/web/src/render/transcript.ts`：`setWelcome()` 去掉整段 `<p>` 说明，只留 sparkle 图标 + `<h2>想做点什么?</h2>`（问号随原型用半角）。
- `packages/web/src/render/sidebar.ts`：顶部按钮文案「新建会话」→「新会话」。工作区右键菜单里的「新建会话」**不改**——它命名的是被施加的工作区（见其注释），与顶部按钮不是同一个控件，票据只提侧栏按钮。
- `packages/web/src/style.css`：删掉失去目标的 `.welcome p` 规则。

`npm run check` 通过（web tsc + token 审计）。改动纯客户端文案与样式，不涉 core/server，无对应 smoke。
