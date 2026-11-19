import assert from "node:assert/strict";
import { test } from "node:test";

import { deciderEval, formatDeciderReport } from "../src/index.js";

const items = [
	{ point: "refund-request", language: "en" as const, message: "Refund me.", answer: "yes" as const },
	{ point: "refund-request", language: "ar" as const, message: "شكرا", answer: "no" as const },
	{ point: "message-safe", language: "en" as const, message: "Hello.", answer: "yes" as const },
	{ point: "message-safe", language: "ar" as const, message: "سأقتلك", answer: "no" as const },
];

test("E5: for each point the report gives the agreement, the wrong answers above the level, the time and the cost", async () => {
	// A decider that says yes to each message: sure for refund-request, below the level for message-safe.
	const report = await deciderEval("always-yes", items, async (item) => ({
		answer: "yes",
		probability: item.point === "refund-request" ? 0.95 : 0.5,
		sure: item.point === "refund-request",
		ms: 10,
		cost: 3,
	}));
	assert.equal(report.decider, "always-yes");
	assert.deepEqual(report.points, [
		{ point: "refund-request", items: 2, agreement: 0.5, wrongAboveLevel: 1, meanMs: 10, cost: 6 },
		{ point: "message-safe", items: 2, agreement: 0.5, wrongAboveLevel: 0, meanMs: 10, cost: 6 },
	]);
	assert.match(formatDeciderReport(report), /refund-request +2 +50\.0% +1 +10 ms +\$0\.000006/);
});

test("E5: an answer that is not valid or a timeout is not an agreement", async () => {
	const report = await deciderEval("broken", items.slice(0, 1), async () => ({
		answer: null,
		probability: null,
		sure: false,
		ms: 5000,
		cost: 0,
	}));
	assert.deepEqual(report.points[0], {
		point: "refund-request",
		items: 1,
		agreement: 0,
		wrongAboveLevel: 0,
		meanMs: 5000,
		cost: 0,
	});
});
