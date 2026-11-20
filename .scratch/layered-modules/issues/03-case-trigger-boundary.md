# case 与 trigger 的边界

Type: grilling
Status: resolved

## Question

case 层的边界是什么？Agent 编排层放哪？trigger 与 infra 之间允许什么？组合根在哪？

## Answer

- **case = SessionHub 原样搬迁**：订阅表、baseline 交付（no-gap 契约）、行折算、
  birth / fork / rename / remove、close——不增删。命令面仍走 case → Agent 公开面，不在 case 重造。
- **Agent 编排层整体进 domain**：引擎、会话表、命令、审批、投影（fanout）都是 domain 的
  `agent.ts`，保持今天的全貌，只是改为构造注入。
- **app 是组合根**：构造 infra 实现 → 注入给 domain 的 managers → 构造 Agent → 构造 case 的
  hub → 启动 trigger。
- **trigger→infra 仅限纯 fs 读**：服务 `web/dist` 静态文件、目录 stat 检查一类；不得经 infra
  绕过 case 触碰任何会话数据。
