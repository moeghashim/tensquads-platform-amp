// The decisions of Petra and the gate, against a real Postgres (task 09, requirements Q3 to Q7).
// The test is here because a plug-in package must not import another plug-in (requirement C2).
import assert from "node:assert/strict";
import test from "node:test";

import { type FixedDeciderOptions, fixedDecider } from "@tensquads/adapters-test";
import { type Decider, ports, startSystem } from "@tensquads/core";
import { contentHash } from "@tensquads/gate";
import { PETRA_TOOLS } from "@tensquads/petra";

import { gateSetup, refund, statusOf } from "./gate-harness.js";
import { AT, type Harness, harness, runTool, startRunner, taskRows } from "./task-harness.js";

const PLAN_MESSAGE = "My eggs arrived broken. I want my $15 back.";
const BEFORE = "2026-11-18T09:00:00.000Z";
const LIMIT_20_REASONS = { kind: "money_limit", params: { maxAmount: 20_000_000, reasons: "damaged or missing" } };
const REFUND_POINTS = ["message-safe", "reason-in-rule", "refund-request"];

const u = (h: { accountId: string }, name: string) => `${name}-${h.accountId}`;

async function fixed(options: FixedDeciderOptions = {}): Promise<Decider> {
	return (await startSystem([fixedDecider(options)])).port(ports.decider);
}

async function shadowFixed(options: FixedDeciderOptions): Promise<Decider> {
	const shadow = (await startSystem([fixedDecider({ ...options, shadow: true })])).port(ports.shadowDecider);
	if (!shadow) throw new Error("The shadow row gave no decider.");
	return shadow;
}

// A decider that counts its calls.
function counting(decider: Decider): Decider & { calls: number } {
	const counter = {
		name: decider.name,
		calls: 0,
		ask: (questions: Parameters<Decider["ask"]>[0]) => {
			counter.calls += 1;
			return decider.ask(questions);
		},
	};
	return counter;
}

interface Row {
	source_ref: string;
	decider: string;
	task_id: string | null;
	point: string;
	message_seq: string | null;
	options: string[];
	answer: string | null;
	probability: number | null;
	shadow: boolean;
	used: boolean;
	ms: number | null;
	at: Date;
}

// The decision records of the deciders, not the choices of the code or the answers of the owner.
async function decisionRows(h: Harness): Promise<Row[]> {
	return h.database.transaction({ role: "petra", accountId: h.accountId }, (tx) =>
		tx.query<Row>(
			`SELECT source_ref, decider, task_id, point, message_seq, options, answer, probability, shadow, used, ms, at
			 FROM decisions WHERE decider NOT IN ('code', 'owner') ORDER BY source_ref, decider`,
		),
	);
}

async function outcomeRows(h: Harness) {
	return h.database.transaction({ role: "petra", accountId: h.accountId }, (tx) =>
		tx.query<{ decision_ref: string; command_id: string; outcome: string; by: string }>(
			"SELECT decision_ref, command_id, outcome, by FROM decision_outcomes ORDER BY decision_ref",
		),
	);
}

test("Q2: when the model of Petra names the bot in start_task, the task starts with no decider call; the two points have records of petra-model", async () => {
	const h = await harness("q2-model-bot");
	const decider = counting(await fixed());
	const { tools } = h.build({ decider });
	const commandId = u(h, "c-bot");
	await runTool(tools, PETRA_TOOLS.startTask, { commandId, text: "Plan the menu of my shop", bot: "test-bot" });
	assert.equal(decider.calls, 0);
	assert.deepEqual(
		(await taskRows(h.database, h.accountId)).tasks.map((task) => task.id),
		[commandId],
	);
	assert.deepEqual(
		(await decisionRows(h)).map((row) => [row.point, row.decider, row.answer, row.used]),
		[
			["request-clear", "petra-model", "yes", true],
			["which-bot", "petra-model", "test-bot", true],
		],
	);
	// With no bot from the model, the decider answers the two points, as before.
	await runTool(tools, PETRA_TOOLS.startTask, { commandId: u(h, "c-nobot"), text: "Plan the menu of my shop" });
	assert.equal(decider.calls, 1);
});

// A task from the message of a customer, with the rule "$20, damaged or missing" (the plan example).
async function planTask(prefix: string, decider: Decider, shadow: Decider | null = null) {
	const customer = { sender: "+966500000001", name: "Sara Customer", at: BEFORE, text: PLAN_MESSAGE };
	const s = await gateSetup(prefix, "refund 15 to cust-1", { customer, decider, shadow });
	await s.work.setRule({ type: "SetRule", commandId: `${s.taskId}-rule`, at: AT, rule: LIMIT_20_REASONS });
	return s;
}

test("Plan example: three sure answers give the $15 refund with no approval, with three records", async () => {
	const s = await planTask("plan-sure", await fixed());
	assert.deepEqual(await s.action({ content: refund(15) }), {
		status: "done",
		answer: { outcome: "confirmed", actionId: `${s.taskId}/call-1` },
	});
	assert.equal(s.paid.length, 1);
	assert.deepEqual(await s.messages("approval_request"), []);
	const rows = await decisionRows(s.h);
	assert.deepEqual(
		rows.map((row) => [row.point, row.answer, row.used, row.task_id]),
		REFUND_POINTS.map((point) => [point, "yes", true, s.taskId]),
	);
});

test("Plan example: one answer below the level gives an approval request, and no refund goes out", async () => {
	const s = await planTask(
		"plan-low",
		await fixed({ points: { "message-safe": { answer: "yes", probability: 0.6 } } }),
	);
	assert.deepEqual(await s.action({ content: refund(15) }), { status: "wait" });
	assert.equal(s.paid.length, 0);
	assert.equal((await s.messages("approval_request")).length, 1);
	const rows = await decisionRows(s.h);
	assert.deepEqual(
		rows.map((row) => [row.point, row.used]),
		[
			["message-safe", false],
			["reason-in-rule", true],
			["refund-request", true],
		],
	);
});

test("Plan example: $60 always gives an approval request", async () => {
	const s = await planTask("plan-60", await fixed());
	assert.deepEqual(await s.action({ content: refund(60) }), { status: "wait" });
	assert.equal(s.paid.length, 0);
	const [request] = await s.messages("approval_request");
	assert.equal(request?.type === "approval_request" && request.limit, 20_000_000);
});

test("Q7: a decider that says yes at 0.99 cannot start a $60 refund, a money action with no rule, or a public action", async () => {
	const yes = await fixed({ answer: "yes", probability: 0.99 });
	const above = await planTask("q7-60", yes);
	assert.deepEqual(await above.action({ content: refund(60) }), { status: "wait" });
	const customer = { sender: "+966500000002", name: "Omar Customer", at: BEFORE, text: PLAN_MESSAGE };
	const noRule = await gateSetup("q7-norule", "refund 15 to cust-1", { customer, decider: yes });
	assert.deepEqual(await noRule.action({ content: refund(15) }), { status: "wait" });
	const reply = await planTask("q7-public", yes);
	assert.deepEqual(await reply.action({ tool: "send_reply", content: { to: "cust-1", text: "We send the money." } }), {
		status: "wait",
	});
	for (const s of [above, noRule, reply]) {
		assert.equal(s.paid.length + s.sent.length, 0);
		assert.equal((await s.messages("approval_request")).length, 1);
	}
});

test("Q7: a task with no customer message and a rule with reasons needs an approval, and no decider is asked", async () => {
	const decider = counting(await fixed());
	const s = await gateSetup("q7-owner", "refund 15 to cust-1", { decider });
	await s.work.setRule({ type: "SetRule", commandId: `${s.taskId}-rule`, at: AT, rule: LIMIT_20_REASONS });
	assert.deepEqual(await s.action({ content: refund(15) }), { status: "wait" });
	assert.equal(decider.calls, 0);
});

test("Q6: the decision of the owner on an approval writes one outcome for each decision record that led to it", async () => {
	const s = await planTask("q6", await fixed({ points: { "reason-in-rule": { answer: "no", probability: 0.95 } } }));
	assert.deepEqual(await s.action({ content: refund(15) }), { status: "wait" });
	const hash = await contentHash("refund", refund(15));
	await s.work.approvalDecision({
		type: "ApprovalDecision",
		commandId: `${s.taskId}-d1`,
		at: AT,
		approvalId: `${s.taskId}/call-1`,
		decision: "reject",
		contentHash: hash,
	});
	const records = (await decisionRows(s.h)).map((row) => row.source_ref);
	assert.deepEqual(await outcomeRows(s.h), [
		...records.map((ref) => ({ decision_ref: ref, command_id: `${s.taskId}-d1`, outcome: "rejected", by: "owner" })),
	]);
	assert.equal(records.length, 3);
});

test("Q3: start a task writes one record for each answer, with no text of the message; a second run does not ask again", async () => {
	const h = await harness("q3");
	const decider = counting(await fixed());
	const { tools, core } = h.build({ decider });
	const commandId = u(h, "c1");
	await core.accept(
		{ type: "OwnerMessage", commandId, at: AT, messageId: "m1", channel: "chat", text: "Tell me the hours." },
		"owner",
	);
	await core.work();
	await runTool(tools, PETRA_TOOLS.startTask, { commandId, text: "Tell me the hours." });
	await runTool(tools, PETRA_TOOLS.startTask, { commandId, text: "Tell me the hours." });
	assert.equal(decider.calls, 1, "The second run reads the records.");
	const seq = await h.writer.messageSeq(`cmd/${commandId}/in`);
	const rows = await decisionRows(h);
	assert.deepEqual(
		rows.map((row) => ({ ...row, at: row.at.toISOString(), ms: typeof row.ms })),
		[
			["request-clear", ["yes", "no"], "yes"],
			["which-bot", ["test-bot"], "test-bot"],
		].map(([point, options, answer]) => ({
			source_ref: `cmd/${commandId}/${point}`,
			decider: "fixed",
			task_id: null,
			point,
			message_seq: String(seq),
			options,
			answer,
			probability: 0.99,
			shadow: false,
			used: true,
			ms: "number",
			at: AT,
		})),
	);
	assert.ok(!JSON.stringify(rows).includes("hours"), "The records have no text of the message.");
	assert.deepEqual(
		(await taskRows(h.database, h.accountId)).tasks.map((task) => task.id),
		[commandId],
	);
});

const broken: Decider = {
	name: "broken",
	ask: async () => {
		throw new Error("The decider is down.");
	},
};
const slow: Decider = { name: "slow", ask: () => new Promise(() => undefined) };

const q4Cases: { name: string; decider: () => Promise<Decider> }[] = [
	{ name: "below the level", decider: () => fixed({ probability: 0.5 }) },
	{
		name: "an answer that is not an option",
		decider: () => fixed({ points: { "request-clear": { answer: "maybe" } } }),
	},
	{ name: "an error", decider: async () => broken },
	{ name: "a timeout", decider: async () => slow },
];

for (const item of q4Cases) {
	test(`Q4: ${item.name} goes to the owner as one question, no task starts, and the event is not lost`, async () => {
		const h = await harness(`q4-${item.name.split(" ").at(-1)}`);
		const { core, tools } = h.build({ decider: await item.decider(), timeoutMs: 50 });
		const commandId = u(h, "c1");
		const text = "Do the thing.";
		await core.accept({ type: "OwnerMessage", commandId, at: AT, messageId: "m1", channel: "chat", text }, "owner");
		await core.work();
		await runTool(tools, PETRA_TOOLS.startTask, { commandId, text });
		assert.deepEqual((await taskRows(h.database, h.accountId)).tasks, []);
		const questions = h.sent.filter((message) => message.type === "question");
		assert.equal(questions.length, 1);
		assert.equal(questions[0]?.type === "question" && questions[0].questionId, `${commandId}/request-clear`);
		assert.equal((await h.writer.messageSeq(`cmd/${commandId}/in`)) !== undefined, true, "The message stays.");
		const rows = await decisionRows(h);
		const clear = rows.find((row) => row.point === "request-clear");
		assert.equal(clear?.used, false);
		// The command is complete: its events row is "done", so no step waits.
		const events = await h.database.transaction({ role: "petra", accountId: h.accountId }, (tx) =>
			tx.query<{ status: string }>("SELECT status FROM events WHERE command_id = $1", [commandId]),
		);
		assert.deepEqual(events, [{ status: "done" }]);
	});
}

test("Q4: a sure answer that the request is not clear also goes to the owner, and the owner answer is an outcome", async () => {
	const h = await harness("q4-no");
	const { tools, work } = h.build({ decider: await fixed({ points: { "request-clear": { answer: "no" } } }) });
	const commandId = u(h, "c1");
	await runTool(tools, PETRA_TOOLS.startTask, { commandId, text: "Hmm." });
	assert.deepEqual((await taskRows(h.database, h.accountId)).tasks, []);
	const question = h.sent.find((message) => message.type === "question");
	assert.ok(question?.type === "question");
	await work.ownerAnswer({
		type: "OwnerAnswer",
		commandId: u(h, "a1"),
		at: AT,
		questionId: question.questionId,
		text: "Tell me the hours.",
	});
	assert.deepEqual(await outcomeRows(h), [
		{ decision_ref: `cmd/${commandId}/request-clear`, command_id: u(h, "a1"), outcome: "changed", by: "owner" },
	]);
});

test("Q4: which bot below the level goes to the owner, and no task starts", async () => {
	const h = await harness("q4-bot");
	const { tools } = h.build({ decider: await fixed({ points: { "which-bot": { probability: 0.7 } } }) });
	await runTool(tools, PETRA_TOOLS.startTask, { commandId: u(h, "c1"), text: "Tell me the hours." });
	assert.deepEqual((await taskRows(h.database, h.accountId)).tasks, []);
	const question = h.sent.find((message) => message.type === "question");
	assert.deepEqual(question?.type === "question" && [question.questionId, question.options], [
		`${u(h, "c1")}/which-bot`,
		["test-bot"],
	]);
});

test("Q5: a shadow decider with a different answer changes nothing in the task, and both records are written", async () => {
	const runWith = async (shadow: Decider | null) => {
		const h = await harness(shadow ? "q5-shadow" : "q5-plain");
		const { tools } = h.build({ decider: await fixed(), shadow });
		await runTool(tools, PETRA_TOOLS.startTask, { commandId: u(h, "c1"), text: "Tell me the hours." });
		const rows = await taskRows(h.database, h.accountId);
		return { h, rows, sent: h.sent.map((message) => message.type) };
	};
	const plain = await runWith(null);
	const shadowed = await runWith(await shadowFixed({ answer: "no", probability: 0.99 }));
	assert.deepEqual(
		shadowed.rows.tasks.map((task) => task.status),
		plain.rows.tasks.map((task) => task.status),
	);
	assert.deepEqual(shadowed.sent, plain.sent);
	const rows = await decisionRows(shadowed.h);
	assert.deepEqual(
		rows.map((row) => [row.point, row.decider, row.answer, row.shadow, row.used]),
		[
			["request-clear", "fixed", "yes", false, true],
			["request-clear", "shadow-fixed", "no", true, false],
			["which-bot", "fixed", "test-bot", false, true],
			["which-bot", "shadow-fixed", "test-bot", true, false],
		],
	);
});

test("Q5: in the plan example, a shadow that says no changes nothing: the refund goes out", async () => {
	const s = await planTask("q5-plan", await fixed(), await shadowFixed({ answer: "no" }));
	assert.equal(statusOf(await s.action({ content: refund(15) })), "done");
	const rows = await decisionRows(s.h);
	assert.equal(rows.filter((row) => row.shadow && row.answer === "no" && !row.used).length, 3);
});

test("Q1: is this message for a task that runs: a sure answer puts the message in the inbox, and below the level Petra asks which task", async () => {
	const sure = await harness("route-sure");
	const built = sure.build({ decider: await fixed() });
	await runTool(built.tools, PETRA_TOOLS.startTask, { commandId: u(sure, "t1"), text: "Tell me the hours." });
	await startRunner(sure, u(sure, "t1"), 1);
	await runTool(built.tools, PETRA_TOOLS.startTask, { commandId: u(sure, "m2"), text: "Also check Sunday." });
	assert.deepEqual(
		(await sure.tasks.inbox(u(sure, "t1"))).messages.map((message) => message.text),
		["Also check Sunday."],
	);
	const low = await harness("route-low");
	const first = low.build({ decider: await fixed() });
	await runTool(first.tools, PETRA_TOOLS.startTask, { commandId: u(low, "t1"), text: "Tell me the hours." });
	await startRunner(low, u(low, "t1"), 1);
	const unsure = low.build({ decider: await fixed({ points: { "message-for-task": { probability: 0.5 } } }) });
	await runTool(unsure.tools, PETRA_TOOLS.startTask, { commandId: u(low, "m2"), text: "Also check Sunday." });
	const question = low.sent.find((message) => message.type === "question");
	assert.deepEqual(question?.type === "question" && question.options, [u(low, "t1"), "new task"]);
	assert.deepEqual((await low.tasks.inbox(u(low, "t1"))).messages, []);
	assert.equal((await taskRows(low.database, low.accountId)).tasks.length, 1);
});
