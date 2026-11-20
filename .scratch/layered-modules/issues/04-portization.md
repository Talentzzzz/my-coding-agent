# 端口化决策

Type: grilling
Status: resolved

## Question

哪些磁盘访问抽成 domain 声明的接口？边界线画在哪？hold 闸怎么处理？接口声明在哪？

## Answer

- **全部自有存储端口化**：会话文件对（`.json` 快照 + `.jsonl` 账本）、`models.json`、
  `tools.json`、`sessions.json`、tool-results 归档（`.my-agent/tool-results/`）。
  否则"未来换 mysql"只对一半数据成立。
- **边界线**：用户工作目录的固有本地事实**不**端口化，`node:fs` 直用——AGENTS.md/CLAUDE.md
  收集、六个工具的文件读写与 shell 执行、路径解析（`workdir.ts`）。这些换 mysql 也不变，且工具
  本来就以"碰这台机器的任何文件"为职责。llm 的供应商 HTTP 同样不端口化：`ChatTransport` 已是
  它的缝，llm 包原样住在 domain。
- **hold 闸整体下沉 infra**：端口方法各自原子（闸是 infra 存储实现自己的并发细节），domain 只见
  `UnknownSessionError` 与撞闸拒绝的语义，不向 domain 暴露 hold/release 动词——ADR-0023 的
  「server 与编排层不感知」升级成「domain 也不感知」。
- **端口由消费方声明**：用数据的包在自己的 types.ts 里声明自己要的存储接口（session 包声明会话
  存储接口、llm 包声明模型目录存储接口……），infra 逐端口一个实现文件、import domain 的类型；
  **不设独立的 ports 包**。
