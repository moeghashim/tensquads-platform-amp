import assert from "node:assert/strict";
import { test } from "node:test";

import { ports, type SandboxRequest, startSystem } from "@tensquads/core";
import { sandboxContract } from "@tensquads/core/contract-tests";

import { localSandbox } from "../src/index.js";

sandboxContract("sandbox-local", async () => (await startSystem([localSandbox()])).port(ports.sandbox));

test("sandbox-local records one request for each attempt", async () => {
	const started: SandboxRequest[] = [];
	const sandbox = (await startSystem([localSandbox({ started })])).port(ports.sandbox);
	const first = { accountId: "account-a", taskId: "task-1", attemptNo: 1, pass: "pass-1" };
	const second = { ...first, attemptNo: 2, pass: "pass-2" };

	assert.deepEqual(await sandbox.start(first), { sandboxId: "sandbox-task-1-1" });
	await sandbox.start(first);
	await sandbox.start(second);

	assert.deepEqual(started, [first, second]);
});
