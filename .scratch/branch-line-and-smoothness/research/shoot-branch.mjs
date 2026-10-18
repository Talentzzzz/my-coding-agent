// 票 04/05 的实物：真 Chromium 打开真窗口（服务器在 127.0.0.1:8080），点进一个会话、翻开分支页，
// 拍照 —— 无分支的主链、拖动之后、放大之后，以及一个有分支的会话。
//
//   node .scratch/branch-line-and-smoothness/research/shoot-branch.mjs
//
// 页面自己没有任何开关，所以这里做的都是用户会做的动作：点会话、点标题带上的分支入口、按住左键拖、
// Ctrl+滚轮。截图落在 research/shots/ 下。
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchChromium, openPage } from "../../../scripts/cdp.ts";

const here = join(resolve(process.cwd()), ".scratch", "branch-line-and-smoothness", "research", "shots");
mkdirSync(here, { recursive: true });

const browser = await launchChromium({ width: 1440, height: 900 });
try {
	const page = await openPage(browser.port, "http://127.0.0.1:8080/", { width: 1440, height: 900 });
	await page.waitFor(`document.querySelectorAll(".session-item").length > 0`, 20_000);

	/** Open the session whose row carries `text`, and wait for its transcript. */
	const open = async (text) => {
		const found = await page.evaluate(`(() => {
			const row = [...document.querySelectorAll(".session-item")].find((item) => item.textContent.includes(${JSON.stringify(text)}));
			if (row === undefined) return false;
			row.click();
			return true;
		})()`);
		if (!found) throw new Error(`找不到会话：${text}`);
		await page.waitFor(`document.querySelectorAll(".turn").length > 0`, 20_000);
		// The branch shape arrives on the baseline that draws the transcript; give the fold a frame.
		await new Promise((done) => setTimeout(done, 800));
	};

	const shoot = async (name) => {
		// The page paints from the baseline that arrived with the transcript, and the transcript can still
		// be the previous session's for a moment: open, look, and if the tree is not there yet, try again.
		await page.click(".branch-chip");
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await new Promise((done) => setTimeout(done, 500));
			if ((await page.evaluate(`document.querySelectorAll(".gnode").length`)) > 0) break;
			await page.click(".back-button");
			await new Promise((done) => setTimeout(done, 400));
			await page.click(".branch-chip");
		}
		await new Promise((done) => setTimeout(done, 300));
		const cards = await page.evaluate(`document.querySelectorAll(".gnode").length`);
		const summary = await page.evaluate(`document.querySelector(".branch-sum")?.textContent ?? ""`);
		const tools = await page.evaluate(`document.querySelector(".branch-tools")?.textContent ?? ""`);
		console.log(`[${name}] ${cards} 张卡 · ${summary}`);
		console.log(`[${name}] 工具行：${tools}`);
		await page.screenshot(join(here, `${name}.png`));
		return cards;
	};

	/** Press in the middle of the canvas, move, release — real pointer events through CDP. */
	const drag = async (dx, dy) => {
		const box = await page.evaluate(`(() => {
			const rect = document.querySelector(".graph-viewport").getBoundingClientRect();
			return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
		})()`);
		const mouse = (type, x, y) => page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
		await mouse("mousePressed", box.x, box.y);
		await mouse("mouseMoved", box.x + dx / 2, box.y + dy / 2);
		await mouse("mouseMoved", box.x + dx, box.y + dy);
		await mouse("mouseReleased", box.x + dx, box.y + dy);
		return { box, transform: await page.evaluate(`document.querySelector(".graph-zoom").style.transform`) };
	};

	// A conversation that never forked: the whole point of ticket 04 is that this page is not blank.
	await open("写一段长回答");
	await shoot("01-line");

	// Press a card on the line the way a person would: select, then read what the header offers.
	await page.evaluate(`document.querySelectorAll(".gnode")[1].scrollIntoView()`);
	const cardBox = await page.evaluate(`(() => { const r = document.querySelectorAll(".gnode")[1].getBoundingClientRect(); return { x: r.x + 40, y: r.y + r.height / 2 }; })()`);
	await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cardBox.x, y: cardBox.y, button: "left", clickCount: 1 });
	await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cardBox.x, y: cardBox.y, button: "left", clickCount: 1 });
	await new Promise((done) => setTimeout(done, 200));
	console.log(`选中之后工具行：${await page.evaluate(`document.querySelector(".branch-tools")?.textContent ?? ""`)}`);
	await page.screenshot(join(here, "06-selected.png"));


	const panned = await drag(220, 90);
	console.log(`拖动之后：${panned.transform}`);
	await page.screenshot(join(here, "02-panned.png"));

	await page.send("Input.dispatchMouseEvent", {
		type: "mouseWheel",
		x: panned.box.x + 220,
		y: panned.box.y + 90,
		deltaX: 0,
		deltaY: -240,
		modifiers: 2,
	});
	console.log(`放大之后：${await page.evaluate(`document.querySelector(".graph-zoom").style.transform`)}`);
	await page.screenshot(join(here, "03-zoomed.png"));

	// A conversation that did fork: the line stays, the alternative hangs below it.
	await page.click(".back-button");
	await open("branch at this message");
	await shoot("04-forked");

	await page.close();
} finally {
	await browser.close();
}
