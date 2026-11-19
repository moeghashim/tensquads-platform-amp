// The cost in the report of a run (requirement E2, decision D26). The runner reads the cost only after the run
// ended, so the report has each cost row of the test account.
import assert from "node:assert/strict";
import { test } from "node:test";

import pg from "pg";

import { loadCases, loadVersions } from "../src/files.js";
import { runEvals } from "../src/run.js";

test("E2: the cost in the report of each run equals the sum of the cost rows of its test account, read after the run", async () => {
	// P2 has no task, so the run ends at once after the tool of Petra. K3 has a task and a sandbox.
	// Each model answer waits 800 ms, so a row that comes after the read cannot hide in the time of the read.
	const versions = loadVersions(["base"]).map((version) => ({
		...version,
		worker: { ...version.worker, MODEL_HOLD_MS: "800" },
	}));
	const outcome = await runEvals({
		versions,
		cases: loadCases(["P2", "K3"]),
		runs: 2,
		log: () => undefined,
	});
	assert.equal(outcome.runs.length, 4);
	// The Workers stopped, so no cost row can come later.
	const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
	try {
		for (const run of outcome.runs) {
			const [row] = (
				await db.query<{ cost: string }>(
					"SELECT coalesce(sum(amount), 0) AS cost FROM costs WHERE account_id = $1",
					[run.accountId],
				)
			).rows;
			assert.equal(run.cost, Number(row?.cost), `The cost of the run ${run.accountId}.`);
		}
	} finally {
		await db.end();
	}
	const total = outcome.runs.reduce((sum, run) => sum + run.cost, 0);
	assert.equal(outcome.reports[0]?.cost, total, "The report adds the cost of each run.");
});
