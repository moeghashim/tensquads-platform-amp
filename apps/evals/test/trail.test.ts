import assert from "node:assert/strict";
import { test } from "node:test";

import { caseFromRows } from "../src/trail.js";

const CUSTOMER = { names: ["Ahmed Ali"], addresses: ["+966501234567"] };
const GOAL = "Please refund 60 to Ahmed. Ahmed Ali calls from +966 50 123 4567 and writes from ahmed.ali@example.com.";

const rows = [
	{ kind: "owner message", actor: "owner", summary: "The owner asked for a task.", data: { text: GOAL } },
	{
		kind: "message to the owner",
		actor: "petra",
		summary: "Petra sent a message of the type approval_request to the owner.",
		data: { type: "approval_request", content: 'refund {"amount":60,"currency":"USD","to":"Ahmed"}' },
	},
	{ kind: "approval", actor: "owner", summary: "The owner rejected the action call-1.", data: { status: "rejected" } },
];

test("E4: a trail with the name, the phone number and the email of a customer gives a case with none of them", () => {
	const made = caseFromRows({ caseId: "from-t1", taskId: "t1", rows, open: false, customer: CUSTOMER });
	assert.ok("case" in made, JSON.stringify(made));
	const text = JSON.stringify(made.case);
	for (const part of ["Ahmed", "Ali", "4567", "+966", "example.com", "@"]) {
		assert.ok(!text.includes(part), `The case has "${part}": ${text}`);
	}
	assert.match(
		made.case.input[0]?.type === "OwnerMessage" ? made.case.input[0].text : "",
		/^Please refund 60 to \[removed\]/,
	);
});

test("E4: a trail that was deleted gives a clear refusal", () => {
	assert.deepEqual(caseFromRows({ caseId: "from-t1", taskId: "t1", rows: [], open: false, customer: CUSTOMER }), {
		refused:
			"The trail of the task t1 was deleted or does not exist. A case can be made only from a trail that exists.",
	});
});
