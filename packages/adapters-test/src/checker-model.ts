// The test adapter of the checker model port. It passes or fails a result by a rule.
import { type CheckRequest, type CheckVerdict, type Plugin, ports } from "@tensquads/core";

export type CheckRule = (request: CheckRequest) => CheckVerdict;

// The default rule fails an empty result and a result that the rule model marked wrong. It passes all other results.
const notEmptyNotWrong: CheckRule = (request) => {
	if (request.result.trim() === "") return { pass: false, reason: "The result is empty." };
	if (request.result.startsWith("WRONG: ")) return { pass: false, reason: "The result is marked wrong." };
	return { pass: true, reason: "The result is not empty and not marked wrong." };
};

export function ruleChecker(rule: CheckRule = notEmptyNotWrong): Plugin {
	return {
		name: "checker-model-rule",
		provides: [ports.checkerModel],
		needs: [],
		apply: (ctx) => {
			ctx.provide(ports.checkerModel, { check: async (request) => rule(request) });
		},
	};
}
