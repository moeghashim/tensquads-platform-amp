import assert from "node:assert/strict";
import test from "node:test";

import { scriptedModel } from "@tensquads/adapters-test";
import type { Command, OwnerMessage } from "@tensquads/contracts";
import { type Database, type Model, ports, startSystem } from "@tensquads/core";
import { accountWriter, type PetraStorage, petra, platformObject, platformWriter } from "@tensquads/petra";

import { testDatabase, uniqueId } from "./db.js";

const AT = "2026-11-18T10:00:00.000Z";

function memoryStorage(): PetraStorage {
	const map = new Map<string, unknown>();
	return {
		get: async <T>(key: string) => map.get(key) as T | undefined,
		put: async (key, value) => void map.set(key, structuredClone(value)),
	};
}

async function scripted(...texts: string[]): Promise<Model> {
	const system = await startSystem([scriptedModel(texts.map((text) => ({ text })))]);
	return system.port(ports.model);
}

async function newAccount(database: Database, prefix: string): Promise<string> {
	const id = uniqueId(prefix);
	await platformWriter(database).addAccount({
		id,
		name: id,
		timeZone: "UTC",
		language: "en",
		modelProfile: "test",
		at: AT,
	});
	return id;
}

const ownerMessage = (commandId: string, text: string): Command => ({
	type: "OwnerMessage",
	commandId,
	at: AT,
	messageId: `m-${commandId}`,
	channel: "chat",
	text,
});

// The rows of the tables that a command writes, for one account.
async function rows(database: Database, accountId: string) {
	return database.transaction({ role: "petra", accountId }, async (tx) => ({
		events: await tx.query<{ command_id: string; status: string }>(
			"SELECT command_id, status FROM events ORDER BY 1",
		),
		messages: await tx.query<{ source_ref: string; seq: string; body: { text: string } }>(
			"SELECT source_ref, seq, body FROM messages ORDER BY seq",
		),
		ledger: await tx.query<{ source_ref: string; credits: string }>("SELECT source_ref, credits FROM ledger"),
	}));
}

test("P1: two commands for one account are handled one after the other", async () => {
	const database = testDatabase();
	const accountId = await newAccount(database, "p1");
	let inFlight = 0;
	let most = 0;
	const model: Model = {
		complete: async (request) => {
			inFlight += 1;
			most = Math.max(most, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 20));
			inFlight -= 1;
			return {
				text: `re: ${request.messages[0]?.content}`,
				toolCalls: [],
				provider: "test",
				model: "slow",
				usage: { inputTokens: 1, outputTokens: 1 },
			};
		},
	};
	const sent: OwnerMessage[] = [];
	const p = petra({
		writer: accountWriter(database, accountId),
		storage: memoryStorage(),
		model,
		now: () => AT,
		send: (m) => void sent.push(m),
	});
	await p.accept(ownerMessage("c1", "first"), "owner");
	await p.accept(ownerMessage("c2", "second"), "owner");
	await Promise.all([p.work(), p.work()]);
	assert.equal(most, 1);
	assert.deepEqual(
		sent.map((m) => (m.type === "reply" ? m.text : m.type)),
		["re: first", "re: second"],
	);
	assert.deepEqual(
		sent.map((m) => m.seq),
		[2, 4],
	);
});

test("P4: an owner command that arrives two times gives one result", async () => {
	const database = testDatabase();
	const accountId = await newAccount(database, "p4");
	const p = petra({
		writer: accountWriter(database, accountId),
		storage: memoryStorage(),
		model: await scripted("one", "two"),
		now: () => AT,
		send: () => undefined,
	});
	await p.accept(ownerMessage("c1", "hello"), "owner");
	await p.work();
	await p.accept(ownerMessage("c1", "hello"), "owner");
	await p.work();
	const tables = await rows(database, accountId);
	assert.deepEqual(tables.events, [{ command_id: "c1", status: "done" }]);
	assert.deepEqual(
		tables.messages.map((m) => [m.source_ref, Number(m.seq), m.body.text]),
		[
			["cmd/c1/in", 1, "hello"],
			["cmd/c1/reply", 2, "one"],
		],
	);
});

test("P4: Petra stops after the first write of a command. After a restart, the command is complete one time", async () => {
	const database = testDatabase();
	const accountId = await newAccount(database, "stop1");
	const writer = accountWriter(database, accountId);
	const before = petra({
		writer,
		storage: memoryStorage(),
		model: await scripted("lost"),
		now: () => AT,
		send: () => undefined,
	});
	await before.accept(ownerMessage("c1", "hello"), "owner");
	// The Durable Object stops here. It also loses its storage.
	const after = petra({
		writer,
		storage: memoryStorage(),
		model: await scripted("after the restart"),
		now: () => AT,
		send: () => undefined,
	});
	await after.recover();
	await after.work();
	await after.recover();
	await after.work();
	const tables = await rows(database, accountId);
	assert.deepEqual(tables.events, [{ command_id: "c1", status: "done" }]);
	assert.deepEqual(
		tables.messages.map((m) => [m.source_ref, Number(m.seq), m.body.text]),
		[
			["cmd/c1/in", 1, "hello"],
			["cmd/c1/reply", 2, "after the restart"],
		],
	);
});

test("P4: a command runs two times with a different model answer. The tables have one reply and one seq for each message", async () => {
	const database = testDatabase();
	const accountId = await newAccount(database, "twice");
	const real = accountWriter(database, accountId);
	// The first run stops after the reply, before the command is marked done.
	const stopping = { ...real, finishEvent: async () => Promise.reject(new Error("stop")) };
	const storage = memoryStorage();
	const first = petra({
		writer: stopping,
		storage,
		model: await scripted("first answer"),
		now: () => AT,
		send: () => undefined,
	});
	await first.accept(ownerMessage("c1", "hello"), "owner");
	await assert.rejects(first.work(), /stop/);
	const sent: OwnerMessage[] = [];
	const second = petra({
		writer: real,
		storage,
		model: await scripted("second answer"),
		now: () => AT,
		send: (m) => void sent.push(m),
	});
	await second.recover();
	await second.work();
	const tables = await rows(database, accountId);
	assert.deepEqual(tables.events, [{ command_id: "c1", status: "done" }]);
	assert.deepEqual(
		tables.messages.map((m) => [m.source_ref, Number(m.seq), m.body.text]),
		[
			["cmd/c1/in", 1, "hello"],
			["cmd/c1/reply", 2, "first answer"],
		],
	);
	assert.deepEqual(sent, []);
});

test("P5: CreateAccount makes an account with its first credits, and AddOwner adds an owner", async () => {
	const database = testDatabase();
	const commandId = uniqueId("create");
	const petras = new Map<string, ReturnType<typeof petra>>();
	const petraOf = (accountId: string) => {
		const existing = petras.get(accountId);
		if (existing) return existing;
		const created = petra({
			writer: accountWriter(database, accountId),
			storage: memoryStorage(),
			model: { complete: async () => Promise.reject(new Error("no model")) },
			now: () => AT,
			send: () => undefined,
		});
		petras.set(accountId, created);
		return created;
	};
	const sendToPetra = async (accountId: string, command: Command) => {
		await petraOf(accountId).accept(command, "system");
		await petraOf(accountId).work();
	};
	const platform = platformObject({ writer: platformWriter(database), sendToPetra });
	const create = {
		type: "CreateAccount",
		commandId,
		at: AT,
		name: "Cafe",
		timeZone: "Asia/Riyadh",
		language: "ar",
		modelProfile: "test",
		initialCredits: 500,
	} as const;
	assert.deepEqual(await platform.accept(create, "super-admin"), { status: "accepted", commandId });
	assert.deepEqual(await platform.accept(create, "super-admin"), { status: "accepted", commandId });
	const owner = {
		type: "AddOwner",
		commandId: `${commandId}-owner`,
		at: AT,
		accountId: commandId,
		identityRef: "owner-a",
	} as const;
	await platform.accept(owner, "super-admin");
	const writer = accountWriter(database, commandId);
	assert.equal(await writer.balance(), 500);
	assert.equal(await writer.isOwner("owner-a"), true);
	assert.equal(await writer.isOwner("owner-b"), false);
	const missing = { ...owner, commandId: `${commandId}-missing`, accountId: "no-such-account" };
	assert.deepEqual(await platform.accept(missing, "super-admin"), {
		code: "not_found",
		message: "The account does not exist.",
	});
});

test("P4: the Platform object stops after the accounts row and before GrantCredits. After a restart, the account has its credits one time", async () => {
	const database = testDatabase();
	const commandId = uniqueId("grant");
	const writer = platformWriter(database);
	const lost = platformObject({ writer, sendToPetra: async () => Promise.reject(new Error("stop")) });
	const create = {
		type: "CreateAccount",
		commandId,
		at: AT,
		name: "Shop",
		timeZone: "UTC",
		language: "en",
		modelProfile: "test",
		initialCredits: 300,
	} as const;
	await assert.rejects(lost.accept(create, "super-admin"), /stop/);
	assert.equal(await writer.accountExists(commandId), true);

	const p = petra({
		writer: accountWriter(database, commandId),
		storage: memoryStorage(),
		model: await scripted(),
		now: () => AT,
		send: () => undefined,
	});
	const sendToPetra = async (_accountId: string, command: Command) => {
		await p.accept(command, "system");
		await p.work();
	};
	const restarted = platformObject({ writer, sendToPetra });
	await restarted.recover();
	await restarted.recover();
	assert.deepEqual(await restarted.accept(create, "super-admin"), { status: "accepted", commandId });
	const tables = await rows(database, commandId);
	assert.deepEqual(
		tables.ledger.map((row) => [row.source_ref, Number(row.credits)]),
		[[`cmd/${commandId}/grant/grant`, 300]],
	);
});
