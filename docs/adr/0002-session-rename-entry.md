# 0002：会话标题改为「可写」——一条 `rename` entry，header 不动

- 状态：**已接受**（[11 号](../../.scratch/window-polish/issues/11-session-rename.md)拍板，[14 号](../../.scratch/window-polish/issues/14-session-rename-server.md)落地）
- 取代或失效：无正式 ADR；被取代的是「标题永远派生、不可写」这一隐含决定（`titleOfBranch` / `deriveTitle` 的独占地位，见下文*被取代的是什么*）
- 取代者：尚无。这份 ADR 本身若被推翻，**不要**悄悄改它——新开一条 ADR，并说明反转的代价

## 为什么会有这份 ADR

会话的标题此前没有存储位置：`SessionHeader` 只有 `{type, version, id, timestamp, cwd, parentSession}`，
标题永远由「分支首条 user 消息」派生（文件扫描走 `titleOfBranch`，活会话走 `deriveTitle`）。11 号的
用户反馈是「user 也可以改名」——一个派生出来的名字没有地方接受用户写进去的名字，所以「改名能不能
持久」不是客户端问题，是**会话格式**问题。格式改动按 `AGENTS.md` 的规则要一条 ADR。

## 决定

**改名是一条 `{ type: "rename", id, parentId, timestamp, title }` entry，追加在会话文件里。**

### 1. header 不动，`version` 维持 3

改名不写进 header。header 是会话的身份与出生地（`id`、`cwd`、`parentSession`），名字不是身份——
它是会话的一件可变更的事实，和「活跃工具集」「leaf 在哪」同类，而那两件事的先例都是**状态 entry**
（`tool_config`、`leaf`）：追加一条记录，读的时候取最后一条赢。

`version` 不动。本格式对未知 entry kind 的既有约定是**原样带过**（`parseJsonlLine` 不过滤、
`getEntries` 不丢弃），所以老构建读到一个带 `rename` 的文件只是忽略它、照旧派生标题——兼容是免费
的，不需要迁移，也不需要第二版本号。

### 2. 读取是会话级，不分支

**文件序里最后一条 `rename` entry 赢，与 leaf 在哪条走法上无关。**

这条和 `tool_config` 的读法（沿 active branch 走、取分支上最后一条）**有意不同**，理由是两者的
主语不同：`tool_config` 是一条**走法**的配置——切到另一条走法，工具集回到那条走法记录的样子；
而左栏一行是一个**会话**，不是一条走法——用户给会话起的名字不会因为切了分支就丢。派生标题自己
也是会话级的（「分支首条 user 消息」在切换分支时会变，但那是派生的事，不是改名的事）。

有 `rename` 用它，没有才派生；两条读取路径（文件扫描与活会话）同改，保证一行在扫描与运行两个
世界里同名。

### 3. `title` 存净名；`（1）` 不存

`rename` entry 的 `title` 是用户敲的名字，服务端写入前用 `shortenTitle`（折叠空白、72 字符截断）
兜底。fork 的「（N）」后缀**不在**存储里：它是派生事实（同一父行下的兄弟序号），由左栏在渲染行时
拼（01 的 ②）。改名改的是净名，后缀自动拼回。

### 4. fork 整份复制时 `rename` entry 随行

`forkFrom(null)` 复制源文件**全部非 header entry**，`rename` entry 是其中之一——所以 fork 出来的
会话落地时名字 = 源名字（含用户改过的名字）。这与今天「派生标题 = 源标题」同构：fork 是把这份记录
接着往下走，名字跟着记录走是同一件事。随后改 fork 的名字不影响源——各自文件里各自的 entry。

## 被取代的是什么

| 原事实 | 本次 |
|---|---|
| 「标题永远从分支首条 user 消息派生，没有存储」（`titleOfBranch` / `deriveTitle` 独占） | **取代**。有 `rename` entry 用它，派生让位为兜底（取不到 rename、或文件里一条消息都没有时的「新会话」占位不变）。 |
| 「`SessionHeader` 是标题的唯一候选存储位置」 | **从未成立**，但 11 号摆事实时列过它：header 保持不动，改名走状态 entry 的老路。 |

## 代价与后果

- **会话格式多一种 entry kind**。所有读 entry 的代码（上下文构建、分支路径、压缩）都必须对它
  无感——它不进模型上下文、不参与 `buildSessionPath` 的对话语义，与 `tool_config` 的待遇相同。
- **`POST /api/sessions/{id}/title` 成为标题的唯一写入口**。客户端的本地改名只是乐观显示，服务端
  的 entry 才是事实；一行被改名的会话在重新打开之后仍然是那个名字。
- 不做「清除改名」：想改回去就再改一次（再追加一条 entry）。append-only 格式不提供删除。
