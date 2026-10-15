# 6 设置面板：钉住形状，并把横向页签换成左侧导航栏

Type: task
Status: open
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
