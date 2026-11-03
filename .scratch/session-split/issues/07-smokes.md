# 07 - smoke 更新与全绿

Type: task
Status: resolved
Blocked by: [03 - 写侧改造](03-writers.md)、[04 - server 连带](04-server-fork-listing.md)、[05 - web 连带](05-web.md)

## Question

`smoke-session` / `smoke-sessions` / `smoke-api` 等对两文件格式的断言更新，覆盖：JSON 原子重写、旧 v≤4 文件删除、fork 复制两文件、重开后各配置当前值恢复、配对残缺的行为、`tool_result_view` 不再被重放。`npm run check` 全绿。

## Answer

全部收账。清点发现六项覆盖里三张已在票 02–05 落地，缺的三张由本票补齐——smoke-sessions 新增「a meta change rewrites the snapshot whole」一节，顺带把文件头注释里「the JSONL file is what a later connection gets back」的旧话改成两文件。

**已在先前的票里绿着的**：

- **旧 v≤4 文件删除、配对残缺**：smoke-sessions「a pair this build cannot open is deleted, not kept」——v4 文件（header 在 JSONL 首行）、孤儿 `.json`、错版本对在扫描时即删，孤 `.jsonl` 在 `fillSession` 打开时删，四个用例齐全。
- **`tool_result_view` 不再被重放**：smoke-session「after_tool hook — the rewrite survives the file」——重放后文件只含六种 v5 kind（「the file holds only the six v5 kinds」），且重开后的请求仍带钩子改写、不带工具原文（视图层复活即会带回来的正是后者）；旧 v≤4 文件随删除政策消失，没有重放路径可言。

**本票补的三张**（smoke-sessions，走 hub 的真会话 + 四个 set 方法现写）：

1. **JSON 原子重写**：四个现值（title/model/thinkingLevel/toolConfig）各写一遍后断言 `.jsonl` 字节不变、`.json` 携带全部现值加身份字段（version/id）、会话目录无 `.tmp` 残留；另补同值 set 不重写（等 20 ms 后对 `.json` 的 mtime 断言，同值写若有落盘必带新时间戳）。原子性本身没有外部观察者——rename 是一步——所以测的是它的可观察半：日志不动、无半写残迹、无谓写不发生；审查校正时在测试注释里把这一层说破。
2. **重开后各配置当前值恢复**：release 后 `fillSession` 重放，`getRecordedSettings` / `getRecordedToolConfig` 原样吐回四个现值（会话只写 user 消息，`getRecordedSettings` 的 assistant 兜底必然落空，断言走的确实是快照路径）。
3. **fork 复制两文件**：fork 后断言磁盘上两文件俱在、`.json` 随拷源的 title/model/level/activeTools/approval 五个现值、`parentSession` 指源 `.jsonl` 路径。

**验证**：`npm run check` 绿；smoke-session / sessions / api（临时 HOME 起服的完整 REST + mux 往返）/ tools / approval 四张 / projection / branch / replay / transcript / sidebar / frame / stream / modes / settings / models 全绿。
