#!/usr/bin/env node

// The demo of task 07, against a running local platform (npm run dev:platform).
// It shows the balance of credits before and after one task, and the full trail of that task.
// The balance and the trail are read from the database with DATABASE_URL, as a developer reads them.
// The first argument is the URL of the Worker. The default is http://localhost:8787.
import { connectDatabase, request, setUpAccount, sleep, waitForTaskEnd } from "./demo-client.mjs";

const base = process.argv[2] ?? "http://localhost:8787";
const at = new Date().toISOString();
const taskId = `demo-${Date.now()}`;
const accountId = "account-a";
const call = (path, token, body) => request(base, path, token, body);

const db = await connectDatabase();

// The balance is a query on the ledger. No table stores a sum (requirement T4).
async function balance() {
	const { rows } = await db.query("SELECT coalesce(sum(credits), 0) AS credits FROM ledger WHERE account_id = $1", [
		accountId,
	]);
	return Number(rows[0].credits);
}

await setUpAccount(call, at);
for (let i = 0; i < 100 && (await balance()) === 0; i++) await sleep(50);
console.log(`== The balance before the task: ${await balance()} credits`);

console.log(`\n== The owner sends: "Please read 2 files." (task ${taskId})`);
await call("/v1/commands", "owner-a", {
	type: "OwnerMessage",
	commandId: taskId,
	at,
	messageId: `m-${taskId}`,
	channel: "chat",
	text: "Please read 2 files.",
});
await waitForTaskEnd(call, taskId);

console.log(`\n== The full trail of the task, in one query (requirement T6)`);
const { rows } = await db.query(
	`SELECT seq, attempt_no, turn_no, kind, actor, summary FROM trail
	 WHERE account_id = $1 AND task_id = $2 ORDER BY seq`,
	[accountId, taskId],
);
for (const row of rows) {
	const where = `attempt ${row.attempt_no ?? "-"}, turn ${row.turn_no ?? "-"}`;
	console.log(
		`${String(row.seq).padStart(4)}  ${where.padEnd(20)} ${row.kind.padEnd(22)} ${row.actor.padEnd(9)} ${row.summary.slice(0, 50)}`,
	);
}

console.log(`\n== The ledger rows of the task`);
const ledger = await db.query("SELECT source_ref, kind, credits FROM ledger WHERE account_id = $1 AND task_id = $2", [
	accountId,
	taskId,
]);
for (const row of ledger.rows) console.log(`${row.source_ref}  ${row.kind}  ${row.credits}`);
console.log(`\n== The balance after the task: ${await balance()} credits`);
await db.end();
