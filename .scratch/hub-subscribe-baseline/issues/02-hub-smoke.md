# 02 - server：hub 级 smoke（`smoke-subscribe.ts`）——no-gap 守约检查落在 hub 缝上

Type: task
Status: done
Blocked-by: 05

## 背景与指针

- Spec：`Z:/my-coding-agent/.scratch/hub-subscribe-baseline/spec.md`（Testing Decisions 全部 + User Stories 1/2/3/5/6/10）。
- 契约的代码：`packages/server/src/hub.ts` 的 `subscribe`（票 01 产物）与 `rebaseline`（票 05 产物）。
- prior art（hub 级直接构造，不接 WS、不接 mux）：`scripts/smoke-projection.ts` L81 `new SessionHub({ workDirAbsPath: root, api: fake.api, modelsHome: join(root, "agent-home") })`；脚本化 transport 用 `scripts/fake-transport.ts`。
- 仓库 smoke 惯例：直接 `node scripts/smoke-xxx.ts` 运行、`check(name, cond, detail)` 断言、中文 process.stdout.write 小节标题。

**本票只新增 `scripts/smoke-subscribe.ts`（并在必要时改 `package.json` 的 smoke 清单/README 的 smoke 列表——看仓库现有 smoke 如何登记，照做）。不改 hub.ts、不改 mux.ts。**

## 改动

### 1. 新缝：直接构造 hub + 脚本化编排层（fake transport），覆盖 spec Testing Decisions 的四组

1. **活半**：会话有活半（一次在飞运行或停在审批的袋）时 `subscribe`：
   - `subscribe` 返回的那一拍 `watcher` 已被 feeds 回调调用过；
   - `onBaseline` 在 `subscribe` 返回**之前**同步到达（用标志位验证：subscribe 返回后立即检查标志已置）；
   - 注册后、快照前不可能有事件落入缝隙——以同步 emit 验证：注册后立刻发布一个事件，断言 onBaseline 先于该事件到达（或事件经调用方扣帧出现在 baseline 之后，两种表述等价，按 hub 活半同步交付的事实写最直接的那一种）。
2. **冷半**：冷会话（从未在本进程运行过）`subscribe`：
   - `onBaseline` 异步**恰好一次**（计数器）；
   - 读取期间发布的事件出现在 baseline 交付之后（**经调用方扣帧**：smoke 自己充当调用方，实现一个最小 backlog——收到 feeds 即开始扣事件、onBaseline 到达后冲刷——然后断言冲刷序为 baseline 先、事件后。这个扣帧是「调用方职责」的示范，不是对 mux 的测试）。
3. **未知会话 / 读盘失败**：`subscribe` 一个不存在的 id → `onError` **恰好一次**、`onBaseline` 零次、`watcher` 不再有任何 feeds 回调；一个读盘会失败的情形（如手写残缺文件对，参照 smoke-sessions 里 v4 遗物用例的构造风格）同样恰好一次 onError。
4. **删除/收摊**：观看中 `hub.remove(id)` → `watcher(undefined)` 到达；`hub.close()` 同理；退订函数调用两次不抛、第二次后无副作用；冷读盘进行中退订 → onBaseline/onError 都不再到达（「退订即终结」语义）。
5. **重发路径（`rebaseline`，票 05 的第二个动词）**——重发 baseline 的活冷分岔同样在 hub 内：
   - 活半：`rebaseline` 返回**之前** `onBaseline` 已同步到达（标志位验证），且快照是在飞状态而不是盘上旧状态（例如袋里有一份正在写出的 partial / running 为真）；
   - 冷半：`onBaseline` 异步**恰好一次**，且不在 `watchers` 里留下任何东西（`hub.isWatched(id)` 前后不变——重发不注册）；
   - 未知会话：`onError` 恰一次、`onBaseline` 零次。

### 2. 断言风格

- 只测外部行为（spec Testing Decisions 第 1 条）：回调时序、次数、顺序的可观察结果。不检查 hub 内部字段、不断言某个私有方法被调用。
- 每 javadoc 契约条目至少一条断言与之对应，断言名用契约的语言（「注册与快照原子」「恰好一次」）。
