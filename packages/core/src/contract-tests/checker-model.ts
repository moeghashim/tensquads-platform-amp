// The contract of the checker model port. Each checker model adapter must pass these tests.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { CheckerModel, CheckRequest, CheckVerdict } from "../lib/ports.js";

// Two requests that the adapter knows. It must pass the first and fail the second.
export interface CheckerModelCases {
	passing: CheckRequest;
	failing: CheckRequest;
}

function assertVerdict(verdict: CheckVerdict): void {
	assert.equal(typeof verdict.pass, "boolean", "The verdict must say pass or fail.");
	assert.ok(verdict.reason.trim().length > 0, "The verdict must give a reason.");
}

// Registers the tests of the checker model port. The make function gives a new checker for each test.
export function checkerModelContract(name: string, make: () => Promise<CheckerModel>, cases: CheckerModelCases): void {
	describe(`${name}: checker model contract`, () => {
		test("a result that must pass passes, with a reason", async () => {
			const checker = await make();
			const verdict = await checker.check(cases.passing);
			assertVerdict(verdict);
			assert.equal(verdict.pass, true);
		});

		test("a result that must fail fails, with a reason", async () => {
			const checker = await make();
			const verdict = await checker.check(cases.failing);
			assertVerdict(verdict);
			assert.equal(verdict.pass, false);
		});
	});
}
