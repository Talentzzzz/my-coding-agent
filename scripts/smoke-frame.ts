// Frame-coalescer smoke：对着共享 DOM shim 驱动生产用的 `OncePerFrame`——这个 shim 也是这里唯一
// 实现 animation frame 的地方。被测的性质是流式渲染赖以成立的那条——多次请求、一次回调、永远
// 跑在最新状态上——外加调用方必须能信赖的三个边界：一次运行中再次请求拿到的是*下一*帧；落在
// 最小间隔内的绘制整体顺延；被取消的帧绝不运行。
//
// 不触网，无需服务器和 provider key。
// 运行：node scripts/smoke-frame.ts
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

	// 一次刷新里的多个 delta：第一个把帧装上，其余都是同一次绘制。
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

	// 之后的 delta 装上新帧；合并器可复用，而不是一次性的。
	state = 4;
	once.schedule();
	check("新的 delta 排了新帧", once.pending);
	shim.frames();
	check("新帧跑的是新状态", runs === 2 && painted === 4, `${runs}/${painted}`);

	// 取消正是立即绘制所依赖的机制：它现在就画同一份状态，而一个留着装好的帧会在下次刷新再画一遍。
	state = 5;
	once.schedule();
	once.cancel();
	check("取消后没有排队", !once.pending);
	check("取消的帧没有跑", shim.frames() === 0 && runs === 2, `${runs}`);
	once.cancel();
}

{
	// 回调里请求自己是在请求*下一*帧：装帧发生在它本会碰撞的那次 handle 被清除之后，一帧里把
	// 回调跑两遍就成了一个没有让出点的死循环。
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

{
	// 最小间隔闸门：与前一次绘制相距不足一个 60 Hz 刷新的绘制被推到下一帧——这是 120 Hz 显示器
	// 产生的形状，两次刷新落在读者感知的一次里。请求不丢失：顺延的帧带着它，在第一个满足间隔
	// 的帧上运行。
	let runs = 0;
	const gated = new OncePerFrame(() => {
		runs += 1;
	});
	gated.schedule();
	shim.frames();
	check("第一帧照常跑", runs === 1, `${runs}`);
	gated.schedule();
	shim.frames(8);
	check("间隔不足就顺延", runs === 1 && gated.pending, `${runs}/${gated.pending}`);
	shim.frames(8.7);
	check("间隔够了补跑", runs === 2 && !gated.pending, `${runs}/${gated.pending}`);

	// 取消同样能到达顺延中的帧：立即绘制抢先它，与抢先一个普通装好的帧走同一条路。
	gated.schedule();
	shim.frames(8);
	check("顺延的帧还在队列里", gated.pending);
	gated.cancel();
	check("顺延中可以取消", !gated.pending);
	shim.frames(8.7);
	check("取消的顺延帧没有跑", runs === 2, `${runs}`);
	check("补跑之后没有多出来的帧", shim.frames() === 0 && runs === 2, `${runs}`);
}

process.stdout.write(failures === 0 ? "\nframe ok\n" : `\n${failures} 项失败\n`);
process.exitCode = failures === 0 ? 0 : 1;
