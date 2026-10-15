# 18 工作区按最近活跃排序：客户端把方向排反了

Type: task
Status: resolved
Blocked by:

## Question

用户要求「刚发过消息的工作区排第一」。服务端 `SessionManager.listWorkspaces`
（`session-manager.ts:1745`）已经是**降序**（`newestAt(b) - newestAt(a)`），但活路径走的是客户端
`rows.ts` 的 `groups()`（`main.ts` 的 `rows.groups()`），它自己又排了一次，而且是
**升序**（`newest(a) - newest(b)`，`rows.ts:111`）——最近活跃的工作区沉底，与要求正好相反。

修法是把那一处比较器反向，并把方法注释里"the same ordering"的说法对齐（服务端确实降序，
是客户端错了）。链路其余各环已核实不用动：消息落地时 `projection.ts:165-169` 把 `modified`
前推并重发 `session_row` 帧 → 客户端行更新、`rows.version` 变 → 重画时 `groups()` 重排。

`smoke-sidebar.ts` 没钉组间顺序（只数了分组个数），断言不用改；补一条组间顺序的断言把方向钉住。
跑 `npm run check` + `smoke-sidebar.ts`。

## Answer

一比较器反转，别的一概没动：

- `packages/web/src/rows.ts` 的 `groups()`：`.sort((a, b) => newest(a) - newest(b))` 改为
  `newest(b) - newest(a)`，注释里 "the same ordering" 的说法一并对齐（服务端确实降序，是客户端错了）。
- `scripts/smoke-sidebar.ts` 新增第 7 节，直接驱动 `SessionRows` 钉住方向：初始 `/new`(300) 在
  `/old`(100) 前；`/old` 的行 `modified` 推到 400 后反超到第一——正是"刚发过消息的工作区排第一"。
- 链路核实结论（写进票面时已确认，落地未改）：消息落地 → `projection.ts:165-169` 前推 `modified`
  并重发 `session_row` → 客户端行更新、`rows.version` 变 → 重画时 `groups()` 重排。服务端
  `listWorkspaces` 本来就对，REST 兜底路径（`loadFrom`）吃的就是服务端顺序。

`npm run check` 绿；`smoke-sidebar.ts` 全绿（含新断言）。
