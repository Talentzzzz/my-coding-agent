# 03 - server：传输层簿记退场 + 删除端点 202 + 实现检查点 + check 收紧

Type: task
Status: open
Blocked-by: 02

## 背景与指针

- Spec：`Z:/my-coding-agent/.scratch/holds-into-manager/spec.md`（Solution §1、§4，Implementation Decisions 第 4-7 条）。
- 探索笔记：`C:/Users/Administrator/WorkBuddy/spaces/2026_11_17_14-35-39/holds-into-manager-notes/exploration.md` §1（hub 现状）、§2（controllers/routes 现状）、§5（check-server-facade）、§6（smoke 对 hub.hold 的直接依赖清单）、§8（意外发现清单）。

## 改动

### 1. hub.ts：holds / closing 全数退场

删除：`holds` map、`closing` map、`hold()`（含两段式「等过 closing」）、`release()`、`holdsOf`、`heldSessionIds`、`close()` 里的 `this.holds.clear()`。迁移后 hub 剩下的簿记只有 `watchers` / `feedMap` / `current`——全部是传输层自己的东西（exploration §1.7 的表）。

`hub.remove` 重写为否决式 + **分离式（detached）**：

1. 存在性校验：`agent.fileAbsPathOf(id)` 无所指 → `UnknownSessionError`（→ 404；这与「第二次删除是 404」一致——删除进行中/完成后文件已消失）。这是删除端点**同步**做的唯一检查。
2. 告别观看者（`watcher(undefined)`，保留在 server 侧）、清 `current`。
3. **不 await** `agent.deleteSessionBySessionId(id)`：否决序（中止 → 等收尾 → 闸内 rm → 出表）分离在后台跑完。理由：spec Testing Decisions 明文「运行中删除 → **202 应答先到**，运行收到中止、流收尾，删除最终成功」——应答先于收尾。分离的 promise 上挂错误日志（沿用仓库现有日志约定；删除的失败只剩真正的病态）。

### 2. 删除端点 202 + 409 退场

- `controllers/routes.ts`：`DELETE /api/sessions/:id` 的应答码 200 → **202**。
- `controllers/sessions.ts` `remove`：删掉 409 映射（`httpStatus.conflict` 那支）——删除的失败只剩 `UnknownSessionError` → 404；`listeners.onRemoved` 触发时机改为 **202 应答时**（删除可能仍在后台进行）——侧边栏状态与用户意图一致（spec User Story 3）。
- health 端点：`held` 字段退场（L101-103）。这是本次 wire 的唯一形状变化（REST 一处；mux 零改动）。

### 3. controller 的 `holding()` 括号删除 + 实现检查点

- 删除 `holding()` 助手（sessions.ts L682-695）与它的 5 个使用点（branch / prompt / abort / updateConfig / approve）；这些命令直接调 `this.hub.agent`。占不占 hold 的命令分类清单随括号一起消失，统一规则变成「触碰文件的 Manager 方法过闸，读不过」。
- **实现检查点（spec 明文要求，逐条核对不许跳过）**：每个 mutating 命令在无所指 id 时确实沿自己的路径抛 `UnknownSessionError` → `internalError` 映射 404，不许有命令从「提前 404」变成「改写了一个不存在的东西」：
  - `prompt`：`startPromptedRun` → `getSessionBySessionId` → `open` 抛——✓，但注意**空文本短路（agent.ts L789）在 open 之前**：空文本 + 未知 id 会从 404 变成 200。空文本本就不改写任何东西——在代码处留一句注释说明这个已知边界即可，不为此加预检查。
  - `applyConfig` / `branchTo`：沿 `getSessionBySessionId` 抛——✓。
  - `rename`：`setTitle(open(id))` 抛——✓。
  - `abort`：**现状对未知 id 静默返回**（agent.ts L1723-1724）——不满足检查点。改 `Agent.abort`：表外 id 抛 `UnknownSessionError`。核对 abort 的全部调用方（exploration §4.2）确认无人依赖静默语义（票 02 的删除序先解析文件，不经过这里）。
  - `approve`：既有 `hasPendingApproval` 409 预检查保留（与 hold 无关）。
  - birth / fork：目标不是既有 id，无检查点。

### 4. check-server-facade 收紧

`scripts/check-server-facade.ts` 的 `bannedMembers` 增补：`.hold\s*\(`、`.release\s*\(`、`.holdsOf\s*\(`、`.heldSessionIds\s*\(`、`.holds\b`——写成成员访问形式避免误伤普通词（参照 `.settings(?!\s*\()` 的负向前瞻先例）。检查只扫代码不扫注释（withoutComments），注释里的 hold 一词不会误报。目标口径：server 包里不存在任何 hold / release / holds 通道——门面上没有、hub 里也没有，出现即失败。

### 5. smoke 脚本的机械适配（7 个脚本直接依赖 hub.hold / holdsOf / release）

exploration §6/§8.10 的清单：smoke-sessions、smoke-approval、smoke-approval-endpoint、smoke-stream、smoke-projection、smoke-mux、smoke-boot。本票只做**机械适配**让全部脚本可运行、语义尽量保留：

- 断言 hub.holdsOf 计数的用例（如 smoke-sessions L179-217）→ 删除或改写为等价的外部行为断言（hold 簿记已不可从 server 观察——这正是 spec 的意图）；
- hold/release 括号 → 直接去掉括号；
- smoke-sessions L549-554 的「read never held」monkey-patch 接缝 → 失去意义，删除该接缝与相关断言；
- **删除语义相关的既有用例**（smoke-sessions L779-809 的 409 节）→ 按否决式改写：删除held 会话 → 202；空闲删除 → 202；第二次删除 → 404；文件真消失。smoke-api 的删除节（L408-427）同步改：200 → 202。
- 更完整的否决式新用例归票 04，本票不新增。

## 验收

- `npm run check` 绿（含收紧后的 check-server-facade：server 包零 hold 通道）；
- 全部 smoke 脚本可运行且通过（`node --experimental-strip-types scripts/<name>.ts` 或仓库现行跑法）；
- mux 帧零改动；health 应答不再含 `held`。
