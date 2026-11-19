import assert from "node:assert/strict";
import test from "node:test";

import { testBot } from "@tensquads/bots";
import type { Brief, TaskResult } from "@tensquads/contracts";
import type { CheckerModel, CheckRequest } from "@tensquads/core";

import { CODE_TESTS, checker } from "../src/index.js";

const brief = (done: string, factIds: string[] = []): Brief => ({
	goal: "Tell the hours of the shop.",
	done,
	facts: factIds.map((id) => ({ id, text: `The text of ${id}.` })),
	limits: { maxTurns: 10, maxBudget: 0.5 },
	notInTask: [],
	replyTo: "task-1",
});

const result = (answer: string, evidence: string[] = []): TaskResult => ({
	stop: "success",
	answer,
	evidence,
	proposedFacts: [],
	notes: [],
});

// A checker model that records each request and gives a fixed verdict.
function recordingModel(pass: boolean): CheckerModel & { requests: CheckRequest[] } {
	const requests: CheckRequest[] = [];
	return {
		requests,
		check: async (request) => {
			requests.push(request);
			return { pass, reason: pass ? "The model passes it." : "The model fails it." };
		},
	};
}

const input = (b: Brief, r: TaskResult, forget: string[] = []) => ({
	taskId: "task-1",
	bot: testBot.id,
	brief: b,
	result: r,
	forget,
});

test("K1: the tests by code run first; a result that fails them does not reach the checker model", async () => {
	const model = recordingModel(true);
	const check = checker(model);
	const verdict = await check(
		input(brief("Give the hours.\n- opening hours\n- closing day"), result("Opening hours: 9 to 5.")),
	);
	assert.equal(verdict.verdict, "continue");
	assert.match(verdict.reason, /^Tests by code: .*"closing day"/);
	assert.equal(model.requests.length, 0);
});

test("K1: each fact that the result names must have an id from the brief", async () => {
	const model = recordingModel(true);
	const check = checker(model);
	const named = await check(
		input(brief("Give the hours.", ["fact-1"]), result("Open at 9 [fact:fact-1].", ["fact/fact-2"])),
	);
	assert.equal(named.verdict, "continue");
	assert.match(named.reason, /"fact-2"/);
	const inText = await check(input(brief("Give the hours.", ["fact-1"]), result("Open at 9 [fact:fact-9].")));
	assert.equal(inText.verdict, "continue");
	assert.match(inText.reason, /"fact-9"/);
	assert.equal(model.requests.length, 0);
});

test("K1: a result that passes the tests by code goes to the checker model, and stands only when the model passes it", async () => {
	const passing = recordingModel(true);
	const answer = "- opening hours: 9 to 5\n- closing day: Sunday [fact:fact-1]";
	const ok = await checker(passing)(
		input(brief("Give the hours.\n- opening hours\n- closing day", ["fact-1"]), result(answer, ["fact/fact-1"])),
	);
	assert.deepEqual(ok, { verdict: "stands", reason: "Checker model: The model passes it." });
	assert.deepEqual(passing.requests, [{ taskId: "task-1", goal: "Tell the hours of the shop.", result: answer }]);
	const failing = await checker(recordingModel(false))(input(brief("Give the hours."), result("Open at 9.")));
	assert.deepEqual(failing, { verdict: "continue", reason: "Checker model: The model fails it." });
});

test("K1: a bot with no tests by code gets no verdict that stands", async () => {
	const model = recordingModel(true);
	await assert.rejects(
		checker(model)({ ...input(brief("Give the hours."), result("Open at 9.")), bot: "other-bot" }),
		/The bot "other-bot" has no tests by code\./,
	);
	assert.equal(model.requests.length, 0);
	assert.ok(CODE_TESTS[testBot.id]);
});

test("M9: a result that has the text of a fact on the forget list of the task does not reach the checker model", async () => {
	const model = recordingModel(true);
	const check = checker(model);
	const used = await check(input(brief("Give the hours.", ["fact-1"]), result("The text of fact-1."), ["fact-1"]));
	assert.deepEqual(used, {
		verdict: "continue",
		reason: 'Tests by code: The result uses the forgotten fact "fact-1".',
	});
	assert.equal(model.requests.length, 0);
	// The same text with no forget passes the tests by code.
	const kept = await check(input(brief("Give the hours.", ["fact-1"]), result("The text of fact-1.")));
	assert.equal(kept.verdict, "stands");
});
