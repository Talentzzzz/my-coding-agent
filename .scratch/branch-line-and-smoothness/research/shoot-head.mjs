import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launchChromium, openPage } from "../../../scripts/cdp.ts";
const here = join(resolve(process.cwd()), ".scratch", "branch-line-and-smoothness", "research");
const browser = await launchChromium({ width: 900, height: 640 });
try {
	const page = await openPage(browser.port, pathToFileURL(join(here, "reasoning-head.html")).href, { width: 900, height: 640 });
	await new Promise((r) => setTimeout(r, 500));
	console.log("头行，短：", await page.evaluate(`document.querySelectorAll(".reasoning")[0].getBoundingClientRect().width`));
	await page.screenshot(join(here, "shots", "05-reasoning-head.png"));
	await page.close();
} finally { await browser.close(); }
