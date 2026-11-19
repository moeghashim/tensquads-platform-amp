#!/usr/bin/env node

// The demo of task 09, against a running local platform (npm run dev:platform).
// The plan example: a customer writes "My eggs arrived broken. I want my $15 back." The owner has a refund limit
// of $20 for the reasons "damaged or missing". The decider answers three questions about the message in one call.
// Three sure answers give the $15 refund with no approval. $60 always gives an approval request.
// The demo prints the decision records of each task. They are read with DATABASE_URL, as a developer reads them.
// The first argument is the URL of the Worker. The default is http://localhost:8787.
import { connectDatabase, request, sendCommand, setUpAccount, sleep } from "./demo-client.mjs";

const call = (path, token, body) => request(process.argv[2] ?? "http://localhost:8787", path, token, body);
const run = Date.now();
const accountId = "account-a";
const db = await connectDatabase();

async function send(command) {
	const answer = await sendCommand(call, command);
	console.log(`POST /v1/commands ${command.type} -> ${answer.status} ${JSON.stringify(answer.body)}`);
}

// Waits until the task has a status in the list, or for 30 seconds.
async function waitForStatus(taskId, statuses) {
	for (let i = 0; i < 600; i++) {
		const { status, body } = await call(`/v1/tasks/${taskId}`, "owner-a");
		if (status === 200 && statuses.includes(body.status)) return body.status;
		await sleep(50);
	}
	return "unknown";
}

async function printDecisions(taskId) {
	const { rows } = await db.query(
		`SELECT point, decider, message_seq, answer, probability, shadow, used, ms FROM decisions
		 WHERE account_id = $1 AND (task_id = $2 OR starts_with(source_ref, 'cmd/' || $2 || '/'))
		 AND decider NOT IN ('code', 'owner') ORDER BY source_ref, decider`,
		[accountId, taskId],
	);
	console.log("   point            decider  message_seq  answer  probability  shadow  used   ms");
	for (const row of rows) {
		console.log(
			`   ${row.point.padEnd(16)} ${row.decider.padEnd(8)} ${String(row.message_seq).padEnd(12)} ${String(row.answer).padEnd(7)} ${String(row.probability).padEnd(12)} ${String(row.shadow).padEnd(7)} ${String(row.used).padEnd(6)} ${row.ms}`,
		);
	}
	const { rows: payments } = await db.query(
		"SELECT tool, status FROM actions WHERE account_id = $1 AND task_id = $2 ORDER BY tool_call_id",
		[accountId, taskId],
	);
	for (const row of payments) console.log(`   action ${row.tool}: ${row.status}`);
}

// The local Worker has no route for an external event (task 08 joins a customer to a task only through fromEvent,
// and the tool "start a task" does not give one). So the demo plays the customer with two local writes of the
// developer, through DATABASE_URL: one message in from the customer, and the customer reference of the task.
// The bot first reads 2 files, so the task has its customer before the refund reaches the gate.
const CUSTOMER_REF = `demo-customer-${run}`;
const PLAN_MESSAGE = "My eggs arrived broken. I want my $15 back.";

// A seq far above the seq of Petra, so the two never meet. Petra counts the seq in her storage.
let nextSeq = 900_000_000 + (run % 10_000_000) * 10;

async function customerMessage(taskId) {
	nextSeq += 1;
	await db.query(
		`INSERT INTO messages (account_id, source_ref, seq, direction, channel, sender, customer_ref, type, body, at)
		 VALUES ($1, $2, $3, 'in', 'whatsapp', 'customer', $4, 'message', $5, now() - interval '1 second')
		 ON CONFLICT DO NOTHING`,
		[accountId, `demo/${taskId}/in`, nextSeq, CUSTOMER_REF, JSON.stringify({ text: PLAN_MESSAGE })],
	);
}

async function linkCustomer(taskId) {
	for (let i = 0; i < 3000; i++) {
		const { rowCount } = await db.query("UPDATE tasks SET customer_ref = $2 WHERE id = $1", [taskId, CUSTOMER_REF]);
		if (rowCount === 1) return;
		await sleep(10);
	}
	throw new Error(`The task ${taskId} did not start.`);
}

async function customerTask(name, amount) {
	const taskId = `${name}-${run}`;
	console.log(`\n== The customer writes: "${PLAN_MESSAGE}"`);
	console.log(`   The owner asks: "Please read 2 files, then refund ${amount} to cust-1" (task ${taskId})`);
	await customerMessage(taskId);
	await send({
		type: "OwnerMessage",
		commandId: taskId,
		messageId: `m-${taskId}`,
		channel: "chat",
		text: `Please read 2 files, then refund ${amount} to cust-1`,
	});
	await linkCustomer(taskId);
	const status = await waitForStatus(taskId, ["done", "failed", "cancelled", "waiting for the owner"]);
	console.log(`GET /v1/tasks/${taskId} -> status ${status}`);
	const { rows } = await db.query(
		"SELECT count(*)::int AS n FROM messages WHERE account_id = $1 AND task_id = $2 AND type = 'approval_request'",
		[accountId, taskId],
	);
	console.log(`   approval requests: ${rows[0].n}`);
	console.log("== The decision records of the task (no text of the message)");
	await printDecisions(taskId);
}

await setUpAccount(call, new Date().toISOString());
console.log('== The owner sets a rule: refunds of $20 or less, for the reasons "damaged or missing"');
await send({
	type: "SetRule",
	commandId: `rule-${run}`,
	rule: { kind: "money_limit", params: { maxAmount: 20_000_000, reasons: "damaged or missing" } },
});
await customerTask("eggs-15", 15);
await customerTask("eggs-60", 60);
await db.end();
