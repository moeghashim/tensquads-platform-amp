// The cost rows of a task, against a real Postgres (task 10, requirements S1, S2, S3 and S9).
// The costs package holds the rules. Petra writes the rows. The test joins them as the Durable Object does.
import assert from "node:assert/strict";
import test from "node:test";

import { ruleChecker } from "@tensquads/adapters-test";
import { checker } from "@tensquads/checker";
import type { GatewayCall, TaskResult } from "@tensquads/contracts";
import { ports, startSystem } from "@tensquads/core";
import { conversationCommand, conversationText, platformWriter } from "@tensquads/petra";
import pg from "pg";

import { gateSetup, refund, startCall, statusOf } from "./gate-harness.js";
import { AT, costRows, harness, harnessGateway, pricedModel, setPrices } from "./task-harness.js";

const TEST_TASK = { bot: "test-bot", taskType: "answer-question", goal: "Answer.", replyTo: "chat" } as const;
const u = (h: { accountId: string }, name: string) => `${name}-${h.accountId}`;

const modelCall = (callNo: number, runnerId: string, turnNo: number): GatewayCall => ({
	call: "model",
	callNo,
	runnerId,
	turnNo,
	messages: [{ role: "user", content: `turn ${turnNo}` }],
	tools: [],
});

const exited = (taskId: string, attempt: number) =>
	({ type: "SandboxExited", commandId: `exit/${taskId}/${attempt}`, at: AT, taskId, attempt, exitCode: 1 }) as const;

test("S1: the same gateway call two times gives one row; a turn that runs again in a new attempt gives two rows; the cost of the task is the sum of both", async () => {
	const h = await harness("s1");
	const provider = `p-${h.accountId}`;
	await setPrices(h, provider, { input: 3_000_000, output: 15_000_000 }, "2026-01-01T00:00:00.000Z");
	const { work } = h.build();
	const model = pricedModel(provider);
	const gw = harnessGateway(h, work, undefined, undefined, model);
	const taskId = u(h, "c1");
	await work.startTask({ commandId: taskId, ...TEST_TASK });

	assert.ok("brief" in (await gw.call(h.claims(taskId, 1), startCall(1, "runner-1"))));
	await gw.call(h.claims(taskId, 1), modelCall(2, "runner-1", 1));
	await gw.call(h.claims(taskId, 1), modelCall(2, "runner-1", 1));
	// Petra stopped after the trail row and before she saved the answer. A new gateway finds the trail row.
	const again = harnessGateway(h, work, undefined, undefined, model);
	await again.call(h.claims(taskId, 1), modelCall(2, "runner-1", 1));
	assert.equal(model.calls(), 1, "The model ran one time.");
	assert.equal((await costRows(h.database, h.accountId)).length, 2, "One row for the input and one for the output.");

	// The sandbox stops in the turn. The turn runs again in a new attempt: that is a real second call.
	await work.sandboxExited(exited(taskId, 1));
	assert.ok("brief" in (await gw.call(h.claims(taskId, 2), startCall(1, "runner-2"))));
	await gw.call(h.claims(taskId, 2), modelCall(2, "runner-2", 1));
	const rows = await costRows(h.database, h.accountId);
	assert.deepEqual(
		rows.map((row) => [row.source_ref, row.attempt_no, row.kind, Number(row.amount)]),
		[
			[`model/${taskId}/1/2/${provider}-1/input`, 1, "large model", 3000],
			[`model/${taskId}/1/2/${provider}-1/output`, 1, "large model", 150],
			[`model/${taskId}/2/2/${provider}-2/input`, 2, "large model", 3000],
			[`model/${taskId}/2/2/${provider}-2/output`, 2, "large model", 150],
		],
	);
	// The cost of the task is a query on its rows, over all its attempts.
	assert.equal(await h.costs.taskCost(taskId), 6300);
});

test("S1: three step calls 400 ms apart give three sandbox rows of 400 ms each, and their amount is not 0", async () => {
	const h = await harness("s1-step");
	// The price starts in 2030, so the rows of the other tests in 2026 keep no price.
	const startsAt = "2030-01-01T00:00:00.000Z";
	// 3700 millionths of a US dollar for 1000 seconds. One step of 400 ms is 1.48 millionths.
	const price = 3700;
	await platformWriter(h.database).addUnitPrice({
		provider: "launcher",
		model: "",
		unit: "1k seconds",
		price,
		startsAt,
	});
	h.setNow("2030-06-01T10:00:00.000Z");
	const { work } = h.build();
	const gw = harnessGateway(h, work);
	const taskId = u(h, "c1");
	await work.startTask({ commandId: taskId, ...TEST_TASK });
	await gw.call(h.claims(taskId, 1), startCall(1, "runner-1"));
	for (const callNo of [2, 3, 4]) {
		h.setNow(new Date(Date.parse("2030-06-01T10:00:00.000Z") + (callNo - 1) * 400).toISOString());
		const step: GatewayCall = {
			call: "step",
			callNo,
			runnerId: "runner-1",
			turnNo: 1,
			toolCallId: `call-${callNo}`,
			tool: "read_file",
			summary: "read a file",
		};
		await gw.call(h.claims(taskId, 1), step);
		// The same call two times adds one row.
		await gw.call(h.claims(taskId, 1), step);
	}
	const rows = await costRows(h.database, h.accountId);
	assert.deepEqual(
		rows.map((row) => [row.source_ref, row.kind, row.provider, Number(row.units), row.unit, Number(row.unit_price)]),
		[2, 3, 4].map((callNo) => [
			`task/${taskId}/1/${callNo}/sandbox`,
			"sandbox",
			"launcher",
			400,
			"1k seconds",
			price,
		]),
	);
	const total = rows.reduce((sum, row) => sum + Number(row.amount), 0);
	assert.ok(total > 0, "The sandbox cost is not 0.");
	// Each row is rounded one time. The sum is within half a millionth for each row of the true total.
	const exact = (3 * 400 * price) / 1_000_000;
	assert.ok(Math.abs(total - exact) <= rows.length * 0.5, `${total} is near ${exact}`);
	assert.ok(Math.abs(total - Math.round(exact)) <= rows.length * 0.5);
});

test("S1: the checker model, a decider in a command of Petra, an outside service and a model call of Petra each add their rows", async () => {
	const setup = await gateSetup("s1-sources", "refund 15 to cust-1");
	const { h, taskId } = setup;
	// A rule of $20 lets the refund go out with no approval. The rule has no reasons, so no decider is asked.
	const rule = { kind: "money_limit", params: { maxAmount: 20_000_000 } };
	await setup.work.setRule({ type: "SetRule", commandId: `${taskId}-rule`, at: AT, rule });
	// An outside service: the payment answers "done" one time, so the gate writes one row.
	assert.equal(statusOf(await setup.action({ content: refund(15) })), "done");
	assert.equal(statusOf(await setup.action({ content: refund(15) })), "done");

	// The checker model reports its usage. The tests by code of this check are empty.
	const port = (await startSystem([ruleChecker()])).port(ports.checkerModel);
	const gw = harnessGateway(h, setup.work, undefined, checker(port, { "test-bot": [] }));
	const result: TaskResult = {
		stop: "success",
		answer: "The refund is done.",
		evidence: [],
		proposedFacts: [],
		notes: [],
	};
	const verdict = await gw.call(h.claims(taskId, 1), { call: "result", callNo: 9, runnerId: "runner-1", result });
	assert.deepEqual(verdict, {
		verdict: "stands",
		reason: "Checker model: The result is not empty and not marked wrong.",
	});

	// A decider in a command of Petra, and a model call of Petra in a command with no conversation.
	const { decide, core } = h.build();
	const commandId = u(h, "cmd");
	await decide.ask([
		{
			sourceRef: `cmd/${commandId}/request-clear`,
			point: "request-clear",
			taskId: null,
			messageSeq: null,
			message: "x",
		},
	]);
	await core.accept(
		{ type: "OwnerMessage", commandId, at: AT, messageId: `m-${commandId}`, channel: "chat", text: "hello" },
		"owner",
	);
	await core.work();

	const rows = (await costRows(h.database, h.accountId)).map((row) => [row.source_ref, row.kind, row.provider]);
	const of = (kind: string) => rows.filter((row) => row[1] === kind);
	assert.deepEqual(of("outside service"), [[`action/${taskId}/call-1/service`, "outside service", "test-payment"]]);
	assert.deepEqual(of("checker model"), [[`model/${taskId}/1/9/rule-check-1/call`, "checker model", "test"]]);
	assert.deepEqual(of("decider"), [[`cmd/${commandId}/model/fixed-1/call`, "decider", "test"]]);
	assert.deepEqual(
		of("large model").map((row) => row[0]),
		[`cmd/${commandId}/model/rule-1/input`, `cmd/${commandId}/model/rule-1/output`],
	);
});

test("S2: a cost row keeps the price of its time, and a new price does not change an old row", async () => {
	const h = await harness("s2");
	const provider = `p-${h.accountId}`;
	await setPrices(h, provider, { input: 1_000_000, output: 0 }, "2026-01-01T00:00:00.000Z");
	const { work } = h.build();
	const gw = harnessGateway(h, work, undefined, undefined, pricedModel(provider));
	const taskId = u(h, "c1");
	await work.startTask({ commandId: taskId, ...TEST_TASK });
	await gw.call(h.claims(taskId, 1), startCall(1, "runner-1"));
	await gw.call(h.claims(taskId, 1), modelCall(2, "runner-1", 1));
	const before = await costRows(h.database, h.accountId);

	// A new price from 11:00, and a price that starts before the first call. Neither changes the first row.
	await setPrices(h, provider, { input: 2_000_000, output: 0 }, "2026-11-18T11:00:00.000Z");
	await setPrices(h, provider, { input: 5_000_000, output: 0 }, "2026-06-01T00:00:00.000Z");
	h.setNow("2026-11-18T12:00:00.000Z");
	await gw.call(h.claims(taskId, 1), modelCall(3, "runner-1", 2));
	const after = await costRows(h.database, h.accountId);
	assert.deepEqual(after.slice(0, 2), before);
	assert.deepEqual(
		after.filter((row) => row.unit === "1M input tokens").map((row) => [Number(row.unit_price), Number(row.amount)]),
		[
			[1_000_000, 1000],
			[2_000_000, 2000],
		],
	);
});

test("S3: costs and credits are in different tables, no table has a stored sum, and the admin schema has only views", async () => {
	const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();
	try {
		const { rows: columns } = await client.query<{ table_name: string; column_name: string }>(
			`SELECT c.table_name, c.column_name FROM information_schema.columns c
			 JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
			 WHERE c.table_schema IN ('public', 'admin') AND t.table_type = 'BASE TABLE'`,
		);
		const of = (table: string) => columns.filter((c) => c.table_name === table).map((c) => c.column_name);
		assert.ok(of("costs").includes("amount") && !of("costs").includes("credits"), "A cost is not a credit.");
		assert.ok(of("ledger").includes("credits") && !of("ledger").includes("amount"), "A credit is not a cost.");
		const sums = columns.filter((column) =>
			/(^|_)(sum|sums|total|totals|balance|balances|average|avg|percent|percentage)(_|$)/.test(column.column_name),
		);
		assert.deepEqual(sums, []);
		// A view calculates its numbers when it is read. The schema admin stores nothing.
		const { rows: kinds } = await client.query<{ relkind: string }>(
			`SELECT DISTINCT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			 WHERE n.nspname = 'admin'`,
		);
		assert.deepEqual(
			kinds.map((row) => row.relkind),
			["v"],
		);
	} finally {
		await client.end();
	}
});

test("S9: a task stops with max_budget when its cost rows over two attempts reach the limit of its task type", async () => {
	const h = await harness("s9");
	const provider = `p-${h.accountId}`;
	// 1000 input tokens at 100 USD for 1M tokens cost 0.1 USD. The limit of the test bot is 0.5 USD.
	await setPrices(h, provider, { input: 100_000_000, output: 0 }, "2026-01-01T00:00:00.000Z");
	const { work } = h.build();
	const model = pricedModel(provider);
	const gw = harnessGateway(h, work, undefined, undefined, model);
	const taskId = u(h, "c1");
	await work.startTask({ commandId: taskId, ...TEST_TASK });
	await gw.call(h.claims(taskId, 1), startCall(1, "runner-1"));
	for (const callNo of [2, 3, 4])
		assert.ok("text" in (await gw.call(h.claims(taskId, 1), modelCall(callNo, "runner-1", callNo - 1))));
	await work.sandboxExited(exited(taskId, 1));
	await gw.call(h.claims(taskId, 2), startCall(1, "runner-2"));
	for (const callNo of [2, 3])
		assert.ok("text" in (await gw.call(h.claims(taskId, 2), modelCall(callNo, "runner-2", callNo + 1))));
	assert.equal(await h.costs.taskCost(taskId), 500_000);

	// At the limit, the gateway does not call the model.
	assert.deepEqual(await gw.call(h.claims(taskId, 2), modelCall(4, "runner-2", 6)), { limit: "max_budget" });
	assert.equal(model.calls(), 5);
	const stop: TaskResult = { stop: "max_budget", answer: "", evidence: [], proposedFacts: [], notes: [] };
	await gw.call(h.claims(taskId, 2), { call: "result", callNo: 5, runnerId: "runner-2", result: stop });
	const task = await h.tasks.task(taskId);
	assert.deepEqual([task?.status, task?.stop], ["done", "max_budget"]);
});

test("S1: a model call of Petra in her conversation has the key of the command of the newest owner message", () => {
	const messages = [
		{ role: "user" as const, content: conversationText("c-1", "chat", "hello") },
		{ role: "assistant" as const, content: "Done." },
		{ role: "user" as const, content: conversationText("c-2", "chat", "[command fake on chat] text") },
		{ role: "tool" as const, content: "{}" },
	];
	assert.equal(conversationCommand(messages), "c-2");
	assert.equal(conversationCommand([{ role: "user", content: "The earlier messages of the owner:" }]), undefined);
});
