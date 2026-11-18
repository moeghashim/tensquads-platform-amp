import assert from "node:assert/strict";
import { test } from "node:test";
import { testBot } from "@tensquads/bots";

import { calculate, readFile, TEST_FILES, testBotRunner } from "../src/index.js";

test("L13: the runner plug-in has the definition of the test bot from packages/bots", () => {
	assert.equal(testBotRunner.definition, testBot);
	assert.ok(testBotRunner.instructions.length > 0);
});

test("the plug-in has one tool for each read tool and compute tool of the definition, and no action tool", () => {
	const sandboxTools = testBot.tools.filter((tool) => tool.kind !== "action").map((tool) => tool.name);
	assert.deepEqual(Object.keys(testBotRunner.tools).sort(), sandboxTools.sort());
});

test("read_file gives the content of a file of the bot", async () => {
	assert.equal(await readFile({ path: "shop/hours.txt" }), TEST_FILES["shop/hours.txt"]);
	await assert.rejects(readFile({ path: "secret.txt" }), /No file has the path "secret.txt"/);
	await assert.rejects(readFile({}), /needs the text field "path"/);
});

test("calculate gives the result of one operation", async () => {
	assert.equal(await calculate({ op: "add", a: 2, b: 3 }), "5");
	assert.equal(await calculate({ op: "subtract", a: 2, b: 3 }), "-1");
	assert.equal(await calculate({ op: "multiply", a: 12, b: 3 }), "36");
	assert.equal(await calculate({ op: "divide", a: 9, b: 2 }), "4.5");
	await assert.rejects(calculate({ op: "divide", a: 1, b: 0 }), /cannot divide by zero/);
	await assert.rejects(calculate({ op: "power", a: 1, b: 2 }), /needs "op"/);
	await assert.rejects(calculate({ op: "toString", a: 1, b: 2 }), /needs "op"/);
	await assert.rejects(calculate({ op: "add", a: "1", b: 2 }), /needs the numbers/);
});
