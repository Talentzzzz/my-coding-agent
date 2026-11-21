# 06 - 本次 effort 的范围：仅设置拆分

Type: grilling
Status: resolved

## Question

这张 map 的目的地是只覆盖设置拆分这一件事，还是把整个 manager 层重构（ToolManager、
SessionManager 的后续改造）都圈进来？

## Answer

**只圈设置拆分**（用户采纳推荐）：目的地是「设置归属重构的 spec」。其他 manager 的重构另立
map——混在一起会让每个 ticket 背着两张地图。

注意边界：本 effort 里 ToolManager / SessionManager **获得**设置持有能力（文件、公开面、
迁移），这属于拆分本身；但它们自身的其他形态改造（实例表、持有簿记等）不动。

细节见 [spec.md](../spec.md) §2。
