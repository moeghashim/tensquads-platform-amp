// The tests of the full path of the check of a result (task 06): the local emulator, the launcher and real runner
// processes. The rule model marks an answer "WRONG: " by script, and the rule checker of Petra fails that answer.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { testBot } from "@tensquads/bots";

import { FullPath } from "./harness.js";

const path = new FullPath();

async function ownerMessages(taskId: string) {
	return path.query<{ type: string; text: string }>(
		`SELECT type, coalesce(body->>'summary', body->>'text') AS text FROM messages
		 WHERE task_id = $1 AND direction = 'out' ORDER BY seq`,
		[taskId],
	);
}

async function checks(taskId: string) {
	return path.query<{ summary: string; verdict: string }>(
		"SELECT summary, data->>'verdict' AS verdict FROM trail WHERE task_id = $1 AND kind = 'check' ORDER BY seq",
		[taskId],
	);
}

before(async () => {
	await path.start();
	await path.setUpAccount();
});

after(async () => {
	await path.stop();
});

test("K1 and K3: the script gives a wrong result first and a correct result second, and the owner gets only the second one", async () => {
	await path.ownerMessage("k1", "Please read 1 file, wrong then right.");
	await path.waitForTask("k1", "done");
	assert.deepEqual(
		(await checks("k1")).map((row) => [row.verdict, row.summary]),
		[
			["continue", "The result does not stand: Checker model: The result is marked wrong."],
			["stands", "The result stands: Checker model: The result is not empty and not marked wrong."],
		],
	);
	const sent = await ownerMessages("k1");
	const results = sent.filter((message) => message.type === "result");
	assert.equal(results.length, 1, "The owner gets one result.");
	assert.match(results[0]?.text ?? "", /^Result: Please read 1 file, wrong then right\./);
	assert.ok(
		sent.every((message) => !message.text.includes("WRONG")),
		"No message to the owner has the wrong result.",
	);
	// The reason of the failed check went back to the bot, in the same attempt.
	assert.match(results[0]?.text ?? "", /Message: Checker model: The result is marked wrong\./);
	const attempts = await path.query<{ n: string }>("SELECT count(*) AS n FROM attempts WHERE task_id = 'k1'");
	assert.equal(Number(attempts[0]?.n), 1);
});

test("K3: a result that always fails the check sends the bot back to work up to the limit of turns, and no result goes out", async () => {
	const { maxTurns } = testBot.taskTypes[0]?.limits ?? { maxTurns: 0 };
	await path.ownerMessage("k3", "Please give an answer that is always wrong.");
	await path.waitForTask("k3", "done");
	const [task] = await path.query<{ stop: string }>("SELECT stop FROM tasks WHERE id = 'k3'");
	assert.equal(task?.stop, "max_turns");
	const rows = await checks("k3");
	const failed = rows.slice(0, -1);
	assert.equal(failed.length, maxTurns, "Each turn gives one answer, and each answer fails the check.");
	assert.ok(failed.every((row) => row.verdict === "continue"));
	// The stop at the limit goes to Petra with no check.
	assert.equal(rows.at(-1)?.summary, "The result stands: A result with the stop max_turns has no check.");
	const sent = await ownerMessages("k3");
	assert.deepEqual(
		sent.filter((message) => message.type === "result"),
		[],
		"No result goes out.",
	);
	assert.equal(sent.filter((message) => /stopped at the limit max_turns/.test(message.text)).length, 1);
	assert.ok(sent.every((message) => !message.text.includes("WRONG")));
});
