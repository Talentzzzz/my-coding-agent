# 05 - 客户端 MuxClient 与窗口 UI

Type: task
Status: open
Blocked by: 03, 04

## Question

`packages/web`：`MuxClient`（独占退避时间轴：cap `500→…→10000`、实际延迟 50–100%、无次数上限、一次尝试硬截止 15000 ms）+ 读超时 watchdog（15000 ms）+ 订阅集合（`status: "subscribed" | "ended"`，重新 live 按引用重放 `open`）；`connected` 拆成 `channel` 与 `reachable`；行 store 连接级、REST 兜底；sidebar 按 `modified` 原地重排（不 `replaceChildren()`）、第二行状态、连接指示器；reducer 加 `baseline` 分支与 `end` 清 `approvals`；删除 `whenOpen()` / `ATTACH_TIMEOUT_MS`。依据：旧图票 03/04/06/07/10。
