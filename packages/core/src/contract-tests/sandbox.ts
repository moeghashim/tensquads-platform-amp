// The contract of the sandbox port. Each sandbox adapter must pass these tests.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Sandbox, SandboxRequest } from "../lib/ports.js";

function attempt(taskId: string, attemptNo: number): SandboxRequest {
	return { accountId: "account-contract", taskId, attemptNo, pass: `pass-${taskId}-${attemptNo}` };
}

// Registers the tests of the sandbox port. The make function gives a new sandbox for each test.
export function sandboxContract(name: string, make: () => Promise<Sandbox>): void {
	describe(`${name}: sandbox contract`, () => {
		test("a start gives a sandbox id", async () => {
			const sandbox = await make();
			const { sandboxId } = await sandbox.start(attempt("task-1", 1));
			assert.equal(typeof sandboxId, "string");
			assert.ok(sandboxId.length > 0, "The sandbox id must not be empty.");
		});

		test("two starts of the same attempt give the same sandbox id", async () => {
			const sandbox = await make();
			const first = await sandbox.start(attempt("task-1", 1));
			const second = await sandbox.start(attempt("task-1", 1));
			assert.equal(second.sandboxId, first.sandboxId);
		});

		test("different attempts give different sandbox ids", async () => {
			const sandbox = await make();
			const ids = [
				(await sandbox.start(attempt("task-1", 1))).sandboxId,
				(await sandbox.start(attempt("task-1", 2))).sandboxId,
				(await sandbox.start(attempt("task-2", 1))).sandboxId,
			];
			assert.equal(new Set(ids).size, ids.length);
		});
	});
}
