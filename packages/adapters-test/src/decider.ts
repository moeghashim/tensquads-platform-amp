// The test adapters of the decider port (requirements Q2 and Q5).
// The fixed decider gives a fixed answer with a fixed probability. A test can give one for each decision point.
import { type Decider, type DeciderQuestion, type Plugin, ports } from "@tensquads/core";

export interface FixedAnswer {
	answer?: string;
	probability?: number;
}

export interface FixedDeciderOptions extends FixedAnswer {
	// The answer of each decision point, by the id of the point. This answer goes out as it is, also when it
	// is not an option, so a test can give an answer that is not valid (requirement Q4).
	points?: Readonly<Record<string, FixedAnswer>>;
	// True: the row provides the port of the shadow decider (requirement Q5).
	shadow?: boolean;
}

// The default probability is above each level, so the default answers keep the behaviour before task 09.
const DEFAULT_PROBABILITY = 0.99;

const isScore = (text: string | undefined): text is string =>
	text !== undefined && text.trim() !== "" && Number(text) >= 0 && Number(text) <= 1;

// The default answer: "yes" for a yes or no question, the first option for a choice, and 1 for a score.
// A fixed answer replaces it when it fits the question.
function defaultAnswer(question: DeciderQuestion, fixed: string | undefined): string {
	if (question.type === "score") return isScore(fixed) ? fixed : "1";
	if (fixed !== undefined && question.options.includes(fixed)) return fixed;
	const answer = question.type === "yes_no" ? "yes" : question.options[0];
	if (answer === undefined || !question.options.includes(answer)) {
		throw new Error(`The question "${question.id}" has no option for the answer.`);
	}
	return answer;
}

export function fixedDecider(options: FixedDeciderOptions = {}): Plugin {
	const port = options.shadow ? ports.shadowDecider : ports.decider;
	const name = options.shadow ? "shadow-fixed" : "fixed";
	let calls = 0;
	const decider: Decider = {
		name,
		ask: async (questions) => {
			// Each call reports one unit "call", with a request id from the count of calls (requirement S1).
			calls += 1;
			const usage = [{ requestId: `${name}-${calls}`, provider: "test", model: name, units: 1, unit: "call" }];
			return questions.map((question) => {
				const point = options.points?.[question.point];
				const answer = point?.answer ?? defaultAnswer(question, options.answer);
				const probability = point?.probability ?? options.probability ?? DEFAULT_PROBABILITY;
				return { id: question.id, answer, probability, usage };
			});
		},
	};
	return {
		name: options.shadow ? "shadow-decider-fixed" : "decider-fixed",
		provides: [port],
		needs: [],
		apply: (ctx) => ctx.provide(port, decider),
	};
}

// The row of the shadow mode when no second decider runs (the setting SHADOW_DECIDER is "none").
export function noShadowDecider(): Plugin {
	return {
		name: "shadow-decider-none",
		provides: [ports.shadowDecider],
		needs: [],
		apply: (ctx) => ctx.provide(ports.shadowDecider, null),
	};
}
