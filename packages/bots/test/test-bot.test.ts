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

test("G11: the test bot 0.2.0 has the compute tool append_file, declared replay safe", () => {
	assert.equal(testBot.version, "0.2.0");
	const tool = testBot.tools.find((item) => item.name === "append_file");
	assert.deepEqual(tool, { name: "append_file", kind: "compute", replay: "safe" });
});
