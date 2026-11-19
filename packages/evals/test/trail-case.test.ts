import assert from "node:assert/strict";
import { test } from "node:test";

import { caseFromTrail, type TrailCaseInput } from "../src/index.js";

// The rows of the trail of an ended task that the owner rejected, as the admin trail call gives them.
const rows = [
	{
		kind: "owner message",
		actor: "owner",
		summary: "The owner asked for a task.",
		data: { text: "Please refund 60 to cust-9" },
	},
	{
		kind: "message to the owner",
		actor: "petra",
		summary: "Petra sent a message of the type approval_request to the owner.",
		data: { type: "approval_request", content: 'refund {"amount":60,"to":"cust-9"}' },
	},
	{ kind: "approval", actor: "owner", summary: "The owner rejected the action call-1.", data: { status: "rejected" } },
];

const input = (overrides: Partial<TrailCaseInput> = {}): TrailCaseInput => ({
	caseId: "from-t1",
	taskId: "t1",
	rows,
	open: false,
	customer: { names: [], addresses: [] },
	clean: (text) => text,
	...overrides,
});

test("E4: an ended task with a rejected approval gives a case for a person to review, with the steps of the owner", () => {
	const made = caseFromTrail(input());
	assert.ok("case" in made, JSON.stringify(made));
	assert.equal(made.case.id, "from-t1");
	assert.equal(made.case.grader.kind, "person");
	assert.deepEqual(made.case.input, [
		{ type: "OwnerMessage", text: "Please refund 60 to cust-9" },
		{ type: "ApprovalDecision", decision: "reject", when: "when the task waits" },
	]);
	assert.match(made.case.expected.text, /The owner rejected: refund/);
});

test("E4: the function refuses a trail that it cannot clean, an open task, and a task that the owner did not reject or change", () => {
	const email = [{ ...rows[0]!, data: { text: "Refund ahmed@example.com, phone 0501234567" } }, ...rows.slice(1)];
	assert.match(String((caseFromTrail(input({ rows: email })) as { refused: string }).refused), /cannot be cleaned/);
	assert.match(String((caseFromTrail(input({ open: true })) as { refused: string }).refused), /still open/);
	const approved = rows.map((row) => (row.kind === "approval" ? { ...row, data: { status: "approved" } } : row));
	assert.match(String((caseFromTrail(input({ rows: approved })) as { refused: string }).refused), /did not reject/);
});

test("E4: a deleted trail gives a clear refusal", () => {
	assert.deepEqual(caseFromTrail(input({ rows: [] })), {
		refused:
			"The trail of the task t1 was deleted or does not exist. A case can be made only from a trail that exists.",
	});
});
