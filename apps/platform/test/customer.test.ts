// The personal data of a customer, against a real Postgres (task 08, requirement M13, ARCHITECTURE section 7.8).
// Petra's clock is the clock of the test. The trail rule of the database uses the clock of the database.
import assert from "node:assert/strict";
import test from "node:test";

import { testBot } from "@tensquads/bots";
import type { Command } from "@tensquads/contracts";
import { customerRef, memoryWriter } from "@tensquads/petra";

import { gateSetup, refund, statusOf, untilSent } from "./gate-harness.js";
import { type Harness, harness, harnessGateway, startRunner } from "./task-harness.js";

type Built = ReturnType<Harness["build"]>;

// The first customer wrote last 12 months and one day before the night job. The second one wrote one month before it.
const OLD = "2025-06-01T10:00:00.000Z";
const RECENT = "2026-05-01T10:00:00.000Z";
const NIGHT = "2026-06-02T00:00:00.000Z";
const NEXT_NIGHT = "2026-06-03T00:00:00.000Z";

interface Customer {
	key: string;
	name: string;
	phone: string;
	at: string;
	// The goal of the task of the customer. Its words find facts for the brief.
	goal: string;
}

const SARA: Customer = {
	key: "c1",
	name: "Sara Haddad",
	phone: "+966 55 123 4567",
	at: OLD,
	goal: "Answer Sara Haddad.",
};
// The goal of Omar finds the two facts of Sara, so his brief holds them and the core item of Sara.
const OMAR: Customer = {
	key: "c2",
	name: "Omar Nasser",
	phone: "+966 55 765 4321",
	at: RECENT,
	goal: "Answer Omar Nasser about oat milk on Fridays.",
};

async function rows<Row>(h: Harness, sql: string, params: unknown[] = []): Promise<Row[]> {
	return h.database.transaction({ role: "petra", accountId: h.accountId }, (tx) => tx.query<Row>(sql, params));
}

const nightCommand = (h: Harness, localDate: string, at: string): Command => ({
	type: "RunJob",
	commandId: `night/${h.accountId}/${localDate}`,
	at,
	job: "night",
	localDate,
});

async function runNight(h: Harness, built: Pick<Built, "core">, now: string): Promise<void> {
	h.setNow(now);
	await built.core.accept(nightCommand(h, now.slice(0, 10), now), "system");
	await built.core.work();
}

// An external event of a customer arrives. Petra writes the event and the message.
async function customerWrites(built: Pick<Built, "core">, c: Customer, eventId: string): Promise<void> {
	await built.core.accept(
		{
			type: "ExternalEvent",
			commandId: eventId,
			at: c.at,
			eventId,
			source: "whatsapp",
			eventType: "message",
			sender: c.phone,
			payload: { text: `Hello, I am ${c.name}. Call me on ${c.phone}.`, name: c.name },
		},
		"not trusted",
	);
	await built.core.work();
}

// One row in each place of section 7.8 for one customer. Returns the id of the task.
async function customerRows(h: Harness, built: Built, c: Customer): Promise<string> {
	h.setNow(c.at);
	const eventId = `event-${c.key}-${h.accountId}`;
	await customerWrites(built, c, eventId);
	const taskId = `task-${c.key}-${h.accountId}`;
	await built.work.startTask({
		commandId: taskId,
		bot: testBot.id,
		taskType: "answer-question",
		goal: c.goal,
		replyTo: "chat",
		fromEvent: eventId,
	});
	await startRunner(h, taskId, 1);
	const gw = harnessGateway(h, built.work);
	const claims = h.claims(taskId, 1);
	await gw.call(claims, { call: "draft", callNo: 1, runnerId: "runner-1", path: "a.txt", body: `For ${c.name}` });
	await gw.call(claims, { call: "journal", callNo: 2, runnerId: "runner-1", copy: `Journal of ${c.name}` });
	await h.tasks.addInbox({
		taskId,
		sourceRef: `in-${c.key}`,
		kind: "message",
		text: `${c.name} asks again.`,
		at: c.at,
	});
	const action = { taskId, toolCallId: "call-1", contentHash: `hash-${c.key}` };
	await h.actions.addAction({
		...action,
		attemptNo: 1,
		tool: "send_reply",
		kind: "public",
		content: { to: c.phone, text: `Hello ${c.name}` },
		status: "pending",
		startedAt: null,
	});
	await h.actions.addApproval({ ...action, ruleId: null, limit: null, at: c.at });
	await h.actions.decideApproval({ ...action, status: "approved", decidedBy: `cmd-${c.key}`, at: c.at });
	await h.actions.moveAction({
		...action,
		from: ["pending"],
		to: "done",
		answer: { text: `Sent to ${c.name}` },
		at: c.at,
	});
	await gw.call(claims, {
		call: "result",
		callNo: 3,
		runnerId: "runner-1",
		result: {
			stop: "success",
			answer: `${c.name} has the answer.`,
			evidence: [],
			proposedFacts: [`${c.name} prefers oat milk. Phone ${c.phone}.`, `${c.name} visits on Fridays.`],
			notes: [`${c.name} asked for prices.`],
		},
	});
	// The owner approved the first fact and promoted it to the core.
	const factId = `task/${taskId}/1/fact/0`;
	await rows(h, "UPDATE facts SET approved_by_owner = true WHERE source_ref = $1", [factId]);
	const store = memoryWriter(h.database, h.accountId);
	const [fact] = await rows<{ text: string; customer_ref: string }>(
		h,
		"SELECT text, customer_ref FROM facts WHERE source_ref = $1",
		[factId],
	);
	await store.addCoreItem(
		{
			sourceRef: `core-${c.key}`,
			text: fact?.text ?? "",
			source: "owner",
			factRef: factId,
			customerRef: fact?.customer_ref ?? null,
			at: c.at,
		},
		25,
	);
	await store.addProposal({
		week: `week-${c.key}`,
		n: 1,
		kind: "core item",
		text: `${c.name} wants a discount.`,
		evidence: [`cmd/${eventId}/in`],
	});
	return taskId;
}

const PLACES = [
	"events",
	"messages",
	"tasks",
	"task_inbox",
	"actions",
	"approvals",
	"notes",
	"facts",
	"core_items",
	"proposals",
	"draft_files",
	"journal_copies",
	"trail",
	"decisions",
] as const;

// Each row of each place, as JSON text.
async function dump(h: Harness, places: readonly string[] = PLACES): Promise<string[]> {
	const all: string[] = [];
	for (const place of places) {
		// The events of the night jobs are new rows of each run. They have no text of a customer.
		const where = place === "events" ? " WHERE kind <> 'RunJob'" : "";
		const found = await rows<{ row: string }>(h, `SELECT row_to_json(t)::text AS row FROM ${place} t${where}`);
		all.push(...found.map((item) => `${place}: ${item.row}`).sort());
	}
	return all;
}

const hasDataOf = (text: string, c: Customer) =>
	[c.name, ...c.name.split(" "), c.phone].some((part) => text.toLowerCase().includes(part.toLowerCase()));

test("M13: after 12 months and one night job, no place of section 7.8 has text of the customer; another customer does not change; an approved fact stays with no name; a brief of another task that copies her facts keeps its ids with no text of her", async () => {
	const h = await harness("m13");
	const built = h.build();
	const saraTask = await customerRows(h, built, SARA);
	// The task of Omar starts after the facts of Sara exist. Its brief copies her core item and her two facts.
	const omarTask = await customerRows(h, built, OMAR);
	const saraIds = ["core-c1", `task/${saraTask}/1/fact/0`, `task/${saraTask}/1/fact/1`];
	const omarBrief = async () => (await h.tasks.task(omarTask))?.brief;
	const briefBefore = await omarBrief();
	assert.deepEqual(
		briefBefore?.facts.map((fact) => fact.id).sort(),
		[...saraIds].sort(),
		"Control: the brief of Omar holds the facts of Sara.",
	);
	const ref = await customerRef(h.accountId, "whatsapp", SARA.phone);
	assert.equal((await h.tasks.task(saraTask))?.customerRef, ref, "The task of the event has the reference.");
	const before = await dump(h);
	assert.ok(
		before.some((row) => hasDataOf(row, SARA)),
		"Control: the places have text of Sara.",
	);
	// The trail and the files of a task follow their own rules, so the comparison of Omar leaves them out.
	const stable = PLACES.filter((place) => !["trail", "draft_files", "journal_copies"].includes(place));
	// The task row of Omar has the facts of Sara in its brief. The test reads that brief by itself.
	const omarRows = async () =>
		(await dump(h, stable)).filter((row) => hasDataOf(row, OMAR) && !row.startsWith(`tasks: {"id":"${omarTask}"`));
	const omarBefore = await omarRows();
	await runNight(h, built, NIGHT);
	const after = await dump(h);
	assert.deepEqual(
		after.filter((row) => hasDataOf(row, SARA)),
		[],
	);
	assert.ok(![...h.objects.map.values()].some((body) => hasDataOf(body, SARA)), "No object in R2 has her text.");
	assert.deepEqual(await omarRows(), omarBefore);
	// The brief of Omar keeps each entry id and his own text. The text of Sara is cleaned.
	const briefAfter = await omarBrief();
	const cleanedTexts: Record<string, string> = {
		"core-c1": "[removed] prefers oat milk. Phone [removed].",
		[`task/${saraTask}/1/fact/0`]: "[removed] prefers oat milk. Phone [removed].",
		[`task/${saraTask}/1/fact/1`]: "[removed] visits on Fridays.",
	};
	assert.deepEqual(briefAfter, {
		...briefBefore,
		facts: briefBefore?.facts.map((fact) => ({ id: fact.id, text: cleanedTexts[fact.id] ?? fact.text })),
	});
	assert.equal(briefAfter?.goal, OMAR.goal);
	const factId = `task/${saraTask}/1/fact/0`;
	const facts = await rows<{ source_ref: string; text: string; customer_ref: string | null; cleaned: boolean }>(
		h,
		"SELECT source_ref, text, customer_ref, cleaned_at IS NOT NULL AS cleaned FROM facts WHERE source_ref LIKE $1",
		[`task/${saraTask}/%`],
	);
	assert.deepEqual(facts, [
		{ source_ref: factId, text: "[removed] prefers oat milk. Phone [removed].", customer_ref: ref, cleaned: true },
	]);
	assert.deepEqual(
		await rows(
			h,
			"SELECT text, customer_ref, cleaned_at IS NOT NULL AS cleaned FROM core_items WHERE source_ref = $1",
			["core-c1"],
		),
		[{ text: "[removed] prefers oat milk. Phone [removed].", customer_ref: ref, cleaned: true }],
	);
	const messages = await rows<{ body: unknown; sender: string; cleaned: boolean; customer_ref: string | null }>(
		h,
		`SELECT body, sender, cleaned_at IS NOT NULL AS cleaned, customer_ref FROM messages
		 WHERE source_ref = $1 OR task_id = $2`,
		[`cmd/event-c1-${h.accountId}/in`, saraTask],
	);
	assert.ok(messages.length >= 2, "The rows stay, with their seq.");
	assert.ok(messages.every((row) => row.cleaned && row.sender === "" && row.customer_ref === null));
	assert.deepEqual(
		await rows(h, "SELECT content, content_hash, status, answer FROM actions WHERE task_id = $1", [saraTask]),
		[{ content: {}, content_hash: "hash-c1", status: "done", answer: null }],
	);
	assert.deepEqual(await rows(h, "SELECT status FROM approvals WHERE task_id = $1", [saraTask]), [
		{ status: "approved" },
	]);
	assert.deepEqual(await rows(h, "SELECT text, evidence FROM proposals WHERE week = 'week-c1'"), [
		{ text: "", evidence: [`cmd/event-c1-${h.accountId}/in`] },
	]);
	// A second night job changes nothing.
	const once = await dump(h);
	await runNight(h, built, NEXT_NIGHT);
	assert.deepEqual(await dump(h), once);
});

test("M13: a deletion is due while a sandbox runs and an action is started: the task is cancelled, later calls are refused, nothing is deleted; after done, the next night job deletes; the credits go back one time", async () => {
	const lina = { sender: "+966 50 111 2222", name: "Lina Saleh", at: "2025-11-01T10:00:00.000Z" };
	const s = await gateSetup("m13d", "refund 15 to cust-1", { hold: true, customer: lina });
	const { h, taskId } = s;
	await s.work.setRule({
		type: "SetRule",
		commandId: `${taskId}-rule`,
		at: h.now(),
		rule: { kind: "money_limit", params: { maxAmount: 20_000_000 } },
	});
	const pending = s.action({ content: refund(15) });
	await untilSent(s.paid);
	const reply = { to: "cust-1", text: `Hello ${lina.name}` };
	assert.equal(statusOf(await s.action({ toolCallId: "call-2", tool: "send_reply", content: reply })), "wait");
	const eventRef = `cmd/event-${h.accountId}/in`;
	const textOf = async () =>
		rows<{ payload: unknown; body: unknown }>(
			h,
			"SELECT e.payload, m.body FROM events e JOIN messages m ON m.source_ref = $1 WHERE e.kind = 'ExternalEvent'",
			[eventRef],
		);
	const original = await textOf();
	assert.ok(JSON.stringify(original).includes(lina.name), "Control: the event and the message have her text.");
	const giveBacks = () => rows(h, "SELECT source_ref FROM ledger WHERE kind = 'give back'");
	// Night 1: the task is cancelled at once. The action is "started", so nothing of the customer is deleted.
	await runNight(h, s, "2026-11-19T00:00:00.000Z");
	assert.deepEqual(
		[(await h.tasks.task(taskId))?.status, (await h.tasks.task(taskId))?.stop],
		["cancelled", "cancelled"],
	);
	const later = await s.gw.call(h.claims(taskId, 1), { call: "inbox", callNo: 9, runnerId: "runner-1" });
	assert.deepEqual(later, { refused: "task" });
	assert.equal((await h.actions.action(taskId, "call-2"))?.status, "rejected");
	const approvals = await rows<{ status: string }>(h, "SELECT status FROM approvals WHERE tool_call_id = 'call-2'");
	assert.deepEqual(approvals, [{ status: "rejected" }]);
	assert.equal((await h.actions.action(taskId, "call-1"))?.status, "started");
	assert.deepEqual(await textOf(), original, "Nothing is deleted.");
	assert.ok((await h.writer.messageSeq(`task/${taskId}/cancelled`)) !== undefined, "The owner is told.");
	assert.equal((await giveBacks()).length, 1);
	// The service answers. The action is "done". The next night job deletes the data.
	s.release();
	assert.equal(statusOf(await pending), "done");
	await runNight(h, s, "2026-11-20T00:00:00.000Z");
	assert.deepEqual(await textOf(), [{ payload: {}, body: {} }]);
	assert.deepEqual(await rows(h, "SELECT brief FROM tasks WHERE id = $1", [taskId]), [{ brief: {} }]);
	assert.equal((await giveBacks()).length, 1, "The credits went back one time.");
});
