// The contract of the database port. Each database adapter must pass these tests (requirements P3 and V4).
// The database must have the migrations of db/ and the three roles. The tests make their own accounts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";

import type { Database } from "../lib/ports.js";

async function twoAccounts(database: Database): Promise<[string, string]> {
	const run = randomUUID().slice(0, 8);
	const ids: [string, string] = [`contract-${run}-a`, `contract-${run}-b`];
	await database.transaction({ role: "platform" }, async (tx) => {
		for (const id of ids) {
			await tx.query(
				"INSERT INTO accounts (id, name, time_zone, language, model_profile, created_at) VALUES ($1, $1, 'UTC', 'en', 'test', now())",
				[id],
			);
		}
	});
	for (const id of ids) {
		await database.transaction({ role: "petra", accountId: id }, (tx) =>
			tx.query(
				"INSERT INTO ledger (account_id, source_ref, kind, credits, at) VALUES ($1, 'grant', 'grant', 10, now())",
				[id],
			),
		);
	}
	return ids;
}

// Registers the tests of the database port. The make function gives a database for each test.
export function databaseContract(name: string, make: () => Promise<Database>): void {
	describe(`${name}: database contract`, () => {
		test("P3: the role of Petra gets zero rows of a second account", async () => {
			const database = await make();
			const [a, b] = await twoAccounts(database);
			const rows = await database.transaction({ role: "petra", accountId: a }, (tx) =>
				tx.query<{ account_id: string }>("SELECT account_id FROM ledger WHERE account_id IN ($1, $2)", [a, b]),
			);
			assert.deepEqual(
				rows.map((row) => row.account_id),
				[a],
			);
			const accounts = await database.transaction({ role: "petra", accountId: a }, (tx) =>
				tx.query<{ id: string }>("SELECT id FROM accounts WHERE id IN ($1, $2)", [a, b]),
			);
			assert.deepEqual(
				accounts.map((row) => row.id),
				[a],
			);
			await database.close();
		});

		test("P3: the role of Petra cannot write a row of a second account", async () => {
			const database = await make();
			const [a, b] = await twoAccounts(database);
			await assert.rejects(
				database.transaction({ role: "petra", accountId: a }, (tx) =>
					tx.query(
						"INSERT INTO ledger (account_id, source_ref, kind, credits, at) VALUES ($1, 'x', 'grant', 1, now())",
						[b],
					),
				),
				/row-level security/,
			);
			await database.close();
		});

		test("P3: the role of the Platform object cannot read an account table", async () => {
			const database = await make();
			await assert.rejects(
				database.transaction({ role: "platform" }, (tx) => tx.query("SELECT count(*) FROM ledger")),
				/permission denied/,
			);
			await database.close();
		});

		test("P3: the role of the views cannot read an account table or the accounts", async () => {
			const database = await make();
			for (const table of ["ledger", "accounts"]) {
				await assert.rejects(
					database.transaction({ role: "admin views" }, (tx) => tx.query(`SELECT count(*) FROM public.${table}`)),
					/permission denied/,
				);
			}
			await database.close();
		});

		test("a transaction that fails writes nothing", async () => {
			const database = await make();
			const [a] = await twoAccounts(database);
			await assert.rejects(
				database.transaction({ role: "petra", accountId: a }, async (tx) => {
					await tx.query(
						"INSERT INTO ledger (account_id, source_ref, kind, credits, at) VALUES ($1, 'lost', 'grant', 1, now())",
						[a],
					);
					throw new Error("stop");
				}),
				/stop/,
			);
			const rows = await database.transaction({ role: "petra", accountId: a }, (tx) =>
				tx.query("SELECT 1 FROM ledger WHERE source_ref = 'lost'"),
			);
			assert.equal(rows.length, 0);
			await database.close();
		});
	});
}
