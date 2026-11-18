// The gateway of Petra against a real Postgres (docs/ARCHITECTURE.md, sections 3.4, 3.5 and 4.3).
// The test is here because a plug-in package must not import another plug-in (requirement C2).
import assert from "node:assert/strict";
import test from "node:test";

import { testBot } from "@tensquads/bots";
import { attemptVersions, type Brief, type GatewayCall, type PassClaims, type TaskResult } from "@tensquads/contracts";
import type { Database, ModelAnswer, ModelRequest } from "@tensquads/core";
import { type GatewayAnswer, gateway } from "@tensquads/gateway";
import { actionWriter, platformWriter, taskWriter } from "@tensquads/petra";

import { testDatabase, uniqueId } from "./db.js";

const AT = "2026-11-18T10:00:00.000Z";
const BRIEF: Brief = {
	goal: "Answer the question.",
	done: "The answer is sent.",
	facts: [{ id: "f1", text: "The shop opens at 9." }],
	limits: { maxTurns: 10, maxBudget: 0.5 },
	notInTask: [],
	replyTo: "chat",
};

function memoryMap() {
	const map = new Map<string, unknown>();
	return {
		map,
		get: async <T>(key: string) => map.get(key) as T | undefined,
		put: async (key: string, value: unknown) => {
			map.set(key, value);
		},
	};
}

interface Setup {
	database: Database;
	accountId: string;
	taskId: string;
	tasks: ReturnType<typeof taskWriter>;
	gw: ReturnType<typeof gateway>;
	modelCalls: ModelRequest[];
	claims: (attemptNo?: number) => PassClaims;
	setNow: (iso: string) => void;
}

async function newAccount(database: Database, prefix: string): Promise<string> {
	const accountId = uniqueId(prefix);
	await platformWriter(database).addAccount({
		id: accountId,
		name: prefix,
		timeZone: "UTC",
		language: "en",
		modelProfile: "test",
		at: AT,
	});
	return accountId;
}

// One account with one task of the test bot and its first attempt, as "start a task" writes them (section 4.6).
async function setup(model?: (request: ModelRequest) => Promise<ModelAnswer>): Promise<Setup> {
	const database = testDatabase();
	const accountId = await newAccount(database, "gw");
	const tasks = taskWriter(database, accountId);
	const commandId = uniqueId("task");
	const taskId = await tasks.createTask({
		commandId,
		bot: "test-bot",
		taskType: "answer-question",
		brief: BRIEF,
		at: AT,
	});
	await tasks.chargeTask({ taskId, credits: 1, at: AT });
	await tasks.addAttempt({ taskId, causeRef: commandId, reason: "first", versions: {} });
	let now = AT;
	const modelCalls: ModelRequest[] = [];
	const gw = gateway({
		accountId,
		tasks,
		actions: actionWriter(database, accountId),
		// The tests of the gate are in gate.test.ts.
		gate: { action: async () => ({ status: "refused", reason: "This test has no gate." }) },
		objectStore: memoryMap(),
		model: {
			complete: async (request) => {
				modelCalls.push(request);
				if (model) return model(request);
				return {
					text: "ok",
					toolCalls: [],
					provider: "test",
					model: "scripted",
					usage: { inputTokens: 1, outputTokens: 1 },
				};
			},
		},
		check: async () => ({ verdict: "stands", reason: "The double always says stands." }),
		storage: memoryMap(),
		now: () => now,
		workerCommit: "worker-abc",
		// Petra ends the task after a result that stands. Task work does more. This test reads the status only.
		settle: async ({ taskId }, result) => {
			if (result.stop === "success") await tasks.setTaskStatus({ taskId, status: "done", stop: "success", at: now });
		},
		noteCall: async () => undefined,
	});
	return {
		database,
		accountId,
		taskId,
		tasks,
		gw,
		modelCalls,
		claims: (attemptNo = 1) => ({
			accountId,
			bot: "test-bot",
			taskId,
			attemptNo,
			endsAt: Date.parse(AT) + 3_600_000,
		}),
		setNow: (iso) => {
			now = iso;
		},
	};
}

const startCall = (callNo: number, runnerId: string): GatewayCall => ({
	call: "start",
	callNo,
	runnerId,
	runnerCommit: "runner-def",
	pluginListHash: "plugins-123",
});

const modelCall = (callNo: number, runnerId: string, turnNo: number): GatewayCall => ({
	call: "model",
	callNo,
	runnerId,
	turnNo,
	messages: [{ role: "user", content: `turn ${turnNo}` }],
	tools: ["read_file"],
});

test("L5: 12 journal copies in one attempt, start gives copy 12, not 9", async () => {
	const { gw, tasks, taskId, claims } = await setup();
	assert.equal("refused" in (await gw.call(claims(), startCall(1, "runner-a"))), false);
	// Copy k has the call number k + 1. As text, the call number "9" is larger than "13".
	for (let k = 1; k <= 12; k += 1) {
		const answer = await gw.call(claims(), {
			call: "journal",
			callNo: k + 1,
			runnerId: "runner-a",
			copy: btoa(`copy ${k}`),
		});
		assert.deepEqual(answer, { ok: true });
	}
	await tasks.addAttempt({ taskId, causeRef: "report-1", reason: "after a failure", versions: {} });
	const start = await gw.call(claims(2), startCall(1, "runner-b"));
	assert.ok("journal" in start);
	assert.equal(atob(start.journal ?? ""), "copy 12");
	assert.deepEqual(await tasks.newestJournalCopy(taskId), {
		attemptNo: 1,
		callNo: 13,
		blobKey: `journal/${taskId}/1/13`,
	});
});

test("L5: the start of a first attempt gives the brief, the forget list and no journal", async () => {
	const { gw, tasks, taskId, claims } = await setup();
	await tasks.addInbox({ taskId, sourceRef: "forget/f1", kind: "forget", factId: "f1", at: AT });
	await tasks.addInbox({ taskId, sourceRef: "cmd/m1", kind: "message", text: "Also say hello.", at: AT });
	assert.deepEqual(await gw.call(claims(), startCall(1, "runner-a")), {
		brief: BRIEF,
		taskType: "answer-question",
		forget: ["f1"],
		journal: null,
		signals: [],
		drafts: [],
	});
	assert.equal((await tasks.task(taskId))?.status, "running");
	assert.deepEqual(await gw.call(claims(), { call: "inbox", callNo: 2, runnerId: "runner-a" }), {
		messages: [{ sourceRef: "cmd/m1", text: "Also say hello." }],
		forget: ["f1"],
		signals: [],
	});
});

test("L12: a second start with another runner id is refused, and each later call needs the first runner id", async () => {
	const { gw, tasks, taskId, claims } = await setup();
	assert.ok("brief" in (await gw.call(claims(), startCall(1, "runner-a"))));
	// The same call number with another runner id: the runner id is checked before the saved answer.
	assert.deepEqual(await gw.call(claims(), startCall(1, "runner-b")), { refused: "runner" });
	assert.deepEqual(await gw.call(claims(), startCall(2, "runner-b")), { refused: "runner" });
	assert.deepEqual(await gw.call(claims(), modelCall(2, "runner-b", 1)), { refused: "runner" });
	assert.equal((await tasks.currentAttempt(taskId))?.runnerId, "runner-a");
	// The first runner continues.
	assert.ok("text" in (await gw.call(claims(), modelCall(2, "runner-a", 1))));
});

test("L12: a call before start is refused", async () => {
	const { gw, claims } = await setup();
	assert.deepEqual(await gw.call(claims(), modelCall(1, "runner-a", 1)), { refused: "runner" });
});

test("L12: two starts at the same time with two runner ids bind one runner", async () => {
	const { gw, claims } = await setup();
	const answers: GatewayAnswer[] = await Promise.all([
		gw.call(claims(), startCall(1, "runner-a")),
		gw.call(claims(), startCall(2, "runner-b")),
	]);
	assert.equal(answers.filter((answer) => "brief" in answer).length, 1);
	assert.equal(answers.filter((answer) => "refused" in answer && answer.refused === "runner").length, 1);
});

test("L5: a duplicate call number gets the saved answer, and a call in progress gets busy", async () => {
	let release: () => void = () => {};
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const { gw, claims, modelCalls, tasks, taskId } = await setup(async () => {
		await blocked;
		return {
			text: "first",
			toolCalls: [],
			provider: "test",
			model: "scripted",
			usage: { inputTokens: 1, outputTokens: 1 },
		};
	});
	await gw.call(claims(), startCall(1, "runner-a"));
	const first = gw.call(claims(), modelCall(2, "runner-a", 1));
	// Wait until the first call is at the model.
	while (modelCalls.length === 0) await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(await gw.call(claims(), modelCall(2, "runner-a", 1)), { busy: true });
	release();
	const answer = await first;
	assert.equal("text" in answer && answer.text, "first");
	assert.deepEqual(await gw.call(claims(), modelCall(2, "runner-a", 1)), answer);
	assert.equal(modelCalls.length, 1);
	assert.equal(await tasks.countTrail(taskId, "model call"), 1);
});

test("L4: the model call at the limit of turns returns max_turns, counted over all attempts", async () => {
	const { gw, tasks, taskId, claims, modelCalls } = await setup();
	await gw.call(claims(), startCall(1, "runner-a"));
	// The test bot has a maximum of 10 turns: 6 in attempt 1 and 4 in attempt 2.
	for (let turn = 1; turn <= 6; turn += 1) {
		assert.ok("text" in (await gw.call(claims(), modelCall(turn + 1, "runner-a", turn))));
	}
	await tasks.addAttempt({ taskId, causeRef: "report-1", reason: "after a failure", versions: {} });
	await gw.call(claims(2), startCall(1, "runner-b"));
	for (let turn = 6; turn <= 9; turn += 1) {
		assert.ok("text" in (await gw.call(claims(2), modelCall(turn - 4, "runner-b", turn))));
	}
	assert.deepEqual(await gw.call(claims(2), modelCall(6, "runner-b", 10)), { limit: "max_turns" });
	assert.equal(modelCalls.length, 10);
});

test("L7: the status of a task comes from its trail rows", async () => {
	const { gw, tasks, taskId, claims, setNow } = await setup();
	assert.equal(await tasks.taskActivity(taskId, AT), undefined);
	await gw.call(claims(), startCall(1, "runner-a"));
	setNow("2026-11-18T10:00:05.000Z");
	await gw.call(claims(), modelCall(2, "runner-a", 1));
	setNow("2026-11-18T10:00:07.000Z");
	await gw.call(claims(), {
		call: "step",
		callNo: 3,
		runnerId: "runner-a",
		turnNo: 1,
		toolCallId: "call-1",
		tool: "read_file",
		summary: "Read the file.",
	});
	assert.deepEqual(await tasks.taskActivity(taskId, "2026-11-18T10:00:10.000Z"), {
		taskId,
		bot: "test-bot",
		attemptNo: 1,
		turnNo: 1,
		toolCall: { id: "call-1", tool: "read_file" },
		firstAt: "2026-11-18T10:00:05.000Z",
		lastAt: "2026-11-18T10:00:07.000Z",
		sinceFirstMs: 5000,
		sinceLastMs: 3000,
	});
});

test("L11: each attempt records the versions that it ran with", async () => {
	const { gw, tasks, taskId, claims } = await setup();
	await gw.call(claims(), startCall(1, "runner-a"));
	await gw.call(claims(), modelCall(2, "runner-a", 1));
	const versions = attemptVersions.parse((await tasks.currentAttempt(taskId))?.versions);
	assert.deepEqual(versions, {
		workerCommit: "worker-abc",
		runnerCommit: "runner-def",
		pluginListHash: "plugins-123",
		botVersion: testBot.version,
		provider: "test",
		model: "scripted",
	});
});

test("L9: a pass of a different task, of an old attempt, or of a task that ended is refused", async () => {
	const { database, gw, tasks, taskId, claims } = await setup();
	// A task of another account, with a pass that names this account.
	const other = taskWriter(database, await newAccount(database, "gw-other"));
	const otherTask = await other.createTask({
		commandId: uniqueId("task"),
		bot: "test-bot",
		taskType: "answer-question",
		brief: BRIEF,
		at: AT,
	});
	assert.deepEqual(await gw.call({ ...claims(), taskId: otherTask }, startCall(1, "runner-a")), { refused: "task" });
	assert.deepEqual(await gw.call({ ...claims(), accountId: "another" }, startCall(1, "runner-a")), {
		refused: "task",
	});
	assert.deepEqual(await gw.call({ ...claims(), bot: "another-bot" }, startCall(1, "runner-a")), { refused: "task" });

	await gw.call(claims(), startCall(1, "runner-a"));
	await tasks.addAttempt({ taskId, causeRef: "report-1", reason: "after a failure", versions: {} });
	assert.deepEqual(await gw.call(claims(1), modelCall(2, "runner-a", 1)), { refused: "attempt" });

	await tasks.setTaskStatus({ taskId, status: "cancelled", stop: "cancelled", at: AT });
	assert.deepEqual(await gw.call(claims(2), startCall(1, "runner-b")), { refused: "task" });
});

test("L2: a result that stands ends the task with the stop name success", async () => {
	const { gw, tasks, taskId, claims } = await setup();
	await gw.call(claims(), startCall(1, "runner-a"));
	const result: TaskResult = { stop: "success", answer: "9", evidence: [], proposedFacts: [], notes: [] };
	assert.deepEqual(await gw.call(claims(), { call: "result", callNo: 2, runnerId: "runner-a", result }), {
		verdict: "stands",
		reason: "The double always says stands.",
	});
	const task = await tasks.task(taskId);
	assert.deepEqual({ status: task?.status, stop: task?.stop }, { status: "done", stop: "success" });
	assert.equal(await tasks.countTrail(taskId, "check"), 1);
});

test("P6: each write of the task writer runs two times, and the rows are the same", async () => {
	const database = testDatabase();
	const accountId = await newAccount(database, "tw");
	const tasks = taskWriter(database, accountId);
	const commandId = uniqueId("task");
	const writeAll = async () => {
		const taskId = await tasks.createTask({
			commandId,
			bot: "test-bot",
			taskType: "answer-question",
			brief: BRIEF,
			at: AT,
		});
		await tasks.chargeTask({ taskId, credits: 3, at: AT });
		const first = await tasks.addAttempt({ taskId, causeRef: commandId, reason: "first", versions: {} });
		const second = await tasks.addAttempt({ taskId, causeRef: "report-1", reason: "after a failure", versions: {} });
		await tasks.endAttempt({ taskId, attemptNo: 1, exit: "1", at: AT });
		await tasks.giveBack({ taskId, credits: 3, at: AT });
		return [first, second];
	};
	assert.deepEqual(await writeAll(), [1, 2]);
	assert.deepEqual(await writeAll(), [1, 2]);
	const rows = await database.transaction({ role: "petra", accountId }, async (tx) => ({
		tasks: await tx.query("SELECT id, status FROM tasks"),
		attempts: await tx.query("SELECT attempt_no, cause_ref, exit FROM attempts ORDER BY attempt_no"),
		ledger: await tx.query("SELECT source_ref, kind, credits FROM ledger ORDER BY source_ref"),
	}));
	assert.deepEqual(rows, {
		tasks: [{ id: commandId, status: "starting" }],
		attempts: [
			{ attempt_no: 1, cause_ref: commandId, exit: "1" },
			{ attempt_no: 2, cause_ref: "report-1", exit: null },
		],
		ledger: [
			{ source_ref: `task/${commandId}/charge`, kind: "charge", credits: "-3" },
			{ source_ref: `task/${commandId}/give back`, kind: "give back", credits: "3" },
		],
	});
});
