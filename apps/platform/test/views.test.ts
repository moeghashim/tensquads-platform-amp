// The views of the schema admin and the role of the views, against a real Postgres (task 10, S6 to S8).
import assert from "node:assert/strict";
import test from "node:test";

import type { GatewayCall } from "@tensquads/contracts";
import { adminTrailRead, costWriter, decisionWriter, operationsRows, platformWriter } from "@tensquads/petra";
import pg from "pg";

import { startCall } from "./gate-harness.js";
import { AT, harness, harnessGateway, pricedModel, setPrices } from "./task-harness.js";

const CREDIT = 50_000;
const TEST_TASK = { bot: "test-bot", taskType: "answer-question", goal: "Answer.", replyTo: "chat" } as const;

// One account with one task: a model call with a price, a step with no price, a failed check, a decider answer
// with an outcome, and an approval that waits.
async function knownSetup() {
	const h = await harness("s6");
	const provider = `p-${h.accountId}`;
	await setPrices(h, provider, { input: 1_000_000, output: 2_000_000 }, "2026-01-01T00:00:00.000Z");
	const { work, decide } = h.build();
	const check = async () => ({ verdict: "continue" as const, reason: "Not yet." });
	const gw = harnessGateway(h, work, undefined, check, pricedModel(provider));
	const taskId = `c1-${h.accountId}`;
	await work.startTask({ commandId: taskId, ...TEST_TASK });
	const claims = h.claims(taskId, 1);
	await gw.call(claims, startCall(1, "runner-1"));
	const model: GatewayCall = { call: "model", callNo: 2, runnerId: "runner-1", turnNo: 1, messages: [], tools: [] };
	await gw.call(claims, model);
	const step: GatewayCall = { ...model, call: "step", callNo: 3, toolCallId: "t", tool: "read_file", summary: "x" };
	await gw.call(claims, step);
	const result = { stop: "success" as const, answer: "a", evidence: [], proposedFacts: [], notes: [] };
	await gw.call(claims, { call: "result", callNo: 4, runnerId: "runner-1", result });
	const ref = `cmd/${taskId}-q/request-clear`;
	await decide.ask([
		{ sourceRef: ref, point: "request-clear", taskId: null, messageSeq: null, message: "secret text" },
	]);
	await decisionWriter(h.database, h.accountId).addOutcome({
		match: "exact",
		ref,
		commandId: `${taskId}-ok`,
		outcome: "approved",
		by: "owner",
		at: AT,
	});
	await h.actions.addApproval({ taskId, toolCallId: "call-9", contentHash: "h", ruleId: null, limit: null, at: AT });
	return { h, provider, taskId };
}

const numbers = (row: Record<string, unknown> | undefined, keys: readonly string[]) =>
	Object.fromEntries(keys.map((key) => [key, Number(row?.[key])]));

test("S6: the views for each account, task type, bot, model and decision point give the expected numbers", async () => {
	const { h, provider } = await knownSetup();
	const view = (name: Parameters<ReturnType<typeof platformWriter>["adminView"]>[0]) =>
		platformWriter(h.database).adminView(name, CREDIT);
	const mine = (rows: Record<string, unknown>[]) => rows.filter((row) => row.account_id === h.accountId);
	// 1000 input tokens at 1 USD and 10 output tokens at 2 USD for 1M tokens: 1000 + 20 millionths.
	assert.deepEqual(
		numbers(mine(await view("account"))[0], [
			"large_model",
			"sandbox",
			"decider",
			"cost",
			"credits_used",
			"difference",
		]),
		{
			large_model: 1020,
			sandbox: 0,
			decider: 0,
			cost: 1020,
			credits_used: 1,
			difference: CREDIT - 1020,
		},
	);
	assert.deepEqual(numbers(mine(await view("task_type"))[0], ["price", "tasks", "mean_cost", "above_price"]), {
		price: 1,
		tasks: 1,
		mean_cost: 1020,
		above_price: 0,
	});
	assert.deepEqual(numbers(mine(await view("bot"))[0], ["tasks", "cost", "mean_cost"]), {
		tasks: 1,
		cost: 1020,
		mean_cost: 1020,
	});
	const model = (await view("model")).find((row) => row.provider === provider);
	assert.deepEqual(numbers(model, ["calls", "input_tokens", "output_tokens", "cost"]), {
		calls: 1,
		input_tokens: 1000,
		output_tokens: 10,
		cost: 1020,
	});
	const point = mine(await view("decision_point")).find((row) => row.point === "request-clear");
	assert.deepEqual(numbers(point, ["answers", "used", "below_level", "approved", "rejected", "cost"]), {
		answers: 1,
		used: 1,
		below_level: 0,
		approved: 1,
		rejected: 0,
		cost: 0,
	});
	const usage = mine(await view("usage"));
	assert.deepEqual(usage.map((row) => [row.kind, Number(row.cost_rows)]).sort(), [
		["decider", 1],
		["large model", 2],
		["sandbox", 1],
	]);
	assert.ok(!JSON.stringify(await view("decision_point")).includes("secret text"), "No text of a message.");
});

test("S7: the operations view gives stuck tasks, waiting approvals, check failures and cost rows with no price", async () => {
	const { h, taskId } = await knownSetup();
	const rows = (await platformWriter(h.database).adminView("operations", CREDIT)).filter(
		(row) => row.account_id === h.accountId || row.account_id === null,
	);
	const items = (name: string) => rows.filter((row) => row.item === name && row.account_id === h.accountId);
	assert.deepEqual(
		items("approval that waits").map((row) => row.ref),
		[`${taskId}/call-9`],
	);
	assert.deepEqual(
		items("checks").map((row) => Number(row.count)),
		[1],
	);
	assert.deepEqual(
		items("failed checks").map((row) => Number(row.count)),
		[1],
	);
	assert.equal(items("cost row with no price").length, 2, "The sandbox row and the decider row.");
	assert.ok(rows.some((row) => row.item === "period with no shared cost" && row.ref === "2026-11/storage"));
	// The Platform object keeps an open task only when it has no trail row for longer than the attempt time.
	const open = items("open task") as unknown as Parameters<typeof operationsRows>[0];
	const limits = { attemptMaxMs: 1_800_000, takeTimeMs: 30_000 };
	const lastAt = Date.parse(String(open[0]?.at));
	assert.deepEqual(operationsRows(open, [], lastAt + 60_000, limits), []);
	assert.deepEqual(
		operationsRows(open, [], lastAt + 1_800_001, limits).map((row) => [row.item, row.ref]),
		[["stuck task", taskId]],
	);
	const request = { accountId: h.accountId, taskId, attemptNo: 2, putAt: lastAt };
	assert.deepEqual(
		operationsRows([], [request, { ...request, attemptNo: 3, takenAt: lastAt }], lastAt + 30_001, limits).map(
			(row) => row.item,
		),
		["sandbox request not taken"],
	);
});

test("S6, S7: no view has a column with the text of a message, a brief, a fact or an action", async () => {
	const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();
	try {
		const { rows } = await client.query<{ table_name: string; column_name: string; data_type: string }>(
			`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'admin'`,
		);
		assert.ok(rows.length > 0);
		// A text column of a view is an id or a name. No other text column exists.
		const names = new Set([
			"account_id",
			"bot",
			"task_type",
			"provider",
			"model",
			"point",
			"decider",
			"item",
			"ref",
			"task_id",
		]);
		for (const name of ["period", "kind"]) names.add(name);
		const texts = rows.filter((row) => row.data_type === "text" && !names.has(row.column_name));
		assert.deepEqual(texts, []);
	} finally {
		await client.end();
	}
});

test("S8: the role of the views cannot read an account table, and the trail read writes admin_reads before it gives the rows", async () => {
	const h = await harness("s8");
	await assert.rejects(
		h.database.transaction({ role: "admin views" }, (tx) => tx.query("SELECT * FROM public.costs")),
		/permission denied/,
	);
	await assert.rejects(
		h.database.transaction({ role: "admin views" }, (tx) => tx.query("SELECT * FROM public.trail")),
		/permission denied/,
	);
	const writer = costWriter(h.database, h.accountId);
	const order: string[] = [];
	const rows = await adminTrailRead<unknown>(
		{
			addAdminRead: async (read) => {
				order.push("admin_reads");
				await writer.addAdminRead(read);
			},
			taskTrail: async () => {
				order.push("rows");
				return [];
			},
		},
		{ readId: "read-1", adminRef: "super-admin", taskId: "t1", at: AT },
	);
	assert.deepEqual([order, rows], [["admin_reads", "rows"], []]);
	const reads = await h.database.transaction({ role: "petra", accountId: h.accountId }, (tx) =>
		tx.query<{ read_id: string; admin_ref: string }>("SELECT read_id, admin_ref FROM admin_reads"),
	);
	assert.deepEqual(reads, [{ read_id: "read-1", admin_ref: "super-admin" }]);
});
