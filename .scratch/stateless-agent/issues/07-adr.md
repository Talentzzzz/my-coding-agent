# 07:ADR——无状态会话架构与重启式审批

Type: task
Status: resolved

## Question

把票 01–06 的决定写成一条 ADR(`docs/adr/0006-…`),正式重开
`docs/architecture.md` 记录的现状决定(每会话有状态类、审批内存挂起),
并更新 `docs/adr/README.md` 清单。门槛检验:难以逆转(回退要恢复三个有状态
类 + loop 语义)、无上下文会困惑(读代码的人会问为什么不是对象)、真实取舍
(放弃了内存挂起与缓存袋)——三条同时成立,够格。

## Answer

已落:`docs/adr/0006-stateless-session-architecture.md`(编号 0006,清单已更新)。
按 README 写法含六节:背景 / 决定 / 后果 / 不可逆性与代价 / 被取代的是什么 /
没有被取代的。明确引用它有意重开 architecture.md 的「每会话有状态类」与
「审批内存挂起」,并声明 ADR-0001/0003/0005 与 compaction、retry、subagent
的既有决定**不被**本 ADR 触碰。
