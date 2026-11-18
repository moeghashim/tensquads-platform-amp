import assert from "node:assert/strict";
import { test } from "node:test";

import { type ModelMessage, ports, startSystem } from "@tensquads/core";

import { ruleModel } from "../src/index.js";

async function complete(messages: ModelMessage[]) {
	const system = await startSystem([ruleModel()]);
	return system.port(ports.model).complete({ messages, tools: [] });
}

const brief = (goal: string): ModelMessage => ({ role: "user", content: `Goal: ${goal}\nDone: a result` });
const result = (output: string): ModelMessage => ({
	role: "tool",
	content: JSON.stringify({ toolCallId: "x", tool: "read_file", output, isError: false }),
});

test("L8: the rule model asks a question first, then reads files, one tool in each turn", async () => {
	const first = await complete([brief("ask, then read 2 files")]);
	assert.deepEqual(
		first.toolCalls.map((call) => call.name),
		["ask_question"],
	);
	const second = await complete([brief("ask, then read 2 files"), result("Monday")]);
	assert.deepEqual(
		second.toolCalls.map((call) => [call.id, call.name]),
		[["call-2", "read_file"]],
	);
	const third = await complete([brief("ask, then read 2 files"), result("Monday"), result("9 to 5")]);
	assert.equal(third.toolCalls[0]?.id, "call-3");
});

test("L3: the last answer of a bot task repeats each message of the owner one time", async () => {
	const done = await complete([
		brief("read 1 file"),
		result("9 to 5"),
		{ role: "user", content: "Also check Sunday." },
	]);
	assert.deepEqual(done.toolCalls, []);
	assert.equal(done.text, "Result: read 1 file\nMessage: Also check Sunday.\n9 to 5");
});
