// The test of the full path of a forget during a task (task 08, requirement M9, decision D11).
// The owner adds a fact with the tool of Petra, and a task gets it in its brief. The owner forgets the fact while
// the task runs. The proxy kills the runner at the next gateway call. The new attempt opens the old journal copy,
// and its model requests do not have the text of the fact.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { FullPath, waitFor } from "./harness.js";

const path = new FullPath();

const FACT = "Ahmed pays with the blue card.";
const FACT_ID = "cmd/m9-fact/fact";
const TASK = "m9-task";

function taskOf(pass: string): string {
	return (JSON.parse(Buffer.from(pass.split(".")[0] ?? "", "base64url").toString()) as { taskId: string }).taskId;
}

before(async () => {
	await path.start();
	await path.setUpAccount();
});

after(async () => {
	await path.stop();
});

test("M9: a fact in the brief is forgotten during the task, the runner is killed, and the model requests of the new attempt do not have the text", async () => {
	await path.ownerMessage("m9-fact", `remember on customers: ${FACT}`);
	await waitFor("the fact is in the memory", async () => {
		const rows = await path.query("SELECT 1 FROM facts WHERE source_ref = $1", [FACT_ID]);
		return rows.length > 0 ? true : undefined;
	});
	let firstPass = "";
	let models = 0;
	let release: () => void = () => {};
	const forgotten = new Promise<void>((resolve) => {
		release = resolve;
	});
	let killNext = false;
	// The second model call of the first runner waits for the forget. The next call of that runner kills it.
	path.rule = ({ call, pass }) => {
		if (taskOf(pass) !== TASK) return undefined;
		firstPass ||= pass;
		if (pass !== firstPass) return undefined;
		if (killNext) return "kill";
		if (call === "model" && ++models === 2) {
			return forgotten.then(() => {
				killNext = true;
			});
		}
		return undefined;
	};
	await path.ownerMessage(TASK, "Which card does Ahmed pay with? Please read 2 files.");
	await path.waitForCall("the first model call", (seen) => seen.pass === firstPass && seen.call === "model");
	const [task] = await path.query<{ brief: { facts: { id: string; text: string }[] } }>(
		"SELECT brief FROM tasks WHERE id = $1",
		[TASK],
	);
	assert.deepEqual(task?.brief.facts, [{ id: FACT_ID, text: FACT }], "The fact is in the brief.");
	await path.send({ type: "ForgetFact", commandId: "m9-forget", factId: FACT_ID });
	await waitFor("the forget list of the task has the fact", async () => {
		const rows = await path.query("SELECT 1 FROM task_inbox WHERE task_id = $1 AND fact_id = $2", [TASK, FACT_ID]);
		return rows.length > 0 ? true : undefined;
	});
	release();
	await path.waitForTask(TASK, "done", 120_000);
	assert.ok(path.killed.includes(firstPass), "The runner of the first attempt was killed.");
	const first = path.calls.filter((seen) => seen.pass === firstPass && seen.call === "model");
	assert.ok(
		first[0]?.messages?.some((message) => message.content.includes(FACT)),
		"Control: the model request before the forget has the text.",
	);
	const newAttempt = path.calls.filter((seen) => taskOf(seen.pass) === TASK && seen.pass !== firstPass);
	const start = newAttempt.find((seen) => seen.call === "start");
	assert.deepEqual((JSON.parse(start?.answer ?? "{}") as { forget?: string[] }).forget, [FACT_ID]);
	const journal = JSON.parse(start?.answer ?? "{}") as { journal?: string | null };
	assert.ok(journal.journal, "The new attempt opens the old journal copy.");
	const requests = newAttempt.filter((seen) => seen.call === "model");
	assert.ok(requests.length > 0, "The new attempt made model requests.");
	for (const request of requests) {
		assert.ok(request.messages && request.messages.length > 0);
		assert.ok(
			request.messages.every((message) => !message.content.includes(FACT)),
			`The model request ${request.callNo} of the new attempt has no text of the fact.`,
		);
	}
	const [attempt] = await path.query<{ n: string }>("SELECT count(*) AS n FROM attempts WHERE task_id = $1", [TASK]);
	assert.equal(Number(attempt?.n), 2);
	path.rule = () => undefined;
});
