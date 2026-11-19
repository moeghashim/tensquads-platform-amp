// The contract of the model port. Each model adapter must pass these tests.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Model, ModelAnswer, ModelRequest } from "../lib/ports.js";

const request: ModelRequest = {
	messages: [
		{ role: "system", content: "You are a test bot." },
		{ role: "user", content: "Look up the order 42." },
	],
	tools: ["lookup"],
};

function assertCount(value: number, label: string): void {
	assert.ok(Number.isInteger(value) && value >= 0, `${label} must be a non-negative integer. It is ${value}.`);
}

function assertAnswer(answer: ModelAnswer): void {
	assert.equal(typeof answer.text, "string", "The text must be a string.");
	assert.ok(answer.requestId.length > 0, "The request id must not be empty.");
	assert.ok(answer.provider.length > 0, "The provider must not be empty.");
	assert.ok(answer.model.length > 0, "The model must not be empty.");
	assertCount(answer.usage.inputTokens, "The input token count");
	assertCount(answer.usage.outputTokens, "The output token count");
	for (const call of answer.toolCalls) {
		assert.ok(call.id.length > 0, "Each tool call must have an id.");
		assert.ok(call.name.length > 0, "Each tool call must have a name.");
	}
	const ids = answer.toolCalls.map((call) => call.id);
	assert.equal(new Set(ids).size, ids.length, "The tool calls of one answer must have different ids.");
}

// Registers the tests of the model port. The make function gives a new model for each test.
export function modelContract(name: string, make: () => Promise<Model>): void {
	describe(`${name}: model contract`, () => {
		test("an answer has a provider, a model, token counts and valid tool calls", async () => {
			const model = await make();
			assertAnswer(await model.complete(request));
		});

		test("each answer in a series of requests is valid", async () => {
			const model = await make();
			const first = await model.complete(request);
			assertAnswer(first);
			const second = await model.complete({
				messages: [
					...request.messages,
					{ role: "assistant", content: first.text },
					{ role: "user", content: "Thanks." },
				],
				tools: request.tools,
			});
			assertAnswer(second);
		});
	});
}
