// 会话应用层 @my-agent/case 的公开面（分层重构步 3 自 `server/src/hub.ts` 原样迁入，spec §7 步 3）：
// SessionHub 与它自带的订阅、行与 birth 辅助词汇。协议信封与客户端/触发面共用的域词汇网关走
// `./protocol` 子路径——trigger 对 domain 盲，域词汇一律从那里到手。
export {
	SessionHub,
	workDirAbsPathForCreate,
	workDirAbsPathOrThrow,
	samePath,
	type HubOptions,
	type SessionSubscription,
	type GlobalSubscription,
	type SubscriptionSink,
} from "./hub.ts";
