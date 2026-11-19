#!/usr/bin/env node

// The demo of task 08, against a running local platform (npm run dev:platform).
// The owner keeps an Arabic fact. A task finds it with a word in a different form of alef and with diacritics.
// Then the owner forgets the fact: a second task does not find it. Then the owner undoes the forget.
// The fact rows and the briefs are read from the database with DATABASE_URL, as a developer reads them.
// The first argument is the URL of the Worker. The default is http://localhost:8787.
import { connectDatabase, request, setUpAccount, sleep, waitForTaskEnd } from "./demo-client.mjs";

const base = process.argv[2] ?? "http://localhost:8787";
const run = Date.now();
const accountId = "account-a";
const call = (path, token, body) => request(base, path, token, body);

const db = await connectDatabase();

async function send(command) {
	const { status } = await call("/v1/commands", "owner-a", { at: new Date().toISOString(), ...command });
	console.log(`POST /v1/commands ${command.type}${command.text ? ` "${command.text}"` : ""} -> ${status}`);
}

// The fact of this run has the source reference of the command that kept it.
const factId = `cmd/remember-${run}/fact`;

async function factRow() {
	const { rows } = await db.query("SELECT source_ref, status FROM facts WHERE account_id = $1 AND source_ref = $2", [
		accountId,
		factId,
	]);
	return rows[0];
}

// Starts a task and waits until it ends. Returns the facts of its brief.
async function taskFacts(name, goal) {
	const taskId = `demo-${name}-${run}`;
	await send({ type: "OwnerMessage", commandId: taskId, messageId: `m-${taskId}`, channel: "chat", text: goal });
	await waitForTaskEnd(call, taskId);
	const { rows } = await db.query("SELECT brief->'facts' AS facts FROM tasks WHERE account_id = $1 AND id = $2", [
		accountId,
		taskId,
	]);
	return rows[0]?.facts ?? [];
}

// Petra handles a command after the answer of the Worker, so the demo waits for the new status.
async function waitStatus(status) {
	for (let i = 0; i < 200; i++) {
		if ((await factRow())?.status === status) break;
		await sleep(50);
	}
	return (await factRow()).status;
}

function showFacts(facts) {
	if (facts.length === 0) console.log("   (no fact in the brief)");
	for (const fact of facts) console.log(`   ${fact.id}: ${fact.text}`);
}

await setUpAccount(call, new Date().toISOString());
const fact = "أحمد يفضل القهوة العربية";
console.log(`== The owner keeps a fact on the page customers: "${fact}"`);
await send({
	type: "OwnerMessage",
	commandId: `remember-${run}`,
	messageId: `m-remember-${run}`,
	channel: "chat",
	text: `remember on customers: ${fact}`,
});
let row;
for (let i = 0; i < 200 && !row; i++) {
	row = await factRow();
	if (!row) await sleep(50);
}
console.log(`fact ${row.source_ref}: status ${row.status}`);

const goal = "اخبر احمد عن القَهوة";
console.log(`\n== A task with the goal "${goal}": "احمد" has a plain alef, and "القَهوة" has a diacritic`);
showFacts(await taskFacts("search", goal));

console.log("\n== The owner forgets the fact");
await send({ type: "ForgetFact", commandId: `forget-${run}`, factId: row.source_ref });
console.log(`fact ${row.source_ref}: status ${await waitStatus("forgotten")}`);
console.log("A new task with the same goal:");
showFacts(await taskFacts("forgotten", goal));

console.log("\n== The owner undoes the forget");
await send({ type: "UndoForget", commandId: `undo-${run}`, factId: row.source_ref });
console.log(`fact ${row.source_ref}: status ${await waitStatus("current")}`);
console.log("A new task with the same goal:");
showFacts(await taskFacts("undone", goal));
await db.end();
