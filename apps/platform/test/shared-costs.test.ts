// The shared costs, against a real Postgres (task 10, requirements S4 and S5).
// The Platform object divides the amount, writes the parts, and sends one AddCostShare to the Petra of each account.
import assert from "node:assert/strict";
import test from "node:test";

import { echoModel } from "@tensquads/adapters-test";
import type { AdminCommand, Command } from "@tensquads/contracts";
import { type Database, ports, startSystem } from "@tensquads/core";
import { costs, divide } from "@tensquads/costs";
import { accountWriter, costWriter, petra, platformObject, platformWriter } from "@tensquads/petra";
import pg from "pg";

import { testDatabase, uniqueId } from "./db.js";
import { costRows, memoryStorage } from "./task-harness.js";

const database = testDatabase();
const model = (await startSystem([echoModel()])).port(ports.model);

// A period before the first account of the database. Only the accounts of the test existed in it.
async function freshPeriod(): Promise<{ period: string; at: string }> {
	const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();
	try {
		const { rows } = await client.query<{ first: Date | null }>("SELECT min(created_at) AS first FROM accounts");
		const first = rows[0]?.first ?? new Date("2001-01-01T00:00:00.000Z");
		const month = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - 1, 1));
		const period = month.toISOString().slice(0, 7);
		return { period, at: `${period}-15T00:00:00.000Z` };
	} finally {
		await client.end();
	}
}

// The Petra of each account, as the Durable Object joins her with the costs.
function petraOf(db: Database, accountId: string) {
	return petra({
		writer: accountWriter(db, accountId),
		storage: memoryStorage(),
		model,
		now: () => new Date().toISOString(),
		send: () => undefined,
		costs: costs({ store: costWriter(db, accountId), now: () => new Date().toISOString() }),
	});
}

// Three accounts that exist in the period. Each one has the number of cost rows of its usage.
async function accountsWithUsage(at: string, usages: readonly number[]): Promise<string[]> {
	const ids: string[] = [];
	// One prefix, so the sequence of the ids is the sequence of the usages.
	const prefix = uniqueId("s4");
	for (const [index, usage] of usages.entries()) {
		const id = `${prefix}-${index}`;
		await platformWriter(database).addAccount({
			id,
			name: "s4",
			timeZone: "UTC",
			language: "en",
			modelProfile: "test",
			at,
		});
		for (let n = 0; n < usage; n += 1) await addUsage(id, `use-${n}`, at);
		ids.push(id);
	}
	return ids;
}

// One cost row that is not divided, in the period of the time.
const addUsage = (accountId: string, name: string, at: string) =>
	costs({ store: costWriter(database, accountId), now: () => at }).outsideService({
		taskId: `t-${name}`,
		attemptNo: 1,
		toolCallId: name,
		provider: "test-payment",
	});

// The Platform object with a Petra for each account. The send can fail after a number of shares.
function platform(failAfter = Number.POSITIVE_INFINITY) {
	let sent = 0;
	return platformObject({
		writer: platformWriter(database),
		divide,
		sendToPetra: async (accountId: string, command: Command) => {
			if (sent >= failAfter) throw new Error("The Platform object stops.");
			sent += 1;
			const core = petraOf(database, accountId);
			await core.accept(command, "system");
			await core.work();
		},
	});
}

const setSharedCost = (period: string, amount: number, supersedes?: string): AdminCommand => ({
	type: "SetSharedCost",
	commandId: uniqueId("shared"),
	at: new Date().toISOString(),
	period,
	kind: "storage",
	provider: "test-r2",
	amount,
	...(supersedes ? { supersedes } : {}),
});

// The share rows of each account, as [account, source ref, amount].
async function shares(ids: readonly string[]) {
	const rows = await Promise.all(
		ids.map(async (id) =>
			(await costRows(database, id))
				.filter((row) => row.divided)
				.map((row) => [id, row.source_ref, Number(row.amount)] as const),
		),
	);
	return rows.flat();
}

const partsOf = async (sharedCostId: string) =>
	(await platformWriter(database).sharedCostParts(sharedCostId)).map((part) => [part.accountId, part.amount]);

test("S4: an amount that does not divide evenly between three accounts gives whole parts, and their sum is the amount", async () => {
	const { period, at } = await freshPeriod();
	const ids = await accountsWithUsage(at, [1, 1, 1]);
	const command = setSharedCost(period, 100);
	assert.deepEqual(await platform().accept(command, "super-admin"), {
		status: "accepted",
		commandId: command.commandId,
	});
	assert.deepEqual(await partsOf(command.commandId), [
		[ids[0], 34],
		[ids[1], 33],
		[ids[2], 33],
	]);
	const rows = await shares(ids);
	assert.deepEqual(
		rows.map(([id, ref, amount]) => [id, ref, amount]),
		ids.map((id, index) => [id, `shared/${command.commandId}`, index === 0 ? 34 : 33]),
	);
	assert.equal(
		rows.reduce((sum, [, , amount]) => sum + amount, 0),
		100,
	);
});

test("S4: the Platform object stops after the first share, one account gets a new cost row, and the second run keeps the parts", async () => {
	const { period, at } = await freshPeriod();
	const ids = await accountsWithUsage(at, [1, 1, 1]);
	const command = setSharedCost(period, 100);
	await assert.rejects(platform(1).accept(command, "super-admin"), /stops/);
	const before = await partsOf(command.commandId);
	assert.equal((await shares(ids)).length, 1, "One share was sent.");
	// A new cost row in the period changes the usage. The parts are saved, so they do not change.
	await addUsage(ids[2] ?? "", "late", at);
	await platform().recover();
	assert.deepEqual(await partsOf(command.commandId), before);
	const rows = await shares(ids);
	assert.deepEqual(
		rows.map(([id, , amount]) => [id, amount]),
		before,
	);
	assert.equal(
		rows.reduce((sum, [, , amount]) => sum + amount, 0),
		100,
	);
});

test("S4: with no usage in the period, the parts are equal between the accounts that existed in it", async () => {
	const { period, at } = await freshPeriod();
	const ids = await accountsWithUsage(at, [0, 0, 0]);
	const command = setSharedCost(period, 10);
	await platform().accept(command, "super-admin");
	assert.deepEqual(await partsOf(command.commandId), [
		[ids[0], 4],
		[ids[1], 3],
		[ids[2], 3],
	]);
});

test("S5: a correction adds rows that cancel the old parts and rows for the new parts; no row changes; the view has the new amount", async () => {
	const { period, at } = await freshPeriod();
	const ids = await accountsWithUsage(at, [1, 2, 3]);
	const first = setSharedCost(period, 60);
	await platform().accept(first, "super-admin");
	const oldRows = await shares(ids);
	const oldParts = await partsOf(first.commandId);
	assert.deepEqual(oldParts, [
		[ids[0], 10],
		[ids[1], 20],
		[ids[2], 30],
	]);

	const correction = setSharedCost(period, 120, first.commandId);
	await platform().accept(correction, "super-admin");
	assert.deepEqual(await partsOf(first.commandId), oldParts, "The old parts did not change.");
	const rows = await shares(ids);
	for (const row of oldRows) assert.ok(rows.some((item) => JSON.stringify(item) === JSON.stringify(row)));
	assert.deepEqual(
		rows.filter(([, ref]) => ref === `shared/${first.commandId}/cancel`).map(([id, , amount]) => [id, amount]),
		oldParts.map(([id, amount]) => [id, -Number(amount)]),
	);
	assert.deepEqual(
		rows.filter(([, ref]) => ref === `shared/${correction.commandId}`).map(([id, , amount]) => [id, amount]),
		[
			[ids[0], 20],
			[ids[1], 40],
			[ids[2], 60],
		],
	);
	// The view adds the rows when it is read: the old part, its cancel row and the new part.
	const view = await platformWriter(database).adminView("account", 50_000);
	assert.deepEqual(
		ids.map((id) => Number(view.find((row) => row.account_id === id)?.storage)),
		[20, 40, 60],
	);
	// An amount is corrected one time only.
	const second = await platform().accept(setSharedCost(period, 90, first.commandId), "super-admin");
	assert.equal("code" in second && second.code, "conflict");
});
