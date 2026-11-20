import assert from "node:assert/strict";
import test from "node:test";

import type { Decider, DeciderQuestion, DecisionRecord } from "@tensquads/core";

import {
	type DecisionAsk,
	type DecisionStore,
	decisions,
	LEVELS,
	POINTS,
	type PointId,
	type Verdict,
} from "../src/index.js";

const AT = "2026-11-19T10:00:00.000Z";

// The store of the rows, in memory. The key is the source reference and the decider.
function memoryStore(): DecisionStore & { rows: DecisionRecord[] } {
	const rows: DecisionRecord[] = [];
	const find = (sourceRef: string, decider: string) =>
		rows.find((row) => row.sourceRef === sourceRef && row.decider === decider);
	return {
		rows,
		decisionRow: async (sourceRef, decider) => find(sourceRef, decider),
		addDecision: async (row) => {
			if (!find(row.sourceRef, row.decider)) rows.push(row);
		},
	};
}

// A decider that gives one answer and one probability to each question, and counts its calls.
function deciderOf(
	name: string,
	answer: (question: DeciderQuestion) => { answer: string; probability: number },
): Decider & { calls: DeciderQuestion[][] } {
	const calls: DeciderQuestion[][] = [];
	return {
		name,
		calls,
		ask: async (questions) => {
			calls.push([...questions]);
			return questions.map((question) => ({ id: question.id, ...answer(question) }));
		},
	};
}

const sure = (question: DeciderQuestion) => ({ answer: question.options[0] ?? "", probability: 0.99 });

const refundAsks = (taskId: string): DecisionAsk[] =>
	(["refund-request", "reason-in-rule", "message-safe"] as const).map((point) => ({
		sourceRef: `action/${taskId}/call-1/${point}`,
		point,
		taskId,
		messageSeq: 7,
		message: "My eggs arrived broken. I want my $15 back.",
		rule: "damaged or missing",
	}));

test("Q1: the list has the six points of the plan, each with its id, question, type, options, harm, level and path below the level", () => {
	assert.deepEqual(POINTS.map((point) => point.id).sort(), [
		"message-for-task",
		"message-safe",
		"reason-in-rule",
		"refund-request",
		"request-clear",
		"which-bot",
	]);
	for (const point of POINTS) {
		assert.ok(point.question.endsWith("?"), point.id);
		assert.ok(["yes_no", "choice", "score"].includes(point.type), point.id);
		assert.ok(point.harm.length > 0, point.id);
		assert.ok(point.below.length > 0, point.id);
		if (point.type === "yes_no") assert.deepEqual(point.options, ["yes", "no"], point.id);
		if (point.type === "choice") assert.equal(point.options, "given by the ask", point.id);
	}
	assert.deepEqual(
		POINTS.filter((point) => point.type === "choice").map((point) => point.id),
		["which-bot", "message-for-task"],
	);
});

test("Q1: the level of each point comes from the one file of levels, and is 0.90 for each yes or no point and each choice", () => {
	assert.deepEqual(Object.keys(LEVELS).sort(), POINTS.map((point) => point.id).sort());
	for (const point of POINTS) {
		assert.equal(point.level, LEVELS[point.id], point.id);
		assert.equal(point.level, 0.9, point.id);
	}
});

test("Q2: the three questions of a refund go to the decider in one call, each with its type and its options", async () => {
	const store = memoryStore();
	const decider = deciderOf("fixed", sure);
	const verdicts = await decisions({ store, decider, shadow: null, timeoutMs: 1000, now: () => AT }).ask(
		refundAsks("t1"),
	);
	assert.equal(decider.calls.length, 1);
	const [questions = []] = decider.calls;
	assert.deepEqual(
		questions.map((question) => [question.point, question.type, question.options]),
		[
			["refund-request", "yes_no", ["yes", "no"]],
			["reason-in-rule", "yes_no", ["yes", "no"]],
			["message-safe", "yes_no", ["yes", "no"]],
		],
	);
	assert.match(questions[1]?.text ?? "", /damaged or missing/);
	assert.match(questions[0]?.text ?? "", /My eggs arrived broken/);
	assert.deepEqual(
		verdicts.map((verdict) => [verdict.sure, verdict.answer]),
		[
			[true, "yes"],
			[true, "yes"],
			[true, "yes"],
		],
	);
});

test("Q2: answers that the model of Petra gave are recorded under the decider petra-model, with no decider call", async () => {
	const store = memoryStore();
	const decider = deciderOf("fixed", sure);
	const asks: DecisionAsk[] = [
		{
			sourceRef: "cmd/c1/request-clear",
			point: "request-clear",
			taskId: null,
			messageSeq: 3,
			message: "Plan my menu",
		},
		{
			sourceRef: "cmd/c1/which-bot",
			point: "which-bot",
			taskId: null,
			messageSeq: 3,
			message: "Plan my menu",
			options: ["test-bot", "menu-bot"],
		},
	];
	const given = { decider: "petra-model", answers: { "request-clear": "yes", "which-bot": "menu-bot" } };
	const verdicts = await decisions({ store, decider, shadow: null, timeoutMs: 1000, now: () => AT }).ask(asks, given);
	assert.equal(decider.calls.length, 0);
	assert.deepEqual(
		verdicts.map((verdict) => [verdict.sure, verdict.answer]),
		[
			[true, "yes"],
			[true, "menu-bot"],
		],
	);
	assert.deepEqual(
		store.rows.map((row) => [row.sourceRef, row.decider, row.answer, row.probability, row.used]),
		[
			["cmd/c1/request-clear", "petra-model", "yes", 1, true],
			["cmd/c1/which-bot", "petra-model", "menu-bot", 1, true],
		],
	);
});

test("Q4: an answer of the model of Petra that is not an option is not used", async () => {
	const store = memoryStore();
	const decider = deciderOf("fixed", sure);
	const ask: DecisionAsk = {
		sourceRef: "cmd/c2/which-bot",
		point: "which-bot",
		taskId: null,
		messageSeq: 4,
		message: "Plan my menu",
		options: ["test-bot"],
	};
	const given = { decider: "petra-model", answers: { "which-bot": "admin-bot" } };
	const [verdict] = await decisions({ store, decider, shadow: null, timeoutMs: 1000, now: () => AT }).ask(
		[ask],
		given,
	);
	assert.equal(decider.calls.length, 0);
	assert.deepEqual([verdict?.sure, verdict?.why], [false, "not valid"]);
	assert.equal(store.rows[0]?.used, false);
});

test("Q3: each answer is one record with its point, message id, options, answer, probability, decider, time, used, shadow and ms, and no text of the message; a second run does not ask again", async () => {
	const store = memoryStore();
	const decider = deciderOf("fixed", sure);
	const run = () => decisions({ store, decider, shadow: null, timeoutMs: 1000, now: () => AT }).ask(refundAsks("t1"));
	const first = await run();
	assert.equal(store.rows.length, 3);
	const [row] = store.rows;
	assert.ok(row);
	assert.deepEqual(
		{ ...row, ms: typeof row.ms },
		{
			sourceRef: "action/t1/call-1/refund-request",
			decider: "fixed",
			taskId: "t1",
			point: "refund-request",
			messageSeq: 7,
			options: ["yes", "no"],
			answer: "yes",
			probability: 0.99,
			shadow: false,
			used: true,
			ms: "number",
			at: AT,
		},
	);
	assert.ok(!JSON.stringify(store.rows).includes("eggs"), "The records have no text of the message.");
	assert.deepEqual(await run(), first);
	assert.equal(decider.calls.length, 1, "The second run reads the records and does not ask again.");
});

// The four cases of Q4. Each one gives "not sure", and its record has used = false.
const notSureCases: { name: string; why: Exclude<Verdict["why"], "sure">; decider: Decider }[] = [
	{
		name: "an answer below the level",
		why: "below the level",
		decider: deciderOf("low", () => ({ answer: "yes", probability: 0.6 })),
	},
	{
		name: "an answer that is not an option",
		why: "not valid",
		decider: deciderOf("odd", () => ({ answer: "maybe", probability: 0.99 })),
	},
	{
		name: "an error",
		why: "error",
		decider: {
			name: "broken",
			ask: async () => {
				throw new Error("The decider is down.");
			},
		},
	},
	{
		name: "a timeout",
		why: "timeout",
		decider: { name: "slow", ask: () => new Promise(() => undefined) },
	},
];

for (const item of notSureCases) {
	test(`Q4: ${item.name} gives "not sure", and the record has used = false`, async () => {
		const store = memoryStore();
		const ask: DecisionAsk = { ...refundAsks("t1")[0], point: "refund-request" } as DecisionAsk;
		const [verdict] = await decisions({
			store,
			decider: item.decider,
			shadow: null,
			timeoutMs: 50,
			now: () => AT,
		}).ask([ask]);
		assert.deepEqual(verdict && { sure: verdict.sure, why: verdict.why }, { sure: false, why: item.why });
		assert.equal(store.rows.length, 1);
		assert.equal(store.rows[0]?.used, false);
		// An error and a timeout have no answer. The other two keep the answer of the decider.
		const expected = { "below the level": "yes", "not valid": "maybe", error: null, timeout: null }[item.why];
		assert.equal(store.rows[0]?.answer, expected);
	});
}

test("Q5: a shadow decider answers the same questions; its records have shadow = true and used = false, and its answers are never used", async () => {
	const store = memoryStore();
	const decider = deciderOf("fixed", sure);
	const shadow = deciderOf("shadow-fixed", () => ({ answer: "no", probability: 0.99 }));
	const verdicts = await decisions({ store, decider, shadow, timeoutMs: 1000, now: () => AT }).ask(refundAsks("t1"));
	assert.deepEqual(
		verdicts.map((verdict) => verdict.answer),
		["yes", "yes", "yes"],
	);
	assert.deepEqual(shadow.calls, decider.calls, "The shadow gets the same questions.");
	const shadowRows = store.rows.filter((row) => row.shadow);
	assert.deepEqual(
		shadowRows.map((row) => [row.decider, row.answer, row.used]),
		[
			["shadow-fixed", "no", false],
			["shadow-fixed", "no", false],
			["shadow-fixed", "no", false],
		],
	);
});

test("Q5: a shadow decider that fails changes nothing", async () => {
	const store = memoryStore();
	const shadow: Decider = {
		name: "shadow-broken",
		ask: async () => {
			throw new Error("down");
		},
	};
	const verdicts = await decisions({
		store,
		decider: deciderOf("fixed", sure),
		shadow,
		timeoutMs: 1000,
		now: () => AT,
	}).ask(refundAsks("t1"));
	assert.ok(verdicts.every((verdict) => verdict.sure));
	assert.equal(store.rows.filter((row) => row.shadow && row.answer === null).length, 3);
});

test("Q5: the shadow decider must have a different name from the decider", () => {
	const decider = deciderOf("fixed", sure);
	assert.throws(
		() => decisions({ store: memoryStore(), decider, shadow: decider, timeoutMs: 1, now: () => AT }),
		/different name/,
	);
});

test("Q1: a choice point takes its options from the ask, and a point with no options is refused", async () => {
	const store = memoryStore();
	const decider = deciderOf("fixed", sure);
	const point: PointId = "which-bot";
	const ask = { sourceRef: "cmd/c1/which-bot", point, taskId: null, messageSeq: null, message: "Hello." };
	const [verdict] = await decisions({ store, decider, shadow: null, timeoutMs: 1000, now: () => AT }).ask([
		{ ...ask, options: ["test-bot"] },
	]);
	assert.deepEqual(verdict && [verdict.sure, verdict.answer], [true, "test-bot"]);
	await assert.rejects(
		decisions({ store, decider, shadow: null, timeoutMs: 1000, now: () => AT }).ask([
			{ ...ask, sourceRef: "cmd/c2/which-bot" },
		]),
		/options/,
	);
});
