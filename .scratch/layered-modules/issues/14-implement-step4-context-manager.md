# 实施步 4：ContextManager（纯 domain 内部）

Type: task
Status: resolved
Blocked by: 13

## Question

按 [spec.md](../spec.md) §3 + §7 步 4 落地：编排留引擎、算法半归 ContextManager、六文件
映射、根 types.ts 共享内核收编（§2.3 名单）、构造零依赖、投影函数注入、systemPrompt 注入点
删除、守卫加 R2；ADR-0006/0010/0016 修订落笔（§8）。
验收 = `npm run check` + 基础门 + smoke-session。

## Answer

`lm/step4-context-manager`（2184b60），已并入 `layered-modules`。验收全绿（check 含 R2 +
基础门 + smoke-session）；R2 做过负测试。已登记偏离（均为 R2/§2.2 的机械应用）：

1. `uuidv7` 与 `ToolResultContent` 进根 types.ts——不在 §2.3 名单上但 R2 强制（session 与
   context/spill/hooks 共同消费）。
2. `prepareCompaction` 保持 smoke 演练缝：context 包内收 `(entries, project)`，domain index
   以单参包装绑定投影函数（spec 说包内私有，但 smoke-tools 的既有调用面不可改）。
3. `Model` 类型经根 types.ts 的 type-only 转发可达 session/context（根→llm type-only 边的
   第三条良性边，§2.2 允许方向）。

**先坏项**：smoke-session 间歇抖动为基线竞速（基线 11 跑 3 败、失败段落随机），非本步回归。
