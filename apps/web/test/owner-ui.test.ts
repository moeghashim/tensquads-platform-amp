// The owner page: the mapping of the messages of the Worker to @tensquads/ui, and the proxy route.
import assert from "node:assert/strict";
import test from "node:test";

import { GET, POST } from "../app/api/worker/[...path]/route.js";
import {
	arrivalLines,
	messageLine,
	openWatched,
	taskIdsOf,
	taskLine,
	taskUpdate,
	watchTasks,
} from "../lib/activity.js";
import { mergeMessages, openQuestion, ownerView, placeSent, type WorkerMessage } from "../lib/owner-messages.js";
import {
	type PetraStep,
	type StepWatch,
	stepLine,
	stepUpdate,
	watchCommand,
	watchedCommands,
} from "../lib/petra-steps.js";

const AT = "2026-11-20T10:00:00.000Z";
const reply = (seq: number, text = "Hello"): WorkerMessage => ({ seq, at: AT, type: "reply", text });
const question = (seq: number, questionId: string): WorkerMessage => ({
	seq,
	at: AT,
	type: "question",
	questionId,
	text: "Which day?",
	options: [],
});
const approval: WorkerMessage = {
	seq: 2,
	at: AT,
	type: "approval_request",
	approvalId: "ap-1",
	action: "refund",
	content: "refund 60",
	contentHash: "h-1",
	rule: "r-1",
	limit: 20_000_000,
	amount: 60_000_000,
	bot: "test-bot",
	taskId: "t-1",
};

test("the approval card gets the fields of the UI schema only, and approval_decided gives its decision", () => {
	const view = ownerView([
		reply(1),
		approval,
		{ seq: 3, at: AT, type: "approval_decided", approvalId: "ap-1", decision: "reject" },
	]);
	assert.deepEqual(
		view.messages.map((message) => message.type),
		["reply", "approval_request"],
	);
	assert.deepEqual(Object.keys(view.messages[1] ?? {}).sort(), [
		"action",
		"approvalId",
		"at",
		"content",
		"contentHash",
		"limit",
		"rule",
		"seq",
		"type",
	]);
	assert.deepEqual(view.decisions, { "ap-1": "reject" });
});

test("a question is open only while it is the newest message of Petra and has no answer", () => {
	assert.deepEqual(openQuestion(ownerView([reply(1), question(2, "t-1/q-1")])), {
		questionId: "t-1/q-1",
		text: "Which day?",
		fromPetra: false,
	});
	// Petra's own question (no task): the platform takes no OwnerAnswer for it, so the text goes as a message.
	assert.equal(openQuestion(ownerView([question(1, "c-9/ask")]))?.fromPetra, true);
	assert.equal(openQuestion(ownerView([question(1, "c-9/request-clear")]))?.fromPetra, true);
	// An old question with a later reply is not open, so the next text is a new message, not an answer.
	assert.equal(openQuestion(ownerView([question(1, "q-1"), reply(2)])), undefined);
	const answered = ownerView([question(1, "q-1"), { seq: 2, at: AT, type: "question_answered", questionId: "q-1" }]);
	assert.equal(openQuestion(answered), undefined);
});

test("a text of the owner shows after the last shown message, also when the newest message was hidden", () => {
	const view = ownerView([
		reply(1),
		approval,
		{ seq: 3, at: AT, type: "approval_decided", approvalId: "ap-1", decision: "approve" },
		reply(5),
	]);
	const places = placeSent(view, [
		{ afterSeq: 0, text: "first" },
		{ afterSeq: 3, text: "after the decision" },
		{ afterSeq: 5, text: "last" },
	]);
	assert.deepEqual(places.get(-1)?.[0]?.text, "first");
	// Seq 3 is hidden. The text goes after the approval card (index 1), not after the reply of seq 5.
	assert.deepEqual(places.get(1)?.[0]?.text, "after the decision");
	assert.deepEqual(places.get(2)?.[0]?.text, "last");
});

test("mergeMessages skips a seq that it has, keeps the order of seq, and keeps the list when nothing is new", () => {
	const list = [reply(1), reply(3)];
	assert.deepEqual(
		mergeMessages(list, [reply(3), reply(2), reply(4)]).map((message) => message.seq),
		[1, 2, 3, 4],
	);
	assert.equal(mergeMessages(list, [reply(1)]), list);
});

test("the proxy forwards the two owner calls with the token, and refuses each other path", async (t) => {
	const calls: { url: string; method: string; authorization: string | null; body: unknown }[] = [];
	t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
		calls.push({
			url,
			method: String(init.method),
			authorization: new Headers(init.headers).get("authorization"),
			body: init.body,
		});
		return Response.json({ messages: [] });
	});
	const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
	const headers = { authorization: "Bearer owner-token" };

	const read = await GET(
		new Request("https://page.test/api/worker/v1/messages?after=3", { headers }),
		context(["v1", "messages"]),
	);
	assert.equal(read.status, 200);
	await POST(
		new Request("https://page.test/api/worker/v1/commands", {
			method: "POST",
			headers,
			body: '{"type":"OwnerMessage"}',
		}),
		context(["v1", "commands"]),
	);
	const task = await GET(
		new Request("https://page.test/api/worker/v1/tasks/t-1", { headers }),
		context(["v1", "tasks", "t-1"]),
	);
	assert.equal(task.status, 200);
	const admin = await GET(
		new Request("https://page.test/api/worker/v1/admin/accounts", { headers }),
		context(["v1", "admin", "accounts"]),
	);

	assert.equal(admin.status, 404);
	assert.equal(calls.length, 3);
	assert.match(calls[2]?.url ?? "", /\/v1\/tasks\/t-1$/);
	assert.match(calls[0]?.url ?? "", /\/v1\/messages\?after=3$/);
	assert.deepEqual(
		calls.map((call) => [call.method, call.authorization]),
		[
			["GET", "Bearer owner-token"],
			["POST", "Bearer owner-token"],
			["GET", "Bearer owner-token"],
		],
	);
	assert.equal(calls[1]?.body, '{"type":"OwnerMessage"}');
});

test("the activity panel names each task that Petra started, in English and in Arabic, and each line has its data", () => {
	const ids = taskIdsOf([
		reply(1, "I started the task chat-mwooxl5y."),
		reply(2, "بدأت المهمة speed-a-1."),
		{ seq: 3, at: AT, type: "result", taskId: "t-9", summary: "ok", evidence: [] },
		reply(4, "You have no open task."),
	]);
	assert.deepEqual(ids, ["chat-mwooxl5y", "speed-a-1", "t-9"]);
	assert.equal(
		messageLine(approval, 9500),
		"petra → approval_request #2 refund amount=60000000 limit=20000000 task=t-1 (+9.5 s)",
	);
	assert.equal(
		taskLine({
			taskId: "t-1",
			status: "running",
			// GET /v1/tasks/{id} gives the tool call as an object (taskStatusAnswer in contracts).
			activity: { bot: "test-bot", attemptNo: 2, turnNo: 3, toolCall: { id: "call-7", tool: "read_file" } },
		}),
		"task t-1: running · test-bot attempt 2 turn 3 · tool read_file",
	);
});

test("a watched task gives a line only when its state changes, and is not read again after it ended", () => {
	const watched = new Map<string, string | null>();
	watchTasks(watched, [reply(1, "I started the task t-1.")]);
	const running = { taskId: "t-1", status: "running", activity: { bot: "test-bot", attemptNo: 1, turnNo: 1 } };
	assert.equal(taskUpdate(watched, running), "task t-1: running · test-bot attempt 1 turn 1");
	assert.equal(taskUpdate(watched, running), undefined);
	assert.equal(taskUpdate(watched, undefined), undefined);
	assert.equal(taskUpdate(watched, { ...running, status: "done" })?.startsWith("task t-1: done"), true);
	assert.deepEqual(openWatched(watched), []);
	// The result message names the ended task again. It is not read again, so "done" shows one time.
	watchTasks(watched, [{ seq: 9, at: AT, type: "result", taskId: "t-1", summary: "ok", evidence: [] }]);
	assert.deepEqual(openWatched(watched), []);
	// The history of a session is one summary line; later messages give one line each.
	assert.deepEqual(arrivalLines([reply(1), reply(2)], true, null), [
		{ kind: "info", text: "signed in · 2 earlier messages" },
	]);
	assert.equal(arrivalLines([reply(3)], false, 1200)[0]?.text, "petra → reply #3 (+1.2 s)");
});

test("the proxy forwards the steps of one command, and refuses each other path under a command", async (t) => {
	const urls: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string) => {
		urls.push(url);
		return Response.json({ commandId: "c-1", steps: [] });
	});
	const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
	const headers = { authorization: "Bearer owner-token" };
	const steps = await GET(
		new Request("https://page.test/api/worker/v1/commands/c-1/steps", { headers }),
		context(["v1", "commands", "c-1", "steps"]),
	);
	assert.equal(steps.status, 200);
	for (const path of [
		["v1", "commands", "c-1"],
		["v1", "commands", "c-1", "trail"],
		["v1", "commands", "c-1", "steps", "x"],
	]) {
		const refused = await GET(
			new Request(`https://page.test/api/worker/${path.join("/")}`, { headers }),
			context(path),
		);
		assert.equal(refused.status, 404, path.join("/"));
	}
	assert.deepEqual(
		urls.map((url) => new URL(url).pathname),
		["/v1/commands/c-1/steps"],
	);
});

const T = (ms: number) => new Date(Date.parse(AT) + ms).toISOString();
const modelStep: PetraStep = {
	kind: "model",
	at: T(0),
	provider: "openai",
	model: "gpt-6.2-sol",
	ms: 1840,
	inputTokens: 3120,
	outputTokens: 42,
	tools: ["start_task"],
	failed: false,
};
const decisionStep: PetraStep = {
	kind: "decision",
	at: T(1900),
	point: "message-for-task",
	decider: "model-decider",
	options: ["t-1", "new task"],
	answer: "new task",
	probability: 0.93,
	used: true,
	shadow: false,
	ms: 610,
};
const costStep: PetraStep = {
	kind: "cost",
	at: T(1850),
	costKind: "large model",
	provider: "openai",
	model: "gpt-6.2-sol",
	units: 3120,
	unit: "1M input tokens",
	amount: 3900,
};

test("each internal step of Petra is one line with its data", () => {
	assert.equal(
		stepLine(modelStep).text,
		"petra model openai/gpt-6.2-sol 1840 ms · 3120 in / 42 out tokens → start_task",
	);
	assert.equal(
		stepLine({ ...modelStep, tools: [], failed: true, ms: 60000, inputTokens: 0, outputTokens: 0 }).text,
		"petra model openai/gpt-6.2-sol failed after 60000 ms",
	);
	assert.equal(stepLine({ ...modelStep, tools: [] }).text.endsWith("→ text"), true);
	assert.equal(
		stepLine({ kind: "tool", at: T(1), tool: "start_task", ms: 95, failed: false }).text,
		"petra tool start_task 95 ms",
	);
	assert.equal(
		stepLine(decisionStep).text,
		"decider model-decider · message-for-task [t-1 | new task] → new task p=0.93 · 610 ms",
	);
	// A choice of the code has no options, no probability and no time. A shadow answer is never used.
	assert.equal(
		stepLine({
			...decisionStep,
			decider: "code",
			point: "stop",
			options: [],
			probability: null,
			ms: null,
			answer: "t-1",
		}).text,
		"decider code · stop → t-1",
	);
	assert.equal(stepLine({ ...decisionStep, shadow: true, used: false }).text.endsWith("(shadow)"), true);
	assert.equal(stepLine(costStep).text, "cost large model openai/gpt-6.2-sol 3120 × 1M input tokens = $0.003900");
	assert.equal(stepLine(costStep).at, "10:00:01.850");
});

test("a watched command gives each step one time, also when a later read puts it in a new place, and stops when quiet", () => {
	const watch: StepWatch = new Map();
	watchCommand(watch, "c-1", 0);
	assert.deepEqual(watchedCommands(watch, 0), ["c-1"]);
	assert.equal(stepUpdate(watch, "c-1", [modelStep, decisionStep], 1000).length, 2);
	// The cost row comes later, and sorts between the two earlier steps. Only the cost row is new.
	const next = stepUpdate(watch, "c-1", [modelStep, costStep, decisionStep], 2000);
	assert.deepEqual(
		next.map((line) => line.kind),
		["cost"],
	);
	assert.equal(stepUpdate(watch, "c-1", [modelStep, costStep, decisionStep], 3000).length, 0);
	// 30 s with no new step: the page stops reading the command. A command with no step yet waits the same time.
	assert.deepEqual(watchedCommands(watch, 31_999), ["c-1"]);
	assert.deepEqual(watchedCommands(watch, 32_001), []);
	assert.equal(watch.size, 0);
});
