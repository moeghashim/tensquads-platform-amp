import assert from "node:assert/strict";
import { test } from "node:test";
import { botDefinition } from "../src/index.js";

// A valid definition. Each test changes one part of it.
function validBot(): Record<string, unknown> {
	return {
		id: "sample-bot",
		version: "1.2.3",
		taskTypes: [
			{
				name: "answer-question",
				price: 2,
				limits: { maxTurns: 5, maxBudget: 0.25 },
			},
		],
		tools: [
			{ name: "read_file", kind: "read", replay: "safe" },
			{ name: "send_reply", kind: "action", actionKind: "public" },
		],
		readList: ["memory/core"],
		factPages: ["customers"],
	};
}

function issuePaths(input: unknown): string[] {
	const result = botDefinition.safeParse(input);
	assert.equal(result.success, false);
	return result.error?.issues.map((issue) => issue.path.join(".")) ?? [];
}

test("the valid sample passes", () => {
	assert.equal(botDefinition.safeParse(validBot()).success, true);
});

test("an action tool with no actionKind fails", () => {
	const bot = validBot();
	bot.tools = [{ name: "send_reply", kind: "action" }];
	assert.deepEqual(issuePaths(bot), ["tools.0.actionKind"]);
});

test("a read tool with actionKind fails", () => {
	const bot = validBot();
	bot.tools = [{ name: "read_file", kind: "read", replay: "safe", actionKind: "money" }];
	assert.deepEqual(issuePaths(bot), ["tools.0"]);
});

test("duplicate tool names fail with a clear message", () => {
	const bot = validBot();
	bot.tools = [
		{ name: "read_file", kind: "read", replay: "safe" },
		{ name: "read_file", kind: "compute", replay: "unsafe" },
	];
	const result = botDefinition.safeParse(bot);
	assert.equal(result.success, false);
	assert.deepEqual(
		result.error?.issues.map((issue) => issue.message),
		["Each tool name must be unique."],
	);
});

test("duplicate task type names fail", () => {
	const bot = validBot();
	const [first] = bot.taskTypes as unknown[];
	bot.taskTypes = [first, first];
	assert.deepEqual(issuePaths(bot), ["taskTypes"]);
});

test("an unknown key fails", () => {
	const bot = validBot();
	bot.instructions = "Be nice.";
	assert.deepEqual(issuePaths(bot), [""]);
});

test("a price of 0 fails", () => {
	const bot = validBot();
	bot.taskTypes = [{ name: "answer-question", price: 0, limits: { maxTurns: 5, maxBudget: 1 } }];
	assert.deepEqual(issuePaths(bot), ["taskTypes.0.price"]);
});
