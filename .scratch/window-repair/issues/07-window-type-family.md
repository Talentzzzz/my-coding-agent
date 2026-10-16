# 7 字号：让设置驱动**整窗**的派生族，并把量程放开到 22

Type: task
Status: resolved
Blocked by:

## Question

**这是一条重开，按本仓库记重开的先例（`client-server-refactor/issues/12-*.md`）写明取代了谁：**
`window-polish` **04 号**拍的是"设置里的『字号』只驱动 body 一档、其余四档固定"，**17 号**又拍了一次
"五档维持现状"（用户看完三方案原型后收回了"字体再大一点"）。用户今天重开它，理由**不是审美，是机制**：

- 那个滑杆只写 `--dsw-fs-body`（`state.ts:263`），而全仓 **59 条 `font-size` 规则里只有 4 条**引用它
  （`.welcome h2`、`.turn-body`、`.reasoning-body`、`.composer textarea`）；
- 量程 `FONT_SIZE_RANGE = { min: 12, max: 20 }`（`config.ts:72`，服务端 `:251-252` 也夹到 20）——
  **用户说的"+2"落在 20 上恰好就是上限**，所以"还是小"里有一部分是"推不动了"；
- `body` 自己的基准字号是 **title 档**（`style.css:38` `font-size: var(--dsw-fs-title)`），所以没写字号
  的元素一律 14px，**根本不看那个滑杆**。

**用户明确说了"整体字号"指的是正文之外**——左栏会话区、顶部这些字。而左栏走 meta/caption、顶部走
title，全在那 4 条之外。所以"+2 之后还是小"是**必然**的，不是错觉。

参考实现的做法是"一个基准 + 一个偏移量派生出整族"（`ui-theme/src/styles/gradient-shadow-text.css:57`）：

    --dsh-content-font-delta: calc(var(--dsh-content-font-size, 14px) - 14px);

每个字号写成 `calc(<字面量>px + var(--dsh-content-font-delta))`；它的量程是 **10–22**、默认 14
（`ui-theme/src/theme-settings.ts:24-30`）。

要拍的：

1. 把五档从**九个独立字面量**（`tokens.css:80-92`）改成**一个基准 + 派生**，让那个滑杆驱动**整窗**：
   正文、标题、代码、表格、**左栏**、**顶部**、状态行一起动；
2. 量程放开到 **10–22**——`config.ts` 的 `FONT_SIZE_RANGE`、**滑杆的 `min`/`max`**（`settings.ts:242`）
   两处都要改，**服务端 clamp 是权威**；
3. 那 6 处 `em` 字号（`.turn-body h1/h2/h3/code/table`、`.reasoning-body code`）本来就骑父级，派生族
   落地后要确认它们仍按预期缩放；
4. **间距不动**——那 301 处 px 间距是另一条轴（map 的雾里记着），这票只动字号；
5. `README.md` 里 `fontSize` 的默认值与量程要跟着改（`AGENTS.md` 的术语表若提到档位也要核对）。

**诚实限度：** 这票改的是**机制**，不是"把五档一起挪"（那是 17 号称过、被否掉的事，本图 Out of scope
里写着）。落地后**请用户把滑杆拉到底试一次**——如果 22 还不够，那才是真的档位问题，另开票。

## Comments

### 落地（2026-10-16）

按参考实现的形状落了"一个基准 + 一个偏移量派生整族"：

- `tokens.css`：五个档位不再是九个独立字面量。`--dsw-fs-base`（默认 15px，滑杆的运行时落点）+
  `--dsw-fs-delta: calc(var(--dsw-fs-base) - 15px)`；title/meta/caption/code 四档写成
  `calc(<字面量>px + var(--dsw-fs-delta))`，body 即 base 本身。**行高一并派生**（各自保持原比率：
  title 20/14、meta 18/13、caption 16/12、body 25/15、code 20/13）——行高是字号自己的那半张决定，
  不是第 4 条说的间距轴；固定行高配派生字号在两端都会挤。
- `state.ts`：`applyAppearance` 落点从 `--dsw-fs-body` 改为 `--dsw-fs-base`，一处改动驱动整窗。
- 量程：`config.ts` 的 `FONT_SIZE_RANGE` 改 10–22（服务端 clamp 随常量走，权威不变），滑杆
  `min`/`max` 同步 10/22；`clampFontSize` 实测两端含、越界夹、非数回默认 15。
- `em` 六处核对过：`.turn-body`/`.reasoning-body` 骑 `--dsw-fs-body`，h1/h2/h3/code/table 的 em
  随父级同比缩放，落地前后行为一致。
- 文档：README 的 `appearance` 段补了 fontSize 的语义（整窗基准、10–22、默认 15）；AGENTS.md 术语表
  不涉档位，无需动。

验证：`npm run check` 绿（含 token 审计 133 定义 / 107 引用），`smoke:boot` 绿。

### 留给用户

**把滑杆拉到底试一次。** 这票改的是机制不是"五档一起挪"；如果 22 还不够，那才是档位问题，另开票。
