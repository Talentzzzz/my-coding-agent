# 实施步 5：端口化 + 组合根翻面（一步翻完）

Type: task
Status: resolved
Blocked by: 14

## Question

按 [spec.md](../spec.md) §4/§5 + §7 步 5 落地：五端口声明落消费包、infra 三文件、hold 闸
下沉、faces 翻面（端口必填）、`setSessionsDir` 消亡、AGENT_HOME/APP_NAME 出 domain 归 app、
12 个 smoke 文件 13 处改形、守卫激活 R3；ADR-0012/0023/0028 修订与新增 ADR-0030 落笔（§8）。
验收 = §7 步 5 附加清单全绿。

## Answer

`lm/step5-ports-app`（c5e1c45），已并入 `layered-modules`。全单 16 项 smoke + check
（R1/R1b/R2/R3，R3 有负测试）全绿，另复跑 13 个相邻 smoke 全绿。spec 未钉死处的判断
（已在代码注释/ADR 登记）：

1. SessionRepository 加只读 `storeDir` 属性（birth/fork 目标路径的布局契约声明半）。
2. options 面加第五必填端口 `sessionDefaultsRepository`（§5.2 prose 有、代码块漏列）。
3. 闸只包端口方法 I/O；被拒写留袋、随调用栈消亡（smoke-sessions 闸内用例原样过）。
4. fill 打不开一律抛 `UnknownSessionError`（契约 #2 取代旧普通 Error 消息）。**REST 可见**：
   打不开的会话文件对从 HTTP 500 变为 404——这是 §4.1 契约 #2 对 §9「REST 面不变」的内部
   张力，实施按契约 #2 裁决（code-review Spec 轴复核成立，登记于此为验收注记）。
5. store 目录 mkdir 移进 infra createPair（R3 下 domain 不能 mkdir）。
6. R3 例外加 `context/agents-md.ts`（§4.5 明文 AGENTS.md 收集不端口化，又搬不进 tool/）。
7. `scanLedger` visit 收 `(entry, {mtimeMs})` + 可选 signal（保 mtime 回落与流中止）。
8. home-json write 一律 mkdir（与 writeDisk/writeLayer 对齐）。
9. smoke-stream.ts 表外改形（直构 SessionHub 用旧 modelsHome，不改会静默崩）。
10. SessionManager 四个 static 发现方法随端口注入改实例方法、`hasSessionsFor` 异步化
   （REST 面不变，hub 适配 await）；`persistEntry` 导出带 repository（无外部消费者）。
