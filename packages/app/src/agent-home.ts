// AGENT_HOME 的解析（分层重构 spec §2.3 / §5.1：自 domain 迁入组合根，2026-11-21）。
//
// domain 从此不知道「真实的 home」——存储走注入的端口，home → infra 实现的翻译只发生在这里
// （`start` 的翻译表）。`APP_NAME` 跟随 `AGENT_HOME` 迁入；domain 里曾经的两个消费者（fill 的
// 身份措辞）随实现下沉 infra，本常量留给需要自称的宿主。
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

/**
 * 存放会话、设置与已存凭据的目录。
 *
 * `MY_AGENT_HOME` 显式指名时用它（smoke 的隔离法：env 先设、动态 import 后行——本常量在 import 时
 * 一次性解析），否则是用户 home 下的 `.my-agent`。
 */
export const AGENT_HOME = resolvePath(process.env.MY_AGENT_HOME ?? join(homedir(), ".my-agent"));

/** 本应用在自己写出的文件与消息里如何自称。 */
export const APP_NAME = "my-agent";
