// 一次性 codemod：把「持有类实例但命名不符」的标识符改成「类名首字母小写」。
// 报告模式：node .scratch/rename-codemod.mjs report
// 应用模式：node .scratch/rename-codemod.mjs apply
import * as ts from "typescript";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);

const ROOT = "Z:/my-coding-agent";
const MODE = process.argv[2] ?? "report";

// ---- 目标映射：类名（项目类 + 指定外部类）-> 变量名（类名首字母小写）----
// 注意： FifoQueue / PendingMessageQueue 不在表里——同作用域常有多个同类实例（queue/waiting、
// steeringQueue/followUpQueue），类名派生的名字无法区分它们，语义名优先。
const TARGETS = new Map([
	// project classes
	["SessionHub", "sessionHub"],
	["SessionProjection", "sessionProjection"],
	["MuxServer", "muxServer"],
	["MuxConnection", "muxConnection"],
	["WebSocketConnection", "webSocketConnection"],
	["Router", "router"],
	["SessionManager", "sessionManager"],
	["ToolManager", "toolManager"],
	["SettingManager", "settingManager"],
	["ModelConfigStore", "modelConfigStore"],
	["Agent", "agent"],
	["Model", "model"],
	["Wire", "wire"],
	["SystemController", "systemController"],
	["SessionController", "sessionController"],
	["HttpError", "httpError"],
	["SessionApi", "sessionApi"],
	["ApiError", "apiError"],
	["MuxClient", "muxClient"],
	["Composer", "composer"],
	["Drain", "drain"],
	["OncePerFrame", "oncePerFrame"],
	["SessionRows", "sessionRows"],
	["BranchView", "branchView"],
	["SessionView", "sessionView"],
	["SettingsPanel", "settingsPanel"],
	["Sidebar", "sidebar"],
	["StatusBar", "statusBar"],
	["TranscriptView", "transcriptView"],
	["ContextOverflow", "contextOverflow"],
	["FileSettingsStorage", "fileSettingsStorage"],
	["InMemorySettingsStorage", "inMemorySettingsStorage"],
	["AssistantMessageFrameEncoder", "assistantMessageFrameEncoder"],
	["EventStream", "eventStream"],
	["AssistantMessageEventStream", "assistantMessageEventStream"],
	["UnknownSessionError", "unknownSessionError"],
	["ModelsError", "modelsError"],
	["RetrySleepAbortError", "retrySleepAbortError"],
	["UnsupportedStrictJsonSchemaError", "unsupportedStrictJsonSchemaError"],
	["FakeNode", "fakeNode"],
	["FakeElement", "fakeElement"],
	["FakeHTMLElement", "fakeHTMLElement"],
	// external classes（口径：外部类也改）
	["WebSocket", "webSocket"],
	["BrowserWindow", "browserWindow"],
	["Anthropic", "anthropic"],
	// service/handle 接口（服务形态，不是数据袋）
	["HttpServerHandle", "httpServerHandle"],
	["ChatTransport", "chatTransport"],
	["SessionProjection", "sessionProjection"],
	["ApprovalAnswers", "approvalAnswers"],
	["FrameSink", "frameSink"],
	["ViteInstance", "viteInstance"],
	["ViteMiddleware", "viteMiddleware"],
	["ViteModule", "viteModule"],
]);

// 这些容器里的属性签名是「类别键」而不是实例持有者，不参与重命名。
const SKIP_CONTAINER = new Set(["ModelTypeMap"]);

// 语义名优先的例外（撞名时保留原名）：
// - anthropicMessages：模块级 ChatTransport 实例，与 Model 构造参数 chatTransport 撞名，
//   改名会让参数默认值自引用；
// - coldHub：smoke-projection 的重启 hub，与顶层已改名的 sessionHub 构成嵌套遮蔽。
const SKIP_CURRENT = new Set(["anthropicMessages", "coldHub"]);

// ---- 收集所有源文件 ----
function collectFiles(dir, out) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === ".scratch" || entry.name === "dist" || entry.name === ".git") continue;
			collectFiles(full, out);
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			out.push(full.replace(/\\/g, "/"));
		}
	}
	return out;
}

const fileNames = [
	...collectFiles(path.join(ROOT, "packages"), []),
	...collectFiles(path.join(ROOT, "scripts"), []),
];

const tsconfigPath = ts.findConfigFile(ROOT, ts.sys.fileExists, "tsconfig.json");
const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(tsconfigPath, ts.sys.readFile).config, ts.sys, ROOT);
const compilerOptions = { ...parsed.options, noEmit: true };

// ---- Language service ----
const snapshots = new Map();
for (const f of fileNames) snapshots.set(f, ts.ScriptSnapshot.fromString(fs.readFileSync(f, "utf8")));

const host = {
	getScriptFileNames: () => fileNames,
	getScriptVersion: () => "0",
	getScriptSnapshot: (f) => {
		f = f.replace(/\\/g, "/");
		if (snapshots.has(f)) return snapshots.get(f);
		if (fs.existsSync(f)) return ts.ScriptSnapshot.fromString(fs.readFileSync(f, "utf8"));
		return undefined;
	},
	getCurrentDirectory: () => ROOT,
	getCompilationSettings: () => compilerOptions,
	getDefaultLibFileName: () => path.join(path.dirname(require_.resolve("typescript/lib/typescript.js")), ts.getDefaultLibFileName(compilerOptions)),
	fileExists: ts.sys.fileExists,
	readFile: ts.sys.readFile,
	readDirectory: ts.sys.readDirectory,
	directoryExists: ts.sys.directoryExists,
	getDirectories: ts.sys.getDirectories,
	realpath: ts.sys.realpath,
};

const languageService = ts.createLanguageService(host, ts.createDocumentRegistry());

// ---- 遍历声明 ----
const mismatches = []; // { file, line, kind, current, target, pos, sf, scopeKey }
const scopeNames = new Map(); // scopeKey -> Set<name>
const scopeOf = new Map(); // sf -> stack of scopeKeys

function isScopeNode(n) {
	return (
		ts.isSourceFile(n) ||
		ts.isFunctionDeclaration(n) ||
		ts.isMethodDeclaration(n) ||
		ts.isConstructorDeclaration(n) ||
		ts.isGetAccessorDeclaration(n) ||
		ts.isSetAccessorDeclaration(n) ||
		ts.isArrowFunction(n) ||
		ts.isFunctionExpression(n) ||
		ts.isClassDeclaration(n) ||
		ts.isClassExpression(n) ||
		ts.isInterfaceDeclaration(n) ||
		ts.isTypeLiteralNode(n) ||
		ts.isBlock(n) ||
		ts.isModuleBlock(n)
	);
}

function typeTargetName(node, checker) {
	const type = checker.getTypeAtLocation(node);
	const candidates = type.isUnion() ? type.types : [type];
	let found;
	for (const t of candidates) {
		if (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) continue;
		const sym = t.aliasSymbol ?? t.symbol;
		if (!sym) continue;
		const name = sym.getName();
		if (TARGETS.has(name)) {
			const target = TARGETS.get(name);
			if (found === undefined) found = target;
			else if (found !== target) return undefined; // 联合到不同目标，歧义，跳过
		} else {
			const base = t.target ?? t;
			const baseSym = base.aliasSymbol ?? base.symbol;
			if (baseSym && TARGETS.has(baseSym.getName())) {
				const target = TARGETS.get(baseSym.getName());
				if (found === undefined) found = target;
				else if (found !== target) return undefined;
			}
		}
	}
	return found;
}

function visit(node, checker) {
	const sf = node.getSourceFile();
	let pushed = false;
	if (isScopeNode(node)) {
		scopeOf.set(sf, [...(scopeOf.get(sf) ?? []), node.getStart(sf)]);
		pushed = true;
	}
	const stack = scopeOf.get(sf) ?? [sf.getStart(sf)];
	const scopeKey = `${sf.fileName}:${stack[stack.length - 1]}`;

	const recordName = (nameNode, extra) => {
		if (!scopeNames.has(scopeKey)) scopeNames.set(scopeKey, new Set());
		scopeNames.get(scopeKey).add(nameNode.text);
		if (extra) mismatches.push({ scopeKey, ...extra });
	};

	if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isBindingElement(node)) {
		const nameNode = node.name;
		if (ts.isIdentifier(nameNode) && nameNode.text !== "this") {
			const target = typeTargetName(nameNode, checker);
			const kind = ts.isVariableDeclaration(node) ? "var" : ts.isParameter(node) ? "param" : ts.isPropertyDeclaration(node) ? "field" : ts.isPropertySignature(node) ? "sig" : "bind";
			// 属性签名：容器若是类别注册表（如 ModelTypeMap），跳过。接口成员的 parent 就是
			// InterfaceDeclaration（没有 TypeLiteral 包裹），两级都查。
			let skip = false;
			if (ts.isPropertySignature(node)) {
				for (const container of [node.parent, node.parent?.parent]) {
					const sym = container && ts.isInterfaceDeclaration(container) ? checker.getSymbolAtLocation(container.name) : undefined;
					if (sym && SKIP_CONTAINER.has(sym.getName())) skip = true;
				}
			}
			if (!skip) {
				recordName(nameNode, {
					file: sf.fileName.replace(/\\/g, "/").slice(ROOT.length + 1),
					line: sf.getLineAndCharacterOfPosition(nameNode.getStart()).line + 1,
					kind,
					current: nameNode.text,
					target,
					pos: nameNode.getStart(sf),
					sf,
					chain: [...stack],
					scopeKey,
				});
			} else {
				recordName(nameNode);
			}
		}
	} else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node)) {
		if (node.name && ts.isIdentifier(node.name)) recordName(node.name);
	}

	ts.forEachChild(node, (child) => visit(child, checker));
	if (pushed) {
		const arr = scopeOf.get(sf);
		arr.pop();
	}
}

const program = languageService.getProgram();
const checker = program.getTypeChecker();

// 调试探针：DEBUG_POS="文件相对路径:行:列" 时打印该位置的类型与符号
if (process.env.DEBUG_POS) {
	const [rel, line, col] = process.env.DEBUG_POS.split(":");
	const sf = program.getSourceFile(path.join(ROOT, rel));
	const pos = sf.getPositionOfLineAndCharacter(Number(line) - 1, Number(col) - 1);
	const tok = ts.getTokenAtPosition(sf, pos);
	const type = checker.getTypeAtLocation(tok);
	console.error(`type: ${checker.typeToString(type)}`);
	console.error(`flags: ${type.flags}, union: ${type.isUnion()}`);
	if (type.isUnion()) for (const t of type.types) console.error(`  member: ${checker.typeToString(t)} sym=${(t.aliasSymbol ?? t.symbol)?.getName()}`);
	else console.error(`  sym=${(type.aliasSymbol ?? type.symbol)?.getName()}`);
	process.exit(0);
}

for (const f of fileNames) {
	const sf = program.getSourceFile(f);
	if (!sf) {
		console.error(`WARN: no source file in program: ${f}`);
		continue;
	}
	visit(sf, checker);
}

// 冲突处理：
// 1) 同作用域内同目标的多个声明 → 全部保留原名（语义名优先）；
// 2) 目标名与作用域内既有标识符冲突 → 保留原名；
// 3) 同文件内同目标的两个声明，作用域嵌套 → 全部保留：都改会内层遮蔽外层，
//    外层声明与内层声明之间的引用会被重绑到内层（TDZ / 语义改变）。
const dropped = [];
const valid = [];
const byScope = new Map();
for (const m of mismatches) {
	if (m.target === undefined || m.current === m.target) continue;
	if (SKIP_CURRENT.has(m.current)) continue;
	if (!byScope.has(m.scopeKey)) byScope.set(m.scopeKey, []);
	byScope.get(m.scopeKey).push(m);
}
for (const [scopeKey, group] of byScope) {
	const names = scopeNames.get(scopeKey) ?? new Set();
	const targetCount = new Map();
	for (const m of group) targetCount.set(m.target, (targetCount.get(m.target) ?? 0) + 1);
	for (const m of group) {
		if (targetCount.get(m.target) > 1) {
			dropped.push({ ...m, reason: "same-scope same-target" });
		} else if (names.has(m.target)) {
			// names 恒含 m.current 自己，而 target≠current，所以 has(target) 即被别人占用
			dropped.push({ ...m, reason: "target name taken in scope" });
		} else {
			valid.push(m);
		}
	}
}

// 跨作用域嵌套检查（规则 3）
const byFileTarget = new Map();
for (const m of valid) {
	const key = `${m.sf.fileName}:${m.target}`;
	if (!byFileTarget.has(key)) byFileTarget.set(key, []);
	byFileTarget.get(key).push(m);
}
for (const group of byFileTarget.values()) {
	if (group.length < 2) continue;
	// 类字段 / 接口属性经由 `this.x` / 属性访问，不产生裸标识符遮蔽与 TDZ，
	// 与块级绑定的嵌套不构成冲突；只有两个块级绑定（var/param/bind）嵌套才危险。
	const blockScoped = group.filter((m) => m.kind === "var" || m.kind === "param" || m.kind === "bind");
	const doomed = new Set();
	for (let i = 0; i < blockScoped.length; i++) {
		for (let j = i + 1; j < blockScoped.length; j++) {
			const a = blockScoped[i], b = blockScoped[j];
			const aTop = a.chain[a.chain.length - 1];
			const bTop = b.chain[b.chain.length - 1];
			if (a.chain.includes(bTop) || b.chain.includes(aTop)) {
				doomed.add(a);
				doomed.add(b);
			}
		}
	}
	for (const m of doomed) {
		const idx = valid.indexOf(m);
		if (idx >= 0) valid.splice(idx, 1);
		dropped.push({ ...m, reason: "nested scopes share target" });
	}
}

if (MODE === "report") {
	for (const m of valid) {
		console.log(`${m.file}:${m.line}\t${m.kind}\t${m.current} -> ${m.target}`);
	}
	console.error(`\nvalid: ${valid.length}, dropped: ${dropped.length}`);
	for (const d of dropped) console.error(`drop [${d.reason}] ${d.file}:${d.line} ${d.current} -> ${d.target}`);
	process.exit(0);
}

// ---- apply ----
const editsByKey = new Map();
const conflicts = [];
const noLocs = [];

for (const m of valid) {
	const locs = languageService.findRenameLocations(m.sf.fileName, m.pos, false, false, false) ?? [];
	if (locs.length === 0) {
		noLocs.push(m);
		continue;
	}
	for (const loc of locs) {
		const key = `${loc.fileName.replace(/\\/g, "/")}:${loc.textSpan.start}`;
		const existing = editsByKey.get(key);
		if (existing) {
			if (existing.newName !== m.target) conflicts.push({ key, a: existing.newName, b: m.target });
			continue;
		}
		editsByKey.set(key, { file: loc.fileName.replace(/\\/g, "/"), start: loc.textSpan.start, end: loc.textSpan.start + loc.textSpan.length, newName: m.target });
	}
}

console.error(`edits: ${editsByKey.size}, no-rename-locations: ${noLocs.length}, conflicts: ${conflicts.length}`);
for (const c of conflicts) console.error(`conflict at ${c.key}: ${c.a} vs ${c.b}`);
for (const s of noLocs) console.error(`no rename locations: ${s.file}:${s.line} ${s.current} -> ${s.target}`);

if (MODE !== "apply") process.exit(0);

const byFile = new Map();
for (const e of editsByKey.values()) {
	if (!byFile.has(e.file)) byFile.set(e.file, []);
	byFile.get(e.file).push(e);
}

let changedFiles = 0;
for (const [file, edits] of byFile) {
	edits.sort((a, b) => b.start - a.start);
	let text = fs.readFileSync(file, "utf8");
	for (const e of edits) text = text.slice(0, e.start) + e.newName + text.slice(e.end);
	fs.writeFileSync(file, text);
	changedFiles++;
}
console.error(`changed files: ${changedFiles}`);
