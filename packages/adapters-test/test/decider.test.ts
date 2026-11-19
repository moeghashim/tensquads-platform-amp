import assert from "node:assert/strict";
import { test } from "node:test";

import { type DeciderQuestion, type Plugin, ports, startSystem } from "@tensquads/core";
import { deciderContract } from "@tensquads/core/contract-tests";

import { fixedDecider, modelDecider, noShadowDecider, petraTestModel, ruleModel, scriptedModel } from "../src/index.js";

deciderContract("decider-fixed", async () => (await startSystem([fixedDecider()])).port(ports.decider));
deciderContract("decider-fixed with an answer", async () =>
	(await startSystem([fixedDecider({ answer: "no", probability: 0.4 })])).port(ports.decider),
);
deciderContract("decider-model with the rule model", async () =>
	(await startSystem([ruleModel(), modelDecider()])).port(ports.decider),
);

const questions: DeciderQuestion[] = [
	{ id: "q-1", point: "request-clear", type: "yes_no", text: "Is it clear?", options: ["yes", "no"] },
	{ id: "q-2", point: "which-bot", type: "choice", text: "Which bot?", options: ["support", "sales"] },
	{ id: "q-3", point: "message-safe", type: "score", text: "How safe?", options: [] },
];

test("Q2: decider-fixed gives the fixed answer when it is an option, and else yes or the first option", async () => {
	const decider = (await startSystem([fixedDecider({ answer: "no", probability: 0.4 })])).port(ports.decider);
	// Each call reports one unit "call", for the cost row of the decider (requirement S1).
	const usage = [{ requestId: "fixed-1", provider: "test", model: "fixed", units: 1, unit: "call" }];
	assert.deepEqual(await decider.ask(questions), [
		{ id: "q-1", answer: "no", probability: 0.4, usage },
		{ id: "q-2", answer: "support", probability: 0.4, usage },
		{ id: "q-3", answer: "1", probability: 0.4, usage },
	]);
});

test("Q2: decider-fixed with no options answers yes at 0.99, and a test gives an answer and a probability for each point", async () => {
	const plain = (await startSystem([fixedDecider()])).port(ports.decider);
	assert.deepEqual(
		(await plain.ask(questions)).map((answer) => [answer.answer, answer.probability]),
		[
			["yes", 0.99],
			["support", 0.99],
			["1", 0.99],
		],
	);
	const byPoint = (
		await startSystem([fixedDecider({ points: { "which-bot": { answer: "sales", probability: 0.5 } } })])
	).port(ports.decider);
	const usage = [{ requestId: "fixed-1", provider: "test", model: "fixed", units: 1, unit: "call" }];
	assert.deepEqual((await byPoint.ask(questions))[1], { id: "q-2", answer: "sales", probability: 0.5, usage });
});

test("Q5: the shadow row provides the shadow port with its own name, and the row none provides null", async () => {
	const system = await startSystem([fixedDecider({ shadow: true, answer: "no" })]);
	const shadow = system.port(ports.shadowDecider);
	assert.equal(shadow?.name, "shadow-fixed");
	assert.equal((await shadow?.ask(questions))?.[0]?.answer, "no");
	assert.equal((await startSystem([noShadowDecider()])).port(ports.shadowDecider), null);
});

// A model that answers with one fixed text and keeps the text of each request.
function recordingModel(text: string, seen: string[]): Plugin {
	return {
		name: "model-recording",
		provides: [ports.model],
		needs: [],
		apply: (ctx) =>
			ctx.provide(ports.model, {
				complete: async (request) => {
					seen.push(request.messages.map((message) => message.content).join("\n"));
					return {
						text,
						toolCalls: [],
						provider: "test",
						model: "recording",
						requestId: "r-1",
						usage: { inputTokens: 1, outputTokens: 1 },
					};
				},
			}),
	};
}

test("Q2: decider-model asks the model one time for all the questions, and parses its JSON answer", async () => {
	const seen: string[] = [];
	const text = JSON.stringify({
		answers: [
			{ id: "q-1", answer: "no", probability: 0.7 },
			{ id: "q-2", answer: "sales", probability: 0.95 },
			{ id: "q-3", answer: "0.2", probability: 0.8 },
		],
	});
	const decider = (await startSystem([recordingModel(text, seen), modelDecider()])).port(ports.decider);
	assert.equal(decider.name, "model");
	// The usage of the one model call goes with each answer (requirement S1).
	const usage = [
		{ requestId: "r-1", provider: "test", model: "recording", units: 1, unit: "1M input tokens" },
		{ requestId: "r-1", provider: "test", model: "recording", units: 1, unit: "1M output tokens" },
	];
	assert.deepEqual(await decider.ask(questions), [
		{ id: "q-1", answer: "no", probability: 0.7, usage },
		{ id: "q-2", answer: "sales", probability: 0.95, usage },
		{ id: "q-3", answer: "0.2", probability: 0.8, usage },
	]);
	assert.equal(seen.length, 1, "One model call for all the questions.");
	assert.match(seen[0] ?? "", /^Decider questions:/);
	assert.match(seen[0] ?? "", /"type":"score"/);
});

test("Q4: decider-model throws when the model answer is not the JSON format", async () => {
	for (const text of ["not json", JSON.stringify({ answers: [{ id: "q-1", answer: "yes" }] }), "{}"]) {
		const decider = (await startSystem([scriptedModel([{ text }]), modelDecider()])).port(ports.decider);
		await assert.rejects(decider.ask(questions), /decider/i, text);
	}
});

test("N1: for a real account, decider-model asks the model of Petra, and reads a JSON answer in a code block", async () => {
	const seen: string[] = [];
	const text = `\`\`\`json\n${JSON.stringify({ answers: [{ id: "q-1", answer: "yes", probability: 0.9 }] })}\n\`\`\``;
	const decider = (
		await startSystem([recordingModel(text, seen), petraTestModel(), modelDecider({ port: ports.petraModel })])
	).port(ports.decider);
	const [answer] = await decider.ask(questions.slice(0, 1));
	assert.equal(answer?.answer, "yes");
	assert.equal(seen.length, 1);
});
