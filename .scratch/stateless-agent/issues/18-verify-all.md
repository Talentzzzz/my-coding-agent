# 18:全量验证——check、smoke 全套、桌面手测

Type: task
Status: open
Blocked by: 15, 16, 17

## Question

重构合龙后的全量验证:

1. `npm run check`(core、server、web 的 tsc + token 审计)。
2. smoke 全套:`smoke-tools.ts` / `smoke-models.ts` / `smoke-sessions.ts` /
   `smoke-api.ts` / `smoke-mux.ts`(均不需供应商密钥)。
3. `npm run desktop` 手测清单:
   - 发消息、流式输出、steer 插话、followUp;
   - 审批新语义全流程:触发审批 → 本轮结束 → 批准 → 恢复续跑;拒绝;超时收尾;
   - 分支:branch 切换、分支页主链与地图、anchor 挂靠;
   - compaction:trim / clear / 摘要三步在重放链路下生效;
   - 会话恢复:重启桌面应用后重开会话,补齐链重建,标题/分支/usage 一致;
   - 设置变更写回:全局与项目两份 settings.json 的 declared 规则;
   - 模式切换与按值匹配的座位显示;
   - 密钥红线抽查:`GET /api/models` 与一切事件/快照无 apiKey。
4. 发现的回归按票回修;全绿后关闭本票,地图到达目的地。

## Progress(2026-10-31,票 18 执行)

**1、2、4 已完成;3 的可自动化部分已完成,交互部分待手测。**

- `npm run check` 全绿(含回修后重跑)。
- smoke 全套跑绿(README「验证一次构建」清单全部 24 项,不止票上五项)。
  发现并回修四处,其中两处是**真回归**、两处是 smoke 停在新生命周期之前:
  - **smoke-stream**(真回归):rig 还给 hub 传旧参数名 `cwd`,`HubOptions.absCwd`
    收到 undefined → `POST /api/sessions` 失败。改传 `absCwd`。
  - **smoke-sidebar**(真回归,出自 d3ce7a1 老提交):重命名从「改文件夹名」
    改成「显示标签」时,客户端把「带路径分隔符 / `.` / `..` 的名字丢弃不发」
    的校验弄丢了,smoke 挂 2 项。校验在 `render/sidebar.ts` 补回。
  - **smoke-projection**(smoke 停留在旧生命周期,15 项):断言「create 即有行」,
    与新语义「文件随第一条消息出现、没说过话的会话不进侧边栏」(ADR-0006 §3)
    冲突。按新语义重写:未说话 = 无行;第一句话把行带进 store;行存在后,
    第二轮才断言 running 发布与多次移动;标题按 ADR-0002 从分支首条 user 消息
    派生,后续消息只推 modified 不改名。
  - **smoke-mux-live**(同上,7 项):概览表 / REST 工作区列表同理——会话与
    工作区都先说一句话再断言出现;`until` 放宽为可收 async 谓词。
- 真服务器验证:隔离 agent home + 独立端口起 `main.ts`,`smoke-api.ts` 全绿;
  密钥红线抽查通过——`/api/models`、`/api/sessions`、`/api/sessions/{id}`、
  `/api/workspaces` 四个 REST 面与 mux 帧(整表 + 基线 + 状态)grep `apiKey`/
  `sk-` 均 0 命中。
- 票 16 曾登记 smoke-stream / smoke-projection / smoke-mux-live 为「干净 master
  上的既有失败,留给 18 处置」——三处至此全部落地,无遗留。
- 剩余:上方手测清单需真桌面窗口与供应商密钥,由人工执行;全过后关闭本票。
