# Map：窗口修复

`wayfinder:map`

## Destination

把桌面上这个窗口从"毛病缠身"做到**可信且舒服**：启动必定开得出窗口、窗口不再卡、字号真的能调到你
满意、设置页有固定的形状、对话与分支一眼可见、左栏工作区能收能展、切换会话不顿。

走到终点时，这些同时成立：

- `npm run desktop` **一定**开得出窗口；开不出时屏幕上有一句人能读的失败原因，而不是什么都不发生；
- 窗口不再**软件合成整屏**：要么把 GPU 拿回来，要么至少让 GPU 单独一个进程，不跟 agent 挤在同一个
  进程里；
- 设置页照参考实现**钉住形状**——宽 800、高 `min(800px, 100vh − 48px)`，**不随内容变**（点一次导航
  面板不会在指针底下长高），左侧导航栏 188px + 内容列各自滚动；
- 「字号」这个滑杆驱动一整个**派生族**（正文、标题、代码、表格、状态行都跟着动），量程到 22，你把
  它拉到底就是整窗的上限；
- 会话列顶部有一对**永远可见**的「对话 / 分支」页签——只有一条走法的会话也看得见；
- 左栏点一个工作区就把它的会话收起来，再点展开；收着的状态关窗再开还在；
- 切换会话不再顿：快照重放不再是 O(n²)、那次没有效果的第二次往返消失、订阅不再排在那次往返之后；
- `npm run check` 与 README 列出的 smoke 全绿——**包括今天红的 `smoke:boot`**。

## Notes

**领域。** 本项目是一个带桌面 UI 的编码 agent：agent 跑在 Node 进程里，窗口是一个 Web 客户端，用
REST 发命令、从一条常驻 WebSocket（`/mux`）读事件流。术语表在根 `AGENTS.md` 的「术语」一节，请求流程
与每个选择的理由在 `docs/architecture.md`——动手改哪个子系统之前先读它对应的那一节。

**这是第三个窗口 effort。** 前两个（`.scratch/window-rework/`、`.scratch/window-polish/`）的票**全部
resolved**，本图接着它们往下走，但有两条是**重开**而不是新增，按本仓库记重开的先例
（`.scratch/client-server-refactor/issues/12-recording-reopened-decisions.md`）在票里写明取代了谁、
理由是什么，不许悄悄漂移：

- **字号**：`window-polish` 17 号**拍板维持现状**（用户看完三方案原型后收回"字体再大一点"）。本图
  重开它——但重开的是**机制**（滑杆只驱动 4 条 CSS 规则、量程到 20 就封顶），不是那条被否掉的"五档
  等比抬一档"。
- **「对话 / 分支」入口**：`window-polish` 01 ③ 设计过这两个页签，12 号把几何横过来，13 号**把两个
  页签整块拆掉**换成「当前分支」chip，09 号照 chip 落地。本图重开 09/13。

**执行在范围内。** 本 effort 沿用前两张图的约定，覆盖 wayfinder 默认的"只产出决定"：`task` 类型的票
就是**执行切片**，解决它 = 把改动真的落到代码里，并跑 `npm run check` 加上对应的 smoke。
`research` / `grilling` 类型的票仍然只产出事实与决定。

**参考材料。**

- 用户 2026-10-16 给的参考截图（**dsh 的设置面板**）已归入
  `reference/01-dsh-settings.png`：800 宽、约 700 高、居中、左侧一条导航栏（账号与余额 / 通用设置 /
  模型 / 内置插件 / Agent 预览）+ 右侧内容区。这是 06 号的形状依据。
- 参考实现的**源码**在工作区的 `deepseek-harness-master/`（不在本仓库的构建图里，只作阅读材料，不要往
  里写东西）。这一轮最吃重的两处：设置面板
  `packages/client/ui-settings-general/src/client/SettingsRoot.module.css`（尺寸与两栏布局就在里面，
  自带注释解释了"为什么高度取自视口而不是内容"）、字号轴
  `packages/client/ui-theme/src/theme-settings.ts` 与 `src/styles/gradient-shadow-text.css`
  （`--dsh-content-font-delta` 那个派生式）。
- 前两个 effort 的 `reference/*.png` 与仓库根那个未跟踪的 `设计/`（三张旧反馈图）继续有效，不要重复
  归类。

**已核过的事实（动手前不必再证）。** 全部在 HEAD `caa373c` 上当场跑过：

- `npm run check` **退出码 0**，token 审计 `127 defined, 101 referenced`。
- `npm run smoke:boot` **是红的**（见下），READMe:184 那句"类型检查与 smoke 脚本通过"今天为假。
- `packages/web/dist` **不是旧的**：dist 最新 2026-10-15 22:56:38 比 src 最新（`composer.ts`
  21:20:44）还新；用 `vite build` 重建到临时目录是**逐字节相同**的（JS 89,219 B / CSS 45,884 B /
  html 1,494 B，三个哈希都相同）。所以"桌面端显示的是旧界面"这条**不成立**，别再去查它。
- `packages/desktop/main.cjs` **有未提交改动**：`+12 行、0 删除`，全部插在
  `const lifecycle = createShutdown({ app })` 之后——`app.disableHardwareAcceleration()`
  （`:39`）+ `appendSwitch("no-sandbox" | "in-process-gpu" | "disable-gpu-shader-disk-cache")`
  （`:45-47`），外面裹着"这台机器"字样的注释。**（03 号已处理，此处是当时的快照：那 12 行从未
  被提交，所以删掉它们不产生任何 diff——`git log -S no-sandbox -- packages/desktop/main.cjs` 为空。
  03 号删掉后工作区回到 `HEAD` 字节。理由与恢复路径见
  [ADR-0004](../../docs/adr/0004-shell-sandbox-switches-removed.md)。）**
- 启动耗时实测：`import(boot.ts)` **415 ms**（Node 类型擦除整张 server+core+agent 图）+ `bootServer()`
  **12 ms** = 到 `loadURL` 427 ms；`npm run desktop` 每次还会先跑 `build:web`（实测 **1077 ms**）。
- **端口不可能撞车**：`port: 0` 由 OS 分配（`main.cjs:88`、`boot.ts:133`），窗口加载的是
  `booted.url`。
- 外壳**没有任何崩溃观测**：`packages/desktop` 里 `child-process-gone` /
  `render-process-gone` / `gpu-process-crashed` / `uncaughtException` / `showErrorBox`
  一律 0 处；`await mainWindow.loadURL(...)`（`main.cjs:247`）没有 try/catch。
- 客户端**没有逐帧循环**：`requestAnimationFrame` / `setInterval` / `queueMicrotask` 在
  `packages/web/src` 里一处都没有；渲染是按 mux 帧事件驱动且逐段门控的。
- **最可能解释"很卡"的是那 12 行补丁本身**：`disableHardwareAcceleration` 让整窗走软件合成，而
  `in-process-gpu` 把 GPU 服务搬进**同一个进程**——`main.cjs:77-91` 正是把 agent 服务器加载进那个
  进程的地方，于是一次忙的回合会和绘制抢同一个进程。这个客户端还有
  `backdrop-filter: blur(2px)`（`style.css:2285`）、20 个 `transition`、7 个 `animation`、7 个
  `box-shadow`，全是无 GPU 时最贵的东西。
- `%LOCALAPPDATA%\CrashDumps` 里有两份**真的**转储：`electron.exe.11344.dmp`（2026-10-13
  23:41:15）与 `electron.exe.26804.dmp`（23:41:35），旁边有 `%APPDATA%\electron-probe\`
  （23:41:10 创建）——10/13 那天有人在诊断的正是这件事。**这些转储归 02 号读，别在别的票里顺手读。**

**环境坑（会浪费时间的四个）。**

- `ELECTRON_RUN_AS_NODE=1` **在环境里**（本机核实）→ 直接跑 electron 二进制会静默退化成普通 Node，
  外壳只能走 `npm run desktop`（`packages/desktop/scripts/launch.mjs:51` 会删掉这个变量）。
- **`npm start` 起的是服务器，不是应用**（根 `package.json:18` → port 8080、没有窗口）。只有
  `npm run desktop` 开窗口。敲错命令的人看到的是"什么都没发生"。
- **代理这条与上一张图的 Notes 相反**：本机这个 shell 里 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`
  **都是空的**，`curl localhost:8080` 不再被送去代理。上一张图那条坑可以不再当承重事实引用。
- ~~`npm run desktop:screenshot` 在本机必崩（GPU 进程），出图走
  `.scratch/window-rework/research/shots.ts` 那套（bootServer + 本机 Chromium）。~~ **已过期（03 号实测，
  2026-10-16）**：这条说的时候那 12 行开关还没加。03 号在**删开关之前与之后**各跑一次
  `npm run desktop:screenshot`，两次都退出码 0、都写出 1280×820 的整窗截图；所以本机现在出图直接走
  这条命令。`shots.ts` 那套仍然可用（它不依赖外壳）。
- `smoke-api.ts` 与其他 smoke 不同：**它要一台已在跑的服务器**（默认 `127.0.0.1:8080`），空跑会在
  WebSocket 连接处报 "the mux connection failed"——那是没起服务器，不是回归。

**2026-10-16 用户答复（动手前不必再问）。**

- **外壳崩溃的根因已经诊断过一轮，而且规避补丁就在工作区里（未提交）。** 用户给的排查记录：这台机器
  上**所有走 Chromium 沙箱的子进程（GPU、网络服务）启动即访问违例**（`exit_code=-1073741819` /
  0xC0000005），GPU 进程连崩约 10 次后 `FATAL: gpu_data_manager_impl_private.cc: GPU process isn't
  usable. Goodbye.` 整个浏览器进程退出；`loadURL()` 于是抛 `ERR_FAILED (-2)`，而**同一个 URL curl 是
  200**。伴生日志：`GPUPersistentCache\DawnGraphiteCache\...` 共享冲突（0x20）。**底层原因没定位**
  （怀疑杀毒软件向子进程注入）。三条已验证的坑：① **仅 `disableHardwareAcceleration()` 不够**——关掉
  加速后 Chromium 照样拉起独立的 GPU/网络子进程，照样崩，所以真正起作用的是 `no-sandbox`；
  ② `electron.exe --disable-gpu .` 这种把开关放在 app 路径**之后**的写法不生效；
  ③ 环境里的 `ELECTRON_RUN_AS_NODE` 会让直接调用退化成纯 Node（`launch.mjs` 已处理）。
  用户明确：该窗口只加载本机 `127.0.0.1`、不加载任意外部网页，所以禁沙箱的攻击面有边界。
- **"整体字号"指的是正文之外**——左栏会话区、顶部这些字。用户把滑杆 +2 之后仍觉得小，正是因为那个
  滑杆**碰不到**这些地方（只写 `--dsw-fs-body`，而左栏走 meta/caption、顶部走 title）。所以 07 号改的
  不是数值，是**轴**。
- **设置页**：确认照参考实现钉形状（800 × `min(800px, 100vh − 48px)`，不随内容变），并**把横向页签换
  成左侧导航栏**（06 号）。
- **工作区**：用户纠正了我的"两态开关"建议——要的是**分页 + 表头收起**：一个工作区**默认只显示 5 条**
  最近的会话，那 5 条**底部有一个「展开其余会话」**，点一次再展开 5 条，**直到全部展开**；**点工作区
  那一栏则收起全部、只剩表头**。用户说"你不清楚的话可以做个原型"，所以 09 号是 `prototype`。
- **切换会话**：用户报的是「**要等一下才有反应，像是先发了请求**」——正是 `await api.read()` 在任何 DOM
  动作之前、且全程没有加载指示的那一段（不是闪烁）。用户补了一句"其他情况可能也存在"，所以桌面端的
  "卡"按**多因**处理，不只归给 H6。
- **其余按建议**：外壳进本图（一张图，不拆）；设置页固定大小取"固定上限、小窗自适应"。
- **「对话 / 分支」入口：不建那两个页签，但要把「当前分支」做成永远可见**（08 号）。用户当场澄清了那
  句"就按原来的吧"：**13 号"拆掉两个页签"的那一半维持**，被推翻的是 **09 号**"只有一条走法时整块收
  掉"——单走法的会话里那块东西必须看得见，因为"看不见"正是用户报的病。

## Decisions so far

<!-- 关掉的票依次列在这里：一行要点 + 指向该票的链接 -->

- [01 外壳的失败面必须看得见](issues/01-shell-observability.md)：新增
  `packages/desktop/observability.cjs`（与 `shutdown.cjs` 同一条理由：冒烟要用假对象驱动真处理器），
  接 `child-process-gone` / `render-process-gone` / `uncaughtException` / `unhandledRejection`，
  `bootServer` 挂上一只 20 s 看门狗，`loadURL` 进 try/catch。**④ 那条没验过的路当场验了**：`data:`
  说明页在渲染进程死后由**换上的新渲染进程**照画（本机 `forcefullyCrashRenderer()` 实测），所以页面是
  首选面，`showErrorBox` 只做兜底——它会阻塞到有人点掉。顺带修掉一个真洞：`data:` 页不触发
  `ready-to-show`，原来的失败窗口**从来没显示过**。**策略（等多久、重试、换端口）按票面没动**，仍是
  下面"引导挂起"那条雾；20 s 那只预算只是为了"挂起 ≠ 什么都没发生"。**语言**：诊断行英文、窗口文案
  中文（外壳是 AGENTS.md 那条诊断中文规则里的既定例外，已记进 `docs/architecture.md`）。
- [02 最小开关组合](issues/02-minimal-switch-set.md)：结论在
  [`research/minimal-switch-set.md`](research/minimal-switch-set.md)。**本机今天那 12 行一行都不起
  作用**——GPU 进程**从未被观察到活着**（进程表采样只有 browser/renderer/utility；九项能力全
  `disabled_software`；WebGL 是 WARP），12 组配置含完全裸跑**全部产出窗口与完整页面、0 次崩溃**，
  所以"最小组合"是**空集**（其中 2 组的测量回合没收场，那是量具自己的 bug，不是窗口）。**但 10/13
  那次崩溃是真的，而且转储读出了名字**：`0x80000003`（FATAL 断点）打在 `electron.exe` 自己里，栈上
  逐字是 `gpu_data_manager_impl_private.cc:417: GPU process isn't usable. Goodbye.`；**退出码只读到
  `-1073741` + 一个非可打印字节，完整的 `-1073741819` 不在转储里**（那是与用户记录的跨来源拼接）。
  被注入的第三方代码是 **腾讯 WorkBuddy 的沙箱产品 `tsbx.dll`（`sandbox\5.7.10`）**，而它
  **10/15 08:13 升级到 5.8.2，5.7.10 已消失**——"升级修好了它"是时间线推断，不是因果证明（GPU 子进程
  自己的转储不在手上，也没做栈回溯）。**给 03 号的形状**：删三条开关与 `disableHardwareAcceleration()`、
  删那段"这台机器"的注释、**保留 `webPreferences.sandbox: true`**（开关一删它就是唯一还在表达沙箱
  意图的地方）、ADR 写**历史 + 恢复路径**，别把开关留成幽灵配置。**04/05 号的交接**：量具留了真窗口的
  帧时间与输入延迟，但**没有**真实流式回合、也**没有**硬件合成的对照（本机做不到）；那唯一一次
  SwiftShader 运行（16.6 ms ≈ 60 Hz）量的是 vsync 有无限住，**别当成"软件渲染慢 4 倍"**；`web_fetch`
  在本 session 解析不了域名，所以**一手文档没读成正文**，03 号写 ADR 时要补（03 号补的是一条诚实的
  限度声明：仍没读成正文，见 ADR-0004 的「证据的限度」；这一段是 02 号当时的快照）。
- [03 落地最小开关组合](issues/03-land-the-switches.md)：按 02 的形状落地——四条开关与那段"这台机器"
  的注释**删除**（`main.cjs` 里 `lifecycle` 与 `packageRoot` 的文档注释之间现在是空的），
  `webPreferences.sandbox: true` **保留、不加注解**（开关一删，那个语义矛盾就不存在了，"死配置"这个
  描述随之失效；删它等于顺手关掉渲染进程的沙箱，没人要求过）。理由、被否决的更便宜方案、没被推翻的
  边界与**恢复路径**写进 **[ADR-0004](../../docs/adr/0004-shell-sandbox-switches-removed.md)**——
  票面要的"两样记录"里，第二样落地成仓库正式 ADR，第一样（"12 行停在未提交状态"）由"删掉"解决，
  因为一组已验证有效的规避留在工作区本身就是 bug。**这次提交里看不到 `main.cjs`，那不是漏做**：
  那 12 行从未被提交（`git log -S no-sandbox -- packages/desktop/main.cjs` 为空），所以删除它们让
  工作区回到 `HEAD` 字节、**不产生 diff**，证据只能是写下来的命令与结果。**本轮当面验了生产启动
  路径**：`npm run desktop:screenshot` 在删之前与删之后**都**退出码 0、都写出 1280×820 的整窗截图
  （截图没提交，`ui.png` 已还原）。
  `npm run check` 退出 0，`smoke-desktop-close` / `smoke-desktop-observability` 全 ok；
  `smoke:boot` 仍红且逐字不变（那是 10 号票）。`observability.cjs` 里那句拿 `no-sandbox` 举例的注释
  一并改掉——它引用的两行已经不在了。**一手文档这一轮仍没读成正文**（`getaddrinfo ENOTFOUND`），
  所以 ADR 里的开关语义全部落在本机实测上，这一点在 ADR 的「证据的限度」里明说。
- [04 修好卡顿量具](issues/04-jank-harness.md)：量具的病因不是"缺一个 `contains`"，而是**同一个 shim 被
  两份代码各抄了一遍**——`smoke-sidebar.ts` 那份补了 `contains`，`jank-harness.ts` 那份没补，于是
  `482673a` 之后量具静默废掉、H6 之后的结论全是读代码读出来的。修法是**一份 shim**
  （`research/dom-shim.ts`，按今天产品代码的 DOM 面补齐，缺成员默认**当场抛**）＋把量具的折叠顺序
  对齐今天的 `apply()`/`render()`（老副本每帧多画一遍状态行、左栏签名抄的是旧公式）。顺带修掉两个
  只有全量跑才现形的坑：`classList.add/remove` 老 shim 改的是副本（于是"加 `dragging`"这类行为在量具
  里从没生效过）、以及 shim 把所有创建过的节点钉在堆上（全量跑 OOM，4 GB）。
  **新场景 `switchScenario` 把「切换会话」拆开了**（500 条×4000 字，中位数）：`read` 8.8 ms、
  `refresh` 0.29 ms、`reduce` 2.7 ms、`paint` 168 ms、`sync` 194 ms；**那第二笔没有效果的往返只占 1%
  上下，顿的是首次绘制，而绘制里几乎全是每条消息的 `renderMarkdown`**（`其中md` 166 ms；口径由
  `research/markdown-attribution-probe.ts` 独立核对：整棵 188 ms / 单量 217 ms / 单字残值 4 ms）。
  **05 号的着力点因此是"快照重放时不要逐条重画 Markdown"，不是"删掉第二次往返"。** 量具全程零产品
  代码改动；`npm run check` 与五个 smoke 全绿。

## Not yet specified
- **"卡"在真窗口里的真实帧时间**：今天所有性能数字都是 `FakeNode` shim 量出来的**比值**，没有一帧
  真实帧时间，`03-jank-profile.md` 自己也把 layout/paint/reflow、GC、Electron 开销列成"没能测到"。
  04 号修好量具之后，要不要顺手给**外壳**也装一把尺子（真实 FPS / 长任务观测），还是继续靠 shim 比值。
- **单实例**：现在没有任何 `requestSingleInstanceLock`，两次启动 = 两个进程内服务器、共写同一批会话
  文件（`main.cjs:64-69` 的默认工作区）。要不要加锁，还是把"开两个窗口"当成合法用法。
- **引导挂起**（而不是拒绝）：`bootServer` 卡住的话，现在没有超时、没有重试、没有日志，就是永远没有
  窗口。01 号会把失败面做可见，但超时/重试的**策略**（等多久、重试几次、要不要换端口重来）还没定。
- **`transcript.ts:127` 每帧写 `scrollTop = scrollHeight`** 带来的强制布局：老剖析里被标过、从来没
  量过。05 号动的是切换会话那条路，逐 token 的这条要不要一起收，等 04 号的量具能给数再判。
- **那 301 处 px 间距值要不要跟着字号族一起动**：07 号只把**字号**变成派生族，间距仍是 36 个散值。
  真正的"整窗放大"要连间距一起骑轴，那是另一件事，等 07 号落地后按读感再判。
- **"文档声称绿"的地方要不要收成一处可执行清单**：README:184 今天为假这件事说明"文档里的绿"和
  "跑一遍的绿"会漂移。10 号修完之后要不要把这类陈述改成指向一个真的会跑的清单。

## Out of scope

- **插件栏、标准模式、会话框左下角的 `+`、「完全权限」这一档**：前两个 effort 的 Out of scope 继续
  有效（`AGENTS.md` 的「规则」把插件明文排除）。
- **参考实现的「轨迹」那一栏本身**：我们借的是页签的位置，不是它的内容。
- **把五档字号等比抬一档**：17 号已经称过一次（用户对照原型后选了维持现状），本图 07 号改的是
  **机制**——让一个滑杆驱动派生族并把量程放开——不是把五个档位一起挪。
- **把整个窗口按比例缩放**（`zoomFactor` 那一类）：07 号把量程放开之后先看用户的实际读感，够不够用
  再说；在此之前不做"整窗缩放"这个新机制。
