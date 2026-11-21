# 08 - retry 的归属：编排层自己持有

Type: grilling
Status: resolved

## Question

`RetrySettings`（供应商调用失败的重试策略）不归工具、不归会话、不归模型、不归 UI——五个既有
关注点之外还有一个簇。归谁？

## Answer

**归编排层自己**（用户委托推荐）：引擎的设置归引擎的持有者。

- `RetrySettings` 迁往新文件 `engine.json`，由 `Agent` 编排层直接持有（构造时接 home，读改
  走与各持有者同形的每次现读）。
- 理由：retry 的唯一消费者就是编排层自己的重试泵；「设置归自己的关注点」这条原则的完整版
  自然推出引擎簇归引擎。
- 若未来出现引擎级的新设置（如压缩阈值），落同一个文件。

细节见 [spec.md](../spec.md) §3、§5。
