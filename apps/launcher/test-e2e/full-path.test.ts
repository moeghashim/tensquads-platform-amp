// The tests of the full path (task 04): the local emulator, the launcher and real runner processes.
// Run: DATABASE_URL=... DB_USER_PASSWORD=... npm run test:e2e -w @tensquads/launcher
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { testBot } from "@tensquads/bots";
import { signPass } from "@tensquads/gateway";

import { AT, FullPath, PASS_KEY, waitFor } from "./harness.js";

const path = new FullPath();

function attemptOf(pass: string): number {
	const claims = JSON.parse(Buffer.from(pass.split(".")[0] ?? "", "base64url").toString()) as { attemptNo: number };
	return claims.attemptNo;
}

function taskOf(pass: string): string {
	return (JSON.parse(Buffer.from(pass.split(".")[0] ?? "", "base64url").toString()) as { taskId: string }).taskId;
}

async function resultText(taskId: string): Promise<string> {
	const [row] = await path.query<{ text: string }>(
		"SELECT body->>'summary' AS text FROM messages WHERE task_id = $1 AND type = 'result'",
		[taskId],
	);
	return row?.text ?? "";
}

async function attempts(taskId: string) {
	return path.query<{ attempt_no: number; reason: string; exit: string | null }>(
		"SELECT attempt_no, reason, exit FROM attempts WHERE task_id = $1 ORDER BY attempt_no",
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

let oldPass = "";
let endedPass = "";

test("L5: the runner is killed during a turn, a new attempt continues from the last copy, and each row has its attempt", async () => {
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let steps = 0;
	path.rule = ({ call, pass }) => {
		if (taskOf(pass) !== "l5") return undefined;
		if (attemptOf(pass) === 1 && call === "step" && ++steps === 2) return "kill";
		if (attemptOf(pass) === 2 && call === "model") return held;
		return undefined;
	};
	await path.ownerMessage("l5", "Please read 3 files.");
	const second = await path.waitForCall(
		"a call of attempt 2",
		(seen) => taskOf(seen.pass) === "l5" && attemptOf(seen.pass) === 2,
	);
	oldPass = path.killed.find((pass) => taskOf(pass) === "l5") ?? "";
	// L9: while attempt 2 runs, the pass of attempt 1 is refused.
	const old = await path.gateway(oldPass, { call: "inbox", callNo: 99, runnerId: "old" });
	assert.equal(old.status, 403);
	assert.deepEqual(await old.json(), { refused: "attempt" });
	release();
	await path.waitForTask("l5", "done");
	endedPass = second.pass;
	assert.deepEqual(
		(await attempts("l5")).map((row) => [row.attempt_no, row.reason]),
		[
			[1, "first"],
			[2, "after a failure"],
		],
	);
	const trail = await path.query<{ attempt_no: number; turn_no: number | null; kind: string; summary: string }>(
		"SELECT attempt_no, turn_no, kind, summary FROM trail WHERE task_id = $1 AND attempt_no IS NOT NULL ORDER BY seq",
		["l5"],
	);
	assert.ok(trail.some((row) => row.attempt_no === 1));
	assert.ok(trail.some((row) => row.attempt_no === 2));
	const keys = trail.map((row) => `${row.attempt_no}/${row.turn_no}/${row.kind}/${row.summary}`);
	assert.equal(new Set(keys).size, keys.length, `A row is there two times: ${keys.join(", ")}`);
	// The turn that was lost runs again in attempt 2: attempt 2 has the model call of turn 2.
	assert.ok(trail.some((row) => row.attempt_no === 2 && row.turn_no === 2 && row.kind === "model call"));
	assert.match(await resultText("l5"), /^Result: Please read 3 files\./);
});

test("L13 and L11: each attempt records its versions, and Petra and the runner have one version of the bot", async () => {
	const rows = await path.query<{ versions: Record<string, string> }>(
		"SELECT versions FROM attempts WHERE task_id = 'l5' ORDER BY attempt_no",
	);
	assert.equal(rows.length, 2);
	for (const { versions } of rows) {
		assert.equal(versions.botVersion, testBot.version);
		assert.equal(versions.workerCommit, "local");
		assert.match(versions.runnerCommit ?? "", /^[0-9a-f]{40}$|^unknown$/);
		assert.match(versions.pluginListHash ?? "", /^[0-9a-f]{64}$/);
		assert.deepEqual([versions.provider, versions.model], ["test", "rule"]);
	}
});

test("L12: a second runner with the pass of one attempt is refused at start", async () => {
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	path.rule = ({ call, pass }) => (taskOf(pass) === "l12" && call === "model" ? held : undefined);
	await path.ownerMessage("l12", "Please read 1 file.");
	const start = await path.waitForCall(
		"the start of the first runner",
		(seen) => taskOf(seen.pass) === "l12" && seen.call === "start",
	);
	assert.equal(start.status, 200);
	const exitCode = await path.runRunner(start.pass);
	assert.equal(exitCode, 3, "The second runner exits after the refusal.");
	const refused = path.calls.filter(
		(seen) => seen.pass === start.pass && seen.call === "start" && seen.status === 403,
	);
	assert.equal(refused.length, 1);
	assert.deepEqual(JSON.parse(refused[0]?.answer ?? "{}"), { refused: "runner" });
	release();
	await path.waitForTask("l12", "done");
	assert.equal((await attempts("l12")).length, 1);
});

test("L3: the runner is killed after inbox and before the next copy, and the new model gets the message one time", async () => {
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let heldOnce = false;
	path.rule = ({ call, pass }) => {
		if (taskOf(pass) !== "l3" || attemptOf(pass) !== 1) return undefined;
		const took = path.calls.some(
			(seen) => seen.pass === pass && seen.call === "inbox" && seen.answer.includes("Also check Sunday."),
		);
		if (took) return "kill";
		if (call === "model" && !heldOnce) {
			heldOnce = true;
			return held;
		}
		return undefined;
	};
	await path.ownerMessage("l3", "Please read 2 files.");
	await path.waitForTask("l3", "running");
	await path.ownerMessage("l3-more", "Also check Sunday.");
	await waitFor("the message is in the inbox of the task", async () => {
		const rows = await path.query("SELECT 1 FROM task_inbox WHERE task_id = 'l3'");
		return rows.length > 0 ? true : undefined;
	});
	release();
	await path.waitForTask("l3", "done");
	assert.equal((await attempts("l3")).length, 2);
	const text = await resultText("l3");
	assert.equal(text.split("Also check Sunday.").length - 1, 1, text);
});

test("L6 and L5: a question parks, the exit report two times adds no attempt, and the answer is the result of the tool", async () => {
	path.rule = () => undefined;
	await path.ownerMessage("l6", "Please ask, then read 1 file.");
	await path.waitForTask("l6", "waiting for the owner");
	const report = { accountId: "account-a", taskId: "l6", attemptNo: 1, exitCode: 0 };
	await waitFor("the attempt has its exit", async () => ((await attempts("l6"))[0]?.exit ? true : undefined));
	for (let i = 0; i < 2; i++) {
		const answer = await fetch(`${path.proxyUrl}/v1/launcher/report`, {
			method: "POST",
			headers: { authorization: "Bearer e2e-launcher-key" },
			body: JSON.stringify(report),
		});
		assert.equal(answer.status, 200);
	}
	await new Promise((resolve) => setTimeout(resolve, 1500));
	assert.equal((await attempts("l6")).length, 1, "A runner that exits on purpose is not a failure.");
	const [question] = await path.query<{ id: string }>(
		"SELECT body->>'questionId' AS id FROM messages WHERE task_id = 'l6' AND type = 'question'",
	);
	assert.ok(question?.id);
	await path.send({ type: "OwnerAnswer", commandId: "l6-answer", questionId: question.id, text: "Monday" });
	await path.waitForTask("l6", "done");
	assert.deepEqual(
		(await attempts("l6")).map((row) => row.reason),
		["first", "after an answer"],
	);
	// The answer of the owner is the output of the same tool call that asked the question.
	assert.match(await resultText("l6"), /^\{"text":"Monday"\}$/m);
});

test("L9: a pass of a different task, of an old attempt, of a task that ended, or after its end time is refused", async () => {
	const call = { call: "inbox", callNo: 1, runnerId: "r" };
	const old = await path.gateway(oldPass, call);
	assert.equal(old.status, 403, "old attempt");
	const ended = await path.gateway(endedPass, call);
	assert.deepEqual([ended.status, await ended.json()], [403, { refused: "task" }], "task that ended");
	const claims = {
		accountId: "account-a",
		bot: "test-bot",
		attemptNo: 1,
		endsAt: Date.parse(AT) + 3_600_000 * 24 * 365,
	};
	const other = await path.gateway(await signPass({ ...claims, taskId: "no-such-task" }, PASS_KEY), call);
	assert.deepEqual([other.status, await other.json()], [403, { refused: "task" }], "different task");
	const late = await path.gateway(
		await signPass({ ...claims, taskId: "l12", endsAt: Date.now() - 1000 }, PASS_KEY),
		call,
	);
	assert.equal(late.status, 401, "after the end time");
	assert.deepEqual(await late.json(), { code: "unauthorized", message: "Unauthorized." });
});
