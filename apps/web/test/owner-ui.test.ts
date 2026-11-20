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
			activity: { bot: "test-bot", attemptNo: 2, turnNo: 3, toolCall: "read_file" },
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
