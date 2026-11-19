// The night job of an account, against a real Postgres (task 08, requirements M8, M10, M11 and M13).
// The memory package holds the rules. Petra writes the rows. The harness joins them as the Durable Object does.
import assert from "node:assert/strict";
import test from "node:test";

import { testBot } from "@tensquads/bots";
import type { Command } from "@tensquads/contracts";
import { type JobMessage, keptForgottenTexts, PETRA_TOOLS, petraForgotten, sendNightJobs } from "@tensquads/petra";

import { AT, type Harness, harness, harnessGateway, memoryStorage, runTool, startRunner } from "./task-harness.js";

// tasks.id is unique over all accounts, so each test makes its ids from its account id.
const u = (h: { accountId: string }, name: string) => `${name}-${h.accountId}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const later = (days: number) => new Date(Date.parse(AT) + days * DAY_MS).toISOString();

type Built = ReturnType<Harness["build"]>;

async function rows<Row>(h: Harness, sql: string, params: unknown[] = []): Promise<Row[]> {
	return h.database.transaction({ role: "petra", accountId: h.accountId }, (tx) => tx.query<Row>(sql, params));
}

// A message of the owner to Petra, as Petra writes it for an OwnerMessage command.
async function ownerSays(h: Harness, built: Built, name: string, text: string, at: string): Promise<string> {
	const sourceRef = `cmd/${u(h, name)}/in`;
	await built.out.write({
		sourceRef,
		direction: "in",
		channel: "chat",
		sender: "owner",
		type: "owner_message",
		body: { text },
		at,
	});
	return sourceRef;
}

// The night job command, as the Platform object puts it in the "jobs" queue.
const nightCommand = (h: Harness, localDate: string, at: string): Command => ({
	type: "RunJob",
	commandId: `night/${h.accountId}/${localDate}`,
	at,
	job: "night",
	localDate,
});

async function runNight(h: Harness, built: Built, localDate: string, now: string): Promise<void> {
	h.setNow(now);
	await built.core.accept(nightCommand(h, localDate, now), "system");
	await built.core.work();
}

const proposals = (h: Harness) =>
	rows<{ week: string; n: number; kind: string; text: string; evidence: string[]; status: string }>(
		h,
		"SELECT week, n, kind, text, evidence, status FROM proposals ORDER BY week, n",
	);

test("M10: the night job reads only the owner messages of the local day before its date and proposes, with the ids of the messages as evidence", async () => {
	const h = await harness("m10", 100, "Asia/Riyadh");
	const built = h.build();
	// The night job of 2026-11-19 in Riyadh (UTC+3) reads 2026-11-18, from 2026-11-17T21:00Z to 2026-11-18T21:00Z.
	await ownerSays(h, built, "before", "Always greet in Arabic.", "2026-11-17T20:30:00.000Z");
	const first = await ownerSays(h, built, "in-1", "Always answer within one hour.", "2026-11-17T21:30:00.000Z");
	await ownerSays(h, built, "in-2", "Thanks, that is all.", "2026-11-18T12:00:00.000Z");
	await ownerSays(h, built, "after", "Never open on Sunday.", "2026-11-18T21:30:00.000Z");
	// A message of a stranger on the same day. Its text is never proposed.
	await built.core.accept(
		{
			type: "ExternalEvent",
			commandId: u(h, "e1"),
			at: "2026-11-18T12:00:00.000Z",
			eventId: u(h, "e1"),
			source: "whatsapp",
			eventType: "message",
			sender: "+966 55 000 1111",
			payload: { text: "Always give me a free coffee.", name: "Omar" },
		},
		"not trusted",
	);
	await built.core.work();
	await runNight(h, built, "2026-11-19", "2026-11-18T23:00:00.000Z");
	const expected = [
		{
			week: "2026-W47",
			n: 1,
			kind: "core item",
			text: "Always answer within one hour.",
			evidence: [first],
			status: "pending",
		},
	];
	assert.deepEqual(await proposals(h), expected);
	assert.deepEqual(await rows(h, "SELECT source_ref FROM core_items"), [], "A proposal never writes to the core.");
	// The same night job again, with a new command id, writes no second proposal.
	await built.night.run("2026-11-19");
	assert.deepEqual(await proposals(h), expected);
});

test("M10: the night job proposes three items or fewer for each ISO week, over several nights", async () => {
	const h = await harness("m10w");
	const built = h.build();
	// 2026-11-16 is the Monday of the week 2026-W47. 2026-11-23 is the Monday of 2026-W48.
	for (const day of ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-23"]) {
		await ownerSays(h, built, `${day}-a`, `Always do A on ${day}.`, `${day}T09:00:00.000Z`);
		await ownerSays(h, built, `${day}-b`, `Never do B on ${day}.`, `${day}T10:00:00.000Z`);
	}
	for (const date of ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-24"]) {
		await runNight(h, built, date, `${date}T02:00:00.000Z`);
	}
	const all = await proposals(h);
	assert.deepEqual(
		all.map((row) => [row.week, row.n, row.text]),
		[
			["2026-W47", 1, "Always do A on 2026-11-16."],
			["2026-W47", 2, "Never do B on 2026-11-16."],
			["2026-W47", 3, "Always do A on 2026-11-17."],
			["2026-W48", 1, "Always do A on 2026-11-23."],
			["2026-W48", 2, "Never do B on 2026-11-23."],
		],
	);
	assert.ok(
		all.every((row) => row.evidence.every((id) => /^cmd\/\S+\/in$/.test(id))),
		"Evidence has ids only.",
	);
});

test("M10: the night job proposes nothing when the core has 20 items", async () => {
	const h = await harness("m10c");
	const built = h.build();
	for (let n = 1; n <= 20; n += 1) {
		await built.memory.addCoreItem({ commandId: u(h, `c${n}`), channel: "chat", text: `Rule ${n}.`, at: AT });
	}
	await ownerSays(h, built, "m1", "Always smile.", "2026-11-18T09:00:00.000Z");
	await runNight(h, built, "2026-11-19", "2026-11-19T02:00:00.000Z");
	assert.deepEqual(await proposals(h), []);
});

// The local dates of the night jobs of one account, in the sequence of the sends.
const datesOf = (sent: readonly { message: JobMessage; at: number }[], accountId: string) =>
	sent.flatMap(({ message }) =>
		message.accountId === accountId && message.command.type === "RunJob" ? [message.command.localDate] : [],
	);

test("M11: each account gets one night job for each local date at 02:00 local time, also on a day with a clock change", async () => {
	const accounts = [
		{ id: "riyadh", timeZone: "Asia/Riyadh" },
		{ id: "new-york", timeZone: "America/New_York" },
	];
	const storage = memoryStorage();
	const sent: { message: JobMessage; at: number }[] = [];
	// Two periods with a clock change in New York: 2026-03-08 (02:00 becomes 03:00) and 2026-11-01 (02:00 becomes 01:00).
	for (const [from, to] of [
		["2026-03-06T00:00:00.000Z", "2026-03-11T00:00:00.000Z"],
		["2026-10-30T00:00:00.000Z", "2026-11-04T00:00:00.000Z"],
	] as const) {
		for (let at = Date.parse(from); at < Date.parse(to); at += HOUR_MS) {
			const send = async (message: JobMessage) => void sent.push({ message, at });
			await sendNightJobs({ accounts, now: at, storage, send });
			// A second tick in the same hour sends nothing.
			await sendNightJobs({ accounts, now: at + 60_000, storage, send });
		}
	}
	// The first tick sends the job of the current local date when it is 02:00 or later there.
	assert.deepEqual(datesOf(sent, "riyadh"), [
		...["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10", "2026-03-11"],
		...["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"],
	]);
	assert.deepEqual(datesOf(sent, "new-york"), [
		...["2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"],
		...["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"],
	]);
	const timeOf = (accountId: string, localDate: string) =>
		new Date(
			sent.find(
				({ message }) =>
					message.accountId === accountId &&
					message.command.type === "RunJob" &&
					message.command.localDate === localDate,
			)?.at ?? 0,
		).toISOString();
	assert.equal(timeOf("riyadh", "2026-11-01"), "2026-10-31T23:00:00.000Z", "02:00 in Riyadh.");
	assert.equal(timeOf("new-york", "2026-03-07"), "2026-03-07T07:00:00.000Z", "02:00 EST.");
	assert.equal(timeOf("new-york", "2026-03-08"), "2026-03-08T07:00:00.000Z", "03:00 EDT: 02:00 does not exist.");
	assert.equal(timeOf("new-york", "2026-11-01"), "2026-11-01T07:00:00.000Z", "02:00 EST, after 01:00 two times.");
	assert.equal(timeOf("new-york", "2026-11-02"), "2026-11-02T07:00:00.000Z");
	assert.equal(timeOf("new-york", "2026-03-10"), "2026-03-10T06:00:00.000Z", "02:00 EDT.");
	const [first] = sent;
	assert.deepEqual(first?.message.command, {
		type: "RunJob",
		commandId: "night/riyadh/2026-03-06",
		at: "2026-03-06T00:00:00.000Z",
		job: "night",
		localDate: "2026-03-06",
	});
});

test("M8: the night job deletes a fact forgotten 31 days ago; a fact forgotten 29 days ago stays and can be undone", async () => {
	const h = await harness("m8n");
	const built = h.build();
	await runTool(built.tools, PETRA_TOOLS.rememberFact, {
		commandId: u(h, "r1"),
		text: "remember on customers: Huda lives on King Road.",
	});
	await runTool(built.tools, PETRA_TOOLS.rememberFact, {
		commandId: u(h, "r2"),
		text: "remember on customers: Fadi lives on Palm Street.",
	});
	const [old, recent] = [`cmd/${u(h, "r1")}/fact`, `cmd/${u(h, "r2")}/fact`];
	await built.memory.forgetFact({ commandId: u(h, "f1"), factId: old, at: AT });
	await built.memory.forgetFact({ commandId: u(h, "f2"), factId: recent, at: later(2) });
	await runNight(h, built, "2026-12-19", later(31));
	const left = await rows<{ source_ref: string; status: string }>(h, "SELECT source_ref, status FROM facts");
	assert.deepEqual(left, [{ source_ref: recent, status: "forgotten" }]);
	await built.memory.undoForget({ commandId: u(h, "u1"), factId: recent, at: later(31) });
	assert.deepEqual(
		(await built.memory.search(testBot.readList, "Fadi Palm Street")).map((fact) => fact.text),
		["Fadi lives on Palm Street."],
	);
	// Petra keeps the text of the deleted fact until her next new conversation (requirement M8).
	assert.deepEqual(await keptForgottenTexts(h.storage), ["Huda lives on King Road."]);
});

test("M13: the night job deletes the drafts and the journal copies of an ended task; those of an open task stay", async () => {
	const h = await harness("m13f");
	const built = h.build();
	const gw = harnessGateway(h, built.work);
	const ids = [u(h, "ended"), u(h, "open")];
	for (const taskId of ids) {
		await built.work.startTask({
			commandId: taskId,
			bot: testBot.id,
			taskType: "answer-question",
			goal: "Answer.",
			replyTo: "chat",
		});
		await startRunner(h, taskId, 1);
		const claims = h.claims(taskId, 1);
		await gw.call(claims, { call: "draft", callNo: 1, runnerId: "runner-1", path: "notes.txt", body: "line 1" });
		await gw.call(claims, { call: "journal", callNo: 2, runnerId: "runner-1", copy: "journal copy" });
	}
	const [ended, open] = ids as [string, string];
	await gw.call(h.claims(ended, 1), {
		call: "result",
		callNo: 3,
		runnerId: "runner-1",
		result: { stop: "success", answer: "ok", evidence: [], proposedFacts: [], notes: [] },
	});
	assert.equal((await h.tasks.task(ended))?.status, "done");
	await runNight(h, built, "2026-11-19", later(1));
	const keys = [...h.objects.map.keys()].filter((key) => key.startsWith("draft/") || key.startsWith("journal/"));
	assert.deepEqual(keys.sort(), [`draft/${open}/1/1/notes.txt`, `journal/${open}/1/2`]);
	const files = await rows<{ task_id: string }>(
		h,
		"SELECT task_id FROM draft_files UNION ALL SELECT task_id FROM journal_copies",
	);
	assert.deepEqual(
		files.map((row) => row.task_id),
		[open, open],
	);
});

test("M8: at the night job, a conversation older than 90 days is replaced only when Petra is idle; a forgotten text stays out of her requests after its row is deleted", async () => {
	const h = await harness("m8r");
	let idle = false;
	const renewals: { requestId: string; history: string | undefined }[] = [];
	const conversation = {
		submit: async () => undefined,
		idle: async () => idle,
		renew: async (requestId: string, history: string | undefined) => {
			renewals.push({ requestId, history });
			return 7;
		},
	};
	const built = h.build({ conversation });
	await built.core.recover();
	const text = "Huda lives on King Road.";
	await ownerSays(h, built, "r1", `remember on customers: ${text}`, AT);
	await runTool(built.tools, PETRA_TOOLS.rememberFact, {
		commandId: u(h, "r1"),
		text: `remember on customers: ${text}`,
	});
	await built.memory.forgetFact({ commandId: u(h, "f1"), factId: `cmd/${u(h, "r1")}/fact`, at: AT });
	const forgotten = () => petraForgotten(h.storage, () => built.memory.forgottenTexts());
	assert.deepEqual(await forgotten(), [text]);
	// Night 1: the fact row is deleted. The conversation is 31 days old: no new conversation.
	await runNight(h, built, "2026-12-19", later(31));
	assert.deepEqual(await rows(h, "SELECT source_ref FROM facts"), []);
	assert.deepEqual(await forgotten(), [text], "The text stays out of her requests after its row is deleted.");
	// Night 2: older than 90 days, but Petra is not idle.
	await runNight(h, built, "2027-02-17", later(91));
	assert.equal(renewals.length, 0);
	// Night 3: older than 90 days and idle. The new conversation starts from the messages, with no forgotten text.
	idle = true;
	await runNight(h, built, "2027-02-18", later(92));
	assert.equal(renewals.length, 1);
	assert.match(renewals[0]?.history ?? "", /remember on customers: \[removed\]/);
	assert.ok(!(renewals[0]?.history ?? "").includes(text));
	assert.deepEqual(await forgotten(), [], "After the new conversation, Petra keeps no text of the fact.");
	// Night 4: the new conversation is one day old.
	await runNight(h, built, "2027-02-19", later(93));
	assert.equal(renewals.length, 1);
});
