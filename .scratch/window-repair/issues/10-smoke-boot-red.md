# 10 `smoke:boot` 是红的：读工具没在审批闸门前停住，外加一个泄漏的句柄

Type: task
Status: resolved
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

## Answer

红态钉住了、根因找到了、修到绿了。**结论先行：这不是审批闸门或循环的 bug，`caa373c` 与 HEAD 的
packages/ 一个字节都没差；是 `smoke-boot` 不封闭——它读了机器上真实的 `models.json`。**

### 一、红是怎么钉住的

按票面排除了两个"不可能"之后，票面自己那个"smoke 自己注入假传输、不读模型清单"的排除**是错的**：
假传输替换的只是 API，hub 仍然从 `UserModelStore`（= `~/.my-agent/models.json`）取模型行装配会话——
绿跑输出里 `models 200 count=1` 就是证据。把 home 指向一个**零行**的 `models.json` 复现了逐字相同的红：

- 零行 → `selectModel` 落空 → 会话跑在 **placeholder model** 上 → `unconfiguredStream` 根本不发请求
  → 工具调用不发生 → `approval_request` 一帧都不来、`pendingApprovals: []`。两条 FAIL 同根。

实测：空 home 下 **13/13 全红**（8 次普通 + 5 次带 CPU 负载），一行 home 与真实 home 全绿。10/16 上午
红、下午绿的"漂移"就是机器上那份文件的状态漂了，与提交无关。

顺带排掉一个次生嫌疑并确认了它的机制：若全局 `settings.json` 记了 `tools` 且不含 `read`，
`prepareToolCall` 会在 `beforeToolCall` **之前**以 "Tool read not found" 结束（`agent-loop.ts:653`），
闸门同样被绕过。本票的两处不封闭（真实 models.json、真实 settings.json）由同一个修法一起关掉。

### 二、修法（`scripts/smoke-boot.ts`）

- 脚本先建一个**自己的 scratch agent home**（写好一行假模型的 `models.json`，无需密钥），再
  `process.env.MY_AGENT_HOME = <scratch>`，然后**动态 import** 应用模块——`AGENT_HOME` 是 import 时刻
  从该变量解析的常量，静态 import 会先于赋值求值，所以三处应用模块的 import 全改成了动态。
- `finally` 里随两个工作区一起删掉 scratch home。**副作用修正**：此前每次跑这个 smoke 都把会话文件
  写进真实 `~/.my-agent/sessions/`（现存 36 个 `my-agent-boot-*` 残留目录是历史欠账，清理由人决定）；
  现在 home 封闭，实测真实 home 目录数不再增长。
- 子进程那半自动受益：它显式传父进程的 `MY_AGENT_HOME`，现在指向 scratch，子进程的会话也落在 scratch。

验证：真实 home 6/6 绿；外部 `MY_AGENT_HOME` 指向空 home（投毒）3/3 仍绿——环境不再能漏进来。

### 三、泄漏的句柄：没复现，诚实记档

那条"process did not exit on its own"在 **14+ 次运行**（两种提交 × 空/真实 home × 有无 CPU 负载）里
**一次都没再出现**，包括复现两条审批 FAIL 的全部场景——它不与审批红同根，或至少不是每次红都伴生。
没有证据就不编因果。能做的已经做了：看门狗退出前现在会 dump
`process.getActiveResourcesInfo()`（去重），下次它再响，输出会直接指认泄漏的是哪类句柄，而不是只喊一声。

### 四、README 与全量清单

- README 的 `smoke:boot` 条目补"自带封闭的 agent home，不读机器上的用户配置"；「状态」一节的
  "类型检查与 smoke 脚本通过"现在是事实，并注明清单不需要密钥。
- README 清单**全量跑过一遍，全绿**：`npm run check`（token 133/107）+ 15 条 smoke（desktop-close、
  desktop-observability、tools、sessions、projection、mux-client、mux-live、mux、liveness、
  backpressure、sidebar、transcript、session、models、approval）+ `smoke-api`（对着一台真跑的服务器，
  `api ok`）。smoke-api 起初两次 FAIL 是我自己的装置错误（服务器跨 shell 没活到下一条命令 + 相对路径
  敲错），与 map 里"the mux connection failed = 没起服务器"那条坑一致，不是连坐。

## Comments

- **2026-10-16 code-review（双轴）收尾**：Standards 轴抓到 `mkdirSync` 导入没人用；Spec 轴指出
  settings.json 的封闭靠"缺席"而非"钉住"。落实两处：删导入、三处 scratch 目录的 rm 收成
  `removeQuiet`；并新增一条断言——PATCH 之后显式检查 `read` 仍在会话 `activeTools` 里，把
  "tools 不含 read → 闸门之前 Tool not found → 静默绕过"这个失败形态变成响亮的 FAIL（`bf4fd6e`）。
  投毒环境复跑 3/3 绿、`npm run check` 通过。
