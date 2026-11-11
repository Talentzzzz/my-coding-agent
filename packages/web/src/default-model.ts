import type { ModelInput, ModelOption } from "@my-agent/core/protocol";

/**
 * 本机尚未导入任何模型时，窗口种下的那一行。
 *
 * 全新安装过去会停在「还没有配置模型」的提示和一个让每个请求都失败的占位符上 —— 这对本机的描述
 * 是准确的，但作为第一屏很糟糕：应用做任何事之前唯一需要的东西，恰恰是它不肯替你写下的东西。
 * 所以客户端内置一行初始数据 —— 名称、端点、厂商自己的数字 —— 由第一个发现列表为空的窗口通过
 * 普通的模型端点存进去。
 *
 * 它刻意不是一个目录：只有一行，用户可以编辑它的每个字段，删除它是最终决定（见
 * {@link defaultModelDue}）。端点用 DeepSeek 的 Anthropic 兼容地址，因为该行所名的模型说的正是
 * 这个应用唯一的传输协议。这些数字是这一行的事实而非猜测，压缩阈值和输出上限读的就是它们。
 *
 * `apiKey` 有意缺席，两重含义都在：应用绝不内置凭据，而缺失的字段正是端点读取为"保留已存值"的
 * 信号。这一行因此在用户粘贴密钥之前一直没有密钥 —— 这是唯一只有用户本人能做的事。
 *
 * `name` 复述了 `packages/core/src/models.ts` 里的 `DEFAULT_MODEL_NAME`，服务端的同一决定住在
 * 那里：那个模块跑在 Node 上，而这个文件要打包进浏览器，所以字面量写了两遍。两者必须一致 ——
 * 这里的名字是这一行种下时的名字，那里的名字是装配时打开会话用的名字。
 */
export const DEFAULT_MODEL: ModelInput = {
	name: "deepseek-flash",
	baseUrl: "https://api.deepseek.com/anthropic",
	id: "deepseek-flash",
	contextWindow: 1_000_000,
	maxTokens: 384_000,
};

/**
 * 会话和用户都没说话时，窗口起始的思考档位。
 *
 * 默认档位是客户端的事实，不是模型行的：行只说哪个端点应答，而 composer 才是展示档位的地方 ——
 * 所以这个值住在 composer 所在处，随每条消息一起发送。`high` 与上面种下的那一行匹配：一个被要求
 * 思考的推理模型，正是初次打开这个应用的人想要的东西。
 */
export const DEFAULT_THINKING_LEVEL = "high";

/**
 * 内置行是否该种下：什么都没导入，且之前的窗口从未种过。
 *
 * `seeded` 是持久化的标记，不是"那一行在不在"的副本 —— 用户随时可以删除种下的行，删掉的行必须
 * 保持已删除。这就是标记放在设置文件里而不是浏览器自带存储里的原因：桌面外壳每次启动都换一个
 * 端口，origin 作用域的存储到下次启动就会忘记这个决定。
 */
export function defaultModelDue(models: readonly ModelOption[], seeded: boolean): boolean {
	return models.length === 0 && !seeded;
}

/** 窗口对内置行能做什么，作为参数传入以保持决策可测试。 */
export interface DefaultModelHost {
	/** 已导入的行，按窗口最后一次读取时的样子。 */
	models: readonly ModelOption[];
	/** 之前的窗口是否已经种过那一行 —— 设置文件自己的标记。 */
	seeded: boolean;
	/** 整体保存列表；以服务端保留下来的行结算。 */
	save(rows: ModelInput[]): Promise<ModelOption[]>;
	/** 记录那一行已种下，让之后的删除成为一个决定而不是一个缺口。 */
	markSeeded(): Promise<void>;
}

/**
 * 在该种下时种下 {@link DEFAULT_MODEL}，并返回窗口此刻应显示的行。
 *
 * 返回 `undefined` 表示什么都没种 —— 行已导入过，或者导入过一次后又被用户删掉了。先存行再写
 * 标记：保存失败必须让标记保持未设，下次启动才会重试；若先写标记，就会留下一个既没有行、又永远
 * 不再种行的机器。
 */
export async function seedDefaultModel(host: DefaultModelHost): Promise<ModelOption[] | undefined> {
	if (!defaultModelDue(host.models, host.seeded)) return undefined;
	const models = await host.save([DEFAULT_MODEL]);
	await host.markSeeded();
	return models;
}
