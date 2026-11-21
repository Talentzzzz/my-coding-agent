import { defineConfig, type Plugin } from "vite";

// 客户端从 `@my-agent/case/protocol` 网关拿域词汇：类型为主，值只有四个纯常量/纯函数
// （`addUsage` / `EMPTY_USAGE` / `compactionSummaryOf` / `APPROVAL_TOOLS`）。domain 是 Node 进程
// 的本体，barrel 的静态 import 把工具、账本与模型文件一并拉进模块图，其中一些以**具名**形式
// import node:* 内建；vite 给浏览器的 node 内建替身不带具名导出，rollup 的绑定检查让构建（与
// dev 的模块加载）直接失败。这里给 node:* 一份带具名导出的空实现替身：树摇后真正留在 bundle
// 里的三个纯模块（snapshot / messages / agent 根 types 的常量）不引用任何 node 调用，替身从不
// 执行——node 代码照旧进不了浏览器 bundle。domain 新增内建 import 时把名字补进下表即可，缺了
// 构建会以缺名导出错误明说。
const NODE_STUB_EXPORTS: Record<string, string[]> = {
	"node:child_process": ["spawn"],
	"node:crypto": ["randomUUID"],
	"node:fs": [
		"appendFileSync",
		"closeSync",
		"createReadStream",
		"existsSync",
		"mkdirSync",
		"openSync",
		"readFileSync",
		"readSync",
		"readdirSync",
		"renameSync",
		"rmSync",
		"rmdirSync",
		"statSync",
		"writeFileSync",
	],
	"node:fs/promises": ["glob", "mkdir", "readFile", "readdir", "rm", "stat", "writeFile"],
	"node:os": ["homedir", "platform"],
	"node:path": ["basename", "dirname", "isAbsolute", "join", "normalize", "relative", "resolve", "sep"],
	"node:readline": ["createInterface"],
	"node:string_decoder": ["StringDecoder"],
};

function nodeBuiltinStub(): Plugin {
	return {
		name: "node-builtin-stub",
		enforce: "pre",
		resolveId(source) {
			return source in NODE_STUB_EXPORTS ? `\0node-stub:${source}` : null;
		},
		load(id) {
			if (!id.startsWith("\0node-stub:")) return null;
			const names = NODE_STUB_EXPORTS[id.slice("\0node-stub:".length)] ?? [];
			return names.map((name) => `export const ${name} = () => 0;`).join("\n");
		},
	};
}

export default defineConfig({
	plugins: [nodeBuiltinStub()],
	build: {
		outDir: "dist",
		emptyOutDir: true,
		target: "es2023",
		rollupOptions: {
			treeshake: {
				// barrel 的静态 import 按 rollup 默认「被 import 即有副作用」会把 domain 的工具、账本、
				// 模型与供应商 SDK 整包拉进浏览器 bundle（334KB 里的死代码）。domain/case 的模块只按
				// 真正被引用的导出纳入（web 的四个值各是纯常量/纯函数，落在三个纯模块里），其余从
				// bundle 掉落；web 自身与第三方依赖维持默认语义。
				moduleSideEffects: (id: string) => {
					const normalized = id.replaceAll("\\", "/");
					return !(normalized.includes("/packages/domain/") || normalized.includes("/packages/case/"));
				},
			},
		},
	},
	server: {
		port: 5173,
	},
});
