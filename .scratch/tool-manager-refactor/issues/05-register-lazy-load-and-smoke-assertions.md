# 05 - register()、懒加载与 smoke 断言的处置

Type: grilling
Status: open
Blocked by: 02

## Question

今天 `Registry.register()`（`tools/registry.ts:70`）只服务测试：
`scripts/smoke-session.ts:1018` 自建 registry 塞 `unbounded` 验证写边界归档、
`:1280` 塞 `noop`；`scripts/smoke-tools.ts:233` 用 `build("bash", run)` 测 bash 超时；
`smoke-session.ts:1264` 断言 `active()` **每次返回新对象**、`:1281` 断言
`build("noop", run) === noop`（register 的对象身份）。
换成一张常驻实例 Map 后，这些断言与新形状天然冲突，定案 3 已授权改。

请裁决：

- **(a)** `register()` 保留为 `map.set`，测试工具与内置工具同表；smoke 断言按新形状重写
  （「每次新对象」改成「恒为同一实例」）。
- **(b)** 去掉 `register()`，测试工具改由 `ToolManager` 构造参数注入；`exerciseOutputBackstop`
  用例随之改。
- **(c)** 保留 `register()` 但只准在 Map 首次填充前调用，之后抛错。

并定旧五个方法在 Manager 上的去留：`names()` / `build(name, run)` / `activeNames(state)` /
`active(state, run)` / `register(tool)` —— 哪些保留、哪些删、要不要留别名过渡
（`smoke-tools.ts:733` 还直接用了 `toolDefinitions().names()`，`scripts/mount-session.ts`
从 `@my-agent/core` 导入工具出口）。
若 02 号票定案 (a)，`run` 参数不再需要，`build` 的签名怎么收？

➡️ 推荐 **(a)**：测试注入是既有能力，没必要为一次改名砍掉；断言按新形状改写并补一条
「同一会话的两个请求取到同一个实例」，把新不变量测出来。
