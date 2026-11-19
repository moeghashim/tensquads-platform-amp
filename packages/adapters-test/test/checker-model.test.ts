import assert from "node:assert/strict";
import { test } from "node:test";

import { ports, startSystem } from "@tensquads/core";
import { checkerModelContract } from "@tensquads/core/contract-tests";

import { ruleChecker } from "../src/index.js";

checkerModelContract("checker-model-rule", async () => (await startSystem([ruleChecker()])).port(ports.checkerModel), {
	passing: { taskId: "task-1", goal: "Answer the customer.", result: "The order is ready." },
	failing: { taskId: "task-2", goal: "Answer the customer.", result: "  " },
});

test("K2: the default rule fails a result that the rule model marked wrong, and passes the same text with no mark", async () => {
	const checker = (await startSystem([ruleChecker()])).port(ports.checkerModel);
	const request = { taskId: "task-3", goal: "Answer the customer." };
	assert.deepEqual(await checker.check({ ...request, result: "WRONG: The order is ready." }), {
		pass: false,
		reason: "The result is marked wrong.",
		// Each check reports one unit "call", for the cost row of the checker model (requirement S1).
		usage: [{ requestId: "rule-check-1", provider: "test", model: "rule-check", units: 1, unit: "call" }],
	});
	assert.equal((await checker.check({ ...request, result: "The order is ready." })).pass, true);
});
