// The test adapter of the decider port. It gives a fixed answer with a fixed probability.
import { type Plugin, ports } from "@tensquads/core";

export function fixedDecider(options: { answer?: string; probability?: number } = {}): Plugin {
	const probability = options.probability ?? 0.9;
	return {
		name: "decider-fixed",
		provides: [ports.decider],
		needs: [],
		apply: (ctx) => {
			ctx.provide(ports.decider, {
				ask: async (questions) =>
					questions.map((question) => {
						const [first] = question.options;
						if (first === undefined) {
							throw new Error(`The question "${question.id}" has no options.`);
						}
						// The fixed answer must be an option. If it is not, the decider gives the first option.
						const fixed = options.answer;
						const answer = fixed !== undefined && question.options.includes(fixed) ? fixed : first;
						return { id: question.id, answer, probability };
					}),
			});
		},
	};
}
