import assert from "node:assert/strict";
import test from "node:test";

import type { Database } from "@tensquads/core";
import { accountWriter, platformWriter } from "@tensquads/petra";

import { testDatabase, uniqueId } from "./db.js";

const AT = "2026-11-18T10:00:00.000Z";

// A snapshot of each table that the writers write, for the rows of one account.
async function snapshot(database: Database, accountId: string, commandIds: string[]): Promise<unknown> {
	const platform = await database.transaction({ role: "platform" }, async (tx) => ({
		admin_commands: await tx.query(
			"SELECT command_id, kind, status, answer FROM admin_commands WHERE command_id = ANY($1) ORDER BY 1",
			[commandIds],
		),
		accounts: await tx.query("SELECT * FROM accounts WHERE id = $1", [accountId]),
		owners: await tx.query("SELECT * FROM owners WHERE account_id = $1 ORDER BY identity_ref", [accountId]),
	}));
	const account = await database.transaction({ role: "petra", accountId }, async (tx) => ({
		events: await tx.query("SELECT * FROM events ORDER BY command_id"),
		messages: await tx.query("SELECT source_ref, seq, type, body FROM messages ORDER BY seq"),
		ledger: await tx.query("SELECT source_ref, kind, credits FROM ledger ORDER BY source_ref"),
	}));
	return { ...platform, ...account };
}

test("P6: each method of each writer runs two times, and the tables are the same", async () => {
	const database = testDatabase();
	const platform = platformWriter(database);
	const accountId = uniqueId("p6");
	const adminCommand = `${accountId}-create`;
	const account = accountWriter(database, accountId);

	const writeAll = async () => {
		await platform.receiveAdminCommand({
			commandId: adminCommand,
			kind: "CreateAccount",
			payload: { name: "A" },
			adminRef: "super-admin",
			at: AT,
		});
		await platform.addAccount({
			id: accountId,
			name: "A",
			timeZone: "UTC",
			language: "en",
			modelProfile: "test",
			at: AT,
		});
		await platform.addOwner({ accountId, identityRef: "owner-a", at: AT });
		await platform.finishAdminCommand(adminCommand, { accountId });
		await account.receiveEvent({
			commandId: "c1",
			kind: "OwnerMessage",
			payload: { text: "hi" },
			origin: "owner",
			at: AT,
		});
		await account.addMessage({
			sourceRef: "cmd/c1/in",
			seq: 1,
			direction: "in",
			channel: "chat",
			sender: "owner",
			type: "owner_message",
			body: { text: "hi" },
			at: AT,
		});
		await account.addMessage({
			sourceRef: "cmd/c1/reply",
			seq: 2,
			direction: "out",
			channel: "chat",
			sender: "petra",
			type: "reply",
			body: { type: "reply", text: "hello" },
			at: AT,
		});
		await account.addGrant({ sourceRef: "cmd/g1/grant", credits: 100, at: AT });
		await account.finishEvent("c1");
	};

	await writeAll();
	const first = await snapshot(database, accountId, [adminCommand]);
	await writeAll();
	const second = await snapshot(database, accountId, [adminCommand]);

	assert.deepEqual(second, first);
	assert.equal(await account.balance(), 100);
});

test("P6: a message that is written again keeps its first seq", async () => {
	const database = testDatabase();
	const accountId = uniqueId("seq");
	await platformWriter(database).addAccount({
		id: accountId,
		name: "S",
		timeZone: "UTC",
		language: "en",
		modelProfile: "test",
		at: AT,
	});
	const account = accountWriter(database, accountId);
	const message = {
		sourceRef: "cmd/c1/reply",
		direction: "out" as const,
		channel: "chat",
		sender: "petra",
		type: "reply",
		body: { type: "reply", text: "x" },
		at: AT,
	};
	assert.equal(await account.addMessage({ ...message, seq: 1 }), 1);
	// After a stop, Petra can try the same reply with a later seq. The row keeps seq 1.
	assert.equal(await account.addMessage({ ...message, seq: 2 }), 1);
	assert.equal(await account.maxSeq(), 1);
});

test("P6: a finished admin command keeps its first answer", async () => {
	const database = testDatabase();
	const platform = platformWriter(database);
	const commandId = uniqueId("admin");
	await platform.receiveAdminCommand({ commandId, kind: "AddOwner", payload: {}, adminRef: "super-admin", at: AT });
	await platform.finishAdminCommand(commandId, { first: true });
	await platform.finishAdminCommand(commandId, { first: false });
	const row = await platform.receiveAdminCommand({
		commandId,
		kind: "AddOwner",
		payload: {},
		adminRef: "super-admin",
		at: AT,
	});
	assert.deepEqual({ status: row.status, answer: row.answer }, { status: "done", answer: { first: true } });
});
