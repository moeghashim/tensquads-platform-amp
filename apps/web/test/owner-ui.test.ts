// The owner page: the mapping of the messages of the Worker to @tensquads/ui, and the proxy route.
import assert from "node:assert/strict";
import test from "node:test";

import { GET, POST } from "../app/api/worker/[...path]/route.js";
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
	assert.deepEqual(openQuestion(ownerView([reply(1), question(2, "q-1")])), { questionId: "q-1", text: "Which day?" });
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
	const admin = await GET(
		new Request("https://page.test/api/worker/v1/admin/accounts", { headers }),
		context(["v1", "admin", "accounts"]),
	);

	assert.equal(admin.status, 404);
	assert.equal(calls.length, 2);
	assert.match(calls[0]?.url ?? "", /\/v1\/messages\?after=3$/);
	assert.deepEqual(
		calls.map((call) => [call.method, call.authorization]),
		[
			["GET", "Bearer owner-token"],
			["POST", "Bearer owner-token"],
		],
	);
	assert.equal(calls[1]?.body, '{"type":"OwnerMessage"}');
});
