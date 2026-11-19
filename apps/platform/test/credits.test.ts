// The credits of a task, against a real Postgres (task 07, requirements T1 to T4).
// The credits package holds the rules. Petra writes the ledger rows. The test joins them as the Durable Object does.
import assert from "node:assert/strict";
import test from "node:test";

import { testBot } from "@tensquads/bots";
import type { TaskResult } from "@tensquads/contracts";
import { PETRA_TOOLS } from "@tensquads/petra";
import pg from "pg";

import { startCall } from "./gate-harness.js";
import { AT, type Harness, harness, harnessGateway, runTool, startRunner, taskRows } from "./task-harness.js";

// tasks.id is unique over all accounts, so each test makes its ids from its account id.
const u = (h: { accountId: string }, name: string) => `${name}-${h.accountId}`;

const PRICE = testBot.taskTypes[0]?.price ?? 0;
const TEST_TASK = { bot: "test-bot", taskType: "answer-question", goal: "Answer.", replyTo: "chat" } as const;

const startTask = (h: Harness, work: ReturnType<Harness["build"]>["work"], name: string) =>
	work.startTask({ commandId: u(h, name), ...TEST_TASK });

test("T1: a task does not start when the balance is lower than the price; the owner gets a clear message", async () => {
	const h = await harness("t1", 0);
	const { tools } = h.build();
	await runTool(tools, PETRA_TOOLS.startTask, { commandId: u(h, "c1"), text: "Answer the customer." });
	const rows = await taskRows(h.database, h.accountId);
	assert.deepEqual(rows, { tasks: [], ledger: [], attempts: [] });
	assert.equal(await h.writer.balance(), 0, "No ledger row was written.");
	assert.equal(h.list.size, 0, "No sandbox request.");
	assert.ok(h.sent.some((m) => m.type === "reply" && m.text === "Your credits are not sufficient for this task."));
	// With a balance equal to the price, the task starts.
	await h.writer.addGrant({ sourceRef: `cmd/${u(h, "g1")}/grant`, credits: PRICE, at: AT });
	await runTool(tools, PETRA_TOOLS.startTask, { commandId: u(h, "c2"), text: "Answer the customer." });
	assert.deepEqual(
		(await taskRows(h.database, h.accountId)).tasks.map((task) => task.id),
		[u(h, "c2")],
	);
	assert.equal(await h.writer.balance(), 0);
});

test("T2: a task with two attempts and ten model calls has one charge row with the price of its task type", async () => {
	const h = await harness("t2");
	const { work } = h.build();
	const gw = harnessGateway(h, work);
	const taskId = u(h, "c1");
	await startTask(h, work, "c1");
	for (const attemptNo of [1, 2]) {
		const runnerId = `runner-${attemptNo}`;
		const claims = h.claims(taskId, attemptNo);
		assert.ok("brief" in (await gw.call(claims, startCall(1, runnerId))));
		for (let turnNo = 1; turnNo <= 5; turnNo += 1) {
			const messages = [{ role: "user" as const, content: `turn ${turnNo}` }];
			const answer = await gw.call(claims, {
				call: "model",
				callNo: turnNo + 1,
				runnerId,
				turnNo,
				messages,
				tools: [],
			});
			assert.ok("text" in answer, `attempt ${attemptNo}, turn ${turnNo}`);
		}
		if (attemptNo === 1) {
			await work.sandboxExited({
				type: "SandboxExited",
				commandId: `exit/${taskId}/1`,
				at: AT,
				taskId,
				attempt: 1,
				exitCode: 1,
			});
		}
	}
	assert.equal(await h.tasks.countTrail(taskId, "model call"), 10);
	const rows = await taskRows(h.database, h.accountId);
	assert.equal(rows.attempts.length, 2);
	assert.deepEqual(rows.ledger, [{ source_ref: `task/${taskId}/charge`, kind: "charge", credits: String(-PRICE) }]);
});

test("T3: the credits go back after a stop at a limit, a cancel for a deletion, and an owner cancel before a start; one row each, also when the step runs two times", async () => {
	const h = await harness("t3");
	const { work } = h.build();
	const limit: TaskResult = { stop: "max_turns", answer: "", evidence: [], proposedFacts: [], notes: [] };
	await startTask(h, work, "limit");
	await startRunner(h, u(h, "limit"), 1);
	await startTask(h, work, "deletion");
	await startRunner(h, u(h, "deletion"), 1);
	await startTask(h, work, "before");
	await startTask(h, work, "after");
	await startRunner(h, u(h, "after"), 1);
	for (let run = 1; run <= 2; run += 1) {
		await work.afterResult(h.claims(u(h, "limit"), 1), limit);
		await work.cancel(u(h, "deletion"), "deletion");
		await work.cancel(u(h, "before"), "owner");
		await work.cancel(u(h, "after"), "owner");
	}
	const rows = await taskRows(h.database, h.accountId);
	const giveBacks = rows.ledger.filter((row) => row.kind === "give back");
	assert.deepEqual(
		giveBacks.map((row) => [row.source_ref, Number(row.credits)]),
		["before", "deletion", "limit"]
			.map((name) => [`task/${u(h, name)}/giveback`, PRICE] as const)
			.sort(([a], [b]) => a.localeCompare(b)),
	);
	assert.equal(rows.ledger.filter((row) => row.kind === "charge").length, 4);
	// 100 credits, four charges, three give backs.
	assert.equal(await h.writer.balance(), 100 - PRICE);
});

test("T4: the balance is a query on the ledger, and no table or view has a column for a sum", async () => {
	const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();
	try {
		// The owner role of the database sees each column of each schema.
		const { rows: columns } = await client.query<{ table_name: string; column_name: string }>(
			`SELECT table_name, column_name FROM information_schema.columns
			 WHERE table_schema IN ('public', 'admin')`,
		);
		assert.ok(
			columns.some((column) => column.table_name === "ledger"),
			"The test reads the real schema.",
		);
		const sums = columns.filter((column) =>
			/(^|_)(sum|sums|total|totals|balance|balances|average|avg|percent|percentage)(_|$)/.test(column.column_name),
		);
		assert.deepEqual(sums, []);
	} finally {
		await client.end();
	}
	const h = await harness("t4");
	const { work } = h.build();
	assert.equal(await h.writer.balance(), 100);
	await startTask(h, work, "c1");
	assert.equal(await h.writer.balance(), 100 - PRICE);
	await work.cancel(u(h, "c1"), "owner");
	assert.equal(await h.writer.balance(), 100);
});
