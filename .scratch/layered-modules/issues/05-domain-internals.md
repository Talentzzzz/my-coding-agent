# domain 内部归属

Type: grilling
Status: resolved

## Question

core 里的散件（model-manager、settings、hooks、workdir、shell、protocol、根 types）归哪个子包？
context 包造不造 manager？依赖方向用什么机械守卫？

## Answer

- **散件归属**：
  - `model-manager.ts` → **llm 包**（models.json 行 → `Model` 的构造链都在 llm）。
  - `settings.ts`（resolveSettings 组合）→ **agent 根**（横跨 tool/session/model 三簇）。
  - `hooks.ts` → **agent 根**（编排的接缝，不是 context 的）。
  - `workdir.ts` + `shell.ts` → **tool 包**（工具路径解析与平台 shell 启动）。
  - 行类型（`SessionRef` / `SessionRow` / `SessionRowPatch`）留 **session 包**（与 snapshot 同属
    会话事实，case 只现算不养类型）；`protocol.ts` 解散、其余 re-export 回归各包。
  - core 根 `types.ts` → **agent/types.ts**。
- **造 ContextManager 注入 Agent**：填充链与压缩步骤的持有者。与 ADR-0016（loop 就是编排、填充
  链是 Agent 私有方法）冲突，ADR 待修订；职责边界另见 ticket「ContextManager 的职责边界」。
- **依赖方向守卫**：`check-server-facade.ts` 改造成模块依赖方向检查——
  trigger→{case,infra}、case→domain、infra→domain、domain→零本仓依赖、app→全部、desktop/web
  维持现状——违规即 `npm run check` 失败。
