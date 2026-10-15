# 10 `smoke:boot` 是红的：读工具没在审批闸门前停住，外加一个泄漏的句柄

Type: task
Status: open
Blocked by:

## Question

README:146 把 `npm run smoke:boot` 列在「验证一次构建」里，而 README:184 声称"类型检查与 smoke 脚本
通过"。**今天两处都假。** 2026-10-16 在 HEAD `caa373c` 上独立跑过两次，结果一致：

    ok   the read tool was put behind the approval gate
    ok   the prompt was accepted
    FAIL the run parked on the approval ["baseline","status","event","event","entry","status",...]
    FAIL and the session is genuinely waiting for an answer []
    ok   close() returned with the worst case in residence
    ok   nothing is left running
    ...
    2 failure(s)
    FAIL the process did not exit on its own — a handle leaked somewhere above
    [exit: 1]

**先排除掉的怀疑**：不是"用户 `models.json` 被清空"造成的——这个 smoke **自己注入假传输**
（`smoke-boot.ts:64-66`：`createFakeTransport()` +
`fake.setResponses([fakeAssistantMessage(fakeToolCall("read", { path: "notes.txt" }))])`，
`bootServer({ ..., api: fake.api })`），**不需要供应商密钥、不读模型清单**。也不是没起服务器——它自己
boot 的那台是活的（`the listener refuses connections after close` 等断言全过）。

**要查的**：工具配置说 `read` 在审批闸门后面（那条断言**过了**），提示也被接受了，事件也在流（帧日志里
全是 `event`）——**但 `approval_request` 一帧都没到**。所以是「闸门配上了但没停」、「停了但没发帧」，还
是「stop 事件先到了」？另外那条**泄漏的句柄**让进程不肯自己退出（`smoke-boot.ts:11-13` 明说那个
`process.exit` 是**故意的看门狗**，专门用来抓这种泄漏）——两件事**可能是同一个根因**：一次没有真正停
下来的运行。

**与外壳的关系**：`bootServer` 正是桌面外壳走的那条路（`packages/desktop/main.cjs:82`），所以"启动有
问题"的爆炸半径包含它。

**先红后绿**：这两条断言今天已经是红的，**不许改成"顺手改断言"**——先钉住红的状态，再修到绿。
最后把 README:184 那句陈述改成**事实**，并跑一遍 README 清单里的其他 smoke 确认没有连坐。
