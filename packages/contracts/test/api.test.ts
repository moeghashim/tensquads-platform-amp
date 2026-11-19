import assert from "node:assert/strict";
import { test } from "node:test";
import { apiError, ERROR_CODES, messageListAnswer, messageListQuery } from "../src/index.js";

test("W4: each error code parses with a message", () => {
	for (const code of ERROR_CODES) {
		assert.equal(apiError.safeParse({ code, message: "Short text." }).success, true);
	}
});

test("W4: an error with a stack field fails", () => {
	const parsed = apiError.safeParse({
		code: "internal",
		message: "Something failed.",
		stack: "Error: at foo.ts:1",
	});
	assert.equal(parsed.success, false);
	assert.deepEqual(
		parsed.error?.issues.map((issue) => issue.path.join(".")),
		[""],
	);
});

test("W4: an error with an unknown code fails", () => {
	assert.equal(apiError.safeParse({ code: "teapot", message: "No." }).success, false);
});

test("W3: the list query makes a number from the text of the query string", () => {
	assert.deepEqual(messageListQuery.parse({ after: "12" }), { after: 12 });
	assert.equal(messageListQuery.safeParse({ after: "-1" }).success, false);
	assert.equal(messageListQuery.safeParse({ after: "1.5" }).success, false);
	assert.equal(messageListQuery.safeParse({ after: "abc" }).success, false);
});

test("W3: the list answer rejects a message that is not of the eight types", () => {
	const at = "2026-11-18T10:00:00Z";
	const reply = { seq: 1, at, type: "reply", text: "Hi" };
	assert.equal(messageListAnswer.safeParse({ messages: [reply] }).success, true);
	const customer = { seq: 2, at, type: "customer_message", text: "Hi" };
	assert.equal(messageListAnswer.safeParse({ messages: [reply, customer] }).success, false);
});
