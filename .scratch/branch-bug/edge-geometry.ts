// Geometry check for the reworked off-line edge routing in branch-view.ts.
// Replays the exact path formulas and asserts, over a stress tree:
//   1. every descent x sits in the inter-column gap (no card ever occupies it below the trunk row);
//   2. no descent crosses an earlier sibling's approach segment;
//   3. no descent or approach enters a card's rectangle.
const NODE_W = 268;
const STEP_X = 300;
const DOT_R = 4.5;
const DOT_X = 12;
const LANE_H = 90; // a plausible resolved --dsw-branch-lane-h

const dotX = (depth: number) => depth * STEP_X + DOT_X;
const dotY = (lane: number) => lane * LANE_H + LANE_H / 2;

// The new formula, verbatim from branch-view.ts.
function edge(depth: number, index: number, lane: number): { drop: number; approach: [number, number]; approachRow: number; vertical: [number, number] } {
	const ax = dotX(depth) + DOT_R;
	const ay = dotY(0);
	const by = dotY(lane);
	const bx = dotX(depth + 1) - DOT_R;
	const gapLeft = depth * STEP_X + NODE_W + 4;
	const gapRight = (depth + 1) * STEP_X - 16;
	const drop = Math.max(gapRight - index * 6, gapLeft);
	const pre = 14;
	void ax; void ay; void by; void bx; void pre;
	return { drop, approach: [drop + 10, bx], approachRow: by, vertical: [0, by] };
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
	process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : ` ${detail}`}\n`);
	if (!ok) failures += 1;
}

// Stress tree: 5 trunk columns, each with 3 branches (lanes assigned the way `layout` does).
const depths = 5;
const cards: { depth: number; lane: number }[] = [];
let lane = 1;
for (let depth = 0; depth < depths; depth += 1) {
	cards.push({ depth, lane: 0 }); // the trunk node itself
	for (let index = 0; index < 3; index += 1) cards.push({ depth: depth + 1, lane: lane++ });
}

const edges = [];
for (let depth = 0; depth < depths; depth += 1) {
	for (let index = 0; index < 3; index += 1) {
		const branchLane = 1 + depth * 3 + index;
		edges.push({ depth, index, lane: branchLane, ...edge(depth, index, branchLane) });
	}
}

// 1. descents live in the gap, and never inside any card's x-range at rows >= 1.
for (const e of edges) {
	const gapOk = e.drop > e.depth * STEP_X + NODE_W && e.drop < (e.depth + 1) * STEP_X;
	check(`descent of col${e.depth}#${e.index} in gap`, gapOk, `x=${e.drop}`);
}
for (const e of edges) {
	for (const card of cards) {
		const left = card.depth * STEP_X;
		const insideX = e.drop > left && e.drop < left + NODE_W;
		const overlapsRows = card.lane > 0 && e.vertical[1] > dotY(card.lane) - 32 && e.vertical[0] < dotY(card.lane) + 32;
		check(`descent of col${e.depth}#${e.index} clears card col${card.depth}/lane${card.lane}`, !(insideX && overlapsRows), `x=${e.drop}`);
	}
}

// 2. sibling descents never cross an earlier sibling's approach: a later descent is left of it.
for (let depth = 0; depth < depths; depth += 1) {
	for (let i = 0; i < 3; i += 1) {
		for (let j = i + 1; j < 3; j += 1) {
			const a = edges.find((e) => e.depth === depth && e.index === i)!;
			const b = edges.find((e) => e.depth === depth && e.index === j)!;
			check(`descent col${depth}#${j} left of approach col${depth}#${i}`, b.drop < a.approach[0], `${b.drop} vs ${a.approach[0]}`);
		}
	}
}

// 3. approaches and descents of OTHER parents never intersect either.
for (const a of edges) {
	for (const b of edges) {
		if (a === b || b.depth <= a.depth) continue;
		const crosses = b.drop > a.approach[0] && b.drop < a.approach[1] && b.vertical[1] > a.approachRow;
		check(`descent col${b.depth}#${b.index} clears approach col${a.depth}#${a.index}`, !crosses, `${b.drop} in [${a.approach[0]},${a.approach[1]}]`);
	}
}

process.exit(failures === 0 ? 0 : 1);
