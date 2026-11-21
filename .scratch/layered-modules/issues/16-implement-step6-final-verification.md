# 实施步 6：终验与文档收尾（不改代码）

Type: task
Status: resolved
Blocked by: 15

## Question

按 [spec.md](../spec.md) §7 步 6 + §8.8–8.10 落笔：README「验证一次构建」全清单、
AGENTS.md（布局节 + 术语句 + ContextManager/端口新条目）、architecture.md 重写点全量、
CONTEXT.md。验收 = `npm run check` + 全部 smoke（README 清单逐条）。

## Answer

`lm/step6-final`（0bb0186，33 文件），已并入 `layered-modules`；README/AGENTS/
architecture/CONTEXT 全量对齐 + 28 份 .ts 的注释字面旧名清扫（零逻辑改动，机器核对）。
终验：check + 全部 33 条 smoke 34/34 全绿。

勘误（spec §1.2 树的登记漂移，非实施缺漏）：session 包的施加半落在 `session/view.ts`
（§3 六文件映射的产物），§1.2 的 session/ 清单成文早于步 4 切分、未列它。

步 6 顺带修正的预存在漂移（以代码现状为准）：README 设置节仍是 ADR-0028/0029 之前的样子
（单一 settings.json、`SettingManager`、appearance 归服务端）——按三簇文件 + 客户端存储
现状改；AGENTS.md「四个持有者」/types.ts 注释「五个持有者」改三（`Agent.settings()` 现状）；
装配代码块 `assembleSession` 改 `assemble`。
