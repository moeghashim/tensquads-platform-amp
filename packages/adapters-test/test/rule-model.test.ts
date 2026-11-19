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

test("G2: the goal 'refund 15 to cust-1' makes one refund call, then the final answer", async () => {
	const first = await complete([brief("refund 15 to cust-1")]);
	assert.deepEqual(first.toolCalls, [
		{ id: "call-1", name: "refund", input: { amount: 15, to: "cust-1", currency: "USD" } },
	]);
	const done = await complete([brief("refund 15 to cust-1"), result("confirmed")]);
	assert.deepEqual(done.toolCalls, []);
});

test("G3: the goal 'reply hello to cust-1' makes one send_reply call", async () => {
	const first = await complete([brief("reply hello to cust-1")]);
	assert.deepEqual(first.toolCalls, [{ id: "call-1", name: "send_reply", input: { to: "cust-1", text: "hello" } }]);
});

test("G8: 'refund 40 then 45 after a restart' asks for 40 the first time and 45 each later time", async () => {
	const system = await startSystem([ruleModel()]);
	const model = system.port(ports.model);
	const ask = async () =>
		(await model.complete({ messages: [brief("refund 40 then 45 after a restart")], tools: [] })).toolCalls[0];
	assert.deepEqual(await ask(), {
		id: "call-1",
		name: "refund",
		input: { amount: 40, to: "cust-1", currency: "USD" },
	});
	assert.deepEqual(await ask(), {
		id: "call-1",
		name: "refund",
		input: { amount: 45, to: "cust-1", currency: "USD" },
	});
	assert.deepEqual((await ask())?.input, { amount: 45, to: "cust-1", currency: "USD" });
	// A new instance of the model starts again at 40.
	const fresh = await complete([brief("refund 40 then 45 after a restart")]);
	assert.deepEqual(fresh.toolCalls[0]?.input, { amount: 40, to: "cust-1", currency: "USD" });
});

test("G11: the append script appends one line in each turn, then reads the file", async () => {
	const first = await complete([brief("append 2 lines")]);
	assert.deepEqual(first.toolCalls, [
		{ id: "call-1", name: "append_file", input: { path: "notes.txt", text: "line 1\n" } },
	]);
	const third = await complete([brief("append 2 lines"), result("x"), result("y")]);
	assert.deepEqual(third.toolCalls, [{ id: "call-3", name: "read_file", input: { path: "notes.txt" } }]);
});

test("K3: 'wrong then right' marks the first answer wrong and the answer after it right; 'always wrong' marks each one", async () => {
	const first = await complete([brief("wrong then right")]);
	assert.match(first.text, /^WRONG: Result: wrong then right/);
	const second = await complete([
		brief("wrong then right"),
		{ role: "assistant", content: first.text },
		{ role: "user", content: "Checker model: The result is marked wrong." },
	]);
	assert.match(second.text, /^Result: wrong then right/);
	const again = await complete([
		brief("always wrong"),
		{ role: "assistant", content: "WRONG: Result: always wrong" },
		{ role: "user", content: "Checker model: The result is marked wrong." },
	]);
	assert.match(again.text, /^WRONG: /);
});

test("M10: for a night job request, the rule model proposes one core item for each owner message that starts with Always or Never", async () => {
	const answer = await complete([
		{
			role: "user",
			content: [
				"Night job: propose items for the core.",
				"[cmd/a/in] Always answer within one hour.",
				"[cmd/b/in] Thanks, that is all.",
				"[cmd/c/in] never open on Sunday.",
			].join("\n"),
		},
	]);
	assert.deepEqual(answer.toolCalls, []);
	assert.deepEqual(JSON.parse(answer.text), [
		{ text: "Always answer within one hour.", evidence: ["cmd/a/in"] },
		{ text: "never open on Sunday.", evidence: ["cmd/c/in"] },
	]);
});
