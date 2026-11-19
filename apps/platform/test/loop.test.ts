// The work of Petra on tasks and attempts, against a real Postgres (task 04).
import assert from "node:assert/strict";
import test from "node:test";

import type { Command, TaskResult } from "@tensquads/contracts";
import { checkCommandId, PETRA_TOOLS, petra } from "@tensquads/petra";

import { AT, harness, memoryStorage, runTool, startRunner, taskRows } from "./task-harness.js";

const exited = (taskId: string, attempt: number, exitCode = 1) =>
	({ type: "SandboxExited", commandId: `exit/${taskId}/${attempt}`, at: AT, taskId, attempt, exitCode }) as const;

// tasks.id is unique over all accounts, so each test makes its ids from its account id.
const u = (h: { accountId: string }, name: string) => `${name}-${h.accountId}`;

const STEPS = ["createTask", "chargeTask", "addAttempt", "sandbox"] as const;

test("D33: Petra stops at each of the four steps of start a task, and one time loses her storage. One task, one charge, one attempt, one request", async () => {
	for (const step of [...STEPS, "storage"] as const) {
		const h = await harness(`d33-${step}`);
		const stop = () => {
			throw new Error(`stop at ${step}`);
		};
		const stopping = {
			...h.tasks,
			...(step === "createTask" ? { createTask: async () => stop() } : {}),
			...(step === "chargeTask" ? { chargeTask: async () => stop() } : {}),
			...(step === "addAttempt" ? { addAttempt: async () => stop() } : {}),
		};
		const first = h.build({ tasks: stopping, ...(step === "sandbox" ? { beforeSandbox: stop } : {}) });
		const input = { commandId: u(h, "c1"), text: "Answer the customer." };
		if (step === "storage") {
			await runTool(first.tools, PETRA_TOOLS.startTask, input);
		} else {
			await assert.rejects(runTool(first.tools, PETRA_TOOLS.startTask, input), /stop at/);
		}
		// The command runs again. For the case "storage", the Durable Object lost its storage.
		const again = h.build(step === "storage" ? { storage: memoryStorage() } : {});
		await runTool(again.tools, PETRA_TOOLS.startTask, input);
		await runTool(again.tools, PETRA_TOOLS.startTask, input);
		const rows = await taskRows(h.database, h.accountId);
		assert.deepEqual(rows.tasks, [{ id: u(h, "c1"), status: "starting", stop: null }], step);
		assert.deepEqual(
			rows.ledger.map((row) => [row.source_ref, Number(row.credits)]),
			[[`task/${u(h, "c1")}/charge`, -1]],
			step,
		);
		assert.deepEqual(
			rows.attempts.map((row) => [row.attempt_no, row.cause_ref, row.reason]),
			[[1, u(h, "c1"), "first"]],
			step,
		);
		assert.deepEqual([...h.list.keys()], [`${u(h, "c1")}/1`], step);
		assert.ok(
			h.jobs.every((job) => job.body.command.commandId === checkCommandId(u(h, "c1"), 1, 1)),
			step,
		);
		assert.equal(h.jobs[0]?.delaySeconds, 120, step);
	}
});

test("L5: an exit report that comes two times adds one attempt, and a second failure makes the task fail", async () => {
	const h = await harness("l5-twice");
	const { tools, work } = h.build();
	await runTool(tools, PETRA_TOOLS.startTask, { commandId: u(h, "t1"), text: "Answer." });
	await startRunner(h, u(h, "t1"), 1);
	await work.sandboxExited(exited(u(h, "t1"), 1));
	await work.sandboxExited(exited(u(h, "t1"), 1));
	let rows = await taskRows(h.database, h.accountId);
	assert.deepEqual(
		rows.attempts.map((row) => [row.attempt_no, row.cause_ref, row.reason, row.exit]),
		[
			[1, u(h, "t1"), "first", "exit 1"],
			[2, `exit/${u(h, "t1")}/1`, "after a failure", null],
		],
	);
	assert.deepEqual([...h.list.keys()], [`${u(h, "t1")}/1`, `${u(h, "t1")}/2`]);
	// A report for the old attempt is ignored.
	await work.sandboxExited({ ...exited(u(h, "t1"), 1), commandId: "exit/t1/1/late" });
	await startRunner(h, u(h, "t1"), 2);
	await work.sandboxExited(exited(u(h, "t1"), 2));
	rows = await taskRows(h.database, h.accountId);
	assert.equal(rows.attempts.length, 2);
	assert.deepEqual(rows.tasks, [{ id: u(h, "t1"), status: "failed", stop: "error" }]);
	assert.ok(h.sent.some((m) => m.type === "reply" && m.text.includes("failed")));
});

test("L5: the runner exits on purpose after a park, the report comes two times, and no new attempt starts", async () => {
	const h = await harness("l5-park");
	const { tools, work } = h.build();
	await runTool(tools, PETRA_TOOLS.startTask, { commandId: u(h, "t1"), text: "Answer." });
	await startRunner(h, u(h, "t1"), 1);
	const question = { id: "q1", text: "Which shop?" };
	const result: TaskResult = { stop: "question", answer: "", evidence: [], proposedFacts: [], notes: [], question };
	await work.afterResult(h.claims(u(h, "t1"), 1), result);
	await work.sandboxExited(exited(u(h, "t1"), 1, 0));
	await work.sandboxExited(exited(u(h, "t1"), 1, 0));
	const rows = await taskRows(h.database, h.accountId);
	assert.equal(rows.attempts.length, 1);
	assert.deepEqual(rows.tasks, [{ id: u(h, "t1"), status: "waiting for the owner", stop: "question" }]);
	assert.ok(h.sent.some((m) => m.type === "question" && m.questionId === "q1"));
});

test("L6: an answer of the owner to a parked question makes a decision, a running task and an attempt after an answer", async () => {
	const h = await harness("l6");
	const { tools, work } = h.build();
	await runTool(tools, PETRA_TOOLS.startTask, { commandId: u(h, "t1"), text: "Answer." });
	await startRunner(h, u(h, "t1"), 1);
	const question = { id: "q1", text: "Which shop?" };
	await work.afterResult(h.claims(u(h, "t1"), 1), {
		stop: "question",
		answer: "",
		evidence: [],
		proposedFacts: [],
		notes: [],
		question,
	});
	const answer = {
		type: "OwnerAnswer",
		commandId: u(h, "a1"),
		at: AT,
		questionId: "q1",
		text: "The shop in Riyadh.",
	} as const;
	assert.equal(await work.ownerAnswer(answer), true);
	assert.equal(await work.ownerAnswer(answer), true);
	const rows = await taskRows(h.database, h.accountId);
	assert.deepEqual(
		rows.attempts.map((row) => [row.attempt_no, row.cause_ref, row.reason]),
		[
			[1, u(h, "t1"), "first"],
			[2, u(h, "a1"), "after an answer"],
		],
	);
	assert.deepEqual(rows.tasks, [{ id: u(h, "t1"), status: "running", stop: "question" }]);
	assert.deepEqual(await h.tasks.signals(u(h, "t1")), [{ key: "q1", value: { text: "The shop in Riyadh." } }]);
	assert.deepEqual([...h.list.keys()], [`${u(h, "t1")}/1`, `${u(h, "t1")}/2`]);
});

test("L5: the launcher took a request and no start came. The task gets a new attempt, and this is not its one failure", async () => {
	const h = await harness("l5-nostart");
	const { tools, work } = h.build();
	await runTool(tools, PETRA_TOOLS.startTask, { commandId: u(h, "t1"), text: "Answer." });
	// The first check: no launcher took the request. The request stays in the list, and the next check is queued.
	h.setNow("2026-11-18T10:02:00.000Z");
	await work.checkTask(checkCommandId(u(h, "t1"), 1, 1), u(h, "t1"));
	assert.equal(h.jobs.at(-1)?.body.command.commandId, checkCommandId(u(h, "t1"), 1, 2));
	// A launcher takes the request, then stops. No start comes in the silent time.
	h.taken.set(`${u(h, "t1")}/1`, Date.parse("2026-11-18T10:02:00.000Z"));
	h.setNow("2026-11-18T10:04:00.000Z");
	await work.checkTask(checkCommandId(u(h, "t1"), 1, 2), u(h, "t1"));
	await work.checkTask(checkCommandId(u(h, "t1"), 1, 2), u(h, "t1"));
	let rows = await taskRows(h.database, h.accountId);
	assert.deepEqual(
		rows.attempts.map((row) => [row.attempt_no, row.reason, row.exit]),
		[
			[1, "first", "did not start"],
			[2, "the sandbox did not start", null],
		],
	);
	// The runner of attempt 2 starts and then stops. This is the one failure, so the task gets a third attempt.
	await startRunner(h, u(h, "t1"), 2);
	await work.sandboxExited(exited(u(h, "t1"), 2));
	rows = await taskRows(h.database, h.accountId);
	assert.deepEqual(
		rows.attempts.map((row) => row.reason),
		["first", "the sandbox did not start", "after a failure"],
	);
	assert.equal(rows.tasks[0]?.status, "running");
});

test("L5: a check finds a silent sandbox and handles it as a sandbox that stopped", async () => {
	const h = await harness("l5-silent");
	const { tools, work } = h.build();
	await runTool(tools, PETRA_TOOLS.startTask, { commandId: u(h, "t1"), text: "Answer." });
	await startRunner(h, u(h, "t1"), 1);
	h.setNow("2026-11-18T10:01:00.000Z");
	await work.noteCall(u(h, "t1"), 1);
	h.setNow("2026-11-18T10:02:00.000Z");
	await work.checkTask(checkCommandId(u(h, "t1"), 1, 1), u(h, "t1"));
	assert.equal((await taskRows(h.database, h.accountId)).attempts.length, 1);
	h.setNow("2026-11-18T10:04:00.000Z");
	await work.checkTask(checkCommandId(u(h, "t1"), 1, 2), u(h, "t1"));
	const rows = await taskRows(h.database, h.accountId);
	assert.deepEqual(
		rows.attempts.map((row) => [row.reason, row.exit]),
		[
			["first", "silent"],
			["after a failure", null],
		],
	);
});

test("L15: the owner writes stop with one open task, and the task is cancelled with its credits back", async () => {
	const h = await harness("l15-one");
	const { tools } = h.build();
	await runTool(tools, PETRA_TOOLS.startTask, { commandId: u(h, "t1"), text: "Answer." });
	await runTool(tools, PETRA_TOOLS.stopTask, { commandId: u(h, "s1"), text: "stop" });
	const rows = await taskRows(h.database, h.accountId);
	assert.deepEqual(rows.tasks, [{ id: u(h, "t1"), status: "cancelled", stop: "cancelled" }]);
	assert.deepEqual(
		rows.ledger.map((row) => [row.source_ref, Number(row.credits)]),
		[
			[`task/${u(h, "t1")}/charge`, -1],
			[`task/${u(h, "t1")}/giveback`, 1],
		],
	);
	assert.equal(rows.attempts[0]?.exit, "cancelled");
	assert.ok(h.sent.some((m) => m.type === "reply" && m.text.includes("is stopped")));
});

test("L15: with two open tasks and no clear target, Petra asks which one", async () => {
	const h = await harness("l15-two");
	const { tools } = h.build();
	await runTool(tools, PETRA_TOOLS.startTask, { commandId: u(h, "t1"), text: "Answer one." });
	await runTool(tools, PETRA_TOOLS.startTask, { commandId: u(h, "t2"), text: "Answer two." });
	await runTool(tools, PETRA_TOOLS.stopTask, { commandId: u(h, "s1"), text: "stop" });
	const rows = await taskRows(h.database, h.accountId);
	assert.deepEqual(
		rows.tasks.map((task) => task.status),
		["starting", "starting"],
	);
	const question = h.sent.find((m) => m.type === "question");
	assert.ok(question && question.type === "question");
	assert.deepEqual(question.options, [u(h, "t1"), u(h, "t2")]);
});

test("L15: a CancelTask command and the tool stop a task give the same rows, and the credits stay after a start", async () => {
	const rowsOf = async (byTool: boolean) => {
		const h = await harness(byTool ? "l15-tool" : "l15-cmd");
		const { tools, work } = h.build();
		await runTool(tools, PETRA_TOOLS.startTask, { commandId: u(h, "t1"), text: "Answer." });
		await startRunner(h, u(h, "t1"), 1);
		if (byTool) await runTool(tools, PETRA_TOOLS.stopTask, { commandId: u(h, "s1"), text: `stop ${u(h, "t1")}` });
		else await work.cancel(u(h, "t1"), "owner");
		const rows = await taskRows(h.database, h.accountId);
		const ledger = rows.ledger.map((row) => [row.source_ref, Number(row.credits)]);
		// The ids differ by account. The test compares the rows with the account id taken out.
		return JSON.parse(JSON.stringify({ ...rows, ledger }).replaceAll(`-${h.accountId}`, ""));
	};
	const byTool = await rowsOf(true);
	assert.deepEqual(byTool, await rowsOf(false));
	assert.deepEqual(byTool.tasks, [{ id: "t1", status: "cancelled", stop: "cancelled" }]);
	// A runner made a start call, so the credits do not go back (requirement T3).
	assert.deepEqual(byTool.ledger, [["task/t1/charge", -1]]);
});

test("L5: a result that stands ends the attempt, tells the owner the result, and ends the task", async () => {
	const h = await harness("l2-result");
	const { tools, work } = h.build();
	await runTool(tools, PETRA_TOOLS.startTask, { commandId: u(h, "t1"), text: "Answer." });
	await startRunner(h, u(h, "t1"), 1);
	const result: TaskResult = {
		stop: "success",
		answer: "The shop opens at 9.",
		evidence: [],
		proposedFacts: [],
		notes: [],
	};
	await work.afterResult(h.claims(u(h, "t1"), 1), result);
	await work.afterResult(h.claims(u(h, "t1"), 1), result);
	await work.sandboxExited(exited(u(h, "t1"), 1, 0));
	const rows = await taskRows(h.database, h.accountId);
	assert.deepEqual(rows.tasks, [{ id: u(h, "t1"), status: "done", stop: "success" }]);
	assert.deepEqual(
		rows.attempts.map((row) => row.exit),
		["result"],
	);
	const results = h.sent.filter((m) => m.type === "result");
	assert.equal(results.length, 1);
	assert.equal(results[0]?.type === "result" && results[0].summary, "The shop opens at 9.");
});

test("L14: Petra loses her storage. She makes a new conversation, keeps each seq, continues the work list and sends the request again", async () => {
	const h = await harness("l14");
	const submits: [string, string][] = [];
	const conversation = { submit: async (requestId: string, text: string) => void submits.push([requestId, text]) };
	const model = { complete: async () => Promise.reject(new Error("no model")) };
	const message = (commandId: string, text: string): Command => ({
		type: "OwnerMessage",
		commandId,
		at: AT,
		messageId: `m-${commandId}`,
		channel: "chat",
		text,
	});
	const first = petra({
		writer: h.writer,
		storage: h.storage,
		model,
		now: h.now,
		send: () => undefined,
		conversation,
	});
	// The first message starts a task. Petra stops before the request for a sandbox.
	await first.accept(message(u(h, "t1"), "Answer the customer."), "owner");
	await first.work();
	await assert.rejects(
		runTool(
			h.build({
				beforeSandbox: () => {
					throw new Error("stop");
				},
			}).tools,
			PETRA_TOOLS.startTask,
			{
				commandId: u(h, "t1"),
				text: "Answer the customer.",
			},
		),
		/stop/,
	);
	// The second message is received, and Petra loses her storage before she handles it.
	await first.accept(message(u(h, "m2"), "And the second question?"), "owner");
	const lost = memoryStorage();
	const after = h.build({ storage: lost });
	submits.length = 0;
	const second = petra({
		writer: h.writer,
		storage: lost,
		model,
		now: h.now,
		send: () => undefined,
		conversation,
		outbox: after.out,
		work: after.work,
	});
	await second.recover();
	await second.recover();
	// The new conversation starts from the messages in the database, one time.
	assert.equal(submits.length, 1);
	assert.match(submits[0]?.[1] ?? "", /Answer the customer\./);
	// The open attempt with no start gets its request again.
	assert.deepEqual([...h.list.keys()], [`${u(h, "t1")}/1`]);
	// The work list has both commands, because no tool marked them done. A new message gets the next seq.
	assert.equal(await second.pending(), true);
	await second.work();
	assert.deepEqual(
		submits.slice(1).map(([requestId]) => requestId),
		// Both commands have the same time, so the events come in the order of their command ids.
		[u(h, "m2"), u(h, "t1")],
	);
	await after.out.tell({ sourceRef: "l14/after", channel: "chat", body: { type: "reply", text: "ok" } });
	const seqs = await h.database.transaction({ role: "petra", accountId: h.accountId }, (tx) =>
		tx.query<{ seq: string }>("SELECT seq FROM messages ORDER BY seq"),
	);
	assert.deepEqual(
		seqs.map((row) => Number(row.seq)),
		[1, 2, 3],
	);
});
