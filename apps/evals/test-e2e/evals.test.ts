// The tests of the runner of evals through the full path (task 11): the local emulator, the launcher and real
// runner processes. In CI each test has one case and one run (decision 8). `npm run evals` runs all the cases.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { evalCase } from "@tensquads/contracts";

import { loadCases, loadVersions } from "../src/files.js";
import { EvalWorker } from "../src/play.js";
import { runEvals } from "../src/run.js";
import { caseFromTask } from "../src/trail.js";

test("E2, E3 and Done: one changed script makes K3 fail, and the comparison names K3; no action goes out", async () => {
	const lines: string[] = [];
	const outcome = await runEvals({
		versions: loadVersions(["base", "refund-double"]),
		cases: loadCases(["K3"]),
		runs: 1,
		log: (line) => lines.push(line),
	});
	const [base, double] = outcome.reports;
	assert.equal(base?.cases[0]?.verdict, "pass", JSON.stringify(base));
	assert.equal(double?.cases[0]?.verdict, "fail", JSON.stringify(double));
	assert.deepEqual(outcome.comparison?.regressions, ["K3"]);
	assert.ok((base?.cost ?? 0) > 0, "The cost view gives a cost.");
	assert.ok((base?.ms ?? 0) > 0);
	const text = lines.join("\n");
	assert.match(text, /Passed in A and fails in B: K3/);
	assert.match(text, /Pass rate: 100\.0%/);
	// The mode with no outgoing action: the payment recorded what it would send, and sent nothing.
	assert.match(outcome.workerLogs.join("\n"), /payment-test: would send eval-/);
	assert.doesNotMatch(outcome.workerLogs.join("\n"), /payment-test: send /);
});

// A task that the owner rejected, with the name, the phone number and the email of a customer in its goal.
const REJECTED = evalCase.parse({
	id: "E4-source",
	source: "A task for the test of E4.",
	input: [
		{
			type: "OwnerMessage",
			text: "Please refund 60 to cust-1 for Ahmed Ali, phone +966 50 123 4567, email ahmed.ali@example.com",
		},
		{ type: "ApprovalDecision", decision: "reject", when: "when the task waits" },
	],
	expected: { text: "The refund does not go out.", checks: [{ check: "sends", port: "payment", count: 0 }] },
	grader: { kind: "code" },
});

const worker = new EvalWorker({});

test("E4: a trail with a name, a phone number and an email of a customer gives a case with none of them", async (t) => {
	await worker.start();
	t.after(() => worker.stop());
	const accountId = `eval-e4-${randomUUID().slice(0, 8)}`;
	const played = await worker.play(REJECTED, accountId);
	const taskId = played.record.tasks[0]?.id ?? "";
	assert.equal(played.record.tasks[0]?.status, "done");
	const customer = { names: ["Ahmed Ali"], addresses: ["+966501234567"] };
	const readId = `e4-${randomUUID()}`;
	const made = await caseFromTask(worker.adminGet, { caseId: "from-e4", taskId, accountId, readId, customer });
	assert.ok("case" in made, JSON.stringify(made));
	const text = JSON.stringify(made.case);
	for (const part of ["Ahmed", "Ali", "4567", "+966", "example.com", "@"]) {
		assert.ok(!text.includes(part), `The case has "${part}": ${text}`);
	}
	assert.deepEqual(
		made.case.input.map((step) => step.type),
		["OwnerMessage", "ApprovalDecision"],
	);
	// The read went through the admin trail call, so admin_reads has it (decision D22).
	const reads = await worker.path.query("SELECT 1 FROM admin_reads WHERE account_id = $1 AND read_id = $2", [
		accountId,
		readId,
	]);
	assert.equal(reads.length, 1);

	// The second test: the trail of the same task is deleted, as the night job does one month after the task ended.
	await worker.path.query("DELETE FROM trail WHERE account_id = $1 AND task_id = $2", [accountId, taskId]);
	const refused = await caseFromTask(worker.adminGet, {
		caseId: "from-e4",
		taskId,
		accountId,
		readId: `e4-${randomUUID()}`,
		customer,
	});
	assert.deepEqual(refused, {
		refused: `The trail of the task ${taskId} was deleted or does not exist. A case can be made only from a trail that exists.`,
	});
});
