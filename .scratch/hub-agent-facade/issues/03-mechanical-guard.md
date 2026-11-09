# 03 「server 不知道 Manager」的机械守卫

Type: grilling
Status: closed

## Question

怎么让「server 包不 import 任何 Manager / 不摸 `agentState()`」成为被机器检查的不变量，而不是
一条会烂掉的注释？本仓库 `npm run check` 已经在做 token 审计（被引用未定义的 `--dsw-*` 名字会
被拒），有先例可循。候选：

- A. check 脚本里加一条 import 扫描：`packages/server` 的源码 import 不含 `SessionManager` /
  `SettingManager` / `ToolManager` / `createSession` / `readSessionSnapshot` / `agentState` 等名字；
- B. TypeScript 层面：core 的 index.ts 停止从 server 可见的面导出这些类型（能不能做到取决于
  core/server 是否同一个 tsconfig 路径）；
- C. 只靠 review，不加机械守卫。

定：选哪种、名单多长（是否连 `agentState` / `agentState().session` 的直读一起禁）、守卫写在哪
个脚本、报错文案。

## Answer

### 形式（裁定 A）

check 脚本扫描（check-tokens 同款先例：独立小脚本 + regex + 进 `npm run check`）。

- **B 被否（事实不可行）**：core 与 server 在同一个 tsconfig（根 `tsconfig.json` 用 `paths`
  别名指向 `packages/core/src/index.ts`），类型层面藏导出必须拆 project references，
  改动远超本 feature。
- **C 被否**：只靠 review 会烂。

### 禁名单（票问「名单多长」，已对当前 server 源码验证误报）

范围：仅 `packages/server/src/**/*.ts`；scripts/ 的 smoke 明确保留 Manager 访问（票 02 裁定）。

**导入禁名单**——任何 import 出现即报错：

```
SessionManager  SettingManager  ToolManager  createToolManager
createSession  readSessionSnapshot  SessionAgentServices
OpenAgentOptions  AgentState  Session
```

后三个是票 01「纯数据、状态对象不出 core」裁定的机器化：`AgentState` / `Session` 类型
引用在 server 侧全部消失，`OpenAgentOptions` 是转递 Manager 的袋子（`sessionOptions`
搬进 Agent 后 hub 不再用）。`new SessionManager()` 这类用法天然被导入名单堵死。

**成员访问禁名单**（同一范围，扫正文不只扫 import）：

- `.agentState(`、`.sessionManager`、`.settings`——`.settings` **排除方法调用形态**
  `.settings(`：routes.ts 的 `controllers.system.settings()` 是合法的 controller 方法名，
  已验证是唯一误报源。
- `.tools` **不进**成员名单：`record.tools` / `fields.tools` 等纯数据用法太多，兜不住也
  不必——`ToolManager` 由导入名单堵死。

名单以后加名字 = 加一行，成本为零。

### 安置与报错（票问「守卫写在哪个脚本、报错文案」，裁定 a）

新脚本 `scripts/check-server-facade.ts`，`npm run check` 在 check-tokens 之后追加一步；
不并进 check-tokens（不同关注点、不同扫描对象）。报错简体中文、带 `file:line`，例如：

```
server 不得触碰 Manager：packages/server/src/hub.ts:383 `.agentState(`——会话操作走 Agent 公开面
```

