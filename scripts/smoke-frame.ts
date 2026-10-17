// Frame-coalescer smoke: drives the production `OncePerFrame` against the shared DOM shim, which is
// also the only thing that implements animation frames here. The property under test is the one a
// streaming run rests on — many asks, one callback, run against the latest state — plus the two
// edges a caller has to be able to trust: a run that asks again gets the *next* frame, and a
// cancelled frame never runs.
//
// Nothing reaches the network, so no server and no provider key are needed.
// Run with: node scripts/smoke-frame.ts
import { OncePerFrame } from "../packages/web/src/frame.ts";
import { installDom } from "./dom-shim.ts";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	process.stdout.write(`${condition ? "  ok  " : "  FAIL"} ${label}${condition ? "" : ` ${detail}`}\n`);
	if (!condition) failures += 1;
}

const shim = installDom();

process.stdout.write("\nframe：一帧只画一次\n");

{
	let state = 0;
	let runs = 0;
	let painted = -1;
	const once = new OncePerFrame(() => {
		runs += 1;
		painted = state;
	});

	// Several deltas inside one refresh: the first arms the frame, the rest are the same draw.
	state = 1;
	once.schedule();
	state = 2;
	once.schedule();
	state = 3;
	once.schedule();
	check("一帧之前什么都没跑", runs === 0, `${runs}`);
	check("队列里有一帧", once.pending);
	check("这一帧跑了一次", shim.frames() > 0 && runs === 1, `${runs}`);
	check("跑的是最后的状态", painted === 3, `${painted}`);
	check("跑完就不再有待跑的帧", !once.pending);

	// A later delta arms a new frame; the coalescer is reusable rather than one-shot.
	state = 4;
	once.schedule();
	check("新的 delta 排了新帧", once.pending);
	shim.frames();
	check("新帧跑的是新状态", runs === 2 && painted === 4, `${runs}/${painted}`);

	// Cancellation is what an immediate draw relies on: it paints the same state now, and a frame
	// left armed would paint it again a refresh later.
	state = 5;
	once.schedule();
	once.cancel();
	check("取消后没有排队", !once.pending);
	check("取消的帧没有跑", shim.frames() === 0 && runs === 2, `${runs}`);
	once.cancel();
}

{
	// A callback that asks for itself is asking for the *next* frame: arming happens after the handle
	// it would collide with was cleared, and a frame that ran its callback twice would be a loop
	// with no yield in it.
	let runs = 0;
	const again = new OncePerFrame(() => {
		runs += 1;
		if (runs < 3) again.schedule();
	});
	again.schedule();
	shim.frames();
	check("回调里再排的是下一帧", runs === 1 && again.pending, `${runs}`);
	shim.frames();
	check("再下一帧继续跑", runs === 2 && again.pending, `${runs}`);
	shim.frames();
	check("跑满之后停下", runs === 3 && !again.pending, `${runs}`);
}

process.stdout.write(failures === 0 ? "\nframe ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
