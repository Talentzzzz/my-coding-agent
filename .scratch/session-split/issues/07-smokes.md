# 07 - smoke 更新与全绿

Type: task
Status: open
Blocked by: [03 - 写侧改造](03-writers.md)、[04 - server 连带](04-server-fork-listing.md)、[05 - web 连带](05-web.md)

## Question

`smoke-session` / `smoke-sessions` / `smoke-api` 等对两文件格式的断言更新，覆盖：JSON 原子重写、旧 v≤4 文件删除、fork 复制两文件、重开后各配置当前值恢复、配对残缺的行为、`tool_result_view` 不再被重放。`npm run check` 全绿。
