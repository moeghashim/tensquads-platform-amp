import assert from "node:assert/strict";
import { test } from "node:test";

import { runDeciderEvals } from "../src/decider.js";
import { loadDeciderItems } from "../src/files.js";

test("E5: the eval of the decider runs against the fixed decider and the model decider, for each yes or no point", async () => {
	const reports = await runDeciderEvals(loadDeciderItems());
	assert.deepEqual(
		reports.map((report) => report.decider),
		["fixed", "model"],
	);
	for (const report of reports) {
		assert.equal(report.points.length, 4);
		for (const point of report.points) {
			assert.equal(point.items, 8);
			// Both test deciders say "yes" at a probability above the level. Half the labels are "no".
			assert.equal(point.agreement, 0.5, `${report.decider} ${point.point}`);
			assert.equal(point.wrongAboveLevel, 4, `${report.decider} ${point.point}`);
			assert.ok(point.cost > 0, "Each call has a price.");
			assert.ok(point.meanMs >= 0);
		}
	}
});
