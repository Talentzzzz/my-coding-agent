# 迁移顺序与验收编排

Type: grilling
Status: open
Blocked by: 06, 07, 08

## Question

spec 的脊柱：分几步搬、每步的顺序与验收是什么？

具体待定：

- 分步迁移顺序：每步结束时 `npm run check` + 相关 smoke 全绿的可验收状态是什么？
  候选思路——先立 infra 端口实现（并行于旧路径）再切 manager、还是先搬 trigger/case 等纯移动、
  ContextManager 与注入改造放在哪一步；一步一个绿状态，避免长期双轨。
- 每步的验收命令清单（五个 smoke 里哪些对哪一步有意义）。
- smoke 脚本归属：留根 `scripts/` 还是随包走？`check-server-facade.ts` 改造成依赖方向守卫的
  实现方式（静态 import 扫描？dependency-cruiser？自写脚本）与并入 `npm run check` 的时机。
- tsconfig / workspace 图的调整时机（一次到位还是随步走）。

前置：[ContextManager 的职责边界](06-context-manager-boundary.md)、
[端口方法集设计](07-port-method-sets.md)、[app 组合根的形状](08-app-composition-root.md)。
