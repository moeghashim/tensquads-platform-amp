import assert from "node:assert/strict";
import test from "node:test";

import { actionIdOf, canonicalJson, contentHash, type GateStore, ruleCheck } from "../src/index.js";

test("G4: the content hash does not depend on the order of the keys, and changes with the content", async () => {
	assert.equal(
		canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } }),
		'{"a":{"c":null,"d":[2,{"x":2,"y":1}]},"b":1}',
	);
	const first = await contentHash("refund", { amount: 15, to: "cust-1", currency: "USD" });
	assert.equal(first, await contentHash("refund", { currency: "USD", to: "cust-1", amount: 15 }));
	assert.match(first, /^[0-9a-f]{64}$/);
	assert.notEqual(first, await contentHash("refund", { amount: 16, to: "cust-1", currency: "USD" }));
	assert.notEqual(first, await contentHash("send_reply", { amount: 15, to: "cust-1", currency: "USD" }));
});

test("G5: the id of an action is the task id and the tool-call id", () => {
	assert.equal(actionIdOf("task-1", "call-3"), "task-1/call-3");
});

function storeWith(maxAmount: number | undefined): GateStore {
	const missing = async () => {
		throw new Error("Not used.");
	};
	return {
		action: missing,
		actionById: missing,
		addAction: missing,
		moveAction: missing,
		approval: missing,
		addApproval: missing,
		activeRule: async () =>
			maxAmount === undefined ? undefined : { ruleId: "rule-1", kind: "money_limit", params: { maxAmount } },
	};
}

test("G2: a money action at or below the limit needs nothing; above it, or with no rule, it needs an approval", async () => {
	const limit20 = storeWith(20_000_000);
	assert.deepEqual(await ruleCheck(limit20, "money", { amount: 15 }), { needs: "nothing" });
	assert.deepEqual(await ruleCheck(limit20, "money", { amount: 20 }), { needs: "nothing" });
	assert.deepEqual(await ruleCheck(limit20, "money", { amount: 20.01 }), {
		needs: "approval",
		ruleId: "rule-1",
		limit: 20_000_000,
	});
	assert.deepEqual(await ruleCheck(storeWith(undefined), "money", { amount: 1 }), {
		needs: "approval",
		ruleId: null,
		limit: null,
	});
});

test("G3: a public action always needs an approval, and the kind other needs nothing", async () => {
	const limit20 = storeWith(20_000_000);
	assert.deepEqual(await ruleCheck(limit20, "public", { to: "c", text: "hi" }), {
		needs: "approval",
		ruleId: null,
		limit: null,
	});
	assert.deepEqual(await ruleCheck(limit20, "other", {}), { needs: "nothing" });
});
