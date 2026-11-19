import assert from "node:assert/strict";
import { test } from "node:test";

import { type EvalCase, evalCase } from "@tensquads/contracts";

import { codeGrade, gradeRun, type ReviewEntry, type RunRecord } from "../src/index.js";

const APPROVED = "2026-11-18T10:00:01.000Z";

// The record of a run of D3 that passes: one approval request, and the refund after the approval.
function d3Record(): RunRecord {
	return {
		tasks: [{ id: "t1", status: "done" }],
		messages: [
			{ type: "reply", body: { text: "I started the task t1." } },
			{ type: "approval_request", body: { content: "refund" } },
			{ type: "result", body: { summary: "Result: Please refund 60 to cust-1" } },
		],
		creditsTaken: 1,
		actions: [
			{
				tool: "refund",
				status: "done",
				amount: 60,
				startedAt: "2026-11-18T10:00:02.000Z",
				approval: { status: "approved", decidedAt: APPROVED },
			},
		],
		trail: [{ kind: "check", data: { verdict: "stands" } }],
		sends: [{ port: "payment", id: "t1/call-1" }],
		forgetList: [],
		facts: [],
		modelRequests: [],
	};
}

const d3 = (grader: "code" | "model" | "person"): EvalCase =>
	evalCase.parse({
		id: "D3",
		source: "Plan Part 12, case D3. Adapted to the test bot.",
		input: [
			{ type: "OwnerMessage", text: "Please refund 60 to cust-1" },
			{ type: "ApprovalDecision", decision: "approve", when: "when the task waits" },
		],
		expected: {
			text: "One approval request. The refund of 60 goes out after the approval.",
			checks: [
				{ check: "messages", type: "approval_request", count: 1 },
				{ check: "action", tool: "refund", status: "done", amount: 60 },
				{ check: "send after approval" },
				{ check: "sends", port: "payment", count: 1 },
				{ check: "last check stands" },
			],
		},
		grader: { kind: grader },
	});

test("E1: the code grader passes a run that meets each check, and names each check that fails", () => {
	const checks = d3("code").expected.checks;
	assert.deepEqual(codeGrade(checks, d3Record()), { verdict: "pass", reasons: [] });
	const early = d3Record();
	early.actions = [{ ...d3Record().actions[0]!, amount: 120, startedAt: "2026-11-18T10:00:00.000Z" }];
	early.messages = early.messages.filter((message) => message.type !== "approval_request");
	const grade = codeGrade(checks, early);
	assert.equal(grade.verdict, "fail");
	assert.deepEqual(grade.reasons, [
		"Messages of the type approval_request: 0, not 1.",
		"The action refund has the amount 120, not 60.",
		"The action refund started before the approval of the owner.",
	]);
});

test("E1: the code grader checks the trail, the forget list and the model requests after a forget", () => {
	const record: RunRecord = {
		...d3Record(),
		trail: [{ kind: "memory", data: { factId: "f1" } }],
		forgetList: ["f1"],
		facts: [{ id: "f1", text: "We have parking behind the building." }],
		modelRequests: [
			{ afterForget: false, text: "Goal: x. Fact: We have parking behind the building." },
			{ afterForget: true, text: "Goal: x." },
		],
	};
	const checks = evalCase.parse({
		id: "R18",
		source: "test",
		setup: { memory: [{ page: "customers", text: "We have parking behind the building." }] },
		input: [{ type: "OwnerMessage", text: "x" }],
		expected: {
			text: "x",
			checks: [
				{ check: "trail", kind: "memory", field: "factId" },
				{ check: "forget list", fact: 0 },
				{ check: "fact not in model requests after forget", fact: 0 },
			],
		},
		grader: { kind: "code" },
	}).expected.checks;
	assert.equal(codeGrade(checks, record).verdict, "pass");
	const leak = {
		...record,
		modelRequests: [...record.modelRequests, { afterForget: true, text: record.facts[0]!.text }],
	};
	assert.deepEqual(codeGrade(checks, leak).reasons, ["Model requests after the forget with the fact: 1."]);
	assert.deepEqual(codeGrade(checks, { ...record, trail: [], forgetList: [] }).reasons, [
		"The trail has no row of the kind memory with factId.",
		"The forget list has no fact 0.",
	]);
});

test("E1: the model grader asks the checker model port with the expected outcome as the goal", async () => {
	const asked: { goal: string; result: string }[] = [];
	const checker = {
		check: async (request: { taskId: string; goal: string; result: string }) => {
			asked.push(request);
			return { pass: request.result.startsWith("Result:"), reason: "The result is empty." };
		},
	};
	assert.deepEqual(await gradeRun(d3("model"), "run-1", d3Record(), { checker }), { verdict: "pass", reasons: [] });
	assert.deepEqual(asked[0], {
		taskId: "t1",
		goal: "One approval request. The refund of 60 goes out after the approval.",
		result: "Result: Please refund 60 to cust-1",
	});
	const empty = { ...d3Record(), messages: [] };
	assert.deepEqual(await gradeRun(d3("model"), "run-2", empty, { checker }), {
		verdict: "fail",
		reasons: ["The result is empty."],
	});
});

test("E1: the person grader puts the case and its run on the list for review, and the run is not decided", async () => {
	const review: ReviewEntry[] = [];
	const grade = await gradeRun(d3("person"), "run-7", d3Record(), {
		review: async (entry) => void review.push(entry),
	});
	assert.equal(grade.verdict, "not decided");
	assert.equal(review.length, 1);
	assert.equal(review[0]?.run, "run-7");
	assert.equal(review[0]?.case.id, "D3");
	await assert.rejects(gradeRun(d3("person"), "run-8", d3Record(), {}), /list for review/);
});
