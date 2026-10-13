# 06 - leaf 可持久化落地

Type: task
Status: resolved

## Question

leaf 落盘为状态 entry（kind `leaf`，`leafId: string | null`），由 `branch()` / `resetLeaf()` 在位置真的移动时写出，`buildIndex()` 重放；老文件不补写，`CURRENT_SESSION_VERSION` 保持 3。唯一的生产代码文件是 `session-manager.ts`。落地清单见旧图票 18 的 Answer（含 `docs/architecture.md` 四处、`docs/notes.md` §三、两个 smoke 的断言）。

## Answer

**2026-10-13 落地**，按旧图票 18 的落地清单逐项：

1. **`packages/core/src/session/session-manager.ts`（唯一的生产代码文件）**：`LeafEntry` 类型进 `SessionEntry` 联合；`branch()` / `resetLeaf()` 在位置**真的移动**时经 `appendLeafRecord()` 写出（追加为 pre-move leaf 的子节点、这次追加不推进 leafId、`recordSelection` 同款 no-op 守卫）；`buildIndex()` 重放——`leaf` entry 把 leafId 设成记录的位置（null 是"第一条 entry 之前"这个位置本身，不走回落），其余每种 entry 设成自己，未知目标回落到 entry 自己的树位置；`getBranchPoints()` 注释枚举补 `leaf`。`Agent` 一行未改（只有 `appendMessage` 的 `branch_changed` 判定处按票 18 的登记补了一句注释：leaf record 会进原始子节点计数，与既有 state-entry 先例同形、多发一帧无害）。`CURRENT_SESSION_VERSION` 保持 3。
2. **文档**：`docs/architecture.md`——kind 七种改八种并加 `leaf` bullet；分支点枚举补 `leaf`；"leaf 本身活在内存里"整段改写为落盘后的实况；"已决未落地"一节整节删除。`docs/notes.md` §三改写为已解决的记录（§五 bug 3 末句的"现在"标注为历史）。`AGENTS.md` 术语的"等"字照旧覆盖，未动。
3. **冒烟**：`scripts/smoke-session.ts` 新增 `exerciseLeafDurability`——真实移动写一条记录、no-op 移动不写、close → `SessionManager.open` 重开 leafId 仍在、上下文不含记录、下一追加是记录位置的子节点、`resetLeaf()` 的 null 位置也活过重开、手写无 `leaf` entry 的 fixture 按最后一条 entry 读且树读得完整。`scripts/smoke-api.ts` 树段落成最终形式：全程不 attach，移动后等回收，冷读报出移动后的 leafId，下一条 prompt 仍从它继续（分支点两选项、恰一个 active）。
4. **登记**：旧图 `map.md` 两处（票 09 决定指针的括号随决定 8 划掉交代、Not yet specified 那条改为已落地）；票 08 的 Comments 登记 smoke-api 已换帧、其清单对 smoke-api 清账。票 15 / 票 09 的 Comments 在票 18 解决时已记，未动。

**落地中发现并修掉的一处**（票 18 的 Answer 未明说、由冒烟抓出）：重放规则里"记录的 null"与"未知目标"是两回事——`leafId: null` 是"第一条 entry 之前"这个**位置本身**，只有**非 null 但不在文件里**的目标才回落到 entry 自己的树位置。首版实现把两者混在一支里，`resetLeaf()` 的 null 位置在一次重开后被回落分支改写成 parentId，`smoke-session` 的断言当场抓出。

**验证**：`npm run check` 全绿；`smoke-session` / `smoke-sessions` / `smoke-tools` / `smoke-models` 全绿（均不需要供应商密钥）；`smoke-api` 对 scratch 服务器（无模型行、retry 关闭）全绿。`smoke-tools` 的分支 tip 断言按新语义更新——移动写的记录成为该子树的最新 tip，这正是票 18 §2 `getBranchTip` 行预判的形状。
