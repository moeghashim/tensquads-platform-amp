// The rules of the costs, with a store in memory (requirements S1, S2, S4 and S9).
import assert from "node:assert/strict";
import test from "node:test";

import type { ModelAnswer } from "@tensquads/core";

import { amountOf, type CostStore, costs, divide, type NewCost } from "../src/index.js";

const AT = "2026-11-18T10:00:00.000Z";

// A store in memory. A row with a key that is there does not change.
function memoryStore(prices: Record<string, number> = {}) {
	const rows = new Map<string, NewCost>();
	const store: CostStore = {
		unitPrice: async ({ provider, model, unit }) => prices[`${provider}/${model}/${unit}`],
		addCost: async (row) => {
			if (!rows.has(row.sourceRef)) rows.set(row.sourceRef, row);
		},
		taskCost: async (taskId) =>
			[...rows.values()].filter((row) => row.taskId === taskId).reduce((sum, row) => sum + row.amount, 0),
	};
	return { rows, store };
}

const answer = (requestId: string, inputTokens: number, outputTokens: number): ModelAnswer => ({
	text: "ok",
	toolCalls: [],
	requestId,
	provider: "test",
	model: "scripted",
	usage: { inputTokens, outputTokens },
});

test("S1: the amount is the units times the price of one unit, in whole millionths, rounded half up", () => {
	// A price for 1M tokens counts tokens. 1500 tokens at 3 USD for 1M tokens is 4500 millionths.
	assert.equal(amountOf(1500, "1M input tokens", 3_000_000), 4500);
	// 500000 tokens at 3 millionths for 1M tokens is 1.5 millionths. Half goes up.
	assert.equal(amountOf(500_000, "1M input tokens", 3), 2);
	assert.equal(amountOf(499_999, "1M input tokens", 3), 1);
	// The sandbox counts milliseconds. A price for 1k seconds is the price of one million milliseconds.
	assert.equal(amountOf(400, "1k seconds", 3700), 1);
	assert.equal(amountOf(500, "1k seconds", 3000), 2);
	assert.equal(amountOf(499, "1k seconds", 3000), 1);
	assert.equal(amountOf(3, "call", 100), 300);
	assert.equal(amountOf(1, "share", -40), -40);
});

test("S1: a model call of a gateway call gives two rows, one for input and one for output, with the attempt", async () => {
	const { rows, store } = memoryStore({ "test/scripted/1M input tokens": 2_000_000 });
	const book = costs({ store, now: () => AT });
	await book.modelCall({ taskId: "t1", attemptNo: 2, callNo: 5 }, answer("req-1", 1000, 10));
	// The same report two times adds one row of each unit.
	await book.modelCall({ taskId: "t1", attemptNo: 2, callNo: 5 }, answer("req-1", 1000, 10));
	assert.deepEqual(
		[...rows.values()].map((row) => [
			row.sourceRef,
			row.attemptNo,
			row.kind,
			row.units,
			row.unit,
			row.unitPrice,
			row.amount,
		]),
		[
			["model/t1/2/5/req-1/input", 2, "large model", 1000, "1M input tokens", 2_000_000, 2000],
			// A cost with no price gets the price 0 and the amount 0. The operations view lists it.
			["model/t1/2/5/req-1/output", 2, "large model", 10, "1M output tokens", 0, 0],
		],
	);
});

test("S1: a model call in a command has the key of the command, and the sandbox and a service have their keys", async () => {
	const { rows, store } = memoryStore();
	const book = costs({ store, now: () => AT });
	await book.modelCall({ cause: "cmd/c1", taskId: null }, answer("req-9", 5, 6));
	await book.usage({ cause: "cmd/c1", taskId: null }, "decider", [
		{ requestId: "fixed-1", provider: "test", model: "fixed", units: 1, unit: "call" },
	]);
	await book.sandbox({ taskId: "t1", attemptNo: 1, callNo: 3 }, 12_345);
	await book.outsideService({ taskId: "t1", attemptNo: 1, toolCallId: "call-1", provider: "test-payment" });
	assert.deepEqual(
		[...rows.values()].map((row) => [row.sourceRef, row.kind, row.provider, row.model, row.units, row.unit]),
		[
			["cmd/c1/model/req-9/input", "large model", "test", "scripted", 5, "1M input tokens"],
			["cmd/c1/model/req-9/output", "large model", "test", "scripted", 6, "1M output tokens"],
			["cmd/c1/model/fixed-1/call", "decider", "test", "fixed", 1, "call"],
			["task/t1/1/3/sandbox", "sandbox", "launcher", "", 12_345, "1k seconds"],
			["action/t1/call-1/service", "outside service", "test-payment", "", 1, "call"],
		],
	);
});

test("S9: the budget of a task is reached when the sum of its cost rows is at the limit or above", async () => {
	const { store } = memoryStore({ "test/scripted/1M input tokens": 100_000_000 });
	const book = costs({ store, now: () => AT });
	// 2000 tokens at 100 USD for 1M tokens cost 0.2 USD.
	await book.modelCall({ taskId: "t1", attemptNo: 1, callNo: 2 }, answer("req-1", 2000, 0));
	assert.equal(await book.overBudget("t1", 0.5), false);
	await book.modelCall({ taskId: "t1", attemptNo: 2, callNo: 2 }, answer("req-2", 3000, 0));
	assert.equal(await book.taskCost("t1"), 500_000);
	assert.equal(await book.overBudget("t1", 0.5), true);
});

test("S4: an amount that does not divide evenly gives whole parts, the remainder by the account ids, and the sum is the amount", () => {
	const parts = divide(100, [
		{ accountId: "c", usage: 1 },
		{ accountId: "a", usage: 1 },
		{ accountId: "b", usage: 1 },
	]);
	assert.deepEqual(parts, [
		{ accountId: "a", usage: 1, amount: 34 },
		{ accountId: "b", usage: 1, amount: 33 },
		{ accountId: "c", usage: 1, amount: 33 },
	]);
});

test("S4: the parts follow the usage, and the remainder goes to the largest fractions first", () => {
	// 10 in the proportion 1:2:4 is 1.43, 2.86 and 5.71. The two units of the remainder go to b and c.
	const parts = divide(10, [
		{ accountId: "a", usage: 1 },
		{ accountId: "b", usage: 2 },
		{ accountId: "c", usage: 4 },
	]);
	assert.deepEqual(
		parts.map((part) => part.amount),
		[1, 3, 6],
	);
});

test("S4: with no usage, the parts are equal", () => {
	const parts = divide(10, [
		{ accountId: "b", usage: 0 },
		{ accountId: "a", usage: 0 },
		{ accountId: "c", usage: 0 },
	]);
	assert.deepEqual(
		parts.map((part) => [part.accountId, part.amount]),
		[
			["a", 4],
			["b", 3],
			["c", 3],
		],
	);
});
