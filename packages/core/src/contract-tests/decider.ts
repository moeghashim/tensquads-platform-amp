// The contract of the decider port. Each decider adapter must pass these tests.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Decider, DeciderQuestion } from "../lib/ports.js";

// One call has several questions (decision D25).
const questions: readonly DeciderQuestion[] = [
	{ id: "q-1", point: "task/start", text: "Is the request clear?", options: ["yes", "no"] },
	{ id: "q-2", point: "task/start", text: "Which bot takes the task?", options: ["support", "sales", "billing"] },
	{ id: "q-3", point: "answer/check", text: "Does the answer need the owner?", options: ["ask", "go"] },
];

// Registers the tests of the decider port. The make function gives a new decider for each test.
export function deciderContract(name: string, make: () => Promise<Decider>): void {
	describe(`${name}: decider contract`, () => {
		test("one call gives exactly one answer for each question, with the same id", async () => {
			const decider = await make();
			const answers = await decider.ask(questions);
			assert.equal(answers.length, questions.length);
			assert.deepEqual(answers.map((answer) => answer.id).sort(), questions.map((question) => question.id).sort());
		});

		test("each answer is one of the options of its question, with a probability between 0 and 1", async () => {
			const decider = await make();
			const answers = await decider.ask(questions);
			for (const question of questions) {
				const answer = answers.find((candidate) => candidate.id === question.id);
				assert.ok(answer, `The question "${question.id}" has no answer.`);
				assert.ok(
					question.options.includes(answer.answer),
					`The answer "${answer.answer}" is not an option of "${question.id}".`,
				);
				assert.ok(
					answer.probability >= 0 && answer.probability <= 1,
					`The probability ${answer.probability} of "${question.id}" is not between 0 and 1.`,
				);
			}
		});

		test("one question gives one answer", async () => {
			const decider = await make();
			const [question] = questions;
			const answers = await decider.ask(question ? [question] : []);
			assert.equal(answers.length, 1);
			assert.equal(answers[0]?.id, "q-1");
		});
	});
}
