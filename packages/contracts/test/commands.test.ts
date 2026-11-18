import assert from "node:assert/strict";
import { test } from "node:test";
import { adminCommand, command, ownerCommand } from "../src/index.js";

const base = { commandId: "cmd-1", at: "2026-11-18T10:00:00Z" };

function issuePaths(schema: typeof command | typeof ownerCommand, input: unknown): string[] {
	const parsed = schema.safeParse(input);
	assert.equal(parsed.success, false);
	return parsed.error?.issues.map((issue) => issue.path.join(".")) ?? [];
}

test("W1: each command of section 6.1 has a schema", () => {
	const names = command.options.map((option) => option.shape.type.value);
	assert.deepEqual([...names].sort(), [
		"AddCoreItem",
		"AddCostShare",
		"ApprovalDecision",
		"CancelTask",
		"ExternalEvent",
		"ForgetFact",
		"GrantCredits",
		"OwnerAnswer",
		"OwnerMessage",
		"RemoveCoreItem",
		"ResendSandboxRequests",
		"RunJob",
		"SandboxExited",
		"SetRule",
		"UndoForget",
	]);
});

test("W1: ownerCommand accepts an owner message", () => {
	const message = { ...base, type: "OwnerMessage", messageId: "m-1", channel: "app", text: "Hi" };
	assert.equal(ownerCommand.safeParse(message).success, true);
});

test("W1: ownerCommand rejects GrantCredits, but command accepts it", () => {
	const grant = { ...base, type: "GrantCredits", credits: 100 };
	assert.equal(command.safeParse(grant).success, true);
	assert.deepEqual(issuePaths(ownerCommand, grant), ["type"]);
});

test("W1: a command with an accountId field fails", () => {
	const cancel = { ...base, type: "CancelTask", taskId: "t-1", accountId: "acc-2" };
	assert.deepEqual(issuePaths(ownerCommand, cancel), [""]);
	assert.deepEqual(issuePaths(command, cancel), [""]);
});

test("W1: a command with no commandId fails", () => {
	const cancel = { at: base.at, type: "CancelTask", taskId: "t-1" };
	assert.deepEqual(issuePaths(command, cancel), ["commandId"]);
});

test("W1: the night job needs localDate, and a check job needs targetId", () => {
	const night = { ...base, type: "RunJob", job: "night", localDate: "2026-11-18" };
	assert.equal(command.safeParse(night).success, true);
	const check = { ...base, type: "RunJob", job: "check task", targetId: "t-1" };
	assert.equal(command.safeParse(check).success, true);
	assert.deepEqual(issuePaths(command, { ...base, type: "RunJob", job: "night" }), ["job"]);
	assert.deepEqual(issuePaths(command, { ...check, localDate: "2026-11-18" }), ["job"]);
});

test("W1: a cost share amount must be a whole number of millionths", () => {
	const share = {
		...base,
		type: "AddCostShare",
		sharedCostId: "sc-1",
		period: "2026-11",
		kind: "storage",
		provider: "cloudflare",
		amount: -1500,
	};
	assert.equal(command.safeParse(share).success, true);
	assert.deepEqual(issuePaths(command, { ...share, amount: 1.5 }), ["amount"]);
});

test("W1: CreateAccount takes optional initial credits that are not negative", () => {
	const create = {
		...base,
		type: "CreateAccount",
		name: "Shop",
		timeZone: "Asia/Riyadh",
		language: "ar",
		modelProfile: "test",
	};
	assert.equal(adminCommand.safeParse(create).success, true);
	assert.equal(adminCommand.safeParse({ ...create, initialCredits: 50 }).success, true);
	const parsed = adminCommand.safeParse({ ...create, initialCredits: -1 });
	assert.deepEqual(
		parsed.error?.issues.map((issue) => issue.path.join(".")),
		["initialCredits"],
	);
});
