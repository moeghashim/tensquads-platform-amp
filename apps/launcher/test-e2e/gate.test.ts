// The tests of the full path of the gate (task 05): the local emulator, the launcher and real runner processes.
// A runner is killed at each of the four points of requirement G12. Each send of the payment adapter is a line
// in the log of the Worker, so a test counts the sends of one action.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { FullPath, type ProxiedCall } from "./harness.js";

// The payment waits 1.5 s, so a test can kill the runner after "started" and before "done".
const path = new FullPath({ PAYMENT_HOLD_MS: "1500" });

function claimsOf(pass: string): { taskId: string; attemptNo: number } {
	return JSON.parse(Buffer.from(pass.split(".")[0] ?? "", "base64url").toString()) as {
		taskId: string;
		attemptNo: number;
	};
}

// True for a call of the first attempt of a task.
function firstAttempt(call: ProxiedCall, taskId: string): boolean {
	const claims = claimsOf(call.pass);
	return claims.taskId === taskId && claims.attemptNo === 1;
}

async function refundRequests(taskId: string): Promise<number> {
	const rows = await path.query<{ n: string }>(
		`SELECT count(*) AS n FROM trail WHERE task_id = $1 AND kind = 'model call'
		 AND data->'answer'->'toolCalls' @> '[{"name": "refund"}]'`,
		[taskId],
	);
	return Number(rows[0]?.n ?? 0);
}

async function actionRows(taskId: string) {
	return path.query<{ tool_call_id: string; status: string; amount: number }>(
		"SELECT tool_call_id, status, (content->>'amount')::numeric AS amount FROM actions WHERE task_id = $1",
		[taskId],
	);
}

async function resultText(taskId: string): Promise<string> {
	const [row] = await path.query<{ text: string }>(
		"SELECT body->>'summary' AS text FROM messages WHERE task_id = $1 AND type = 'result'",
		[taskId],
	);
	return row?.text ?? "";
}

before(async () => {
	await path.start();
	await path.setUpAccount();
	// Refunds of $50 or less need no approval (requirement G2).
	await path.send({
		type: "SetRule",
		commandId: "rule-50",
		rule: { kind: "money_limit", params: { maxAmount: 50_000_000 } },
	});
});

after(async () => {
	await path.stop();
});

// Runs one refund task of $15, with a kill in attempt 1, and checks that the refund went out one time.
async function refundWithKill(taskId: string, setUp: () => void): Promise<void> {
	setUp();
	await path.ownerMessage(taskId, "Please refund 15 to cust-1");
	await path.waitForTask(taskId, "done");
	path.rule = () => undefined;
	path.answerRule = () => undefined;
	assert.equal(
		path.killed.filter((pass) => claimsOf(pass).taskId === taskId).length,
		1,
		"The runner was killed one time.",
	);
	assert.deepEqual(
		(await actionRows(taskId)).map((row) => [row.tool_call_id, row.status]),
		[["call-1", "done"]],
	);
	assert.equal(path.payments(`${taskId}/call-1`), 1, "The payment adapter has one send.");
	assert.equal(await refundRequests(taskId), 1, "The model asked for the refund one time.");
}

test("G12 and G5: the runner is killed before the call to the gate, and the refund goes out one time", async () => {
	await refundWithKill("g12-before", () => {
		path.rule = (call) => (firstAttempt(call, "g12-before") && call.call === "action" ? "kill" : undefined);
	});
});

test("G12 and G6: the runner is killed after started and before done, and the refund goes out one time", async () => {
	await refundWithKill("g12-started", () => {
		path.rule = (call) => {
			if (firstAttempt(call, "g12-started") && call.call === "action") {
				// The payment waits 1.5 s. The kill comes while the action is "started".
				setTimeout(() => path.kill(call.pass), 400);
			}
			return undefined;
		};
	});
});

test("G12 and G7: the runner is killed after done, before the answer reaches it, and the refund goes out one time", async () => {
	await refundWithKill("g12-done", () => {
		path.answerRule = (call) => (firstAttempt(call, "g12-done") && call.call === "action" ? "kill" : undefined);
	});
});

test("G12: the runner is killed after the answer came back and before the next copy, and the refund goes out one time", async () => {
	await refundWithKill("g12-answer", () => {
		path.rule = (call) => {
			if (!firstAttempt(call, "g12-answer") || call.call !== "journal") return undefined;
			const answered = path.calls.some((seen) => seen.pass === call.pass && seen.call === "action");
			return answered ? "kill" : undefined;
		};
	});
});

test("G8: the model asks for $40, then for $45 with the same tool-call id; the gate refuses, and one send goes out", async () => {
	const taskId = "g8";
	path.rule = (call) => {
		if (!firstAttempt(call, taskId) || call.call !== "journal") return undefined;
		const answered = path.calls.some((seen) => seen.pass === call.pass && seen.call === "action");
		// The copy before the action is lost, so the new attempt asks the model again. The next copy never comes.
		return answered ? "kill" : "drop";
	};
	await path.ownerMessage(taskId, "Please refund 40 then 45 after a restart to cust-1");
	await path.waitForTask(taskId, "done");
	path.rule = () => undefined;
	assert.equal(await refundRequests(taskId), 2, "The model asked two times with the same tool-call id.");
	const rows = await actionRows(taskId);
	assert.deepEqual(
		rows.map((row) => [row.tool_call_id, row.status, Number(row.amount)]),
		[["call-1", "done", 40]],
	);
	assert.equal(path.payments(`${taskId}/call-1`), 1, "No second send goes out.");
	const refusals = await path.query("SELECT 1 FROM trail WHERE task_id = $1 AND kind = 'refusal'", [taskId]);
	assert.equal(refusals.length, 1, "The refusal is in the trail.");
});

test("G11: a file is appended after the last copy and the runner is killed; the append is there one time", async () => {
	const taskId = "g11";
	path.rule = (call) => {
		if (!firstAttempt(call, taskId) || call.call !== "journal") return undefined;
		const drafts = path.calls.filter((seen) => seen.pass === call.pass && seen.call === "draft").length;
		// The second append went to the draft store. Its turn has no copy yet.
		return drafts >= 2 ? "kill" : undefined;
	};
	await path.ownerMessage(taskId, "Please append 2 lines");
	await path.waitForTask(taskId, "done");
	path.rule = () => undefined;
	const text = await resultText(taskId);
	assert.ok(text.endsWith("line 1\nline 2\n"), text);
	assert.equal(text.split("line 2\n").length - 1, 1, text);
	const attempts = await path.query("SELECT 1 FROM attempts WHERE task_id = $1", [taskId]);
	assert.equal(attempts.length, 2);
});
