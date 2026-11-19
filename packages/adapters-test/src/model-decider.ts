// The decider that asks the model port (decision D19, build item 3 of task 09).
// It sends all the questions in one model call, and checks the answer before it gives it.
//
// The format of the request: one user message. Its first line is "Decider questions:". The second line is
// the JSON {"questions":[{"id","point","type","text","options"}]}. The model answers with only the JSON
// {"answers":[{"id","answer","probability"}]}: one answer for each question, with the same id. A "yes_no" or a
// "choice" answer is one of the options. A "score" answer is a number from 0 to 1, written as text. The
// probability is a number from 0 to 1.
import { type DeciderAnswer, type DeciderQuestion, type Plugin, ports } from "@tensquads/core";

export const DECIDER_HEADER = "Decider questions:";

const INSTRUCTION =
	'Answer with only JSON: {"answers":[{"id":"...","answer":"...","probability":0.0}]}. One answer for each question. ' +
	"For yes_no and choice, the answer is one of the options. For score, the answer is a number from 0 to 1.";

function deciderRequestText(questions: readonly DeciderQuestion[]): string {
	return [DECIDER_HEADER, JSON.stringify({ questions }), INSTRUCTION].join("\n");
}

function isAnswer(value: unknown): value is DeciderAnswer {
	if (typeof value !== "object" || value === null) return false;
	const { id, answer, probability } = value as Record<string, unknown>;
	return typeof id === "string" && typeof answer === "string" && typeof probability === "number";
}

// Parses the text of the model. A text that does not have the format is an error of the decider.
function parseDeciderAnswers(text: string, questions: readonly DeciderQuestion[]): DeciderAnswer[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("The model decider got an answer that is not JSON.");
	}
	const list = (parsed as { answers?: unknown } | null)?.answers;
	if (!Array.isArray(list) || !list.every(isAnswer)) {
		throw new Error("The model decider got an answer that does not have the format.");
	}
	return questions.map((question) => {
		const found = list.find((answer) => answer.id === question.id);
		if (!found) throw new Error(`The model decider got no answer for the question "${question.id}".`);
		return { id: found.id, answer: found.answer, probability: found.probability };
	});
}

export function modelDecider(): Plugin {
	return {
		name: "decider-model",
		provides: [ports.decider],
		needs: [ports.model],
		apply: (ctx) => {
			const model = ctx.port(ports.model);
			ctx.provide(ports.decider, {
				name: "model",
				ask: async (questions) => {
					const answer = await model.complete({
						messages: [{ role: "user", content: deciderRequestText(questions) }],
						tools: [],
					});
					return parseDeciderAnswers(answer.text, questions);
				},
			});
		},
	};
}
