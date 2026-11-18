import assert from "node:assert/strict";
import { test } from "node:test";

import { ports, startSystem } from "@tensquads/core";
import { modelContract } from "@tensquads/core/contract-tests";

import { echoModel, type ScriptedAnswer, scriptedModel } from "../src/index.js";

const script: readonly ScriptedAnswer[] = [
	{ toolCalls: [{ name: "lookup", input: { order: 42 } }] },
	{ toolCalls: [{ name: "refund", input: { order: 42, amount: 1250 } }] },
	{ text: "Which amount do you want to refund?" },
	{ text: "The order 42 is ready." },
];

modelContract("model-scripted", async () => (await startSystem([scriptedModel(script)])).port(ports.model));
modelContract("model-echo", async () => (await startSystem([echoModel()])).port(ports.model));

const request = { messages: [{ role: "user" as const, content: "Hello." }], tools: ["lookup", "refund"] };

test("model-scripted gives the answers in the order of the script, with stable tool call ids", async () => {
	const model = (await startSystem([scriptedModel(script)])).port(ports.model);
	const answers = [];
	for (const _ of script) {
		answers.push(await model.complete(request));
	}
	assert.deepEqual(
		answers.map((answer) => answer.toolCalls),
		[
			[{ id: "call-1", name: "lookup", input: { order: 42 } }],
			[{ id: "call-2", name: "refund", input: { order: 42, amount: 1250 } }],
			[],
			[],
		],
	);
	assert.deepEqual(
		answers.map((answer) => answer.text),
		["", "", "Which amount do you want to refund?", "The order 42 is ready."],
	);
});

test("model-scripted throws a clear error when the script ends", async () => {
	const model = (await startSystem([scriptedModel([{ text: "only" }])])).port(ports.model);
	await model.complete(request);
	await assert.rejects(model.complete(request), {
		message: "The scripted model has no answer for request 2. The script has 1 answers.",
	});
});

test("model-echo gives the text of the last user message", async () => {
	const model = (await startSystem([echoModel()])).port(ports.model);
	const answer = await model.complete({
		messages: [
			{ role: "user", content: "first" },
			{ role: "user", content: "last" },
			{ role: "assistant", content: "reply" },
		],
		tools: [],
	});
	assert.equal(answer.text, "last");
});
