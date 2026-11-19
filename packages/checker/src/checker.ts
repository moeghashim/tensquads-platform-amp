// The check of a result (requirements K1 to K3). The tests by code run first, then the checker model.
// A failed check answers "continue" with the reason, and the loop of the bot continues inside its limits.
import type { Brief, ResultAnswer, TaskResult } from "@tensquads/contracts";
import type { CheckerModel } from "@tensquads/core";

import { CODE_TESTS, type CodeTest } from "./code-tests.js";

export interface CheckInput {
	taskId: string;
	bot: string;
	brief: Brief;
	result: TaskResult;
	// The full forget list of the task (decision D11).
	forget: readonly string[];
}

export type Check = (input: CheckInput) => Promise<ResultAnswer>;

// The checker model is a port with its own row in the plug-in list, so the maker is not the checker (K2).
export function checker(model: CheckerModel, tests: Readonly<Record<string, readonly CodeTest[]>> = CODE_TESTS): Check {
	return async ({ taskId, bot, brief, result, forget }) => {
		const botTests = tests[bot];
		// A result with no tests by code never stands.
		if (botTests === undefined) throw new Error(`The bot "${bot}" has no tests by code.`);
		for (const codeTest of botTests) {
			const failure = codeTest({ brief, result, forget });
			if (failure !== undefined) return { verdict: "continue", reason: `Tests by code: ${failure}` };
		}
		const verdict = await model.check({ taskId, goal: brief.goal, result: result.answer });
		return { verdict: verdict.pass ? "stands" : "continue", reason: `Checker model: ${verdict.reason}` };
	};
}
