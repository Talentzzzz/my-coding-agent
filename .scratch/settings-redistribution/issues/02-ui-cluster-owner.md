# 02 - UI 簇的归属：最小的新持有者

Type: grilling
Status: resolved

## Question

`appearance`、`hiddenDirectories`、`directoryNames` 是纯窗口视图偏好，既不关工具也不关会话。
归谁：(a) 宿主侧（server/hub）；(b) core 里一个最小的新持有者；(c) 其他。

## Answer

**(b) 的变体**（用户采纳推荐）：不建一个「大」manager——在设置归属表里承认 UI 簇是一个独立
关注点，落在一个最小的新持有者上，独占自己的文件 `ui.json`。

- 它不是「一个 manager 管了别人的设置」的反例：它只拥有自己的关注点。
- 持有 `appearance`（主题、字号、两个宽度、目录翻页）、`hiddenDirectories`、`directoryNames`。
- 名字暂定 `UiSettingsManager`，实施时可再定；它与其他持有者同形：无状态、每次现读。
- UI 簇的规范化纯函数（`clampFontSize` 等）随类型一起搬进它的文件。

细节见 [spec.md](../spec.md) §3、§5。
