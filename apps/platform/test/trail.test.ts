// The trail of a task, against a real Postgres (task 07, requirements T5 to T8).
// The trail package holds the rules. Petra writes the rows. The test joins them as the Durable Object does.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { Command, GatewayCall, TaskResult } from "@tensquads/contracts";
import { petra } from "@tensquads/petra";

import { startCall } from "./gate-harness.js";
import { type Harness, harness, harnessGateway, startRunner } from "./task-harness.js";

const u = (h: { accountId: string }, name: string) => `${name}-${h.accountId}`;

const DAY_MS = 86_400_000;
// The retention rule uses the time of the database. The test makes its times from the time of this machine.
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

const TEST_TASK = { bot: "test-bot", taskType: "answer-question", goal: "Answer.", replyTo: "chat" } as const;
const SUCCESS: TaskResult = { stop: "success", answer: "9", evidence: [], proposedFacts: [], notes: [] };

const modelCall = (callNo: number, runnerId: string, turnNo: number): GatewayCall => ({
	call: "model",
	callNo,
	runnerId,
	turnNo,
	messages: [{ role: "user", content: `turn ${turnNo}` }],
	tools: [],
});

// The rows of the trail table, read with the role of Petra.
function trailRows(h: Harness, taskId: string) {
	return h.database.transaction({ role: "petra", accountId: h.accountId }, (tx) =>
		tx.query<{
			source_ref: string;
			task_id: string | null;
			attempt_no: number | null;
			turn_no: number | null;
			seq: string;
			kind: string;
			actor: string;
			data: unknown;
			blob_key: string | null;
			blob_hash: string | null;
			at: Date;
		}>("SELECT * FROM trail WHERE task_id = $1 ORDER BY seq", [taskId]),
	);
}

// A task that the owner started, at the time of the clock of Petra.
async function startedTask(h: Harness, work: ReturnType<Harness["build"]>["work"], name: string) {
	await work.startTask({ commandId: u(h, name), ...TEST_TASK });
	await startRunner(h, u(h, name), 1);
	return u(h, name);
}

test("T5: each step of a task is one row with its task, attempt, turn, seq, actor, kind and time", async () => {
	const h = await harness("t5-rows");
	const { work } = h.build();
	const gw = harnessGateway(h, work);
	const taskId = u(h, "c1");
	await work.startTask({ commandId: taskId, ...TEST_TASK });
	const claims = h.claims(taskId, 1);
	await gw.call(claims, startCall(1, "runner-a"));
	await gw.call(claims, modelCall(2, "runner-a", 1));
	await gw.call(claims, modelCall(2, "runner-a", 1));
	const step = { call: "step", callNo: 3, runnerId: "runner-a", turnNo: 1, toolCallId: "tc-1", tool: "read_file" };
	await gw.call(claims, { ...step, summary: "The bot read a file." } as GatewayCall);
	const rows = (await trailRows(h, taskId)).filter((row) => row.attempt_no !== null);
	assert.deepEqual(
		rows.map((row) => [row.source_ref, row.task_id, row.attempt_no, row.turn_no, row.kind, row.actor]),
		[
			[`task/${taskId}/1/2/model-call`, taskId, 1, 1, "model call", "test-bot"],
			[`task/${taskId}/1/3/tool-use`, taskId, 1, 1, "tool use", "test-bot"],
		],
	);
	assert.ok(Number(rows[0]?.seq) < Number(rows[1]?.seq));
	assert.ok(rows.every((row) => row.at instanceof Date));
});

test("T5: the role of Petra cannot change or delete a ledger row or a trail row, except the deletion of T8", async () => {
	const h = await harness("t5-role");
	const { work } = h.build();
	h.setNow(daysAgo(40));
	const old = await startedTask(h, work, "old");
	await work.cancel(old, "owner");
	h.setNow(daysAgo(5));
	const recent = await startedTask(h, work, "recent");
	await work.cancel(recent, "owner");
	h.setNow(daysAgo(40));
	const open = await startedTask(h, work, "open");
	const asPetra = <T>(sql: string, params: unknown[] = []) =>
		h.database.transaction({ role: "petra", accountId: h.accountId }, (tx) => tx.query<T>(sql, params));
	await assert.rejects(asPetra("UPDATE ledger SET credits = 0"), /permission denied/);
	await assert.rejects(asPetra("DELETE FROM ledger"), /permission denied/);
	await assert.rejects(asPetra("UPDATE trail SET summary = 'changed'"), /permission denied/);
	const deleteOf = (taskId: string) =>
		asPetra<{ source_ref: string }>("DELETE FROM trail WHERE task_id = $1 RETURNING source_ref", [taskId]);
	assert.deepEqual(await deleteOf(recent), [], "A task that ended 5 days ago keeps its trail.");
	assert.deepEqual(await deleteOf(open), [], "An open task keeps its trail.");
	assert.ok((await deleteOf(old)).length > 0, "A task that ended 40 days ago loses its trail.");
	assert.ok((await trailRows(h, recent)).length > 0);
	assert.ok((await trailRows(h, open)).length > 0);
});

test("T6: one query gives the full trail of a task with two attempts, from the owner message to the result", async () => {
	const h = await harness("t6");
	const { work } = h.build();
	const gw = harnessGateway(h, work);
	const taskId = u(h, "c1");
	await work.startTask({ commandId: taskId, ...TEST_TASK });
	await gw.call(h.claims(taskId, 1), startCall(1, "runner-a"));
	await gw.call(h.claims(taskId, 1), modelCall(2, "runner-a", 1));
	await work.sandboxExited({
		type: "SandboxExited",
		commandId: `exit/${taskId}/1`,
		at: h.now(),
		taskId,
		attempt: 1,
		exitCode: 1,
	});
	await gw.call(h.claims(taskId, 2), startCall(1, "runner-b"));
	await gw.call(h.claims(taskId, 2), modelCall(2, "runner-b", 1));
	await gw.call(h.claims(taskId, 2), { call: "result", callNo: 3, runnerId: "runner-b", result: SUCCESS });
	const rows = await h.trail.taskTrail(taskId);
	assert.deepEqual(
		rows.map((row) => [row.kind, row.attemptNo, row.attemptReason]),
		[
			["owner message", null, null],
			["model call", 1, "first"],
			["model call", 2, "after a failure"],
			["check", 2, "after a failure"],
			["message to the owner", null, null],
		],
	);
	assert.deepEqual(rows[0]?.data, { text: "Answer." });
	assert.equal((rows.at(-1)?.data as { type?: string } | undefined)?.type, "result");
	assert.deepEqual(
		rows.map((row) => row.seq),
		rows.map((row) => row.seq).sort((a, b) => a - b),
	);
});

test("T7: a large item goes to the object store; the row keeps the link and the SHA-256 hash", async () => {
	const h = await harness("t7");
	const { work } = h.build();
	const taskId = await startedTask(h, work, "c1");
	const large = { text: "x".repeat(20_000) };
	const row = { taskId, attemptNo: 1, turnNo: 1, kind: "tool use", actor: "test-bot", at: h.now() } as const;
	await h.tasks.addTrail({ ...row, sourceRef: `task/${taskId}/1/2/tool-use`, summary: "A large item.", data: large });
	await h.tasks.addTrail({
		...row,
		sourceRef: `task/${taskId}/1/3/tool-use`,
		summary: "A small item.",
		data: { n: 1 },
	});
	const [big, small] = (await trailRows(h, taskId)).filter((item) => item.kind === "tool use");
	const hash = createHash("sha256").update(JSON.stringify(large)).digest("hex");
	assert.deepEqual([big?.data, big?.blob_key, big?.blob_hash], [null, `trail/${taskId}/${hash}`, hash]);
	const body = h.objects.map.get(`trail/${taskId}/${hash}`);
	assert.equal(
		createHash("sha256")
			.update(body ?? "")
			.digest("hex"),
		hash,
	);
	assert.deepEqual([small?.data, small?.blob_key, small?.blob_hash], [{ n: 1 }, null, null]);
	assert.deepEqual((await h.trail.row(`task/${taskId}/1/2/tool-use`))?.data, large);
});

test("T8: the night job deletes the trail of a task that ended 32 days ago, with its items, and keeps an open task and the approvals", async () => {
	const h = await harness("t8");
	const { work, out } = h.build();
	const large = { text: "y".repeat(20_000) };
	const item = (taskId: string | null, name: string) =>
		h.tasks.addTrail({
			sourceRef: `cmd/${u(h, name)}/item`,
			taskId,
			attemptNo: taskId ? 1 : null,
			turnNo: null,
			kind: "tool use",
			actor: "test-bot",
			summary: "A large item.",
			// Two rows with no task have the same item, so the night job must not delete the item of the newer row.
			data: taskId ? { ...large, name } : large,
			at: h.now(),
		});
	h.setNow(daysAgo(32));
	const ended = await startedTask(h, work, "ended");
	await item(ended, "ended");
	await h.actions.addApproval({
		taskId: ended,
		toolCallId: "call-1",
		contentHash: "h1",
		ruleId: null,
		limit: null,
		at: h.now(),
	});
	await work.cancel(ended, "owner");
	await item(null, "no-task-old");
	h.setNow(daysAgo(40));
	const waiting = await startedTask(h, work, "waiting");
	await item(waiting, "waiting");
	await h.tasks.setTaskStatus({ taskId: waiting, status: "waiting for the owner", at: h.now() });
	h.setNow(daysAgo(5));
	await item(null, "no-task-new");
	const waitingBefore = await h.trail.taskTrail(waiting);
	const objectsBefore = [...h.objects.map.keys()];
	h.setNow(new Date().toISOString());
	const core = petra({
		writer: h.writer,
		storage: h.storage,
		model: { complete: async () => Promise.reject(new Error("The night job needs no model.")) },
		now: h.now,
		send: () => undefined,
		outbox: out,
		work,
		nightJob: async () => void (await h.trail.night()),
	});
	const night: Command = {
		type: "RunJob",
		commandId: u(h, "night"),
		at: h.now(),
		job: "night",
		localDate: "2026-11-19",
	};
	await core.accept(night, "system");
	await core.work();
	assert.deepEqual(await h.trail.taskTrail(ended), []);
	assert.ok(objectsBefore.some((key) => key.startsWith(`trail/${ended}/`)));
	assert.deepEqual(
		[...h.objects.map.keys()].filter((key) => key.startsWith(`trail/${ended}/`)),
		[],
	);
	assert.deepEqual(await h.trail.taskTrail(waiting), waitingBefore, "A task that waits for 40 days keeps its trail.");
	assert.equal(await h.trail.row(`cmd/${u(h, "no-task-old")}/item`), undefined);
	assert.ok(await h.trail.row(`cmd/${u(h, "no-task-new")}/item`));
	assert.equal((await h.actions.approval(ended, "call-1", "h1"))?.status, "pending", "The approval stays.");
});
