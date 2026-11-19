// The contract of the decider port. Each decider adapter must pass these tests.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Decider, DeciderQuestion } from "../lib/ports.js";

// One call has several typed questions (decision D25, requirement Q2).
const questions: readonly DeciderQuestion[] = [
	{ id: "q-1", point: "request-clear", type: "yes_no", text: "Is the request clear?", options: ["yes", "no"] },
	{
		id: "q-2",
		point: "which-bot",
		type: "choice",
		text: "Which bot takes the task?",
		options: ["support", "sales", "billing"],
	},
	{ id: "q-3", point: "message-safe", type: "score", text: "How safe is the message to send?", options: [] },
];

// A score answer is a number from 0 to 1, written as text. Each other answer is one of the options.
function validAnswer(question: DeciderQuestion, answer: string): boolean {
	if (question.type !== "score") return question.options.includes(answer);
	const score = Number(answer);
	return answer.trim() !== "" && score >= 0 && score <= 1;
}

// Registers the tests of the decider port. The make function gives a new decider for each test.
export function deciderContract(name: string, make: () => Promise<Decider>): void {
	describe(`${name}: decider contract`, () => {
		test("Q2: the decider has a name for its records", async () => {
			const decider = await make();
			assert.ok(decider.name.length > 0);
		});

		test("Q2: one call gives exactly one answer for each question, with the same id", async () => {
			const decider = await make();
			const answers = await decider.ask(questions);
			assert.equal(answers.length, questions.length);
			assert.deepEqual(answers.map((answer) => answer.id).sort(), questions.map((question) => question.id).sort());
		});

		test("Q2: each answer fits the type of its question, with a probability between 0 and 1", async () => {
			const decider = await make();
			const answers = await decider.ask(questions);
			for (const question of questions) {
				const answer = answers.find((candidate) => candidate.id === question.id);
				assert.ok(answer, `The question "${question.id}" has no answer.`);
				assert.ok(
					validAnswer(question, answer.answer),
					`The answer "${answer.answer}" does not fit "${question.id}".`,
				);
				assert.ok(
					answer.probability >= 0 && answer.probability <= 1,
					`The probability ${answer.probability} of "${question.id}" is not between 0 and 1.`,
				);
			}
		});

		test("Q2: one question gives one answer", async () => {
			const decider = await make();
			const [question] = questions;
			const answers = await decider.ask(question ? [question] : []);
			assert.equal(answers.length, 1);
			assert.equal(answers[0]?.id, "q-1");
		});
	});
}
