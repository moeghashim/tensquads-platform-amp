// The test adapter of the checker model port. It passes or fails a result by a rule.
import { type CheckRequest, type CheckVerdict, type Plugin, ports } from "@tensquads/core";

export type CheckRule = (request: CheckRequest) => CheckVerdict;

// The default rule fails an empty result and passes all other results.
const notEmpty: CheckRule = (request) =>
	request.result.trim() === ""
		? { pass: false, reason: "The result is empty." }
		: { pass: true, reason: "The result is not empty." };

export function ruleChecker(rule: CheckRule = notEmpty): Plugin {
	return {
		name: "checker-model-rule",
		provides: [ports.checkerModel],
		needs: [],
		apply: (ctx) => {
			ctx.provide(ports.checkerModel, { check: async (request) => rule(request) });
		},
	};
}
