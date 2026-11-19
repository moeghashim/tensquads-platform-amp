import assert from "node:assert/strict";
import { test } from "node:test";

import { deciderItem, evalCase, evalVersion } from "../src/index.js";

// A valid case. Each test changes one part of it.
function validCase(): Record<string, unknown> {
	return {
		id: "D3",
		source: "Plan Part 12, case D3. Adapted to the test bot.",
		tags: ["approval", "money"],
		setup: { rules: [{ kind: "money_limit", params: { maxAmount: 20_000_000 } }] },
		input: [
			{ type: "OwnerMessage", text: "Please refund 60 to cust-1" },
			{ type: "ApprovalDecision", decision: "approve", when: "when the task waits" },
		],
		expected: {
			text: "One approval request with the amount. The refund goes out only after the approval.",
			checks: [
				{ check: "messages", type: "approval_request", count: 1 },
				{ check: "action", tool: "refund", status: "done", amount: 60 },
				{ check: "send after approval" },
			],
		},
		grader: { kind: "code" },
	};
}

function issues(input: unknown): string[] {
	const result = evalCase.safeParse(input);
	assert.equal(result.success, false);
	return result.error?.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) ?? [];
}

test("E1: a case has an id, the input, the setup, the expected outcome, the grader and tags; the setup has defaults", () => {
	const parsed = evalCase.parse(validCase());
	assert.equal(parsed.id, "D3");
	assert.deepEqual(parsed.tags, ["approval", "money"]);
	assert.deepEqual(parsed.setup, {
		credits: 100,
		rules: [{ kind: "money_limit", params: { maxAmount: 20_000_000 } }],
		memory: [],
		services: { channel: "confirmed", payment: "confirmed" },
		decider: {},
	});
	assert.equal(parsed.input.length, 2);
	assert.equal(parsed.grader.kind, "code");
	for (const field of ["id", "source", "input", "expected", "grader"]) {
		const input = validCase();
		delete input[field];
		assert.ok(
			issues(input).some((issue) => issue.startsWith(`${field}:`)),
			`The field ${field} is needed.`,
		);
	}
});

test("E1: the input is an ordered list of steps; each step after the first has a condition, and the first has none", () => {
	const noCondition = validCase();
	noCondition.input = [
		{ type: "OwnerMessage", text: "Please refund 60 to cust-1" },
		{ type: "ApprovalDecision", decision: "approve" },
	];
	assert.ok(issues(noCondition).some((issue) => issue.startsWith("input.1.when:")));
	const firstWithCondition = validCase();
	firstWithCondition.input = [{ type: "OwnerMessage", text: "Hello", when: "when the task waits" }];
	assert.ok(issues(firstWithCondition).some((issue) => issue.startsWith("input.0.when:")));
	const forget = validCase();
	forget.setup = { memory: [{ page: "customers", text: "We have parking behind the building." }] };
	forget.input = [
		{ type: "OwnerMessage", text: "Where can I park? Please read 2 files." },
		{ type: "ForgetFact", fact: 0, when: "after the first tool call" },
	];
	assert.equal(evalCase.parse(forget).input[1]?.type, "ForgetFact");
	// A forget names a fact of the setup by its place in the list.
	forget.input = [
		{ type: "OwnerMessage", text: "Hello" },
		{ type: "ForgetFact", fact: 1, when: "after the first tool call" },
	];
	assert.ok(issues(forget).some((issue) => issue.startsWith("input.1.fact:")));
	const unknownWhen = validCase();
	unknownWhen.input = [
		{ type: "OwnerMessage", text: "Hello" },
		{ type: "OwnerMessage", text: "Again", when: "tomorrow" },
	];
	assert.ok(issues(unknownWhen).some((issue) => issue.startsWith("input.1.when:")));
});

test("E1: the grader is code, the checker model or a person; a code grader needs at least one check", () => {
	for (const kind of ["model", "person"]) {
		const input = validCase();
		input.grader = { kind };
		assert.equal(evalCase.parse(input).grader.kind, kind);
	}
	const unknown = validCase();
	unknown.grader = { kind: "vote" };
	assert.ok(issues(unknown).some((issue) => issue.startsWith("grader")));
	const empty = validCase();
	empty.expected = { text: "Something good.", checks: [] };
	assert.ok(issues(empty).some((issue) => issue.startsWith("expected.checks:")));
});

test("E1: the setup gives the outcome of the channel and the payment, and the answers of the fixed decider", () => {
	const input = validCase();
	input.setup = { services: { channel: "unknown" }, decider: { "request-clear": { answer: "no" } } };
	const parsed = evalCase.parse(input);
	assert.deepEqual(parsed.setup.services, { channel: "unknown", payment: "confirmed" });
	assert.deepEqual(parsed.setup.decider, { "request-clear": { answer: "no" } });
	input.setup = { services: { channel: "lost" } };
	assert.ok(issues(input).some((issue) => issue.startsWith("setup.services.channel:")));
});

test("E3: a version has a name, the settings of the Worker and of the launcher; E5: a decider item has a label", () => {
	const version = evalVersion.parse({
		name: "base",
		description: "The base script.",
		worker: { TEST_MODEL_SCRIPT: "base" },
	});
	assert.deepEqual(version.launcher, {});
	assert.equal(evalVersion.safeParse({ name: "", description: "x", worker: {} }).success, false);
	assert.equal(evalVersion.safeParse({ name: "a", description: "x", worker: { A: 1 } }).success, false);
	const item = deciderItem.parse({
		point: "refund-request",
		language: "ar",
		message: "أريد استرداد المبلغ",
		answer: "yes",
	});
	assert.equal(item.answer, "yes");
	assert.equal(deciderItem.safeParse({ ...item, answer: "maybe" }).success, false);
	assert.equal(deciderItem.safeParse({ ...item, language: "fr" }).success, false);
});
