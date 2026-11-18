import assert from "node:assert/strict";
import { test } from "node:test";
import { botDefinition } from "@tensquads/contracts";
import { testBot } from "../src/index.js";

test("the test bot passes the schema", () => {
	assert.deepEqual(botDefinition.parse(testBot), testBot);
});

test("the test bot has one task type and a money action tool", () => {
	assert.equal(testBot.taskTypes.length, 1);
	const moneyTools = testBot.tools.filter((tool) => tool.kind === "action" && tool.actionKind === "money");
	assert.ok(moneyTools.length >= 1);
});
