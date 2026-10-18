import { SessionManager } from "../packages/core/src/index.ts";

const file = process.argv[2];
const manager = SessionManager.open(file);
const points = manager.getBranchPoints();
console.log("branch points:", points.length);
for (const point of points) {
	console.log("\nPOINT", point.entryId, JSON.stringify({ prompt: point.prompt.slice(0, 60), answer: point.answer.slice(0, 60) }));
	for (const option of point.options) {
		console.log(
			"  option",
			option.entryId,
			JSON.stringify({
				role: option.role,
				label: option.label.slice(0, 60),
				answer: option.answer.slice(0, 60),
				active: option.active,
			}),
		);
	}
}
