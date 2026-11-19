// The super admin role in the Workers runtime (task 10, requirement S8).
import { TEST_TOKENS } from "@tensquads/adapters-test";
import { ADMIN_VIEWS, apiError } from "@tensquads/contracts";
import { beforeAll, describe, expect, test } from "vitest";

import { AT, call, ownerMessage, post, setUpAccountA } from "./helpers.js";

beforeAll(setUpAccountA);

const unitPrice = (commandId: string) => ({
	type: "SetUnitPrice",
	commandId,
	at: AT,
	provider: "test",
	model: "rule",
	unit: "1M input tokens",
	price: 1_000_000,
	startsAt: "2026-01-01T00:00:00.000Z",
});

const TRAIL = "/v1/admin/accounts/account-a/tasks/s8-task/trail?readId=s8-read";

async function expectForbidden(pending: Promise<Response>): Promise<void> {
	const response = await pending;
	const body = await response.json();
	expect({ status: response.status, body }).toEqual({
		status: 403,
		body: { code: "forbidden", message: expect.any(String) },
	});
	expect(apiError.safeParse(body).success).toBe(true);
}

describe("the super admin role", () => {
	test("S8: an owner gets forbidden on each admin call", async () => {
		await expectForbidden(post("/v1/admin/commands", TEST_TOKENS.ownerA, unitPrice("s8-owner")));
		for (const name of ADMIN_VIEWS) await expectForbidden(call(`/v1/admin/views/${name}`, TEST_TOKENS.ownerA));
		await expectForbidden(call(TRAIL, TEST_TOKENS.ownerA));
	});

	test("S8: a super admin gets forbidden on each owner call", async () => {
		await expectForbidden(post("/v1/commands", TEST_TOKENS.superAdmin, ownerMessage("s8-admin", "hello")));
		await expectForbidden(call("/v1/messages?after=0", TEST_TOKENS.superAdmin));
		await expectForbidden(
			call("/v1/messages/stream?after=0", TEST_TOKENS.superAdmin, { headers: { upgrade: "websocket" } }),
		);
		await expectForbidden(call("/v1/tasks/s8-task", TEST_TOKENS.superAdmin));
	});

	test("S8: a super admin sends SetUnitPrice and reads each view as rows", async () => {
		const answer = await post("/v1/admin/commands", TEST_TOKENS.superAdmin, unitPrice("s8-price"));
		expect(await answer.json()).toEqual({ status: "accepted", commandId: "s8-price" });
		for (const name of ADMIN_VIEWS) {
			const response = await call(`/v1/admin/views/${name}`, TEST_TOKENS.superAdmin);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { view: string; rows: unknown[] };
			expect(body.view).toBe(name);
			expect(Array.isArray(body.rows)).toBe(true);
		}
		const account = (await (await call("/v1/admin/views/account", TEST_TOKENS.superAdmin)).json()) as {
			rows: { account_id: string }[];
		};
		expect(account.rows.map((row) => row.account_id)).toContain("account-a");
		const missing = await call("/v1/admin/views/messages", TEST_TOKENS.superAdmin);
		expect(missing.status).toBe(404);
	});

	test("S8: the one trail read of a super admin gives the rows of one task, with its read id", async () => {
		await post("/v1/commands", TEST_TOKENS.ownerA, ownerMessage("s8-task", "Please read 1 file."));
		let rows: unknown[] = [];
		for (let i = 0; i < 200 && rows.length === 0; i++) {
			const response = await call(TRAIL, TEST_TOKENS.superAdmin);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { taskId: string; readId: string; rows: unknown[] };
			expect([body.taskId, body.readId]).toEqual(["s8-task", "s8-read"]);
			rows = body.rows;
			if (rows.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(rows.length).toBeGreaterThan(0);
		// A trail read needs its read id.
		const noId = await call("/v1/admin/accounts/account-a/tasks/s8-task/trail", TEST_TOKENS.superAdmin);
		expect(noId.status).toBe(400);
	});
});
