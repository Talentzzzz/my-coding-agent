# 14 改名的持久化：rename entry 与标题端点

Type: task
Status: open
Blocked by: 11

## Question

把 [11 号](11-session-rename.md)拍下的决定落进 core 与 server。**动手前先写 ADR**——格式改动按
AGENTS.md 的规则要一条 `docs/adr/0002-session-rename-entry.md`，下面第 3 条是整张票唯一需要先想清楚
再写码的地方。

要做的：

1. **entry kind**：`{ type: "rename", id, parentId, timestamp, title }`，进 `SessionEntry` 联合类型
   （`session-manager.ts:181-189`）。它不进模型上下文，也不参与 `buildSessionPath` 的对话语义；
   追加 helper 照 `tool_config` 的追加（`:1144` 一带）抄，`parentId` 骑在当时的 leaf 上。
   **header 不动、`version` 维持 3**——老构建读到未知 kind 原样带过，兼容免费。
2. **读取让位**：文件序里最后一条 `rename` entry 赢（照 `tool_config` 的读法，`:1413`），与 leaf 在
   哪条走法上无关——左栏一行是一个会话，不是一条走法。清单扫描路径 `titleOfBranch`（`:767-786`）与
   活会话路径 `deriveTitle`/`getTitle()`（`:1459-1461, 1830-1837`）都改成：有 `rename` 用它，
   没有才派生。`title` 存的是净名，`（1）` 后缀不存、仍由左栏渲染（01 的 ② 原样成立）。
3. **追加落盘**：`hub` 上一个 `rename(id, title)`。会话**未被本进程打开**时照 `forkFrom`（`:1584`）
   的先例按路径追加；会话**正被本进程打开**时必须走活着的那个 manager（或让它自己追加），
   不能绕过它直写文件让两边打架。
4. **端点**：`POST /api/sessions/{id}/title { title }` = 控制器一个方法 + `createRoutes()` 一条记录。
   空名/纯空白 400；不做"清除改名"（想改回去就再改一次）；服务端存之前用 `shortenTitle` 的
   72 字符截断兜底（`:1846-1849`）。追加成功后确认既有发布路（`rowForId` → `publish` →
   `session_row` 帧，`mux.ts:576-578`）把新 title 送到客户端——**`protocol.ts` 一个字节都不动**，
   `title` 本来就在 `SessionRef` 里。
5. **ADR**：`docs/adr/0002-session-rename-entry.md`，四条必须进去：不碰 header（append-only）、
   `version` 不动（未知 kind 原样带过）、读取是会话级不分支、fork 整份复制时 `rename` entry 随行
   （`forkFrom` 复制全部非 header entry，`:1600`——所以 fork 落地时名字 = 源名字，与今天
   "派生标题 = 源标题"同构）。
6. **smoke**：`scripts/smoke-sessions.ts` 加改名断言（改名后 `rowForId` 的 title 是存的净名；重开仍在；
   fork 落地继承源名，随后改 fork 不影响源）；`scripts/smoke-api.ts` 加端点断言（201/400）。

`npm run check` 全绿。AGENTS.md 术语表里「session」一条顺手补一句"标题可被一条 `rename` entry 覆写"。
客户端的入口与就地编辑在 [08 号](08-fork-menu.md)，不在这张票里。
