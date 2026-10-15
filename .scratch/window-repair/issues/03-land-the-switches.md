# 3 落地最小开关组合，并记下"为什么这台机器要禁沙箱"

Type: task
Status: resolved
Blocked by: 02

## Question

02 号给出组合之后，落地它。除了改代码，这票必须交出**两样记录**，否则下一个读 `main.cjs` 的人会以为
这是一次漂移：

1. **那 12 行现在是未提交的**——`git status` 里 `M packages/desktop/main.cjs`，`+12 行、0 删除`。
   一个**已经验证有效**的启动规避停留在工作区，这件事本身就是 bug：一次误操作就没了。
2. **一条 ADR**。按 `docs/agents/domain.md` 引的门槛（难以逆转 + 没有上下文会让人困惑 + 是真实取舍的
   结果），这条**三条全中**：
   - **难以逆转**：用户换机器、或杀毒软件升级之后，没人知道当初为什么关了沙箱；
   - **没有上下文会困惑**：**会**，而且强烈——一个只加载本机 `127.0.0.1` 的窗口凭什么关掉沙箱；
   - **真实取舍**：是，"这台机器的子进程一启动就崩"对"沙箱提供的纵深防御"。
   写清：症状与证据（那两个 `exit_code=-1073741819` 与 `ERR_FAILED` vs curl 200 的对照）、被否决的
   更便宜方案、**没被推翻的边界**（只加载本机地址、不加载任意外部网页）、以及**恢复路径**——什么条
   件下可以把这个开关拿掉。
3. 顺手清掉 `webPreferences.sandbox: true` 与 `no-sandbox` 的**语义矛盾**：按 02 号的结论决定是删掉那
   个死配置、还是就地加注解说明它被开关压过。

改完跑 `npm run check` 与外壳相关 smoke（`smoke-boot`、`smoke-desktop-close`）——**注意
`smoke-boot` 今天是红的**（见 10 号），别把它算成自己改坏的。

## Answer

**落地形状按 02 号的结论，不是按本票开头那段设想的"把组合落地"。** 02 号实测的结论是"那四条在本机
全是空操作"（GPU 进程**从未被观察到活着**，12 组配置含完全裸跑全部开出窗口），所以"落地"在这里等于
**删掉四条 + 删掉那段"这台机器"的注释**，而不是把它们固化成代码。本票开头那段写的"12 行现在是未提交
的，这件事本身就是 bug"仍然成立，只是解法从"提交它"变成"删掉它并提交"——一条已验证有效的规避留在
工作区是 bug，把它当配置留下来同样是 bug（02 号的原话：**别把开关留成幽灵配置**）。

### 票面三件交付

1. **那 12 行**：删除。`packages/desktop/main.cjs` 里 `const lifecycle = createShutdown({ app })` 与
   `/** The repository root … */` 之间现在是空的，文件与 `HEAD` **逐字节相同**
   （`git hash-object packages/desktop/main.cjs` == `git rev-parse HEAD:packages/desktop/main.cjs`），
   `git status` 干净。**一个必须说清的后果**：那 12 行**从未被提交过**，所以这次删除**不产生任何
   diff**（`git log -S no-sandbox -- packages/desktop/main.cjs` 为空）——本票的提交里看不到
   `main.cjs`，那不是漏做，而是"删掉一段从未入库的工作区状态"的形状。这也是票面"这 12 行是未提交的"
   那句的另一面：它在版本控制里**从来就不存在**，所以"提交它"与"删掉它"是仅有的两种收场，而 02 号
   的结论选了后者。
2. **ADR**：**[`docs/adr/0004-shell-sandbox-switches-removed.md`](../../../docs/adr/0004-shell-sandbox-switches-removed.md)**，
   已登记进 `docs/adr/README.md` 的清单。按 `docs/adr/README.md` 要求的四件东西写（背景 / 决定 /
   后果 / 不可逆性与代价），另加两节（被取代的是什么 / 没有被取代的）。票面点名的四样都在：
   **症状与证据**（两份转储的 `0x80000003`、`+0x72D4CB9`、栈上逐字的
   `gpu_data_manager_impl_private.cc:417: GPU process isn't usable. Goodbye.`；以及 `ERR_FAILED` vs
   `curl` 200 的对照——**并写明完整的 `-1073741819` 不在那两份转储里，是跨来源拼接**）、
   **被否决的更便宜方案**（五条，含"留成幽灵配置""只在检测到注入时才加开关"）、
   **没被推翻的边界**（窗口只加载 `127.0.0.1` 上它自己那台服务器的 URL；`setWindowOpenHandler` 一律
   `deny`；`nodeIntegration: false` / `contextIsolation: true` / `webSecurity: true`）、
   以及**恢复路径**（什么条件、按什么顺序把哪几条加回来，加回去时要同时做的三件事）。
3. **`webPreferences.sandbox: true` 的语义矛盾**：**保留、不加注解**（02 号的结论）。理由写在 ADR 的
   D 段：`--no-sandbox` 一删，这一句不再被任何东西压过，它就是唯一还在表达沙箱意图的地方；删它等于
   顺手把渲染进程的沙箱也关掉，没有人要求过。矛盾随开关一起消失，"死配置"这个描述因此失效。

### 一件票面没要求、但不改就会留下漂移的事

`packages/desktop/observability.cjs` 里 `watch()` 的文档注释拿 `no-sandbox` / `in-process-gpu` 当
"子进程为什么会死"的例子——那两行已经不在了，注释改成"子进程死一行就够"的本义，并指向 ADR-0004。

### 验证

- **生产启动路径当面验过两次**：`npm run desktop:screenshot`（`build:web` + `scripts/launch.mjs`，
  真窗口、真服务器、真页面）在**删之前与删之后都**退出码 0，都写出 1280×820 的整窗截图；删之后那张
  逐项看过：左栏工作区与会话、输入框、状态行都在，画得全。**"两条都成功"本身就是这次落地的要点。**
  **没有把截图当成产物提交**——`packages/desktop/ui.png` 是仓库里已有的构建产物，跑一次就会被改写，
  所以它已被 `git checkout` 还原；要复现这个证据就重跑那条命令。
- `npm run check` 退出码 0（token 审计 127 defined / 101 referenced）。
- `node scripts/smoke-desktop-close.ts` 与 `node scripts/smoke-desktop-observability.ts` 全过
  （两者都不依赖任何开关，所以删掉它们不需要动测试）。
- `npm run smoke:boot` **仍是红的，逐字与本票改动前一致**（`the run parked on the approval` /
  `and the session is genuinely waiting for an answer` + 泄漏句柄），即 10 号票的那两条；不是本票改坏的。

### 一条诚实的限度

**一手文档这一轮仍然没读成正文**：`web_fetch` 在本 session 解析不了域名（`getaddrinfo ENOTFOUND`），
搜索结果也只有标题。所以 ADR 里的开关语义**全部落在本机实测**上，这一点写进了 ADR 的「证据的限度」，
没有假称引过官方文档。

**另一条**：本次唯一的产物是文字（ADR + 一处注释 + 文档），**没有可被 diff 证明的代码改动**——被删的
那 12 行不在版本控制里（见上）。所以这次"验过了没有"只能落在两处：本票与 ADR 里逐字写下的命令与
结果，以及 `.scratch/window-repair/research/minimal-switch-set.md` 里 02 号已经提交的实测证据。**这
是本票无法用 diff 自证的部分，明说。**
