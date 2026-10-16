# 6 设置面板：钉住形状，并把横向页签换成左侧导航栏

Type: task
Status: resolved
Blocked by:

## Question

用户给的参考截图在 `reference/01-dsh-settings.png`；参考实现源码在工作区
`deepseek-harness-master/packages/client/ui-settings-general/src/client/SettingsRoot.module.css`。

**今天的毛病**（`style.css:2288-2299`）：宽度其实**已经**是固定的 720px，缺的是**高度**——

    .settings { width: min(720px, 100%); max-height: min(760px, 100%); min-height: 0; }

**一个 `height` 都没有**，只有上限，所以面板是**内容撑开**的：点一次「外观」（两个字段）和点一次
「模型」（一屏卡片），面板会在指针底下长高或缩短。这就是「大小不合适」。

参考实现的做法与**它自己写下的理由**（`SettingsRoot.module.css:78-103`）：

    width: 800px;
    height: min(800px, calc(100vh - 2 * max(24px, var(--dsh-frame-overlay-top, 24px))));
    max-width: calc(100vw - 48px);
    /* "One height for every section, taken from the viewport rather than the content, because a
       content-sized panel would resize under the pointer on every nav click." */

而且它是**两栏**：`.nav { width: 188px }` + `.content`，`.options` 与 `.navList` **各自独立滚动**。
我们今天是**一条横向页签**（`.settings-tabs`，外观 / 模型 / 默认）压在一个单栏 body 上，头、页签、脚注
都是固定 chrome，只有 `.settings-body` 滚动。

**用户已确认：照参考实现钉形状，并换成左侧导航栏。** 所以要落的：

1. **钉住高度**（视口派生，**不随内容变**），宽 800、`max-width: calc(100vw − 48px)`，小窗自适应；
2. **横向页签 → 左侧导航栏**（188px），导航栏与内容列**各自滚动**；
3. 尺寸值进 `tokens.css`——`style.css` 里的字面 px 是约定禁止的（map 的 Notes），新增名字沿用
   `--dsw-*`，`npm run check` 的 token 审计会拒绝被引用却没定义的名字；
4. 面板自己的字号**今天一律不吃 `--dsw-fs-body`**（头部 title、页签 meta、其余 caption）——**07 号会
   改字号轴**，所以别把面板钉死在一个会变的档上，两票要按 07 号的结论对齐；
5. 覆盖面：`.settings-overlay` 的 `backdrop-filter: blur(2px)`（`style.css:2285`）在**无 GPU 时最贵**
   ——03 号如果没把硬件加速拿回来，这里要顺手量一次值不值得留。

出图走 `.scratch/window-rework/research/shots.ts` 那套（`desktop:screenshot` 在本机必崩）。

## Answer

五条全部落地，`npm run check` 退出码 0（token 审计 **131 defined / 105 referenced**，恰好是新增的
四个），出图见本目录 `settings-nav-*.png`（三页 + 小窗）与 `session-settings-after.png`。

### 1. 形状（tokens.css + style.css）

四个尺寸进了 `tokens.css`，紧跟在 content width 轴之后，注释写明"高度取自视口而不是内容"的同一句
理由：`--dsw-settings-width: 800px`、`--dsw-settings-height: 800px`、`--dsw-settings-nav-width: 188px`、
`--dsw-settings-air: 24px`。air 是**一个**值管两处：overlay 的 padding 用它、面板的高减两倍它，两个
数不可能漂移。

`.settings` **不再直接携带任何面板的形状**——它是两个面板共用的表面（应用级和会话级都挂它），直接改
它会把会话面板一并改坏。现在 `.settings` 只剩表面（边框、圆角、底色、阴影、裁切），形状各说各的：
`.session-settings` 保持原来的内容撑开（`width: min(720px, 100%); max-height: min(760px, 100%)`，
注释说明为什么它不钉——composer 后面开一眼的短面板，钉满高就是大半屏空）；新的 `.app-settings` 钉
视口派生的形状：`width: min(var(--dsw-settings-width), 100%)`、
`height: min(var(--dsw-settings-height), calc(100vh − 2 * var(--dsw-settings-air)))`、
`max-width: calc(100vw − 2 * var(--dsw-settings-air))`。参考实现的 `max(24px, --dsh-frame-overlay-top)`
那一层这里不需要：我们没有一个 published 的 frame overlay inset，overlay 本来就是 `inset: 0` 盖满
视口、自己带 24px padding。

**验证**：出图里「外观」（两个字段）与「模型」（一屏卡片）**逐像素等高**；900×520 的小窗里面板收进
视口（`settings-nav-small.png`），导航栏与内容列完好。

### 2. 左侧导航栏（settings.ts + style.css）

`SettingsPanel` 的 DOM 重排：面板是两栏——`.settings-nav`（188px：标题「设置」+ 三个导航项，列表
`overflow-y: auto` 自己滚）+ `.settings-content`（固定 head、滚动的 body、脚注）。横向页签
`.settings-tabs` / `.settings-tab` 整块删除。head 里只剩关闭按钮（`justify-content` 覆写为
flex-end，注释说明为什么：标题搬去了 nav 列，space-between 没有可配对的东西了）；`.settings-head`
与 `.settings-head h2` 原样保留，会话面板还在用。导航项的 aria 从 `aria-selected`（需要 tablist
role 才合法）换成 `aria-current`。导航列表加进了滚动条 token 的四个选择器组。

### 3. 字号轴（第 4 条）

面板的字号维持原分档没动：nav 标题吃 `fs-title`、导航项吃 `fs-meta`、其余 caption——**没有一处吃
`--dsw-fs-body`**，与票面要求一致，07 号改字号轴时这批档位不会被连坐。

### 4. backdrop-filter（第 5 条）：**摘掉**

03 号的结论是 GPU **没有**拿回来（02 号实测：GPU 进程在这台机器上从未被观察到活着，ADR-0004），所以
按票面量了一次。仪器走了五条路，前四条作废的原因记录在
`.scratch/window-repair/research/overlay-blur.ts` 的头注释里（headless rAF 不产帧、有头 rAF 量的是
调度、HeadlessExperimental 域已被新版 Chromium 移除、tracing 的事件名已换且 headless 合帧不可分）。
最终仪器：**canvas 2D `ctx.filter` 微基准**——headless Chromium 同为软件光栅，对同尺寸画布量
`blur(2px)` 的 drawImage（每帧 `getImageData` 强制冲刷，否则量到的是入队），这正是 backdrop-filter
在软件路径下执行的同一个 Skia 原语：

- 1280×860（本机窗口实测大小）：无 filter 全视口重画 8.2ms/帧，blur(2px) 10.8ms/帧——**blur 自身
  ~2.6ms/帧**；
- 1920×1080：15.7 → 18.0ms——**~2.3ms/帧**。

也就是说：面板开着、背后有内容动（流式正是这样）的时候，每帧多付 ~2.5ms 纯 CPU，而全视口软件重画
本身已经要 8–15ms；换来的效果压在 32% 黑色 dim 底下**不可见**。结论：摘掉 `backdrop-filter`，留
`rgb(0 0 0 / 32%)` 的 dim，理由写成注释留在 `.settings-overlay` 的规则里。参考实现留 blur 是因为
它跑在 GPU 上；我们不是。

### 顺带

- `.settings-note` / `.settings-body` 等共享件原样未动；jank harness（`window-rework`）复刻的是旧
  DOM 形状，属研究装置不进构建图，未同步。
- `npm run build:web` 通过；`scripts/smoke-sidebar.ts` 绿（web 侧唯一有 shim 的 smoke）；设置面板
  没有 smoke 覆盖，验证落在出图与当面核对上。`smoke:boot` 维持已知红（10 号票），与本票无关。
- 出图脚本归档在 `.scratch/window-repair/research/settings-shots.ts`，量 blur 的在
  `overlay-blur.ts`，可重跑复现。
