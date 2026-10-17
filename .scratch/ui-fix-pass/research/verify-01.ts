// Ticket 01 (meta copy button, chevron, reasoning panel, runtime line), checked in a real browser.
//
// The four fixes are all stylesheet rules, so the acceptance is what a computed style and a painted
// screenshot say, not what a unit test says. This harness boots the production server against a
// scripted transport, drives the real client in Chromium, and reads the four places the ticket names:
// both copy controls, a closed tool row's chevron, the expanded reasoning body beside an expanded
// tool output, and the ticking line's left edge against the prose's.
//
//   npm run build:web && node .scratch/ui-fix-pass/research/verify-01.ts [--shots]
//
// `--shots` writes the comparison images next to this file; without it the checks alone run.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { UserModel } from "@my-agent/core";

const shots = process.argv.includes("--shots");
const { chromium } = createRequire(import.meta.url)(
	"C:/Users/a1368/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js",
);

let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

const root = await mkdtemp(join(tmpdir(), "my-agent-verify-01-"));
// The session store and settings live under the agent home. Point it inside the throwaway root, so a
// run — including its session records and, in the window, its sidebar rows — leaves nothing behind in
// the real `~/.my-agent`. `AGENT_HOME` is read when its module loads, so the server is imported after
// this line rather than at the top of the file.
process.env.MY_AGENT_HOME = join(root, "home");
const { bootServer } = await import("../../../packages/server/src/boot.ts");
const { createFakeTransport, fakeAssistantMessage, fakeThinking, fakeToolCall } = await import(
	"../../../scripts/fake-transport.ts"
);

// Slow enough that a long answer's ticking line is still on screen when the live check looks for it.
const fake = createFakeTransport({ tokensPerSecond: 120, tokenSize: { min: 2, max: 4 } });
const rows: UserModel[] = [
	{
		name: "scripted",
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "unused",
		modelId: "claude-sonnet-4-5",
		contextWindow: 200_000,
		maxTokens: 8_192,
		reasoning: false,
	},
];
await writeFile(join(root, "README.md"), "# my-coding-agent\n\n一个带桌面 UI 的编码 agent。\n");
await writeFile(join(root, "notes.txt"), "随手记\n");

const server = await bootServer({ cwd: root, port: 0, api: fake.api });
server.hub.setUserModels(rows);
fake.appendResponses([
	// Two tool calls so one row can be opened while the other stays closed: the chevron check needs a
	// row that is not showing its expanded state.
	() =>
		fakeAssistantMessage(
			[
				fakeThinking(
					"先读 README，再数一遍仓库里的 markdown。工具输出和思考都要能直接看出边界，不然一段长文本会连成一片。",
				),
				fakeToolCall("read", { path: "README.md" }),
				fakeToolCall("glob", { pattern: "*.md" }),
			],
			// Stamped at request time rather than at script time, so the footer's wall clock and its
			// elapsed reading are as real as the ones a provider would produce.
			{ timestamp: Date.now() + 1_000 },
		),
	() =>
		fakeAssistantMessage(
			"README 是项目说明：这是一个带桌面 UI 的编码 agent，仓库里 markdown 的 glob 命中只有 README 这一份。",
			{ timestamp: Date.now() + 2_000 },
		),
	// The live runtime check's own round: long enough that the line is still ticking after the click.
	() =>
		fakeAssistantMessage(
			`补充说明。${"这一段用来让计时行有足够长的流式时间，从而能在窗口里量到真实的用时节点。".repeat(30)}`,
			{ timestamp: Date.now() + 2_000 },
		),
]);

const browser = await chromium.launch({
	executablePath: "C:/Users/a1368/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe",
	headless: true,
});
const outDir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
page.on("pageerror", (error: Error) => process.stdout.write(`page error: ${error.message}\n`));
await page.goto(server.url);
await page.waitForSelector("textarea", { timeout: 10_000 });
await page.waitForTimeout(800);

const { sessionId } = (await fetch(`${server.url}/api/sessions/current`, {
	headers: { accept: "application/json" },
}).then((response) => response.json() as Promise<{ sessionId: string }>));

await page.fill(".composer textarea", "帮我看看 README 里写了什么，仓库里还有几份 markdown？");
await page.press(".composer textarea", "Enter");

// Wait for the round to settle: the footer (and its copy control) only exists on a finished answer.
for (let waited = 0; waited < 20_000; waited += 150) {
	const response = await fetch(`${server.url}/api/sessions/${encodeURIComponent(sessionId)}`, {
		headers: { accept: "application/json" },
	});
	const body = (await response.json()) as { session: { submitting: boolean; messages: unknown[] } };
	if (!body.session.submitting && body.session.messages.length >= 4) break;
	await new Promise((resolve) => setTimeout(resolve, 150));
}
await page.waitForTimeout(700);
// No pointer on the transcript, so a hover-only style cannot make the checks pass by accident.
await page.mouse.move(0, 0);

interface Style {
	background: string;
	borderStyle: string;
	borderWidth: string;
	paddingTop: string;
	paddingRight: string;
	paddingBottom: string;
	paddingLeft: string;
	color: string;
	width: string;
	height: string;
	fontFamily: string;
	lineHeight: string;
	borderRadius: string;
	maxHeight: string;
	overflowY: string;
	opacity: string;
	transform: string;
	marginTop: string;
}

async function styleOf(selector: string): Promise<Style> {
	return page.$eval(selector, (element: Element) => {
		const style = getComputedStyle(element);
		return {
			background: style.backgroundColor,
			borderStyle: style.borderTopStyle,
			borderWidth: style.borderTopWidth,
			paddingTop: style.paddingTop,
			paddingRight: style.paddingRight,
			paddingBottom: style.paddingBottom,
			paddingLeft: style.paddingLeft,
			color: style.color,
			width: style.width,
			height: style.height,
			fontFamily: style.fontFamily,
			lineHeight: style.lineHeight,
			borderRadius: style.borderTopLeftRadius,
			maxHeight: style.maxHeight,
			overflowY: style.overflowY,
			opacity: style.opacity,
			transform: style.transform,
			marginTop: style.marginTop,
		};
	});
}

async function rectOf(selector: string): Promise<{ left: number }> {
	return page.$eval(selector, (element: Element) => ({ left: element.getBoundingClientRect().left }));
}

const TRANSPARENT = "rgba(0, 0, 0, 0)";

// ---------------------------------------------------------------- 1. the copy controls

process.stdout.write("\n01：复制按钮是纯图标\n");
{
	const meta = await styleOf(".turn[data-role=\"user\"] .turn-meta .turn-copy");
	const foot = await styleOf(".turn-foot:not([hidden]) .turn-copy");
	const caption = await styleOf(".turn-meta");

	for (const [where, style] of [["user meta", meta], ["agent foot", foot]] as const) {
		check(`${where}：无浏览器底色`, style.background === TRANSPARENT, style.background);
		check(`${where}：无边框`, style.borderStyle === "none" && style.borderWidth === "0px", `${style.borderStyle} ${style.borderWidth}`);
		check(`${where}：无内边距`, style.paddingTop === "0px" && style.paddingLeft === "0px", `${style.paddingTop} ${style.paddingLeft}`);
		check(`${where}：24×24`, style.width === "24px" && style.height === "24px", `${style.width} × ${style.height}`);
		check(`${where}：图标为 caption 色`, style.color === caption.color, `${style.color} vs ${caption.color}`);
	}
	check("两处副本视觉一致", meta.background === foot.background && meta.color === foot.color && meta.width === foot.width);

	// Hover is the only state that shows a surface, and it must be the hover token with a brighter label.
	const before = foot.color;
	await page.hover(".turn-foot:not([hidden]) .turn-copy");
	await page.waitForTimeout(300);
	const hovered = await styleOf(".turn-foot:not([hidden]) .turn-copy");
	check("hover 才出现底色", hovered.background !== TRANSPARENT, hovered.background);
	check("hover 的文字更亮", hovered.color !== before, `${before} -> ${hovered.color}`);
	await page.mouse.move(0, 0);
	await page.waitForTimeout(300);

	if (shots) {
		await page.locator(".turn[data-role=\"user\"]").last().screenshot({ path: join(outDir, "after-01-user-meta.png") });
		await page.locator(".turn-foot").last().screenshot({ path: join(outDir, "after-01-foot.png") });
	}
}

// ---------------------------------------------------------------- 2. the chevron

process.stdout.write("\n01：三角始终可见\n");
{
	// The reasoning row and the two tool rows are all closed and un-hovered here.
	const closed = await page.$$eval(".tool:not([open]) .tool-chevron", (elements: Element[]) =>
		elements.map((element) => getComputedStyle(element).opacity),
	);
	check("未展开、未悬停也可见", closed.length >= 3 && closed.every((opacity) => opacity === "1"), JSON.stringify(closed));
	const chevronColor = await styleOf(".tool:not([open]) .tool-chevron");
	const captionColor = await page.$eval(".turn-meta", (element: Element) => getComputedStyle(element).color);
	check("未悬停时为 caption 色", chevronColor.color === captionColor, `${chevronColor.color} vs ${captionColor}`);

	// Hover no longer owns visibility: the mark stays, and only the line's name lifts.
	await page.hover(".tool:not(.reasoning) > summary");
	await page.waitForTimeout(250);
	const hovered = await styleOf(".tool:not(.reasoning):not([open]) .tool-chevron");
	check("悬停后仍然可见", hovered.opacity === "1", hovered.opacity);
	const hoveredName = await styleOf(".tool:not(.reasoning) > summary .tool-name");
	const primary = await page.$eval("body", (element: Element) => getComputedStyle(element).color);
	check("悬停把行抬到 primary", hoveredName.color === primary, `${hoveredName.color} vs ${primary}`);
	await page.mouse.move(0, 0);
	await page.waitForTimeout(250);

	if (shots) await page.locator(".tool-group").screenshot({ path: join(outDir, "after-03-chevron.png") });

	// Opening one row turns its own chevron only.
	await page.locator(".tool:not(.reasoning) > summary").first().click();
	await page.waitForTimeout(400);
	const openTransform = (await styleOf(".tool[open]:not(.reasoning) .tool-chevron")).transform;
	check("展开后旋转 90°", openTransform.startsWith("matrix(0, 1, -1, 0"), openTransform);
	const stillClosed = await styleOf(".tool:not([open]):not(.reasoning) .tool-chevron");
	check("其余行保持原方向", stillClosed.transform === "none", stillClosed.transform);

	await page.locator(".reasoning > summary").click();
	await page.waitForTimeout(400);
	const reasoningTransform = (await styleOf(".reasoning[open] .tool-chevron")).transform;
	check("思考行同样旋转", reasoningTransform.startsWith("matrix(0, 1, -1, 0"), reasoningTransform);
}

// ---------------------------------------------------------------- 3. the reasoning panel

process.stdout.write("\n01：思考展开体与工具输出同一块灰面板\n");
{
	const body = await styleOf(".reasoning-body");
	const output = await styleOf(".tool-output");
	check("同一背景 token", body.background === output.background, `${body.background} vs ${output.background}`);
	check("同一圆角", body.borderRadius === output.borderRadius, `${body.borderRadius} vs ${output.borderRadius}`);
	check(
		"同一内边距",
		body.paddingTop === output.paddingTop &&
			body.paddingRight === output.paddingRight &&
			body.paddingBottom === output.paddingBottom &&
			body.paddingLeft === output.paddingLeft,
		`${body.paddingTop} ${body.paddingRight} ${body.paddingBottom} ${body.paddingLeft} vs ${output.paddingTop} ${output.paddingRight} ${output.paddingBottom} ${output.paddingLeft}`,
	);
	check("同一滚动策略", body.overflowY === output.overflowY && body.maxHeight === output.maxHeight, `${body.overflowY}/${body.maxHeight} vs ${output.overflowY}/${output.maxHeight}`);

	const prose = await styleOf(".turn-body");
	check("正文仍是 prose 而不是 mono", body.fontFamily === prose.fontFamily && body.fontFamily !== output.fontFamily);
	check("仍走在 prose 的行高上", body.lineHeight !== output.lineHeight, `${body.lineHeight} vs ${output.lineHeight}`);

	const bodyRect = await rectOf(".reasoning-body");
	const outputRect = await rectOf(".tool-output");
	check("左侧仍缩进到工具输出行首", Math.abs(bodyRect.left - outputRect.left) < 1, `${bodyRect.left} vs ${outputRect.left}`);

	if (shots) {
		await page.locator(".reasoning").first().screenshot({ path: join(outDir, "after-04-reasoning.png") });
		await page.locator(".tool:not(.reasoning)").first().screenshot({ path: join(outDir, "after-04-tool-output.png") });
	}
}

// ---------------------------------------------------------------- 4. the runtime line

process.stdout.write("\n01：用时行与正文同一左边界\n");
{
	// The ticking line is the only transcript child that is not a turn, and it lives only while the
	// loop streams. The rule is measured against a probe first — the same div the view mounts, placed
	// where the view places it — so the layout answer does not depend on catching a frame.
	await page.evaluate(() => {
		const line = document.createElement("div");
		line.className = "runtime";
		line.id = "runtime-probe";
		line.append("用时 ", Object.assign(document.createElement("span"), { className: "runtime-time", textContent: "00:00" }));
		document.querySelector(".transcript")!.append(line);
	});
	const runtimeRect = await rectOf("#runtime-probe");
	const turnRect = await rectOf(".turn");
	const transcriptRect = await rectOf(".transcript");
	check("与正文同一左边界", Math.abs(runtimeRect.left - turnRect.left) < 1, `${runtimeRect.left} vs ${turnRect.left}`);
	check("不再贴容器左缘", runtimeRect.left - transcriptRect.left > 10, `${runtimeRect.left} vs ${transcriptRect.left}`);
	const runtimeMarginTop = (await styleOf("#runtime-probe")).marginTop;
	check("保留 block 方向的外边距", runtimeMarginTop === "16px", runtimeMarginTop);

	if (shots) {
		const box = await page.locator("#runtime-probe").boundingBox();
		if (box) {
			await page.screenshot({
				path: join(outDir, "after-05-runtime.png"),
				clip: { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 90), width: 760, height: 180 },
			});
		}
	}
	await page.locator("#runtime-probe").evaluate((element: Element) => element.remove());
	if (shots) await page.screenshot({ path: join(outDir, "after-window.png") });
}

// ----------------------------------------------------- 5. the line the view really mounts

process.stdout.write("\n01：真实流式时同样对齐\n");
{
	// The probe above proves the rule; this round proves the production node — the line the view
	// appends while a run streams — lands on the same boundary.
	await page.fill(".composer textarea", "再补一段说明");
	await page.press(".composer textarea", "Enter");
	await page.waitForSelector(".runtime", { timeout: 10_000 });
	const liveRect = await rectOf(".runtime");
	const liveTurnRect = await rectOf(".turn");
	check("流式中的用时行与正文同一左边界", Math.abs(liveRect.left - liveTurnRect.left) < 1, `${liveRect.left} vs ${liveTurnRect.left}`);

	if (shots) {
		const box = await page.locator(".runtime").boundingBox();
		if (box) {
			await page.screenshot({
				path: join(outDir, "after-05-runtime-live.png"),
				clip: { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 90), width: 760, height: 180 },
			});
		}
	}
	// Let the round finish, so closing the server never cuts a run in half.
	await page.waitForSelector(".runtime", { state: "detached", timeout: 30_000 });
}

await browser.close();
await server.close();
await rm(root, { recursive: true, force: true });

process.stdout.write(failures === 0 ? "\n01 ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
